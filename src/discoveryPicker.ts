import * as clack from "@clack/prompts";
import { Effect, Option } from "effect";

import { Display } from "./Display.js";
import { InitError } from "./errors.js";
import type { AgentEntry } from "./InitService.js";
import {
  discoverAgent,
  discoverAgents,
  getDiscoveryAdapter,
} from "./discovery/registry.js";
import { nodeDiscoveryExec } from "./discovery/nodeExec.js";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveredModel,
  DiscoveryExec,
} from "./discovery/contract.js";
import type { ModelSource } from "./ProjectSettings.js";

/**
 * The host-mode agent picker and discovery-driven model/effort resolution for
 * `sandcastle init` (ADR 0021/0026).
 *
 * Host mode probes every registered discovery adapter on the host in one
 * parallel pass (`discoverAgents`), then renders a picker where verified
 * ready agents come first and unavailable ones sit behind a secondary
 * "other agents" choice carrying their state (missing / unauthenticated /
 * wrong-product / error), actionable Vietnamese guidance, and a recheck
 * option. Agents with no discovery adapter stay selectable through the same
 * secondary list as explicit manual (unverified) entries.
 *
 * Every prompt is Vietnamese; identifiers (agent names, model ids, effort
 * values, provider names) stay English. A cancelled prompt is always a safe
 * stop — nothing is scaffolded until init resumes with a selection.
 */

/** The model/effort selection init resolved through agent discovery. */
export interface DiscoveredSelection {
  readonly model: string;
  readonly effort?: string;
  readonly modelSource: ModelSource;
}

/**
 * Outcome of {@link resolveDiscoveredSelection}. `"back"` is only produced in
 * interactive mode when `offerBack` is set — the host agent picker then
 * returns to its agent list carrying the latest report so a recheck that ran
 * inside the recovery menu is reflected on the next render.
 */
export type AgentSelectionOutcome =
  | { readonly kind: "selection"; readonly selection: DiscoveredSelection }
  | { readonly kind: "back"; readonly report: AgentDiscoveryReport };

/** The agent + model/effort the host picker resolved. */
export interface HostAgentChoice {
  readonly agent: AgentEntry;
  readonly selection: DiscoveredSelection;
}

/** Safe-stop message — raised before anything is scaffolded. */
export const INIT_STOPPED_MESSAGE =
  "Đã dừng khởi tạo — chưa có tệp nào được tạo.";

const stopInit = (): Effect.Effect<never, InitError> =>
  Effect.fail(new InitError({ message: INIT_STOPPED_MESSAGE }));

/** Sentinel picker values — can never collide with registry agent names. */
const OTHER_AGENTS_VALUE = "__other-agents__";
const BACK_VALUE = "__back__";

// ---------------------------------------------------------------------------
// Discovery runners (spinner-wrapped, injectable boundary)
// ---------------------------------------------------------------------------

/**
 * Run one adapter's discovery through the process boundary, showing a spinner
 * while the CLI probes run. Never fails — adapters report every outcome via
 * `report.state`.
 */
export const runAgentDiscovery = (
  adapter: AgentDiscoveryAdapter,
  agentLabel: string,
  exec: DiscoveryExec = nodeDiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    return yield* d.spinner(
      `Đang kiểm tra ${agentLabel} trên máy này…`,
      Effect.promise(() => discoverAgent(adapter.agent, exec)),
    );
  }).pipe(
    Effect.map(
      (report) =>
        report ??
        ({
          agent: adapter.agent,
          executable: adapter.executable,
          state: "error",
          models: [],
          detail: "Không có adapter nào đăng ký cho agent này.",
        } satisfies AgentDiscoveryReport),
    ),
  );

/**
 * Probe every registered discovery adapter in parallel, showing one spinner
 * for the whole sweep. Never fails — each report stands alone.
 */
export const runAllAgentDiscovery = (
  exec: DiscoveryExec = nodeDiscoveryExec,
): Effect.Effect<readonly AgentDiscoveryReport[], never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    return yield* d.spinner(
      "Đang kiểm tra các agent trên máy này…",
      Effect.promise(() => discoverAgents(exec)),
    );
  });

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Read a flag pair as a manual (unverified) model/effort entry. */
const manualFromFlags = (
  modelFlag: Option.Option<string>,
  effortFlag: Option.Option<string>,
): { model?: string; effort?: string } => {
  const model =
    modelFlag._tag === "Some" && modelFlag.value.trim().length > 0
      ? modelFlag.value.trim()
      : undefined;
  const effort =
    effortFlag._tag === "Some" && effortFlag.value.trim().length > 0
      ? effortFlag.value.trim()
      : undefined;
  return { model, effort };
};

/**
 * Prompt for a manual model (+ optional effort) entry. The result is always
 * `manual-unverified` — the value was never checked against the agent.
 * A passed --model/--effort flag counts as the manual answer.
 */
const promptManualEntry = (
  agentLabel: string,
  modelFlag: Option.Option<string>,
  effortFlag: Option.Option<string>,
): Effect.Effect<DiscoveredSelection, InitError> =>
  Effect.gen(function* () {
    let model = modelFlag._tag === "Some" ? modelFlag.value.trim() : undefined;
    if (model === undefined || model.length === 0) {
      const entered = yield* Effect.promise(() =>
        clack.text({
          message: `Nhập model cho ${agentLabel} (sẽ được đánh dấu chưa xác minh):`,
          validate: (value) =>
            value === undefined || value.trim().length === 0
              ? "Model không được để trống."
              : undefined,
        }),
      );
      if (clack.isCancel(entered)) {
        return yield* stopInit();
      }
      model = entered.trim();
    }
    let effort =
      effortFlag._tag === "Some" ? effortFlag.value.trim() : undefined;
    // An explicitly-empty --effort (" ") counts as absent — prompt for it.
    if (effort === undefined || effort.length === 0) {
      const entered = yield* Effect.promise(() =>
        clack.text({
          message: `Nhập effort cho ${model} (để trống nếu không dùng):`,
        }),
      );
      if (clack.isCancel(entered)) {
        return yield* stopInit();
      }
      effort = entered.trim().length > 0 ? entered.trim() : undefined;
    }
    return {
      model,
      ...(effort !== undefined ? { effort } : {}),
      modelSource: "manual-unverified" as const,
    };
  });

type RecoveryAction = "retry" | "manual" | "back" | "stop";

/**
 * The discovery-failure recovery menu. `offerRetry` is omitted for agents
 * with no adapter (nothing to re-probe); `offerBack` adds the "pick another
 * agent" escape the host picker uses. Cancel and "stop" are the same safe
 * stop — raised as an InitError before any file is written.
 */
const promptRecoveryAction = (params: {
  readonly offerRetry: boolean;
  readonly offerBack: boolean;
}): Effect.Effect<RecoveryAction, InitError> =>
  Effect.gen(function* () {
    const options: { value: RecoveryAction; label: string }[] = [];
    if (params.offerRetry) {
      options.push({ value: "retry", label: "Thử lại" });
    }
    options.push({
      value: "manual",
      label: "Nhập model thủ công (chưa xác minh)",
    });
    if (params.offerBack) {
      options.push({ value: "back", label: "Chọn agent khác" });
    }
    options.push({ value: "stop", label: "Dừng lại" });
    const action = yield* Effect.promise(() =>
      clack.select<RecoveryAction>({
        message: "Bạn muốn tiếp tục thế nào?",
        options,
      }),
    );
    if (clack.isCancel(action) || action === "stop") {
      return yield* stopInit();
    }
    return action;
  });

// ---------------------------------------------------------------------------
// Picker option builders (grouping + recommendation markers)
// ---------------------------------------------------------------------------

/** Value prefix for the non-selectable provider header rows. */
const PROVIDER_HEADER_PREFIX = "__provider-group__:";

/**
 * Build the model picker options, grouped by model provider when the catalog
 * carries more than one (Pi, OpenCode). Groups keep first-appearance order —
 * adapters emit their catalogs provider-grouped already. Each provider gets a
 * disabled header row, so the list visually reads grouped; without multiple
 * providers the provider name stays in the per-model hint instead. The
 * catalog's recommended model carries a `(khuyến nghị)` marker and is the
 * picker's initial selection.
 */
export const buildModelOptions = (
  catalog: readonly DiscoveredModel[],
  recommendedModel: string | undefined,
): { value: string; label: string; hint?: string; disabled?: boolean }[] => {
  const groups = new Map<string | undefined, DiscoveredModel[]>();
  for (const m of catalog) {
    const list = groups.get(m.provider) ?? [];
    list.push(m);
    groups.set(m.provider, list);
  }
  const showHeaders =
    groups.size > 1 && [...groups.keys()].some((p) => p !== undefined);
  const options: {
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }[] = [];
  for (const [provider, models] of groups) {
    if (showHeaders) {
      options.push({
        value: `${PROVIDER_HEADER_PREFIX}${provider ?? "other"}`,
        label: provider ?? "khác",
        disabled: true,
      });
    }
    for (const m of models) {
      const hint = [
        ...(showHeaders || m.provider === undefined ? [] : [m.provider]),
        ...(m.description !== undefined ? [m.description] : []),
      ].join(" — ");
      options.push({
        value: m.id,
        label:
          m.id === recommendedModel
            ? `${m.displayName} (khuyến nghị)`
            : m.displayName,
        ...(hint.length > 0 ? { hint } : {}),
      });
    }
  }
  return options;
};

/**
 * Effort options for one catalog model — the model's declared default effort
 * carries the `(khuyến nghị)` marker and is the picker's initial selection.
 */
const buildEffortOptions = (
  model: DiscoveredModel,
): { value: string; label: string; hint?: string }[] =>
  model.effortChoices.map((e) => ({
    value: e.id,
    label: e.id === model.defaultEffort ? `${e.id} (khuyến nghị)` : e.id,
    ...(e.description !== undefined ? { hint: e.description } : {}),
  }));

// ---------------------------------------------------------------------------
// Discovery-driven model/effort resolution for one agent
// ---------------------------------------------------------------------------

/**
 * Resolve the model and effort for one host-mode agent through live discovery
 * (ADR 0021). Non-interactive runs fail with the report's Vietnamese guidance
 * on any non-ready state — unless `allowUnverified` is set, in which case an
 * explicit `--model` (with optional `--effort`) is accepted and persisted as
 * `manual-unverified`. The same flag downgrades interactive/flag catalog
 * mismatches (unknown model, unsupported effort) to `manual-unverified`
 * instead of a hard error. Interactive runs offer retry / manual-unverified
 * entry / safe stop — plus "pick another agent" when `offerBack` is set —
 * before anything is scaffolded. No cached or bundled list is ever presented
 * as a live result.
 */
export const resolveDiscoveredSelection = (params: {
  readonly adapter: AgentDiscoveryAdapter;
  readonly agentLabel: string;
  /** Registry default used when the agent has no model catalog to pick from. */
  readonly defaultModel: string;
  readonly modelFlag: Option.Option<string>;
  readonly effortFlag: Option.Option<string>;
  readonly isInteractive: boolean;
  readonly allowUnverified: boolean;
  /**
   * A report the caller already fetched (e.g. the host picker's parallel
   * sweep) — used instead of probing again. Recheck retries still probe.
   */
  readonly initialReport?: AgentDiscoveryReport;
  /**
   * Interactive only: add "Chọn agent khác" to the recovery menu and return
   * `{ kind: "back" }` (with the latest report) when the user takes it.
   */
  readonly offerBack?: boolean;
  readonly exec?: DiscoveryExec;
}): Effect.Effect<AgentSelectionOutcome, InitError, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const {
      adapter,
      agentLabel,
      defaultModel,
      modelFlag,
      effortFlag,
      isInteractive,
      allowUnverified,
    } = params;
    const exec = params.exec ?? nodeDiscoveryExec;
    const offerBack = params.offerBack === true;

    const select = (
      model: string,
      effort: string | undefined,
      modelSource: ModelSource,
    ): AgentSelectionOutcome => ({
      kind: "selection",
      selection: {
        model,
        ...(effort !== undefined ? { effort } : {}),
        modelSource,
      },
    });

    let report =
      params.initialReport ??
      (yield* runAgentDiscovery(adapter, agentLabel, exec));

    // Every state except "ready" needs either a flag answer or an
    // interactive choice before init may continue.
    while (report.state !== "ready") {
      const reason =
        report.guidance ??
        report.detail ??
        `Không khám phá được ${agentLabel}.`;
      if (!isInteractive) {
        // Non-interactive parity with the manual-entry choice: the flag pair
        // is accepted only with explicit unverified acceptance, so an
        // automation caller can never mistake it for a verified value.
        if (allowUnverified) {
          const manual = manualFromFlags(modelFlag, effortFlag);
          if (manual.model !== undefined) {
            return select(manual.model, manual.effort, "manual-unverified");
          }
          return yield* Effect.fail(
            new InitError({
              message:
                `${reason}\n` +
                "--allow-unverified cần --model <id> để ghi nhận lựa chọn chưa xác minh.",
            }),
          );
        }
        return yield* Effect.fail(new InitError({ message: reason }));
      }
      yield* d.status(reason, "warn");
      const action = yield* promptRecoveryAction({
        offerRetry: true,
        offerBack,
      });
      if (action === "back") {
        return { kind: "back", report };
      }
      if (action === "retry") {
        report = yield* runAgentDiscovery(adapter, agentLabel, exec);
        continue;
      }
      // "manual" — an explicitly unverified entry (ADR 0021). A passed
      // --model flag counts as the manual entry; otherwise prompt for it.
      const selection = yield* promptManualEntry(
        agentLabel,
        modelFlag,
        effortFlag,
      );
      return { kind: "selection", selection };
    }

    // --- state === "ready": pick from the live catalog ---
    const catalog = report.models;
    yield* d.status(
      `${agentLabel} ${report.version ?? ""} — đã xác minh và đăng nhập`.trim(),
      "success",
    );

    if (catalog.length === 0) {
      // The agent is verified and signed in, but its CLI exposes no model
      // catalog (e.g. Claude Code, Copilot). The model can never be verified
      // against a live list, so selection stays on the static path — the
      // --model flag or the registry default — and is persisted as
      // "manual-unverified" rather than "discovered" (ADR 0021).
      if (report.guidance !== undefined) {
        yield* d.status(report.guidance, "warn");
      }
      const manual = manualFromFlags(modelFlag, effortFlag);
      return select(
        manual.model ?? defaultModel,
        manual.effort,
        "manual-unverified",
      );
    }

    let model: string;
    let modelVerified = true;
    if (modelFlag._tag === "Some" && modelFlag.value.trim().length > 0) {
      const requested = modelFlag.value.trim();
      const found = catalog.some((m) => m.id === requested);
      if (!found) {
        if (!allowUnverified) {
          const names = catalog.map((m) => m.id).join(", ");
          return yield* Effect.fail(
            new InitError({
              message: `Model "${requested}" không có trong catalog của ${agentLabel}. Có sẵn: ${names}`,
            }),
          );
        }
        // Explicit unverified acceptance — the flag model passes through but
        // is honestly marked, and the effort flag is never verified either.
        const manual = manualFromFlags(modelFlag, effortFlag);
        return select(manual.model!, manual.effort, "manual-unverified");
      }
      model = requested;
    } else if (isInteractive) {
      const selected = yield* Effect.promise(() =>
        clack.select({
          message: `Chọn model cho ${agentLabel}:`,
          initialValue: report.recommendedModel,
          options: buildModelOptions(catalog, report.recommendedModel),
        }),
      );
      if (clack.isCancel(selected)) {
        return yield* stopInit();
      }
      model = selected as string;
    } else {
      model = report.recommendedModel ?? catalog[0]!.id;
    }
    const chosenModel = catalog.find((m) => m.id === model)!;

    let effort: string | undefined;
    if (effortFlag._tag === "Some" && effortFlag.value.trim().length > 0) {
      const requested = effortFlag.value.trim();
      const supported = chosenModel.effortChoices.some(
        (e) => e.id === requested,
      );
      if (!supported) {
        if (!allowUnverified) {
          const values = chosenModel.effortChoices.map((e) => e.id).join(", ");
          return yield* Effect.fail(
            new InitError({
              message:
                `Effort "${requested}" không được model "${model}" hỗ trợ.` +
                (values.length > 0 ? ` Có sẵn: ${values}` : ""),
            }),
          );
        }
        // Accepted unverified — the whole selection is marked accordingly so
        // an unchecked effort is never presented as discovered truth.
        modelVerified = false;
      }
      effort = requested;
    } else if (chosenModel.effortChoices.length > 0) {
      if (isInteractive) {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: `Chọn effort cho ${model}:`,
            initialValue: chosenModel.defaultEffort,
            options: buildEffortOptions(chosenModel),
          }),
        );
        if (clack.isCancel(selected)) {
          return yield* stopInit();
        }
        effort = selected as string;
      } else {
        effort = chosenModel.defaultEffort;
      }
    }

    return select(
      model,
      effort,
      modelVerified ? "discovered" : "manual-unverified",
    );
  });

// ---------------------------------------------------------------------------
// The host-mode agent picker (ready-first, secondary list for the rest)
// ---------------------------------------------------------------------------

/** One registry agent joined with its discovery report and adapter. */
interface AgentRow {
  readonly entry: AgentEntry;
  readonly report: AgentDiscoveryReport | undefined;
  readonly adapter: AgentDiscoveryAdapter | undefined;
}

/** Short Vietnamese state label for the unavailable-agent list. */
const unavailableHint = (report: AgentDiscoveryReport | undefined): string => {
  if (report === undefined) return "không hỗ trợ khám phá";
  switch (report.state) {
    case "not-installed":
      return "chưa cài đặt";
    case "unauthenticated":
      return "chưa đăng nhập";
    case "wrong-product":
      return "sai chương trình";
    case "error":
      return "lỗi khám phá";
    default:
      return "chưa sẵn sàng";
  }
};

/** Ready-agent hint: installed version + live catalog size. */
const readyHint = (report: AgentDiscoveryReport): string =>
  [
    report.version,
    report.models.length > 0 ? `${report.models.length} model` : "đã xác minh",
  ]
    .filter((s): s is string => s !== undefined)
    .join(" · ");

/**
 * The secondary "other agents" list: every agent whose report isn't `ready`,
 * labelled with its state. `offerBack` appends a return-to-ready-list entry —
 * meaningless (and omitted) when the unavailable list is the only screen.
 */
const pickUnavailableAgent = (
  rows: readonly AgentRow[],
  offerBack: boolean,
): Effect.Effect<AgentRow | "back", InitError> =>
  Effect.gen(function* () {
    const options: { value: string; label: string; hint?: string }[] = rows.map(
      (r) => ({
        value: r.entry.name,
        label: r.entry.label,
        hint: unavailableHint(r.report),
      }),
    );
    if (offerBack) {
      options.push({ value: BACK_VALUE, label: "← Quay lại" });
    }
    const picked = yield* Effect.promise(() =>
      clack.select({
        message: "Agent chưa sẵn sàng — chọn để xem hướng dẫn:",
        options,
      }),
    );
    if (clack.isCancel(picked)) {
      return yield* stopInit();
    }
    if (picked === BACK_VALUE) return "back";
    return rows.find((r) => r.entry.name === picked)!;
  });

/**
 * The interactive host-mode agent picker (ADR 0021).
 *
 * Probes every registered adapter in one parallel pass, then lists verified
 * ready agents first — each hint shows the installed version and model count.
 * Unavailable agents sit behind an "Agent khác" secondary choice that renders
 * their state; picking one shows its actionable guidance and offers recheck,
 * manual-unverified entry, back, or a safe stop. Agents without a discovery
 * adapter stay selectable through the secondary list as manual entries.
 */
export const pickHostAgent = (params: {
  readonly agents: readonly AgentEntry[];
  readonly modelFlag: Option.Option<string>;
  readonly effortFlag: Option.Option<string>;
  readonly allowUnverified: boolean;
  readonly exec?: DiscoveryExec;
}): Effect.Effect<HostAgentChoice, InitError, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const exec = params.exec ?? nodeDiscoveryExec;
    const reports = new Map<string, AgentDiscoveryReport>();
    for (const report of yield* runAllAgentDiscovery(exec)) {
      reports.set(report.agent, report);
    }

    // The picker loops: "Chọn agent khác" in a recovery menu and the "Quay
    // lại" entry in the secondary list both re-render here, with rechecks
    // updating the report map in place.
    for (;;) {
      const rows: AgentRow[] = params.agents.map((entry) => ({
        entry,
        report: reports.get(entry.name),
        adapter: getDiscoveryAdapter(entry.name),
      }));
      const ready = rows.filter((r) => r.report?.state === "ready");
      const unavailable = rows.filter((r) => r.report?.state !== "ready");

      let chosen: AgentRow;
      if (ready.length > 0) {
        const options: { value: string; label: string; hint?: string }[] =
          ready.map((r) => ({
            value: r.entry.name,
            label: r.entry.label,
            hint: readyHint(r.report!),
          }));
        if (unavailable.length > 0) {
          options.push({
            value: OTHER_AGENTS_VALUE,
            label: "Agent khác (chưa sẵn sàng)…",
            hint: `${unavailable.length} agent cần cài đặt, đăng nhập, hoặc kiểm tra lại`,
          });
        }
        const picked = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn agent chạy trên máy này:",
            initialValue: ready[0]!.entry.name,
            options,
          }),
        );
        if (clack.isCancel(picked)) {
          return yield* stopInit();
        }
        if (picked === OTHER_AGENTS_VALUE) {
          const sub = yield* pickUnavailableAgent(unavailable, true);
          if (sub === "back") continue;
          chosen = sub;
        } else {
          chosen = ready.find((r) => r.entry.name === picked)!;
        }
      } else {
        yield* d.status(
          "Không tìm thấy agent nào sẵn sàng trên máy này.",
          "warn",
        );
        const sub = yield* pickUnavailableAgent(unavailable, false);
        if (sub === "back") continue; // unreachable — no back entry rendered
        chosen = sub;
      }

      if (chosen.adapter === undefined) {
        // No discovery adapter — the agent stays statically selectable, but
        // nothing can be probed so the only honest entry is a manual one.
        yield* d.status(
          `${chosen.entry.label} chưa hỗ trợ khám phá tự động — model nhập tay sẽ được đánh dấu chưa xác minh.`,
          "warn",
        );
        const action = yield* promptRecoveryAction({
          offerRetry: false,
          offerBack: true,
        });
        if (action === "back") continue;
        // "manual" is the only remaining action ("stop"/cancel already
        // raised inside the menu).
        const selection = yield* promptManualEntry(
          chosen.entry.label,
          params.modelFlag,
          params.effortFlag,
        );
        return { agent: chosen.entry, selection };
      }

      const outcome = yield* resolveDiscoveredSelection({
        adapter: chosen.adapter,
        agentLabel: chosen.entry.label,
        defaultModel: chosen.entry.defaultModel,
        modelFlag: params.modelFlag,
        effortFlag: params.effortFlag,
        isInteractive: true,
        allowUnverified: params.allowUnverified,
        ...(chosen.report !== undefined
          ? { initialReport: chosen.report }
          : {}),
        offerBack: true,
        exec,
      });
      if (outcome.kind === "back") {
        reports.set(chosen.entry.name, outcome.report);
        continue;
      }
      return { agent: chosen.entry, selection: outcome.selection };
    }
  });

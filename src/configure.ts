import * as clack from "@clack/prompts";
import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";

import { Display } from "./Display.js";
import { InitError } from "./errors.js";
import { getAgent, listAgents } from "./InitService.js";
import { getDiscoveryAdapter } from "./discovery/registry.js";
import {
  INIT_STOPPED_MESSAGE,
  pickHostAgent,
  resolveDiscoveredSelection,
  type HostAgentChoice,
} from "./discoveryPicker.js";
import {
  MAX_PARALLELISM,
  MIN_PARALLELISM,
  WORKFLOW_ROLES,
  loadProjectSettings,
  updateProjectSettings,
  type ProjectSettings,
  type ProjectSettingsUpdate,
  type RoleOverride,
  type RoleOverrideUpdate,
  type WorkflowRole,
} from "./ProjectSettings.js";

/**
 * `sandcastle configure` (ADR 0025/0026) — loads `.sandcastle/settings.json`,
 * shows the current values, and applies changes through
 * `updateProjectSettings` only. Generated prompts, workflow code, and
 * `package.json` are never touched: settings.json is the single write target,
 * so customized scaffolds stay byte-for-byte intact. A cancelled or failed
 * run leaves the prior settings in place — the write happens once, after all
 * choices resolve.
 *
 * Shared agent/model/effort changes reuse init's live-discovery seam
 * (`pickHostAgent` / `resolveDiscoveredSelection`) whenever the project's
 * sandbox is `host`; container projects keep the static picker because
 * probing host CLIs says nothing about what the image installs. Per-role
 * overrides (planner/implementer/reviewer/merger) are optional partials —
 * removing one restores inheritance from the shared defaults.
 *
 * Interactive prompts and statuses are Vietnamese (ADR 0026); flag names,
 * identifiers, and flag-validation errors stay English.
 */

/** Safe-stop message — raised before settings.json is written. */
export const CONFIGURE_STOPPED_MESSAGE =
  "Đã dừng cấu hình — không có thay đổi nào được lưu.";

const stopConfigure = (): Effect.Effect<never, InitError> =>
  Effect.fail(new InitError({ message: CONFIGURE_STOPPED_MESSAGE }));

/** Flag/usage failures — English, matching init's flag-validation errors. */
const failConfigure = (message: string): Effect.Effect<never, InitError> =>
  Effect.fail(new InitError({ message }));

/** Fields a `--set-role role.field=value` entry may write. */
const ROLE_SET_FIELDS = ["agent", "model", "effort"] as const;
type RoleSetField = (typeof ROLE_SET_FIELDS)[number];

/** Sentinel picker values — can never collide with workflow role names. */
const ROLE_BACK_VALUE = "__back__";

/**
 * Mutable view of {@link ProjectSettingsUpdate} while the patch is being
 * assembled section by section.
 */
type MutableUpdate = {
  -readonly [K in keyof ProjectSettingsUpdate]: ProjectSettingsUpdate[K];
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** One-line rendering of a role override: `agent=codex model=gpt-5.4`, or `kế thừa` when unset. */
const describeOverride = (override: RoleOverride | undefined): string => {
  if (override === undefined) return "kế thừa";
  const parts = ROLE_SET_FIELDS.filter(
    (key) => override[key] !== undefined,
  ).map((key) => `${key}=${override[key]}`);
  return parts.length > 0 ? parts.join(" ") : "kế thừa";
};

/** Rows for the `d.summary` view of a settings document. */
const settingsSummaryRows = (
  settings: ProjectSettings,
): Record<string, string> => {
  const rows: Record<string, string> = {
    agent: settings.agent,
    model: settings.model,
    effort: settings.effort ?? "—",
    agentExecutable: settings.agentExecutable ?? "—",
    modelSource: settings.modelSource,
    workflow: settings.workflow,
    sandbox: settings.sandbox,
    issueTracker: settings.issueTracker,
    parallelism: String(settings.parallelism),
    verificationCommands:
      settings.verificationCommands.length > 0
        ? settings.verificationCommands.join(", ")
        : "—",
    verificationStatus: settings.verificationStatus ?? "—",
  };
  for (const role of WORKFLOW_ROLES) {
    rows[`roleOverrides.${role}`] = describeOverride(
      settings.roleOverrides?.[role],
    );
  }
  return rows;
};

/**
 * The role override that results from the pending patch applied over the
 * loaded settings — what the picker should show as the role's current state.
 */
const effectiveOverride = (
  current: ProjectSettings,
  update: MutableUpdate,
  role: WorkflowRole,
): RoleOverride | undefined => {
  const patch = update.roleOverrides?.[role];
  if (patch === null) return undefined;
  const merged: { agent?: string; model?: string; effort?: string } = {
    ...(current.roleOverrides?.[role] ?? {}),
  };
  if (patch !== undefined) {
    for (const key of ROLE_SET_FIELDS) {
      const value = patch[key];
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * Discovery-flow cancellations surface init's stop message; inside configure
 * the same safe stop must read as a cancelled *configuration* — nothing is
 * written either way.
 */
const translateStopMessage = <A, R>(
  effect: Effect.Effect<A, InitError, R>,
): Effect.Effect<A, InitError, R> =>
  Effect.catchIf(
    effect,
    (e) => e.message === INIT_STOPPED_MESSAGE,
    () => stopConfigure(),
  );

// ---------------------------------------------------------------------------
// Flag parsing helpers
// ---------------------------------------------------------------------------

const nonEmptyFlag = (opt: Option.Option<string>): boolean =>
  opt._tag === "Some" && opt.value.trim().length > 0;

const parseCommandList = (raw: string): string[] =>
  raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

/**
 * Parse one `--set-role role.field=value` entry. Field `agent` is validated
 * against the agent registry; model/effort values are accepted as explicit
 * entries (the scriptable path does not re-probe agent CLIs).
 */
const parseSetRoleEntry = (
  raw: string,
): Effect.Effect<
  { role: WorkflowRole; field: RoleSetField; value: string },
  InitError
> =>
  Effect.gen(function* () {
    const match = /^([^.=]+)\.([^.=]+)=(.*)$/.exec(raw.trim());
    if (match === null) {
      return yield* failConfigure(
        `--set-role expects entries like "planner.model=gpt-5.4" ` +
          `(role: ${WORKFLOW_ROLES.join("|")}; field: ${ROLE_SET_FIELDS.join("|")}). ` +
          `Got: "${raw}".`,
      );
    }
    const [, roleRaw, fieldRaw, valueRaw] = match;
    const role = roleRaw!.trim();
    if (!WORKFLOW_ROLES.includes(role as WorkflowRole)) {
      return yield* failConfigure(
        `--set-role: unknown role "${role}". ` +
          `Available: ${WORKFLOW_ROLES.join(", ")}.`,
      );
    }
    const field = fieldRaw!.trim();
    if (!ROLE_SET_FIELDS.includes(field as RoleSetField)) {
      return yield* failConfigure(
        `--set-role: unknown field "${field}" for role "${role}". ` +
          `Available: ${ROLE_SET_FIELDS.join(", ")}.`,
      );
    }
    const value = valueRaw!.trim();
    if (value.length === 0) {
      return yield* failConfigure(
        `--set-role: empty value for "${role}.${field}".`,
      );
    }
    if (field === "agent" && getAgent(value) === undefined) {
      const names = listAgents()
        .map((a) => a.name)
        .join(", ");
      return yield* failConfigure(
        `--set-role: unknown agent "${value}" for role "${role}". ` +
          `Available: ${names}.`,
      );
    }
    return { role: role as WorkflowRole, field: field as RoleSetField, value };
  });

// ---------------------------------------------------------------------------
// Shared agent/model/effort resolution (flag mode)
// ---------------------------------------------------------------------------

/**
 * Resolve the shared agent/model/effort change from flags (ADR 0021 seam).
 *
 * With a `host` sandbox and a discoverable agent this runs the same live
 * discovery as init — a changed agent re-discovers its catalog; an unchanged
 * agent re-validates the current model/effort (or the flag values) against
 * it. Container sandboxes keep the static path: `--model`/`--effort` are
 * applied as explicit `manual-unverified` entries and a changed agent falls
 * back to its registry default model.
 */
const resolveSharedFlagUpdate = (params: {
  readonly current: ProjectSettings;
  readonly agentFlag: Option.Option<string>;
  readonly modelFlag: Option.Option<string>;
  readonly effortFlag: Option.Option<string>;
  readonly clearEffort: boolean;
  readonly allowUnverified: boolean;
  readonly isInteractive: boolean;
}): Effect.Effect<
  Pick<
    MutableUpdate,
    "agent" | "model" | "effort" | "agentExecutable" | "modelSource"
  >,
  InitError,
  Display
> =>
  Effect.gen(function* () {
    const {
      current,
      agentFlag,
      modelFlag,
      effortFlag,
      clearEffort,
      allowUnverified,
      isInteractive,
    } = params;

    const targetName =
      agentFlag._tag === "Some" ? agentFlag.value.trim() : current.agent;
    const agentChanged = targetName !== current.agent;
    const entry = getAgent(targetName);

    // --clear-effort alone is a pure removal — no resolution needed.
    if (
      agentFlag._tag !== "Some" &&
      modelFlag._tag !== "Some" &&
      effortFlag._tag !== "Some" &&
      clearEffort
    ) {
      return { effort: null };
    }

    const adapter =
      current.sandbox === "host" && entry !== undefined
        ? getDiscoveryAdapter(targetName)
        : undefined;

    if (adapter !== undefined && entry !== undefined) {
      // Live discovery — the same seam init uses. When the agent is
      // unchanged, absent model/effort flags fall back to the persisted
      // values so they are re-validated against the live catalog rather
      // than silently replaced by the catalog's recommendation.
      const resolvedModelFlag =
        modelFlag._tag === "Some"
          ? modelFlag
          : agentChanged
            ? Option.none()
            : Option.some(current.model);
      // F037 parity with the static path below: when `--model` moves the
      // model, an absent `--effort` must NOT replay the persisted effort as
      // an explicit flag — it was verified against the OLD model, so it
      // would either silently survive on an incompatible model or
      // hard-error naming a flag the user never passed.
      const modelChanged =
        modelFlag._tag === "Some" &&
        modelFlag.value.trim() !== current.model;
      const resolvedEffortFlag =
        effortFlag._tag === "Some"
          ? effortFlag
          : clearEffort ||
              agentChanged ||
              modelChanged ||
              current.effort === undefined
            ? Option.none()
            : Option.some(current.effort);
      const outcome = yield* resolveDiscoveredSelection({
        adapter,
        agentLabel: entry.label,
        defaultModel: agentChanged ? entry.defaultModel : current.model,
        modelFlag: resolvedModelFlag,
        effortFlag: resolvedEffortFlag,
        isInteractive,
        allowUnverified,
        offerBack: isInteractive && agentChanged,
      }).pipe(translateStopMessage);
      if (outcome.kind === "back") {
        // Interactive escape: "pick another agent" — fall into the full
        // ready-first picker exactly like init does, still pre-selecting the
        // current effective values.
        const picked = yield* pickHostAgent({
          agents: listAgents(),
          modelFlag,
          effortFlag,
          allowUnverified,
          initialAgentName: current.agent,
          initialModel: current.model,
          initialEffort: current.effort,
        }).pipe(translateStopMessage);
        const exe = executableUpdate(
          picked.agent.name,
          picked.selection,
          current,
        );
        return {
          agent: picked.agent.name,
          model: picked.selection.model,
          effort: clearEffort ? null : (picked.selection.effort ?? null),
          modelSource: picked.selection.modelSource,
          ...(exe !== undefined ? { agentExecutable: exe } : {}),
        };
      }
      const exe = executableUpdate(targetName, outcome.selection, current);
      return {
        agent: targetName,
        model: outcome.selection.model,
        effort: clearEffort ? null : (outcome.selection.effort ?? null),
        modelSource: outcome.selection.modelSource,
        ...(exe !== undefined ? { agentExecutable: exe } : {}),
      };
    }

    // Static path — container projects never probe the host, and a changed
    // agent drops the previous model/effort for the registry default. A
    // changed model also drops the inherited effort (F037): it was verified
    // — or never verified — against the old model, so only an explicit
    // --effort survives the switch.
    const model =
      modelFlag._tag === "Some"
        ? modelFlag.value.trim()
        : agentChanged
          ? (entry?.defaultModel ?? current.model)
          : current.model;
    const modelChanged = model !== current.model;
    const effort = clearEffort
      ? null
      : effortFlag._tag === "Some"
        ? effortFlag.value.trim()
        : agentChanged || modelChanged
          ? null
          : undefined; // unchanged
    return {
      agent: targetName,
      model,
      ...(effort !== undefined ? { effort } : {}),
      // The persisted executable alias names the previous agent's binary —
      // it must not follow an agent switch.
      ...(agentChanged ? { agentExecutable: null } : {}),
      modelSource: "manual-unverified" as const,
    };
  });

// ---------------------------------------------------------------------------
// Flag mode — build the whole update from CLI flags
// ---------------------------------------------------------------------------

const buildFlagUpdate = (params: {
  readonly current: ProjectSettings;
  readonly agentFlag: Option.Option<string>;
  readonly modelFlag: Option.Option<string>;
  readonly effortFlag: Option.Option<string>;
  readonly clearEffort: boolean;
  readonly allowUnverified: boolean;
  readonly isInteractive: boolean;
  readonly verificationCommandsFlag: Option.Option<string>;
  readonly skipVerification: boolean;
  readonly parallelismFlag: Option.Option<number>;
  readonly setRoleFlags: readonly string[];
  readonly clearRoleFlags: readonly WorkflowRole[];
}): Effect.Effect<MutableUpdate, InitError, Display> =>
  Effect.gen(function* () {
    const update: MutableUpdate = {};
    const { current } = params;

    const sharedRequested =
      params.agentFlag._tag === "Some" ||
      params.modelFlag._tag === "Some" ||
      params.effortFlag._tag === "Some" ||
      params.clearEffort;
    if (sharedRequested) {
      Object.assign(
        update,
        yield* resolveSharedFlagUpdate({
          current,
          agentFlag: params.agentFlag,
          modelFlag: params.modelFlag,
          effortFlag: params.effortFlag,
          clearEffort: params.clearEffort,
          allowUnverified: params.allowUnverified,
          isInteractive: params.isInteractive,
        }),
      );
    }

    // Verification commands replace wholesale; writing a new list clears a
    // stale status back to "configured, not yet run" while --skip-verification
    // records an explicit "skipped" (init parity, ADR 0024).
    if (params.verificationCommandsFlag._tag === "Some") {
      const commands = parseCommandList(params.verificationCommandsFlag.value);
      if (commands.length === 0) {
        return yield* failConfigure(
          "--verification-commands must list at least one command (or pass --skip-verification).",
        );
      }
      update.verificationCommands = commands;
      update.verificationStatus = null;
    }
    if (params.skipVerification) {
      update.verificationCommands = [];
      update.verificationStatus = "skipped";
    }

    if (params.parallelismFlag._tag === "Some") {
      update.parallelism = params.parallelismFlag.value;
    }

    // Role overrides: each --set-role entry merges one field into the role's
    // override; --clear-role removes the whole override (inheritance restored).
    const rolePatch: Partial<Record<WorkflowRole, RoleOverrideUpdate | null>> =
      {};
    for (const raw of params.setRoleFlags) {
      const entry = yield* parseSetRoleEntry(raw);
      rolePatch[entry.role] = {
        ...(rolePatch[entry.role] ?? {}),
        [entry.field]: entry.value,
      };
    }
    for (const role of params.clearRoleFlags) {
      rolePatch[role] = null;
    }
    if (Object.keys(rolePatch).length > 0) {
      update.roleOverrides = rolePatch;
    }

    return update;
  });

// ---------------------------------------------------------------------------
// Interactive mode — section prompts
// ---------------------------------------------------------------------------

/**
 * The static (non-host) agent picker for configure: registry select, then
 * manual model/effort text entries — always `manual-unverified`, matching
 * init's container path where no live catalog exists.
 */
const pickStaticAgent = (params: {
  readonly initialAgentName?: string;
  readonly initialModel?: string;
  readonly initialEffort?: string;
}): Effect.Effect<HostAgentChoice, InitError> =>
  Effect.gen(function* () {
    const agents = listAgents();
    const selected = yield* Effect.promise(() =>
      clack.select({
        message: "Chọn agent:",
        ...(params.initialAgentName !== undefined
          ? { initialValue: params.initialAgentName }
          : {}),
        options: agents.map((a) => ({
          value: a.name,
          label: a.label,
          hint: `Default model: ${a.defaultModel}`,
        })),
      }),
    );
    if (clack.isCancel(selected)) {
      return yield* stopConfigure();
    }
    const entry = getAgent(selected as string)!;
    const sameAgent = entry.name === params.initialAgentName;

    const modelEntered = yield* Effect.promise(() =>
      clack.text({
        message: `Nhập model cho ${entry.label}:`,
        initialValue: sameAgent ? params.initialModel : entry.defaultModel,
        validate: (value) =>
          value === undefined || value.trim().length === 0
            ? "Model không được để trống."
            : undefined,
      }),
    );
    if (clack.isCancel(modelEntered)) {
      return yield* stopConfigure();
    }
    // F037: the persisted effort only pre-fills while the model is unchanged —
    // once the model moves, an inherited effort is at best unverified, so the
    // prompt starts empty and only a freshly typed value is kept.
    const sameModel = sameAgent && modelEntered.trim() === params.initialModel;
    const effortEntered = yield* Effect.promise(() =>
      clack.text({
        message: `Nhập effort cho ${modelEntered.trim()} (để trống nếu không dùng):`,
        ...(sameModel && params.initialEffort !== undefined
          ? { initialValue: params.initialEffort }
          : {}),
      }),
    );
    if (clack.isCancel(effortEntered)) {
      return yield* stopConfigure();
    }
    const effort = effortEntered.trim();
    return {
      agent: entry,
      selection: {
        model: modelEntered.trim(),
        ...(effort.length > 0 ? { effort } : {}),
        modelSource: "manual-unverified" as const,
      },
    };
  });

/**
 * Pick an agent+model+effort triple the same way the shared setting would be:
 * the live-discovery host picker on `host` sandboxes, the static picker
 * otherwise. Used by both the shared section and per-role customization.
 */
const pickAgentSelection = (params: {
  readonly current: ProjectSettings;
  readonly allowUnverified: boolean;
  readonly initialAgentName?: string;
  readonly initialModel?: string;
  readonly initialEffort?: string;
}): Effect.Effect<HostAgentChoice, InitError, Display> =>
  params.current.sandbox === "host"
    ? pickHostAgent({
        agents: listAgents(),
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        allowUnverified: params.allowUnverified,
        // Forward the current effective values — the pickers pre-select them
        // instead of the first ready agent / catalog recommendation (F015).
        initialAgentName: params.initialAgentName,
        initialModel: params.initialModel,
        initialEffort: params.initialEffort,
      }).pipe(translateStopMessage)
    : pickStaticAgent({
        initialAgentName: params.initialAgentName,
        initialModel: params.initialModel,
        initialEffort: params.initialEffort,
      });

/**
 * What a re-resolved selection means for the persisted `agentExecutable`
 * alias: a freshly probed executable replaces it; a switch to a different
 * agent clears it (the alias names the old agent's binary); an unchanged
 * agent without a probed executable leaves the stored value alone.
 */
const executableUpdate = (
  selectedAgentName: string,
  selection: { readonly executable?: string },
  current: ProjectSettings,
): string | null | undefined =>
  selection.executable !== undefined
    ? selection.executable
    : selectedAgentName !== current.agent
      ? null
      : undefined;

type ConfigureSection =
  | "shared"
  | "verification"
  | "parallelism"
  | "roles"
  | "save"
  | "cancel";

const sharedSection = (params: {
  readonly current: ProjectSettings;
  readonly update: MutableUpdate;
  readonly allowUnverified: boolean;
}): Effect.Effect<void, InitError, Display> =>
  Effect.gen(function* () {
    const { current, update } = params;
    const effectiveEffort =
      update.effort === null ? undefined : (update.effort ?? current.effort);
    const picked = yield* pickAgentSelection({
      current,
      allowUnverified: params.allowUnverified,
      initialAgentName: update.agent ?? current.agent,
      initialModel: update.model ?? current.model,
      initialEffort: effectiveEffort,
    });
    update.agent = picked.agent.name;
    update.model = picked.selection.model;
    update.effort = picked.selection.effort ?? null;
    update.modelSource = picked.selection.modelSource;
    const exe = executableUpdate(picked.agent.name, picked.selection, current);
    if (exe !== undefined) update.agentExecutable = exe;
  });

const verificationSection = (params: {
  readonly current: ProjectSettings;
  readonly update: MutableUpdate;
}): Effect.Effect<void, InitError, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const { current, update } = params;
    const effective =
      update.verificationCommands ?? current.verificationCommands;
    yield* d.text(
      "Lệnh xác minh hiện tại:\n" +
        (effective.length > 0
          ? effective.map((c) => `  • ${c}`).join("\n")
          : "  (không có)"),
    );
    const action = yield* Effect.promise(() =>
      clack.select<"keep" | "edit" | "clear">({
        message: "Thiết lập lệnh xác minh:",
        options: [
          { value: "keep", label: "Giữ nguyên" },
          { value: "edit", label: "Chỉnh sửa danh sách" },
          { value: "clear", label: "Không dùng lệnh xác minh" },
        ],
      }),
    );
    if (clack.isCancel(action)) {
      return yield* stopConfigure();
    }
    if (action === "edit") {
      const entered = yield* Effect.promise(() =>
        clack.text({
          message:
            "Nhập các lệnh xác minh, cách nhau bởi dấu phẩy (để trống = không dùng):",
          initialValue: effective.join(", "),
        }),
      );
      if (clack.isCancel(entered)) {
        return yield* stopConfigure();
      }
      const commands = parseCommandList(entered);
      update.verificationCommands = commands;
      // A fresh list clears any stale status back to "configured, not yet
      // run"; an empty edit is an explicit skip (init parity, ADR 0024).
      update.verificationStatus = commands.length > 0 ? null : "skipped";
      if (commands.length === 0) {
        yield* d.status(
          'Đã tắt lệnh xác minh — settings ghi nhận trạng thái "skipped", không bao giờ báo cáo là đã pass.',
          "warn",
        );
      }
    } else if (action === "clear") {
      update.verificationCommands = [];
      update.verificationStatus = "skipped";
      yield* d.status(
        'Đã tắt lệnh xác minh — settings ghi nhận trạng thái "skipped", không bao giờ báo cáo là đã pass.',
        "warn",
      );
    }
    // "keep" — leave the pending update untouched.
  });

const parallelismSection = (params: {
  readonly current: ProjectSettings;
  readonly update: MutableUpdate;
}): Effect.Effect<void, InitError> =>
  Effect.gen(function* () {
    const { current, update } = params;
    const picked = yield* Effect.promise(() =>
      clack.select<number>({
        message: `Chọn giới hạn song song — số issue chạy cùng lúc (${MIN_PARALLELISM}–${MAX_PARALLELISM}):`,
        initialValue: update.parallelism ?? current.parallelism,
        options: [
          { value: 1, label: "1 — tuần tự" },
          { value: 2, label: "2" },
          { value: 3, label: "3" },
          { value: 4, label: "4 — tối đa" },
        ],
      }),
    );
    if (clack.isCancel(picked)) {
      return yield* stopConfigure();
    }
    update.parallelism = picked;
  });

type RoleAction = "customize" | "inherit" | "back";

const rolesSection = (params: {
  readonly current: ProjectSettings;
  readonly update: MutableUpdate;
  readonly allowUnverified: boolean;
}): Effect.Effect<void, InitError, Display> =>
  Effect.gen(function* () {
    const { current, update } = params;
    for (;;) {
      const rolePicked = yield* Effect.promise(() =>
        clack.select<string>({
          message:
            "Chọn vai trò để cấu hình (không ghi đè = kế thừa cấu hình chung):",
          options: [
            ...WORKFLOW_ROLES.map((role) => ({
              value: role as string,
              label: role,
              hint: describeOverride(effectiveOverride(current, update, role)),
            })),
            { value: ROLE_BACK_VALUE, label: "← Quay lại" },
          ],
        }),
      );
      if (clack.isCancel(rolePicked)) {
        return yield* stopConfigure();
      }
      if (rolePicked === ROLE_BACK_VALUE) return;
      const role = rolePicked as WorkflowRole;
      const existing = effectiveOverride(current, update, role);

      const action = yield* Effect.promise(() =>
        clack.select<RoleAction>({
          message: `Vai trò "${role}": ${describeOverride(existing)}`,
          options: [
            {
              value: "customize",
              label: "Đặt agent/model/effort riêng cho vai trò này",
            },
            ...(existing !== undefined
              ? [
                  {
                    value: "inherit" as const,
                    label: "Xóa ghi đè — kế thừa cấu hình chung",
                  },
                ]
              : []),
            { value: "back", label: "← Quay lại" },
          ],
        }),
      );
      if (clack.isCancel(action)) {
        return yield* stopConfigure();
      }
      if (action === "back") continue;
      if (action === "inherit") {
        update.roleOverrides = { ...update.roleOverrides, [role]: null };
        continue;
      }
      // "customize" — resolve agent/model/effort exactly like the shared
      // section; the override stores all three keys (effort cleared when the
      // selection carries none) so the role no longer tracks the shared side.
      const sharedEffort =
        update.effort === null ? undefined : (update.effort ?? current.effort);
      const picked = yield* pickAgentSelection({
        current,
        allowUnverified: params.allowUnverified,
        initialAgentName: existing?.agent ?? update.agent ?? current.agent,
        initialModel: existing?.model ?? update.model ?? current.model,
        initialEffort: existing?.effort ?? sharedEffort,
      });
      const patch: RoleOverrideUpdate = {
        agent: picked.agent.name,
        model: picked.selection.model,
        effort: picked.selection.effort ?? null,
      };
      update.roleOverrides = { ...update.roleOverrides, [role]: patch };
    }
  });

// ---------------------------------------------------------------------------
// Write — the single place settings.json is touched
// ---------------------------------------------------------------------------

const persistUpdate = (
  repoDir: string,
  update: MutableUpdate,
): Effect.Effect<void, InitError, FileSystem.FileSystem | Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    if (Object.keys(update).length === 0) {
      yield* d.status("Không có thay đổi nào — cấu hình giữ nguyên.", "info");
      return;
    }
    const next = yield* updateProjectSettings(repoDir, update).pipe(
      Effect.mapError((e) => new InitError({ message: e.message })),
    );
    yield* d.status(
      "Đã lưu cấu hình vào .sandcastle/settings.json — prompt, workflow và package.json giữ nguyên.",
      "success",
    );
    yield* d.summary("Cấu hình sau khi lưu", settingsSummaryRows(next));
  });

const interactiveConfigure = (params: {
  readonly cwd: string;
  readonly current: ProjectSettings;
  readonly allowUnverified: boolean;
}): Effect.Effect<void, InitError, FileSystem.FileSystem | Display> =>
  Effect.gen(function* () {
    const { current } = params;
    const update: MutableUpdate = {};

    for (;;) {
      // Hints reflect the pending update so the menu shows what a save would
      // write, not just the on-disk values.
      const effectiveEffort =
        update.effort === null ? undefined : (update.effort ?? current.effort);
      const effectiveVerification =
        update.verificationCommands ?? current.verificationCommands;
      const overrideCount = WORKFLOW_ROLES.filter(
        (role) => effectiveOverride(current, update, role) !== undefined,
      ).length;

      const action = yield* Effect.promise(() =>
        clack.select<ConfigureSection>({
          message: "Chọn mục cần thay đổi:",
          options: [
            {
              value: "shared",
              label: "Agent / model / effort dùng chung",
              hint: `${update.agent ?? current.agent} · ${update.model ?? current.model}${effectiveEffort !== undefined ? ` · ${effectiveEffort}` : ""}`,
            },
            {
              value: "verification",
              label: "Lệnh xác minh",
              hint:
                effectiveVerification.length > 0
                  ? `${effectiveVerification.length} lệnh`
                  : "không có",
            },
            {
              value: "parallelism",
              label: `Giới hạn song song (${MIN_PARALLELISM}–${MAX_PARALLELISM})`,
              hint: `hiện tại: ${update.parallelism ?? current.parallelism}`,
            },
            {
              value: "roles",
              label: "Ghi đè theo vai trò",
              hint:
                overrideCount > 0
                  ? `${overrideCount} vai trò đang ghi đè`
                  : "tất cả kế thừa",
            },
            { value: "save", label: "Lưu thay đổi vào settings.json" },
            { value: "cancel", label: "Hủy — không lưu" },
          ],
        }),
      );
      if (clack.isCancel(action)) {
        return yield* stopConfigure();
      }
      switch (action) {
        case "shared":
          yield* sharedSection({
            current,
            update,
            allowUnverified: params.allowUnverified,
          });
          break;
        case "verification":
          yield* verificationSection({ current, update });
          break;
        case "parallelism":
          yield* parallelismSection({ current, update });
          break;
        case "roles":
          yield* rolesSection({
            current,
            update,
            allowUnverified: params.allowUnverified,
          });
          break;
        case "save":
          return yield* persistUpdate(params.cwd, update);
        case "cancel":
          return yield* stopConfigure();
      }
    }
  });

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const configureAgentOption = Options.text("agent").pipe(
  Options.withDescription(
    "Change the shared agent (e.g. claude-code). On a host sandbox its live discovery re-resolves model and effort",
  ),
  Options.optional,
);

const configureModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Change the shared model (e.g. claude-sonnet-4-6). On a host sandbox it is validated against the agent's live catalog",
  ),
  Options.optional,
);

const configureEffortOption = Options.text("effort").pipe(
  Options.withDescription(
    "Change the shared reasoning effort (e.g. low, medium, high)",
  ),
  Options.optional,
);

const clearEffortOption = Options.boolean("clear-effort").pipe(
  Options.withDescription(
    "Remove the configured shared effort (cannot be combined with --effort)",
  ),
);

const allowUnverifiedOption = Options.boolean("allow-unverified").pipe(
  Options.withDescription(
    "Host sandbox: accept --model/--effort without live-catalog verification (marked unverified). Without it, discovery failures exit non-zero",
  ),
);

const verificationCommandsOption = Options.text("verification-commands").pipe(
  Options.withDescription(
    'Replace the ordered verification commands (comma-separated, e.g. "npm run typecheck,npm test"); clears verificationStatus',
  ),
  Options.optional,
);

const skipVerificationOption = Options.boolean("skip-verification").pipe(
  Options.withDescription(
    'Clear the verification commands and record verificationStatus "skipped"',
  ),
);

const parallelismOption = Options.integer("parallelism").pipe(
  Options.withDescription(
    `Bounded parallelism for parallel workflows (integer ${MIN_PARALLELISM}-${MAX_PARALLELISM})`,
  ),
  Options.optional,
);

const setRoleOption = Options.text("set-role").pipe(
  Options.withDescription(
    `Per-role override entry "role.field=value" (role: ${WORKFLOW_ROLES.join("|")}; field: ${ROLE_SET_FIELDS.join("|")}). Repeatable`,
  ),
  Options.repeated,
);

const clearRoleOption = Options.choice("clear-role", [
  "planner",
  "implementer",
  "reviewer",
  "merger",
]).pipe(
  Options.withDescription(
    "Remove a role's override so it inherits the shared defaults. Repeatable",
  ),
  Options.repeated,
);

/**
 * `sandcastle configure` — see the module docstring. Flag mode applies every
 * given flag in one write; with no change flags an interactive TTY gets the
 * section menu, and a non-TTY run just prints the current settings. Prompts
 * are only ever opened when stdin is a TTY.
 */
export const configureCommand = Command.make(
  "configure",
  {
    agent: configureAgentOption,
    model: configureModelOption,
    effort: configureEffortOption,
    clearEffort: clearEffortOption,
    allowUnverified: allowUnverifiedOption,
    verificationCommands: verificationCommandsOption,
    skipVerification: skipVerificationOption,
    parallelism: parallelismOption,
    setRole: setRoleOption,
    clearRole: clearRoleOption,
  },
  ({
    agent: agentFlag,
    model: modelFlag,
    effort: effortFlag,
    clearEffort,
    allowUnverified,
    verificationCommands: verificationCommandsFlag,
    skipVerification,
    parallelism: parallelismFlag,
    setRole: setRoleFlags,
    clearRole: clearRoleFlags,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const isInteractive = process.stdin.isTTY === true;

      // Loading is the gate: a missing, malformed, or version-mismatched
      // settings file fails here with its Vietnamese diagnostic before
      // anything is prompted or written.
      const current = yield* loadProjectSettings(cwd).pipe(
        Effect.mapError((e) => new InitError({ message: e.message })),
      );

      yield* d.summary(
        "Cấu hình Sandcastle hiện tại",
        settingsSummaryRows(current),
      );

      // --- early flag validation (English, like init's flag errors) ---
      if (agentFlag._tag === "Some") {
        if (!nonEmptyFlag(agentFlag)) {
          yield* failConfigure("--agent must not be empty.");
        } else if (getAgent(agentFlag.value.trim()) === undefined) {
          const names = listAgents()
            .map((a) => a.name)
            .join(", ");
          yield* failConfigure(
            `Unknown agent "${agentFlag.value}". Available: ${names}`,
          );
        }
      }
      if (modelFlag._tag === "Some" && !nonEmptyFlag(modelFlag)) {
        yield* failConfigure("--model must not be empty.");
      }
      if (effortFlag._tag === "Some" && !nonEmptyFlag(effortFlag)) {
        yield* failConfigure(
          "--effort must not be empty (use --clear-effort to remove the configured effort).",
        );
      }
      if (nonEmptyFlag(effortFlag) && clearEffort) {
        yield* failConfigure("--effort and --clear-effort cannot be combined.");
      }
      if (verificationCommandsFlag._tag === "Some" && skipVerification) {
        yield* failConfigure(
          "--verification-commands and --skip-verification cannot be combined.",
        );
      }
      if (parallelismFlag._tag === "Some") {
        const n = parallelismFlag.value;
        if (
          !Number.isInteger(n) ||
          n < MIN_PARALLELISM ||
          n > MAX_PARALLELISM
        ) {
          yield* failConfigure(
            `--parallelism must be an integer from ${MIN_PARALLELISM} to ${MAX_PARALLELISM}.`,
          );
        }
      }

      // Role flags: --set-role entries are validated as they are parsed
      // (unknown role/field/agent and empty values all fail before any
      // write), and a role may not be set and cleared in the same run.
      const parsedSetRoles: {
        role: WorkflowRole;
        field: RoleSetField;
        value: string;
      }[] = [];
      for (const raw of setRoleFlags) {
        parsedSetRoles.push(yield* parseSetRoleEntry(raw));
      }
      const clearedRoles = new Set<string>(clearRoleFlags);
      for (const entry of parsedSetRoles) {
        if (clearedRoles.has(entry.role)) {
          yield* failConfigure(
            `--set-role and --clear-role cannot both target role "${entry.role}".`,
          );
        }
      }

      const hasChangeFlags =
        agentFlag._tag === "Some" ||
        modelFlag._tag === "Some" ||
        effortFlag._tag === "Some" ||
        clearEffort ||
        verificationCommandsFlag._tag === "Some" ||
        skipVerification ||
        parallelismFlag._tag === "Some" ||
        parsedSetRoles.length > 0 ||
        clearRoleFlags.length > 0;

      if (hasChangeFlags) {
        const update = yield* buildFlagUpdate({
          current,
          agentFlag,
          modelFlag,
          effortFlag,
          clearEffort,
          allowUnverified,
          isInteractive,
          verificationCommandsFlag,
          skipVerification,
          parallelismFlag,
          setRoleFlags,
          clearRoleFlags,
        });
        return yield* persistUpdate(cwd, update);
      }

      if (!isInteractive) {
        // Display-only: a headless `sandcastle configure` just reports the
        // current settings — flags are required to change anything without
        // a TTY, and prompts are never opened.
        return;
      }

      return yield* interactiveConfigure({
        cwd,
        current,
        allowUnverified,
      });
    }),
);

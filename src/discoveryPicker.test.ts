import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Ref } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the host-mode agent picker (ADR 0021/0026, ticket #14).
 * `@clack/prompts` is mocked — every prompt resolves from a queue the test
 * sets up — and agent discovery runs through an injected `DiscoveryExec`, so
 * no real CLI, TTY, or subscription is ever touched.
 */
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    select: vi.fn(),
    text: vi.fn(),
    // clack cancels surface as a symbol; our mocks resolve `Symbol("cancel")`.
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
  };
});

import * as clack from "@clack/prompts";

import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { InitError } from "./errors.js";
import { listAgents, type AgentEntry } from "./InitService.js";
import {
  buildModelOptions,
  INIT_STOPPED_MESSAGE,
  pickHostAgent,
  resolveDiscoveredSelection,
} from "./discoveryPicker.js";
import { getDiscoveryAdapter } from "./discovery/registry.js";
import type {
  AgentDiscoveryReport,
  DiscoveredModel,
  DiscoveryExec,
  DiscoveryExecOptions,
  DiscoveryExecResult,
} from "./discovery/contract.js";

const mockSelect = vi.mocked(clack.select);
const mockText = vi.mocked(clack.text);

type CapturedOption = {
  value: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

/** The options/message/initialValue passed to the i-th clack.select call. */
const selectCall = (
  i: number,
): {
  message: string;
  initialValue?: string;
  options: readonly CapturedOption[];
} => mockSelect.mock.calls[i]![0] as never;

const selectValues = (i: number): string[] =>
  selectCall(i).options.map((o) => o.value);

const optionOf = (i: number, value: string): CapturedOption | undefined =>
  selectCall(i).options.find((o) => o.value === value);

// ---------------------------------------------------------------------------
// Fake DiscoveryExec — keyed on `"command args"`, ENOENT by default
// ---------------------------------------------------------------------------

const res = (
  partial: Partial<DiscoveryExecResult> & { stdout?: string } = {},
): DiscoveryExecResult => ({
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
  exitCode: partial.exitCode ?? 0,
  ...(partial.spawnError !== undefined
    ? { spawnError: partial.spawnError }
    : {}),
  ...(partial.timedOut !== undefined ? { timedOut: partial.timedOut } : {}),
});

const ENOENT = res({ exitCode: null, spawnError: "ENOENT" });

type Handler = (options?: DiscoveryExecOptions) => DiscoveryExecResult;

const makeExec = (
  handlers: Record<string, Handler | DiscoveryExecResult> = {},
) => {
  const calls: string[] = [];
  const exec: DiscoveryExec = (command, args, options) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const handler = handlers[key];
    if (typeof handler === "function") return Promise.resolve(handler(options));
    if (handler !== undefined) return Promise.resolve(handler);
    return Promise.resolve(ENOENT);
  };
  return { exec, calls };
};

// --- Codex: version + login status + app-server JSON-RPC catalog ---

const CODEX_CATALOG = {
  data: [
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Everyday workhorse",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    },
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium" },
        { reasoningEffort: "xhigh" },
      ],
    },
  ],
  nextCursor: null,
};

const codexAppServer =
  (catalog: unknown): Handler =>
  (options) => {
    const out: string[] = [];
    for (const line of (options?.stdin ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let msg: { id?: unknown; method?: string };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") {
        out.push(
          JSON.stringify({
            id: msg.id,
            result: {
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "macos",
              userAgent: "fake-codex",
            },
          }),
        );
      } else if (msg.method === "model/list") {
        out.push(JSON.stringify({ id: msg.id, result: catalog }));
      }
    }
    return res({ stdout: out.join("\n") });
  };

const codexReady = (): Record<string, Handler | DiscoveryExecResult> => ({
  "codex --version": res({ stdout: "codex-cli 0.150.1\n" }),
  "codex login status": res({ stdout: "Logged in using ChatGPT\n" }),
  "codex app-server": codexAppServer(CODEX_CATALOG),
});

const codexUnauthenticated = (): Record<
  string,
  Handler | DiscoveryExecResult
> => ({
  "codex --version": res({ stdout: "codex-cli 0.150.1\n" }),
  "codex login status": res({ stderr: "Not logged in", exitCode: 1 }),
});

// --- Pi: bare --version, --help fingerprint, --list-models table ---

const PI_MODELS_TABLE = `provider   model                 context  max-out  thinking  images
anthropic  claude-opus-4-1       200K     32K      yes       yes
google     gemini-3-pro-preview  1M       64K      yes       yes
openai     gpt-4o-mini           128K     16K      no        yes
`;

const piAuthCheck = (provider: string) =>
  res({
    stdout: JSON.stringify({
      status: "ready",
      provider,
      authType: "api_key",
    }),
  });

const piReady = (): Record<string, Handler | DiscoveryExecResult> => ({
  "pi --version": res({ stdout: "0.84.4\n" }),
  "pi --help": res({
    stdout:
      "pi - AI coding assistant with read, bash, edit, write tools\n\n" +
      "Usage:\n  pi [options]\n",
  }),
  "pi --list-models": res({ stdout: PI_MODELS_TABLE }),
  "pi auth check --provider anthropic --json --no-refresh":
    piAuthCheck("anthropic"),
  "pi auth check --provider google --json --no-refresh": piAuthCheck("google"),
  "pi auth check --provider openai --json --no-refresh": piAuthCheck("openai"),
});

// --- Claude Code: --version fingerprint + `auth status` JSON, no catalog ---

const claudeReady = (): Record<string, Handler | DiscoveryExecResult> => ({
  "claude --version": res({ stdout: "2.1.263 (Claude Code)\n" }),
  "claude auth status": res({
    stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }),
  }),
});

// --- Devin: version + auth status + families/variants catalog fixture ---

/** The sanitized `devin models list --format json` capture. */
const DEVIN_CATALOG_PATH = join(
  import.meta.dirname,
  "discovery",
  "fixtures",
  "devin-models.json",
);

/** A real fixture-backed Devin report — catalog parsing included. */
const devinReport = async (): Promise<AgentDiscoveryReport> => {
  const { exec } = makeExec({
    "devin --version": res({ stdout: "devin 3000.10.31 (b98cc431)\n" }),
    "devin auth status": res({ stdout: "Logged in (via Devin).\n" }),
    "devin models list --format json": res({
      stdout: await readFile(DEVIN_CATALOG_PATH, "utf-8"),
    }),
  });
  const report = await getDiscoveryAdapter("devin")!.discover(exec);
  expect(report.state).toBe("ready");
  return report;
};

/** resolveDiscoveredSelection against a pre-fetched Devin report. */
const resolveDevin = (
  report: AgentDiscoveryReport,
  flags: { model?: string; effort?: string },
  ref = displayRef(),
) =>
  resolveDiscoveredSelection({
    adapter: getDiscoveryAdapter("devin")!,
    agentLabel: "Devin",
    defaultModel: "claude-opus-5",
    modelFlag:
      flags.model !== undefined ? Option.some(flags.model) : Option.none(),
    effortFlag:
      flags.effort !== undefined ? Option.some(flags.effort) : Option.none(),
    isInteractive: false,
    allowUnverified: false,
    initialReport: report,
  }).pipe(Effect.provide(SilentDisplay.layer(ref)));

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

const displayRef = () => Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

const entries = (
  ref: Ref.Ref<ReadonlyArray<DisplayEntry>>,
): ReadonlyArray<DisplayEntry> => Effect.runSync(Ref.get(ref));

const runPicker = (
  exec: DiscoveryExec,
  ref = displayRef(),
  agents: readonly AgentEntry[] = listAgents(),
) =>
  pickHostAgent({
    agents,
    modelFlag: Option.none(),
    effortFlag: Option.none(),
    allowUnverified: false,
    exec,
  }).pipe(Effect.provide(SilentDisplay.layer(ref)));

const statusMessages = (entries: ReadonlyArray<DisplayEntry>): string[] =>
  entries.filter((e) => e._tag === "status").map((e) => e.message);

const codexAdapter = () => getDiscoveryAdapter("codex")!;

// ---------------------------------------------------------------------------
// pickHostAgent — ready-first ordering
// ---------------------------------------------------------------------------

describe("pickHostAgent", () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockText.mockReset();
  });

  it("lists verified-ready agents first with version + model-count hints", async () => {
    const { exec } = makeExec({ ...piReady(), ...codexReady() });
    mockSelect
      .mockResolvedValueOnce("codex") // agent picker
      .mockResolvedValueOnce("gpt-5.6-terra") // model picker
      .mockResolvedValueOnce("xhigh"); // effort picker

    const picked = await Effect.runPromise(runPicker(exec));

    // Registry order among the ready agents: pi before codex; the secondary
    // "other agents" entry comes last.
    const agentCall = selectCall(0);
    expect(agentCall.message).toBe("Chọn agent chạy trên máy này:");
    expect(selectValues(0)).toEqual(["pi", "codex", "__other-agents__"]);
    expect(agentCall.initialValue).toBe("pi");
    expect(optionOf(0, "codex")?.hint).toContain("0.150.1");
    expect(optionOf(0, "codex")?.hint).toContain("2 model");
    expect(optionOf(0, "pi")?.hint).toContain("0.84.4");
    expect(optionOf(0, "pi")?.hint).toContain("3 model");

    // Recommended model + effort markers.
    const modelCall = selectCall(1);
    expect(modelCall.initialValue).toBe("gpt-5.6-sol");
    expect(optionOf(1, "gpt-5.6-sol")?.label).toBe("GPT-5.6-Sol (khuyến nghị)");
    expect(optionOf(1, "gpt-5.6-terra")?.label).toBe("GPT-5.6-Terra");

    const effortCall = selectCall(2);
    expect(effortCall.initialValue).toBe("xhigh");
    expect(optionOf(2, "xhigh")?.label).toBe("xhigh (khuyến nghị)");
    expect(optionOf(2, "medium")?.label).toBe("medium");

    expect(picked.agent.name).toBe("codex");
    expect(picked.selection).toEqual({
      model: "gpt-5.6-terra",
      effort: "xhigh",
      executable: "codex",
      modelSource: "discovered",
    });
  });

  it("groups the model picker by provider with disabled header rows", async () => {
    const { exec } = makeExec(piReady());
    mockSelect
      .mockResolvedValueOnce("pi")
      // gpt-4o-mini is a thinking:no model → no effort prompt at all.
      .mockResolvedValueOnce("openai/gpt-4o-mini");

    const picked = await Effect.runPromise(runPicker(exec));

    const modelCall = selectCall(1);
    expect(selectValues(1)).toEqual([
      "__provider-group__:anthropic",
      "anthropic/claude-opus-4-1",
      "__provider-group__:google",
      "google/gemini-3-pro-preview",
      "__provider-group__:openai",
      "openai/gpt-4o-mini",
    ]);
    // Headers are inert rows.
    expect(modelCall.options[0]?.disabled).toBe(true);
    expect(modelCall.options[0]?.label).toBe("anthropic");
    // pi's recommended model is the first google entry (its default provider).
    expect(modelCall.initialValue).toBe("google/gemini-3-pro-preview");
    expect(optionOf(1, "google/gemini-3-pro-preview")?.label).toContain(
      "(khuyến nghị)",
    );

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(picked.selection).toEqual({
      model: "openai/gpt-4o-mini",
      executable: "pi",
      modelSource: "discovered",
    });
  });

  it("keeps unavailable agents behind 'Agent khác' with state hints + guidance", async () => {
    const ref = displayRef();
    const { exec } = makeExec(codexUnauthenticated());
    mockSelect
      .mockResolvedValueOnce("codex") // secondary list (zero ready → direct)
      .mockResolvedValueOnce("manual"); // recovery action
    mockText.mockResolvedValueOnce("custom-model-9").mockResolvedValueOnce(""); // empty effort → unset

    const picked = await Effect.runPromise(runPicker(exec, ref));

    // The secondary list shows every agent with a Vietnamese state hint.
    const subCall = selectCall(0);
    expect(subCall.message).toBe(
      "Agent chưa sẵn sàng — chọn để xem hướng dẫn:",
    );
    expect(optionOf(0, "codex")?.hint).toBe("chưa đăng nhập");
    expect(optionOf(0, "claude-code")?.hint).toBe("chưa cài đặt");
    expect(optionOf(0, "devin")?.hint).toBe("chưa cài đặt");

    // Statuses: the zero-ready notice, then codex's login guidance.
    const statuses = statusMessages(entries(ref));
    expect(statuses.some((m) => m.includes("Không tìm thấy agent nào"))).toBe(
      true,
    );
    expect(statuses.some((m) => m.includes("codex login"))).toBe(true);

    // Recovery menu offers retry/manual/back/stop.
    expect(selectValues(1)).toEqual(["retry", "manual", "back", "stop"]);

    expect(picked.agent.name).toBe("codex");
    expect(picked.selection).toEqual({
      model: "custom-model-9",
      // unauthenticated still fingerprinted the binary — the probed
      // executable rides along with the manual entry.
      executable: "codex",
      modelSource: "manual-unverified",
    });
  });

  it("recheck re-probes only the selected agent and continues when ready", async () => {
    let loggedIn = false;
    const { exec, calls } = makeExec({
      "codex --version": res({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": () =>
        loggedIn
          ? res({ stdout: "Logged in using ChatGPT\n" })
          : res({ stderr: "Not logged in", exitCode: 1 }),
      "codex app-server": codexAppServer(CODEX_CATALOG),
    });
    mockSelect
      .mockResolvedValueOnce("codex") // secondary list
      .mockImplementationOnce(() => {
        loggedIn = true; // the user ran `codex login` before hitting retry
        return Promise.resolve("retry");
      })
      .mockResolvedValueOnce("gpt-5.6-sol")
      .mockResolvedValueOnce("high");

    const picked = await Effect.runPromise(runPicker(exec));

    expect(picked.selection).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
      executable: "codex",
      modelSource: "discovered",
    });
    // codex was probed twice (initial sweep + recheck); the catalog probe ran
    // only after login succeeded.
    expect(calls.filter((c) => c === "codex --version")).toHaveLength(2);
    expect(calls.filter((c) => c === "codex app-server")).toHaveLength(1);
    // No other agent was re-probed by the recheck — pi saw only its one
    // initial-sweep call.
    expect(calls.filter((c) => c.startsWith("pi "))).toHaveLength(1);
  });

  it("'Chọn agent khác' returns to the ready-first picker", async () => {
    const { exec } = makeExec({ ...piReady(), ...codexUnauthenticated() });
    mockSelect
      .mockResolvedValueOnce("__other-agents__") // main picker → secondary
      .mockResolvedValueOnce("codex") // secondary → codex
      .mockResolvedValueOnce("back") // recovery → pick another agent
      .mockResolvedValueOnce("pi") // main picker → pi
      .mockResolvedValueOnce("google/gemini-3-pro-preview")
      .mockResolvedValueOnce("medium");

    const picked = await Effect.runPromise(runPicker(exec));

    // The second main-picker render still lists pi first.
    expect(selectValues(3)[0]).toBe("pi");
    expect(picked.agent.name).toBe("pi");
    expect(picked.selection).toEqual({
      model: "google/gemini-3-pro-preview",
      effort: "medium",
      executable: "pi",
      modelSource: "discovered",
    });
  });

  it("'Dừng lại' is a safe stop before any selection is made", async () => {
    const { exec } = makeExec(codexUnauthenticated());
    mockSelect.mockResolvedValueOnce("codex").mockResolvedValueOnce("stop");

    const err = await Effect.runPromise(runPicker(exec).pipe(Effect.flip));
    expect(err).toBeInstanceOf(InitError);
    expect(err.message).toBe(INIT_STOPPED_MESSAGE);
  });

  it("cancelling the agent picker is the same safe stop", async () => {
    const { exec } = makeExec(piReady());
    mockSelect.mockResolvedValueOnce(Symbol("cancel"));

    const err = await Effect.runPromise(runPicker(exec).pipe(Effect.flip));
    expect(err).toBeInstanceOf(InitError);
    expect(err.message).toBe(INIT_STOPPED_MESSAGE);
  });

  it("agents without a discovery adapter stay selectable as manual entries", async () => {
    const fakeEntry: AgentEntry = {
      name: "fake-agent",
      label: "Fake Agent",
      defaultModel: "fake-1",
      factoryImport: "agents/fake",
      dockerfileTemplate: "",
      envExample: "",
      setupCommand: "",
    };
    const ref = displayRef();
    const { exec } = makeExec(); // nothing on PATH at all
    mockSelect
      .mockResolvedValueOnce("fake-agent") // secondary list
      .mockResolvedValueOnce("manual"); // recovery — no retry offered
    mockText.mockResolvedValueOnce("fake-model-2").mockResolvedValueOnce("max");

    const picked = await Effect.runPromise(
      runPicker(exec, ref, [...listAgents(), fakeEntry]),
    );

    expect(optionOf(0, "fake-agent")?.hint).toBe("không hỗ trợ khám phá");
    // No retry for an agent with nothing to probe.
    expect(selectValues(1)).toEqual(["manual", "back", "stop"]);
    expect(
      statusMessages(entries(ref)).some((m) =>
        m.includes("chưa hỗ trợ khám phá"),
      ),
    ).toBe(true);
    expect(picked.agent.name).toBe("fake-agent");
    expect(picked.selection).toEqual({
      model: "fake-model-2",
      effort: "max",
      modelSource: "manual-unverified",
    });
  });

  it("a ready agent with no catalog keeps the registry default, unverified", async () => {
    const { exec } = makeExec(claudeReady());
    mockSelect.mockResolvedValueOnce("claude-code");

    const picked = await Effect.runPromise(runPicker(exec));

    // Claude Code is verified but exposes no model list — the registry
    // default is used and honestly marked manual-unverified.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(picked.agent.name).toBe("claude-code");
    expect(picked.selection).toEqual({
      model: "claude-opus-4-8",
      executable: "claude",
      modelSource: "manual-unverified",
    });
  });

  it("pre-selects the persisted agent/model/effort when they are still valid (#27 F015)", async () => {
    const { exec } = makeExec({ ...piReady(), ...codexReady() });
    mockSelect
      .mockResolvedValueOnce("codex") // agent picker
      .mockResolvedValueOnce("gpt-5.6-terra") // model picker
      .mockResolvedValueOnce("xhigh"); // effort picker

    const picked = await Effect.runPromise(
      pickHostAgent({
        agents: listAgents(),
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        allowUnverified: false,
        initialAgentName: "codex",
        initialModel: "gpt-5.6-terra",
        initialEffort: "xhigh",
        exec,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );

    // Agent picker opens on the persisted agent (codex), not the first ready
    // entry (pi) — and so do the model/effort pickers on the persisted values.
    expect(selectCall(0).initialValue).toBe("codex");
    expect(selectCall(1).initialValue).toBe("gpt-5.6-terra");
    expect(selectCall(2).initialValue).toBe("xhigh");
    expect(picked.agent.name).toBe("codex");
    expect(picked.selection).toEqual({
      model: "gpt-5.6-terra",
      effort: "xhigh",
      executable: "codex",
      modelSource: "discovered",
    });
  });

  it("does not forward persisted model/effort to a different agent's pickers", async () => {
    const { exec } = makeExec({ ...piReady(), ...codexReady() });
    mockSelect
      .mockResolvedValueOnce("pi") // user switches away from codex
      .mockResolvedValueOnce("google/gemini-3-pro-preview")
      .mockResolvedValueOnce("medium");

    const picked = await Effect.runPromise(
      pickHostAgent({
        agents: listAgents(),
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        allowUnverified: false,
        initialAgentName: "codex",
        initialModel: "gpt-5.6-terra",
        initialEffort: "xhigh",
        exec,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );

    // Pi's picker starts from ITS recommendation — codex's persisted model
    // would be a meaningless preselection here.
    expect(selectCall(1).initialValue).toBe("google/gemini-3-pro-preview");
    expect(picked.agent.name).toBe("pi");
    expect(picked.selection.model).toBe("google/gemini-3-pro-preview");
  });

  it("a persisted effort is only pre-selected when the newly chosen model offers it (F037)", async () => {
    const { exec } = makeExec(codexReady());
    mockSelect
      .mockResolvedValueOnce("codex")
      .mockResolvedValueOnce("gpt-5.6-terra") // terra: medium/xhigh only
      .mockResolvedValueOnce("xhigh");

    const picked = await Effect.runPromise(
      pickHostAgent({
        agents: listAgents(),
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        allowUnverified: false,
        initialAgentName: "codex",
        initialModel: "gpt-5.6-sol",
        initialEffort: "low", // valid for sol, not for terra
        exec,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );

    // sol is still in the catalog → model picker pre-selects it. But once the
    // user picks terra, "low" is incompatible — the effort picker opens on
    // terra's own default instead of inheriting it.
    expect(selectCall(1).initialValue).toBe("gpt-5.6-sol");
    expect(selectCall(2).initialValue).toBe("xhigh");
    expect(picked.selection).toEqual({
      model: "gpt-5.6-terra",
      effort: "xhigh",
      executable: "codex",
      modelSource: "discovered",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveDiscoveredSelection — non-interactive + flag paths
// ---------------------------------------------------------------------------

describe("resolveDiscoveredSelection", () => {
  const resolve = (
    exec: DiscoveryExec,
    params: {
      isInteractive: boolean;
      allowUnverified: boolean;
      modelFlag?: Option.Option<string>;
      effortFlag?: Option.Option<string>;
    },
  ) =>
    resolveDiscoveredSelection({
      adapter: codexAdapter(),
      agentLabel: "Codex",
      defaultModel: "gpt-5.4",
      modelFlag: params.modelFlag ?? Option.none(),
      effortFlag: params.effortFlag ?? Option.none(),
      isInteractive: params.isInteractive,
      allowUnverified: params.allowUnverified,
      exec,
    }).pipe(Effect.provide(SilentDisplay.layer(displayRef())));

  it("non-interactive failure reports the actionable guidance, non-zero", async () => {
    const { exec } = makeExec(codexUnauthenticated());
    const err = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: false,
      }).pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(InitError);
    expect(err.message).toContain("codex login");
  });

  it("--allow-unverified + --model/--effort accepts the entry as manual-unverified", async () => {
    const { exec } = makeExec(codexUnauthenticated());
    const outcome = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: true,
        modelFlag: Option.some("custom-model"),
        effortFlag: Option.some("ultra"),
      }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "custom-model",
        effort: "ultra",
        // unauthenticated still fingerprinted the binary — the probed
        // executable rides along with the unverified flag entry.
        executable: "codex",
        modelSource: "manual-unverified",
      },
    });
  });

  it("--allow-unverified without --model still fails, naming the missing flag", async () => {
    const { exec } = makeExec(codexUnauthenticated());
    const err = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: true,
      }).pipe(Effect.flip),
    );
    expect(err.message).toContain("--allow-unverified");
    expect(err.message).toContain("--model");
    // The actionable guidance is still part of the error.
    expect(err.message).toContain("codex login");
  });

  it("an unknown --model on a live catalog is manual-unverified only with --allow-unverified", async () => {
    const { exec } = makeExec(codexReady());

    const strict = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: false,
        modelFlag: Option.some("gpt-4-turbo"),
      }).pipe(Effect.flip),
    );
    expect(strict.message).toContain("gpt-4-turbo");
    expect(strict.message).toContain("không có trong catalog");

    const outcome = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: true,
        modelFlag: Option.some("gpt-4-turbo"),
      }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "gpt-4-turbo",
        executable: "codex",
        modelSource: "manual-unverified",
      },
    });
  });

  it("an unsupported --effort downgrades the whole selection to manual-unverified", async () => {
    const { exec } = makeExec(codexReady());
    const outcome = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: true,
        modelFlag: Option.some("gpt-5.6-terra"),
        effortFlag: Option.some("low"), // terra only offers medium/xhigh
      }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "gpt-5.6-terra",
        effort: "low",
        executable: "codex",
        modelSource: "manual-unverified",
      },
    });
  });

  it("an unlisted effort on a non-exhaustive list (Grok) is accepted as unverified, not rejected", async () => {
    // Grok's --reasoning-effort capability is verified but the CLI never
    // enumerates its valid values — the bundled list is only an observed
    // suggestion set. A newer CLI's effort name must not be rejected: the
    // flag passes through with modelSource "manual-unverified", no
    // --allow-unverified required.
    const grokReport: AgentDiscoveryReport = {
      agent: "grok",
      executable: "grok",
      state: "ready",
      version: "1.0.30",
      models: [
        {
          id: "grok-4.6",
          displayName: "grok-4.6",
          effortChoices: [
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "xhigh" },
          ],
          effortChoicesExhaustive: false,
        },
      ],
      recommendedModel: "grok-4.6",
    };
    const resolveGrok = (effort: string) =>
      resolveDiscoveredSelection({
        adapter: getDiscoveryAdapter("grok")!,
        agentLabel: "Grok",
        defaultModel: "grok-code-fast-1",
        modelFlag: Option.some("grok-4.6"),
        effortFlag: Option.some(effort),
        isInteractive: false,
        allowUnverified: false,
        // The pre-fetched report skips the probe — resolution itself is
        // what's under test.
        initialReport: grokReport,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef())));

    const outcome = await Effect.runPromise(resolveGrok("ultra"));
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "grok-4.6",
        effort: "ultra",
        executable: "grok",
        modelSource: "manual-unverified",
      },
    });
    // A listed value still verifies fully — the suggestion list is not a
    // free pass for the whole agent.
    const verified = await Effect.runPromise(resolveGrok("high"));
    expect(verified).toEqual({
      kind: "selection",
      selection: {
        model: "grok-4.6",
        effort: "high",
        executable: "grok",
        modelSource: "discovered",
      },
    });
  });

  it("valid --model/--effort flags stay discovered without the flag", async () => {
    const { exec } = makeExec(codexReady());
    const outcome = await Effect.runPromise(
      resolve(exec, {
        isInteractive: false,
        allowUnverified: false,
        modelFlag: Option.some("gpt-5.6-terra"),
        effortFlag: Option.some("xhigh"),
      }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "gpt-5.6-terra",
        effort: "xhigh",
        executable: "codex",
        modelSource: "discovered",
      },
    });
  });

  it("non-interactive defaults to the recommended model + effort", async () => {
    const { exec } = makeExec(codexReady());
    const outcome = await Effect.runPromise(
      resolve(exec, { isInteractive: false, allowUnverified: false }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "gpt-5.6-sol",
        effort: "medium",
        executable: "codex",
        modelSource: "discovered",
      },
    });
  });

  it("carries the probed executable alias into the selection (#27 F006)", async () => {
    // Grok was fingerprinted under its `agent` alias — the selection must
    // carry that name so it can be persisted as `agentExecutable`.
    const report: AgentDiscoveryReport = {
      agent: "grok",
      executable: "agent",
      state: "ready",
      version: "1.0.30",
      models: [{ id: "grok-4.6", displayName: "grok-4.6", effortChoices: [] }],
      recommendedModel: "grok-4.6",
    };
    const outcome = await Effect.runPromise(
      resolveDiscoveredSelection({
        adapter: getDiscoveryAdapter("grok")!,
        agentLabel: "Grok",
        defaultModel: "grok-code-fast-1",
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        isInteractive: false,
        allowUnverified: false,
        initialReport: report,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "grok-4.6",
        executable: "agent",
        modelSource: "discovered",
      },
    });
  });

  it("keeps the fingerprinted executable on the manual path after an unauthenticated report", async () => {
    // `unauthenticated` means the product was identified — the probed
    // executable name is real and stays attached to a manual selection.
    const report: AgentDiscoveryReport = {
      agent: "grok",
      executable: "agent",
      state: "unauthenticated",
      models: [],
      detail: "You are not authenticated.",
    };
    mockSelect.mockResolvedValueOnce("manual");
    mockText.mockResolvedValueOnce("grok-4.6").mockResolvedValueOnce("");

    const outcome = await Effect.runPromise(
      resolveDiscoveredSelection({
        adapter: getDiscoveryAdapter("grok")!,
        agentLabel: "Grok",
        defaultModel: "grok-code-fast-1",
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        isInteractive: true,
        allowUnverified: false,
        initialReport: report,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "grok-4.6",
        executable: "agent",
        modelSource: "manual-unverified",
      },
    });
  });

  it("never persists a wrong-product executable name", async () => {
    // The binary that answered as `grok` turned out to be an impostor — its
    // name must not become `agentExecutable` for a manual selection.
    const report: AgentDiscoveryReport = {
      agent: "grok",
      executable: "grok",
      state: "wrong-product",
      models: [],
      fingerprint: "not-grok 9.9",
      detail: "not-grok 9.9",
    };
    mockSelect.mockResolvedValueOnce("manual");
    mockText.mockResolvedValueOnce("grok-4.6").mockResolvedValueOnce("");

    const outcome = await Effect.runPromise(
      resolveDiscoveredSelection({
        adapter: getDiscoveryAdapter("grok")!,
        agentLabel: "Grok",
        defaultModel: "grok-code-fast-1",
        modelFlag: Option.none(),
        effortFlag: Option.none(),
        isInteractive: true,
        allowUnverified: false,
        initialReport: report,
      }).pipe(Effect.provide(SilentDisplay.layer(displayRef()))),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: { model: "grok-4.6", modelSource: "manual-unverified" },
    });
  });
});

// ---------------------------------------------------------------------------
// Devin — family slugs vs aliases vs exact variant model_uids (F016, ADR 0021)
// ---------------------------------------------------------------------------

describe("resolveDiscoveredSelection — Devin selectors", () => {
  it("--model <family slug> selects the family with no variant", async () => {
    const outcome = await Effect.runPromise(
      resolveDevin(await devinReport(), { model: "claude-opus-5" }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: { model: "claude-opus-5", modelSource: "discovered" },
    });
  });

  it("--model <family alias> resolves to the family slug, discovered", async () => {
    // `devin --model opus` is advertised by the live catalog's `aliases`.
    const outcome = await Effect.runPromise(
      resolveDevin(await devinReport(), { model: "opus" }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: { model: "claude-opus-5", modelSource: "discovered" },
    });
  });

  it("--model <exact variant model_uid> keeps family and variant distinct", async () => {
    // `claude-opus-5-high` is not a family — it picks the family AND the
    // thinking level in one selector. The uid lands on `effort` so the
    // provider can pass it back to --model unchanged.
    const outcome = await Effect.runPromise(
      resolveDevin(await devinReport(), { model: "claude-opus-5-high" }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "claude-opus-5",
        effort: "claude-opus-5-high",
        modelSource: "discovered",
      },
    });
  });

  it("--model <enum-style model_uid> resolves through the variant path too", async () => {
    const outcome = await Effect.runPromise(
      resolveDevin(await devinReport(), { model: "MODEL_GPT_5_2_XHIGH" }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "gpt-5.2",
        effort: "MODEL_GPT_5_2_XHIGH",
        modelSource: "discovered",
      },
    });
  });

  it("an explicit --effort still wins over a variant --model", async () => {
    const outcome = await Effect.runPromise(
      resolveDevin(await devinReport(), {
        model: "claude-opus-5-high",
        effort: "claude-opus-5-max",
      }),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: {
        model: "claude-opus-5",
        effort: "claude-opus-5-max",
        modelSource: "discovered",
      },
    });
  });

  it("an unknown selector is still rejected with the catalog ids", async () => {
    const err = await Effect.runPromise(
      resolveDevin(await devinReport(), { model: "bogus-9" }).pipe(Effect.flip),
    );
    expect(err).toBeInstanceOf(InitError);
    expect(err.message).toContain("bogus-9");
    expect(err.message).toContain("claude-opus-5");
  });

  it("a recommended model outside the catalog degrades to a real entry (F018)", async () => {
    // `recommendedModel` surfaces raw CLI output — an off-catalog value must
    // not crash the headless path on the effort lookup.
    const report = await devinReport();
    const ref = displayRef();
    const outcome = await Effect.runPromise(
      resolveDevin({ ...report, recommendedModel: "grok-next-beta" }, {}, ref),
    );
    expect(outcome).toEqual({
      kind: "selection",
      selection: { model: "claude-opus-5", modelSource: "discovered" },
    });
    expect(
      statusMessages(entries(ref)).some((m) => m.includes("grok-next-beta")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildModelOptions — pure grouping/marker unit tests
// ---------------------------------------------------------------------------

describe("buildModelOptions", () => {
  const model = (over: Partial<DiscoveredModel>): DiscoveredModel => ({
    id: "m",
    displayName: "M",
    effortChoices: [],
    ...over,
  });

  it("groups by provider with disabled headers when several providers exist", () => {
    const options = buildModelOptions(
      [
        model({ id: "a/one", displayName: "One", provider: "a" }),
        model({ id: "a/two", displayName: "Two", provider: "a" }),
        model({ id: "b/one", displayName: "Bee", provider: "b" }),
      ],
      "b/one",
    );
    expect(options.map((o) => o.value)).toEqual([
      "__provider-group__:a",
      "a/one",
      "a/two",
      "__provider-group__:b",
      "b/one",
    ]);
    expect(options[0]?.disabled).toBe(true);
    expect(options[3]?.disabled).toBe(true);
    expect(options[4]?.label).toBe("Bee (khuyến nghị)");
  });

  it("keeps the provider in per-model hints for a single-provider catalog", () => {
    const options = buildModelOptions(
      [
        model({
          id: "m1",
          displayName: "One",
          provider: "solo",
          description: "desc",
        }),
      ],
      undefined,
    );
    expect(options).toHaveLength(1);
    expect(options[0]?.disabled).toBeUndefined();
    expect(options[0]?.hint).toContain("solo");
    expect(options[0]?.hint).toContain("desc");
  });
});

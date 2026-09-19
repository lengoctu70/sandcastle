import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexDiscoveryAdapter } from "./codex.js";
import type {
  DiscoveryExec,
  DiscoveryExecOptions,
  DiscoveryExecResult,
} from "./contract.js";

/**
 * Contract tests for the Codex discovery adapter. Every case runs through an
 * injected `DiscoveryExec` — no real `codex` binary, no subscription, no
 * network. The app-server fake answers the JSON-RPC requests piped into
 * `options.stdin` exactly like `codex app-server` over stdio.
 */

const execResult = (
  partial: Partial<DiscoveryExecResult> & { stdout?: string },
): DiscoveryExecResult => ({
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
  exitCode: partial.exitCode ?? 0,
  ...(partial.spawnError !== undefined
    ? { spawnError: partial.spawnError }
    : {}),
  ...(partial.timedOut !== undefined ? { timedOut: partial.timedOut } : {}),
});

const INIT_RESULT = {
  codexHome: "/tmp/fake-codex-home",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "fake-codex/test",
};

/** A model entry in the app-server `model/list` wire shape. */
const appServerModel = (over: Record<string, unknown>) => ({
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6-Sol",
  description: "Everyday workhorse",
  isDefault: false,
  hidden: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast responses" },
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep reasoning" },
  ],
  ...over,
});

const APP_SERVER_CATALOG = {
  data: [
    appServerModel({ isDefault: true }),
    appServerModel({
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Hardest problems",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium" },
        { reasoningEffort: "xhigh" },
      ],
    }),
    // Hidden models are filtered out of the picker list.
    appServerModel({
      id: "codex-auto-review",
      model: "codex-auto-review",
      displayName: "Codex Auto Review",
      hidden: true,
    }),
  ],
  nextCursor: null,
};

/** `codex debug models` output shape (snake_case raw catalog). */
const DEBUG_CATALOG = {
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Everyday workhorse",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses" },
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deep reasoning" },
      ],
      visibility: "list",
      priority: 0,
      supported_in_api: true,
    },
    {
      slug: "gpt-reserve",
      display_name: "GPT-Reserve",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }],
      visibility: "hide",
      priority: 3,
    },
  ],
};

type Handler = (
  args: readonly string[],
  options?: DiscoveryExecOptions,
) => DiscoveryExecResult;

/**
 * Build a fake boundary. `appServer` receives the model/list params (or an
 * error/empty result). Any command without a handler exits 1 with no output.
 */
const makeFakeExec = (
  handlers: Record<string, Handler | DiscoveryExecResult>,
) => {
  const calls: string[] = [];
  const exec: DiscoveryExec = async (command, args, options) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const handler = handlers[key];
    if (typeof handler === "function") return handler(args, options);
    if (handler !== undefined) return handler;
    return execResult({ stderr: "unknown command", exitCode: 1 });
  };
  return { exec, calls };
};

/**
 * An app-server handler answering `model/list` from piped stdin. `response`
 * is the value placed under `result` for the model/list request — a constant,
 * or a function of the request params (for pagination).
 */
const appServerCatalog =
  (response: unknown | ((params: { cursor?: string }) => unknown)): Handler =>
  (_args, options) => {
    const out: string[] = [];
    for (const line of (options?.stdin ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let msg: { id?: unknown; method?: string; params?: { cursor?: string } };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") {
        out.push(JSON.stringify({ id: msg.id, result: INIT_RESULT }));
      } else if (msg.method === "model/list") {
        const result =
          typeof response === "function"
            ? response(msg.params ?? {})
            : response;
        out.push(JSON.stringify({ id: msg.id, result }));
      }
    }
    return execResult({ stdout: out.join("\n") });
  };

const readyExec = (catalog: unknown = APP_SERVER_CATALOG) =>
  makeFakeExec({
    "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
    "codex login status": execResult({ stdout: "Logged in using ChatGPT\n" }),
    "codex app-server": appServerCatalog(catalog),
    "codex debug models": execResult({
      stdout: JSON.stringify(DEBUG_CATALOG),
    }),
  });

describe("codexDiscoveryAdapter", () => {
  it("reports a ready agent with the live model catalog", async () => {
    const { exec, calls } = readyExec();
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("codex");
    expect(report.executable).toBe("codex");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("0.150.1");
    expect(report.fingerprint).toBe("codex-cli 0.150.1");
    expect(report.authDetail).toBe("Logged in using ChatGPT");

    // Hidden entries are filtered; the catalog default is recommended.
    expect(report.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(report.recommendedModel).toBe("gpt-5.6-sol");
    expect(report.recommendedEffort).toBe("medium");
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(report.models[1]!.defaultEffort).toBe("xhigh");

    // The app-server protocol answered, so the debug fallback never ran.
    expect(calls).toContain("codex app-server");
    expect(calls).not.toContain("codex debug models");
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "codex --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("npm install -g @openai/codex");
    // Discovery stops at the fingerprint — no auth or catalog probes ran.
    expect(calls).toEqual(["codex --version"]);
  });

  it("rejects an executable whose fingerprint is a different product", async () => {
    // The `agent`-on-PATH collision case: something answers to `codex` but
    // identifies as Grok.
    const { exec } = makeFakeExec({
      "codex --version": execResult({ stdout: "grok 1.0.30 (04b7ffed98c6)\n" }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    expect(report.guidance).toContain("không phải Codex CLI");
  });

  it("reports unauthenticated distinctly from ready", async () => {
    const { exec, calls } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({
        stderr: "Not logged in\n",
        exitCode: 1,
      }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("0.150.1");
    expect(report.guidance).toContain("codex login");
    // No catalog fetch is attempted for an agent the user cannot run.
    expect(calls).not.toContain("codex app-server");
    expect(calls).not.toContain("codex debug models");
  });

  it("does not confuse 'Not logged in' with a logged-in line", async () => {
    const { exec } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({
        stdout: "Not logged in\n",
        exitCode: 1,
      }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
  });

  it("tolerates unknown catalog fields", async () => {
    const catalog = {
      data: [
        appServerModel({
          isDefault: true,
          someFutureField: { nested: true },
          anotherNewThing: [1, 2, 3],
        }),
      ],
      nextCursor: null,
      futureResponseField: "yes",
    };
    const { exec } = readyExec(catalog);
    const report = await codexDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("reports a discovery error on malformed required catalog data", async () => {
    const { exec, calls } = readyExec({
      data: [appServerModel({ id: undefined })],
      nextCursor: null,
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("id");
    // Malformed data is terminal — the debug fallback must not mask it.
    expect(calls).not.toContain("codex debug models");
  });

  it("falls back to `codex debug models` when the app-server transport fails", async () => {
    const { exec, calls } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({ stdout: "Logged in using ChatGPT\n" }),
      // e.g. an older CLI without the app-server subcommand.
      "codex app-server": execResult({
        stderr: "error: unrecognized subcommand 'app-server'",
        exitCode: 2,
      }),
      "codex debug models": execResult({
        stdout: JSON.stringify(DEBUG_CATALOG),
      }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(calls).toContain("codex debug models");
    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
    expect(report.recommendedModel).toBe("gpt-5.6-sol");
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("parses the captured real `codex debug models` catalog verbatim", async () => {
    // Captured from `codex debug models` on codex-cli 0.150.1 — six real
    // catalog entries including hidden ones and unknown fields the adapter
    // must tolerate (service_tiers, model_messages, availability_nux, …).
    const fixture = await readFile(
      join(import.meta.dirname, "fixtures", "codex-debug-models.json"),
      "utf-8",
    );
    const { exec } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({
        stdout: "Logged in using ChatGPT\n",
      }),
      "codex app-server": execResult({
        stderr: "error: unrecognized subcommand 'app-server'",
        exitCode: 2,
      }),
      "codex debug models": execResult({ stdout: fixture }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    // Hidden entries are filtered; order follows the catalog.
    expect(report.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    // priority 0 is Codex's flagship/recommended slot.
    expect(report.recommendedModel).toBe("gpt-5.6-sol");
    expect(report.recommendedEffort).toBe("medium");
    // The real catalog exposes efforts beyond the historical
    // low/medium/high/xhigh set — discovery must pass them through.
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("reports an error when both catalog paths fail", async () => {
    const { exec } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({ stdout: "Logged in using ChatGPT\n" }),
      "codex app-server": execResult({
        stderr: "error: unrecognized subcommand 'app-server'",
        exitCode: 2,
      }),
      "codex debug models": execResult({
        stderr: "error: unrecognized subcommand 'debug'",
        exitCode: 2,
      }),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance).toContain("debug models");
  });

  it("follows model/list pagination", async () => {
    const page1 = {
      data: [appServerModel({ isDefault: true })],
      nextCursor: "page-2",
    };
    const page2 = {
      data: [
        appServerModel({
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
        }),
      ],
      nextCursor: null,
    };
    const { exec, calls } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({ stdout: "Logged in using ChatGPT\n" }),
      "codex app-server": appServerCatalog((params: { cursor?: string }) =>
        params.cursor === "page-2" ? page2 : page1,
      ),
    });
    const report = await codexDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(calls.filter((c) => c === "codex app-server")).toHaveLength(2);
  });

  it("reflects a changing catalog between runs", async () => {
    let catalog: unknown = {
      data: [appServerModel({ isDefault: true })],
      nextCursor: null,
    };
    const exec: DiscoveryExec = async (command, args, options) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "codex --version") {
        return execResult({ stdout: "codex-cli 0.150.1\n" });
      }
      if (key === "codex login status") {
        return execResult({ stdout: "Logged in using ChatGPT\n" });
      }
      if (key === "codex app-server") {
        return appServerCatalog(() => catalog)(args, options);
      }
      return execResult({ exitCode: 1 });
    };

    const first = await codexDiscoveryAdapter.discover(exec);
    catalog = {
      data: [
        appServerModel({
          id: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          isDefault: true,
        }),
      ],
      nextCursor: null,
    };
    const second = await codexDiscoveryAdapter.discover(exec);

    expect(first.recommendedModel).toBe("gpt-5.6-sol");
    expect(second.recommendedModel).toBe("gpt-6-astra");
    expect(second.models.map((m) => m.id)).toEqual(["gpt-6-astra"]);
  });

  it("accepts non-ChatGPT login lines (e.g. API key auth)", async () => {
    const { exec } = makeFakeExec({
      "codex --version": execResult({ stdout: "codex-cli 0.150.1\n" }),
      "codex login status": execResult({
        stdout: "Logged in using API key\n",
      }),
      "codex app-server": appServerCatalog(APP_SERVER_CATALOG),
    });
    const report = await codexDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.authDetail).toBe("Logged in using API key");
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await codexDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });
});

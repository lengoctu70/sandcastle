import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { opencodeDiscoveryAdapter } from "./opencode.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type {
  DiscoveryExec,
  DiscoveryExecOptions,
  DiscoveryExecResult,
} from "./contract.js";

/**
 * Contract tests for the OpenCode discovery adapter. Every case runs through
 * an injected `DiscoveryExec` (or a fake `opencode` shim on PATH) — no real
 * `opencode` binary, no account, no billable request. Captured output comes
 * from fixtures trimmed out of a real OpenCode 1.18.31 capture.
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

const fixture = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures", name), "utf-8");

let VERSION_OUTPUT: string;
let HELP_OUTPUT: string;
let AUTH_LIST_OUTPUT: string;
let MODELS_VERBOSE_OUTPUT: string;

beforeAll(async () => {
  VERSION_OUTPUT = await fixture("opencode-version.txt");
  HELP_OUTPUT = await fixture("opencode-help.txt");
  AUTH_LIST_OUTPUT = await fixture("opencode-auth-list.txt");
  MODELS_VERBOSE_OUTPUT = await fixture("opencode-models-verbose.txt");
});

type Handler = (
  args: readonly string[],
  options?: DiscoveryExecOptions,
) => DiscoveryExecResult;

/**
 * Build a fake boundary keyed on `opencode <args>`. Any command without a
 * handler exits 1 with no output — exactly like an unknown subcommand.
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

/** A signed-in, fully-working fake opencode. Catalog is overridable. */
const readyExec = (catalog: string) =>
  makeFakeExec({
    "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
    "opencode --help": execResult({ stdout: HELP_OUTPUT }),
    "opencode auth list": execResult({ stdout: AUTH_LIST_OUTPUT }),
    "opencode models --verbose": execResult({ stdout: catalog }),
  });

/** A minimal verbose-catalog document for one model. */
const modelBlock = (header: string, json: Record<string, unknown>): string =>
  `${header}\n${JSON.stringify(json, null, 2)}\n`;

describe("opencodeDiscoveryAdapter", () => {
  it("reports a ready agent with the provider-grouped live catalog", async () => {
    const { exec, calls } = readyExec(MODELS_VERBOSE_OUTPUT);
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("opencode");
    expect(report.executable).toBe("opencode");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("1.18.31");
    expect(report.fingerprint).toContain("opencode");
    expect(report.authDetail).toContain("2 credentials");
    expect(report.authDetail).toContain("OpenAI");
    expect(report.authDetail).toContain("OpenCode Go");

    // Full `provider/model` ids, grouped by provider in catalog order.
    expect(report.models.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode/ling-3.0-flash-fin-free",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/mimo-v2.5",
      "openai/gpt-5.3-codex-spark",
      "openai/gpt-5.6-sol",
    ]);
    expect(report.models.map((m) => m.provider)).toEqual([
      "opencode",
      "opencode",
      "opencode-go",
      "opencode-go",
      "openai",
      "openai",
    ]);
    expect(report.models[0]!.displayName).toBe("Big Pickle");

    // Variants are the model's effort choices, in catalog order.
    expect(report.models[4]!.effortChoices.map((e) => e.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(report.models[5]!.effortChoices.map((e) => e.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(report.models[2]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "high",
      "max",
    ]);

    // Models without variants get NO effort choices — nothing is invented.
    expect(report.models[0]!.effortChoices).toEqual([]);
    expect(report.models[0]!.defaultEffort).toBeUndefined();
    expect(report.models[3]!.effortChoices).toEqual([]);

    expect(calls).toEqual([
      "opencode --version",
      "opencode --help",
      "opencode auth list",
      "opencode models --verbose",
    ]);
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "opencode --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("opencode-ai");
    // Discovery stops at the first probe — no help/auth/catalog calls ran.
    expect(calls).toEqual(["opencode --version"]);
  });

  it("rejects an executable whose --help is a different product", async () => {
    // A same-named binary that prints a bare semver still isn't OpenCode —
    // the --help fingerprint is authoritative.
    const { exec, calls } = makeFakeExec({
      "opencode --version": execResult({ stdout: "1.18.31\n" }),
      "opencode --help": execResult({
        stdout: "Grok Build TUI\nUsage: opencode [options]\n",
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("Grok Build TUI");
    expect(report.guidance).toContain("không phải OpenCode CLI");
    // No auth or catalog probes run for a foreign product.
    expect(calls).not.toContain("opencode auth list");
    expect(calls).not.toContain("opencode models --verbose");
  });

  it("fingerprints from the command list even without the block-art banner", async () => {
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({
        stdout: [
          "Commands:",
          "  opencode run [message..]     run opencode with a message",
          "  opencode models [provider]   list all available models",
          "  opencode providers           manage AI providers and credentials",
          "  opencode serve               starts a headless opencode server",
          "",
        ].join("\n"),
      }),
      "opencode auth list": execResult({ stdout: AUTH_LIST_OUTPUT }),
      "opencode models --verbose": execResult({
        stdout: MODELS_VERBOSE_OUTPUT,
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.fingerprint).toContain("opencode run");
  });

  it("reports an error when --help produces no output", async () => {
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: "", exitCode: 1 }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
  });

  it("reports unauthenticated when no credentials are stored", async () => {
    const { exec, calls } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: HELP_OUTPUT }),
      "opencode auth list": execResult({
        stdout:
          "┌  Credentials ~/.local/share/opencode/auth.json\n└  0 credentials\n",
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("1.18.31");
    expect(report.guidance).toContain("opencode auth login");
    // No catalog fetch is attempted for an agent the user cannot run.
    expect(calls).not.toContain("opencode models --verbose");
  });

  it("reports unauthenticated when the auth probe fails entirely", async () => {
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: HELP_OUTPUT }),
      "opencode auth list": execResult({
        stderr: "unexpected error",
        exitCode: 1,
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
  });

  it("accepts a single credential row as authentication", async () => {
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: HELP_OUTPUT }),
      // Single credential, no ANSI styling.
      "opencode auth list": execResult({
        stdout: "●  Anthropic api\n└  1 credential\n",
      }),
      "opencode models --verbose": execResult({
        stdout: MODELS_VERBOSE_OUTPUT,
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.authDetail).toContain("1 credential");
    expect(report.authDetail).toContain("Anthropic");
  });

  it("reports a discovery error on malformed required catalog data", async () => {
    const catalog = modelBlock("opencode/broken", {
      providerID: "opencode",
      name: "Broken",
    });
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("id");
  });

  it("reports a discovery error when the catalog has no JSON blocks", async () => {
    const { exec } = readyExec("not json at all\nstill not json\n");
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
  });

  it("reports a discovery error when a model JSON block is unterminated", async () => {
    const catalog =
      'opencode/broken\n{\n  "id": "broken",\n  "providerID": "opencode"';
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
  });

  it("reports a discovery error when the catalog command fails", async () => {
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: HELP_OUTPUT }),
      "opencode auth list": execResult({ stdout: AUTH_LIST_OUTPUT }),
      "opencode models --verbose": execResult({
        stderr: "cache unavailable",
        exitCode: 1,
      }),
    });
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("models --verbose");
  });

  it("tolerates unknown catalog fields", async () => {
    const catalog = modelBlock("opencode/future", {
      id: "future",
      providerID: "opencode",
      name: "Future Model",
      status: "active",
      someFutureField: { nested: true },
      variants: { high: { reasoningEffort: "high" } },
    });
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["opencode/future"]);
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual(["high"]);
  });

  it("filters deprecated models out of the picker list", async () => {
    const catalog =
      modelBlock("opencode/old", {
        id: "old",
        providerID: "opencode",
        name: "Old",
        status: "deprecated",
      }) +
      modelBlock("opencode/new", {
        id: "new",
        providerID: "opencode",
        name: "New",
        status: "beta",
      });
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["opencode/new"]);
  });

  it("reports a discovery error when every model is filtered out", async () => {
    const catalog = modelBlock("opencode/old", {
      id: "old",
      providerID: "opencode",
      name: "Old",
      status: "deprecated",
    });
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("catalog rỗng");
  });

  it("rejects a non-object variants field as malformed data", async () => {
    const catalog = modelBlock("opencode/broken", {
      id: "broken",
      providerID: "opencode",
      name: "Broken",
      variants: "high",
    });
    const { exec } = readyExec(catalog);
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("variants");
  });

  it("reflects a changing catalog between runs", async () => {
    let catalog = MODELS_VERBOSE_OUTPUT;
    const { exec } = makeFakeExec({
      "opencode --version": execResult({ stdout: VERSION_OUTPUT }),
      "opencode --help": execResult({ stdout: HELP_OUTPUT }),
      "opencode auth list": execResult({ stdout: AUTH_LIST_OUTPUT }),
      "opencode models --verbose": () => execResult({ stdout: catalog }),
    });

    const first = await opencodeDiscoveryAdapter.discover(exec);
    catalog = modelBlock("openai/gpt-7", {
      id: "gpt-7",
      providerID: "openai",
      name: "GPT-7",
      variants: { low: {}, ultra: {} },
    });
    const second = await opencodeDiscoveryAdapter.discover(exec);

    expect(first.models.map((m) => m.id)).toContain("opencode/big-pickle");
    expect(second.models.map((m) => m.id)).toEqual(["openai/gpt-7"]);
    expect(second.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "ultra",
    ]);
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await opencodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });

  it("discovers a fake opencode executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
    const shimPath = join(shimDir, "opencode");
    // A node-script fake answering every probe the adapter runs.
    const catalog = JSON.stringify({
      id: "big-pickle",
      providerID: "opencode",
      name: "Big Pickle",
      status: "active",
      variants: {},
    });
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.join(" ");
if (key === "--version") {
  console.log("1.18.31");
  process.exit(0);
}
if (key === "--help") {
  console.log(\`Commands:
  opencode run [message..]     run opencode with a message
  opencode models [provider]   list all available models
  opencode providers           manage AI providers and credentials\`);
  process.exit(0);
}
if (key === "auth list") {
  console.log("●  OpenAI oauth");
  console.log("└  1 credential");
  process.exit(0);
}
if (key === "models --verbose") {
  console.log("opencode/big-pickle");
  console.log(${JSON.stringify(catalog)});
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await opencodeDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("ready");
      expect(report.version).toBe("1.18.31");
      expect(report.models.map((m) => m.id)).toEqual(["opencode/big-pickle"]);
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

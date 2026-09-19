import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorDiscoveryAdapter } from "./cursor.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type { DiscoveryExec, DiscoveryExecResult } from "./contract.js";

/**
 * Contract tests for the Cursor discovery adapter — the command-name
 * collision case. `agent` is the Cursor Agent binary, but the same name can
 * resolve to a different product entirely (on the design machine it is Grok
 * Build: `grok 1.0.30`, banner `Grok Build TUI`). The adapter must never
 * offer such an executable as Cursor.
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

const makeFakeExec = (handlers: Record<string, DiscoveryExecResult>) => {
  const calls: string[] = [];
  const exec: DiscoveryExec = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    return (
      handlers[key] ?? execResult({ stderr: "unknown command", exitCode: 1 })
    );
  };
  return { exec, calls };
};

/** Real Cursor Agent: `agent --version` prints a bare calver. */
const CURSOR_VERSION = execResult({ stdout: "2026.07.16-899851b\n" });
/**
 * Cursor's `agent --help` carries the product markers used for positive
 * identity ("Cursor Agent" command descriptions, `CURSOR_API_KEY`).
 */
const CURSOR_HELP = execResult({
  stdout: `Usage: agent [options] [command] [prompt...]

Cursor Agent CLI - run the Cursor agent from your terminal

Options:
  -v, --version                 Output the version number
  --api-key <key>               API key for authentication (or use CURSOR_API_KEY env var)
  -p, --print                   Print responses to console (non-interactive)
  --output-format <format>      text, json, or stream-json
  --model <model>               Model to use
  -f, --force                   Force allow commands unless explicitly denied
  -h, --help                    Display help for command

Commands:
  agent [prompt...]             Start the Cursor Agent (default command)
  login                         Authenticate with Cursor
  logout                        Sign out and clear authentication
  status | whoami               View authentication status
  models                        List available models for this account
  update | upgrade              Update Cursor Agent to latest version
`,
});

/**
 * Grok's `agent --help` — the collision fixture. Note it DOES contain the
 * word "Cursor" in the `cursor-worker` subcommand line ("Register this
 * machine as a Cursor private worker"); a naive /\bcursor\b/i fingerprint
 * would false-positive here, so the adapter uses narrower markers.
 */
const GROK_VERSION = execResult({ stdout: "grok 1.0.30 (04b7ffed98c6)\n" });
const GROK_HELP = execResult({
  stdout: `Grok Build TUI

Usage: agent [OPTIONS] [PROMPT] [COMMAND]

Commands:
  agent          Run Grok without the interactive UI
  cursor-worker  Register this machine as a Cursor private worker (via the leader)
  login          Sign in to Grok
  models         List available models and exit
  version        Print version information [aliases: v]
`,
});

const STATUS_LOGGED_IN = execResult({
  stdout: "✓ Logged in as dev@example.com\n",
});
const STATUS_LOGGED_OUT = execResult({
  stdout: "✗ Not logged in\n",
  exitCode: 1,
});

/** `agent models` — `id - Display Name` rows with (default)/(current) marks. */
const MODELS_OUTPUT = execResult({
  stdout: `Available models

auto - Auto (default)
composer-2 - Composer 2
gpt-5.4-medium - GPT-5.4
gpt-5.4-high - GPT-5.4 High
sonnet-4.6-thinking - Claude 4.6 Sonnet (Thinking)  (current)
sonnet-4.6 - Claude 4.6 Sonnet

Tip: use --model <id> to pick a model
`,
});

const readyExec = () =>
  makeFakeExec({
    "agent --version": CURSOR_VERSION,
    "agent --help": CURSOR_HELP,
    "agent status": STATUS_LOGGED_IN,
    "agent models": MODELS_OUTPUT,
  });

describe("cursorDiscoveryAdapter", () => {
  const ENV_KEY = "CURSOR_API_KEY";
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedApiKey;
    }
  });

  it("reports a ready agent with the live account catalog", async () => {
    const { exec, calls } = readyExec();
    const report = await cursorDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("cursor");
    expect(report.executable).toBe("agent");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("2026.07.16-899851b");
    expect(report.authDetail).toContain("Logged in");

    // `id - Display` rows parsed; (default)/(current) markers stripped.
    expect(report.models.map((m) => m.id)).toEqual([
      "auto",
      "composer-2",
      "gpt-5.4-medium",
      "gpt-5.4-high",
      "sonnet-4.6-thinking",
      "sonnet-4.6",
    ]);
    expect(report.models[0]!.displayName).toBe("Auto");
    expect(report.models[4]!.displayName).toBe("Claude 4.6 Sonnet (Thinking)");
    // The catalog's `(default)` row is recommended; Cursor has no effort.
    expect(report.recommendedModel).toBe("auto");
    expect(report.models.every((m) => m.effortChoices.length === 0)).toBe(true);
    expect(calls).toEqual([
      "agent --version",
      "agent --help",
      "agent status",
      "agent models",
    ]);
  });

  it("rejects an `agent` binary that identifies as Grok (the collision case)", async () => {
    const { exec, calls } = makeFakeExec({
      "agent --version": GROK_VERSION,
      "agent --help": GROK_HELP,
    });
    const report = await cursorDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    // The evidence line shows which product actually answered.
    expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    expect(report.guidance).toContain("không phải Cursor Agent");
    // Auth and catalog probes must never run on a rejected binary.
    expect(calls).toEqual(["agent --version", "agent --help"]);
  });

  it("rejects an `agent` binary with unrelated output too", async () => {
    const { exec } = makeFakeExec({
      "agent --version": execResult({ stdout: "some-tool 3.2.1\n" }),
      "agent --help": execResult({ stdout: "Usage: some-tool [options]\n" }),
    });
    const report = await cursorDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("some-tool 3.2.1");
  });

  it("reports not-installed when no `agent` executable exists", async () => {
    const { exec, calls } = makeFakeExec({
      "agent --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await cursorDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("cursor.com/install");
    expect(calls).toEqual(["agent --version"]);
  });

  it("reports unauthenticated when `agent status` shows no login", async () => {
    const { exec, calls } = makeFakeExec({
      "agent --version": CURSOR_VERSION,
      "agent --help": CURSOR_HELP,
      "agent status": STATUS_LOGGED_OUT,
    });
    const report = await cursorDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("2026.07.16-899851b");
    expect(report.guidance).toContain("agent login");
    // No catalog fetch for an agent the user cannot run.
    expect(calls).not.toContain("agent models");
  });

  it("treats CURSOR_API_KEY as authenticated without probing status", async () => {
    process.env[ENV_KEY] = "key-123";
    const { exec, calls } = readyExec();
    const report = await cursorDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.authDetail).toContain("CURSOR_API_KEY");
    expect(calls).not.toContain("agent status");
  });

  it("maps an `agent models` auth failure back to unauthenticated", async () => {
    const { exec } = makeFakeExec({
      "agent --version": CURSOR_VERSION,
      "agent --help": CURSOR_HELP,
      "agent status": STATUS_LOGGED_IN,
      // e.g. the stored session expired between the two probes.
      "agent models": execResult({
        stdout: "Authentication required\n",
        exitCode: 1,
      }),
    });
    const report = await cursorDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
    expect(report.guidance).toContain("agent login");
  });

  it("reports an error when the catalog answers with no model rows", async () => {
    const { exec } = makeFakeExec({
      "agent --version": CURSOR_VERSION,
      "agent --help": CURSOR_HELP,
      "agent status": STATUS_LOGGED_IN,
      "agent models": execResult({
        stdout: "No models available for this account.\n",
      }),
    });
    const report = await cursorDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("model");
  });

  it("reports an error when the identity probe times out", async () => {
    const { exec } = makeFakeExec({
      "agent --version": CURSOR_VERSION,
      "agent --help": execResult({ exitCode: null, timedOut: true }),
    });
    const report = await cursorDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await cursorDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });

  it("rejects a fake `agent` (Grok) executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-agent-grok-"));
    const shimPath = join(shimDir, "agent");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("grok 1.0.30 (04b7ffed98c6)");
  process.exit(0);
}
if (key === "--help") {
  console.log("Grok Build TUI");
  console.log("");
  console.log("Usage: agent [OPTIONS] [PROMPT] [COMMAND]");
  console.log("  cursor-worker  Register this machine as a Cursor private worker (via the leader)");
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await cursorDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("wrong-product");
      expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it("discovers a fake `agent` (Cursor) executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-agent-cursor-"));
    const shimPath = join(shimDir, "agent");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("2026.07.16-899851b");
  process.exit(0);
}
if (key === "--help") {
  console.log("Cursor Agent CLI");
  console.log("--api-key <key>  API key for authentication (or use CURSOR_API_KEY env var)");
  process.exit(0);
}
if (key === "status") {
  console.log("✓ Logged in as dev@example.com");
  process.exit(0);
}
if (key === "models") {
  console.log("Available models\\n\\nauto - Auto (default)\\ncomposer-2 - Composer 2\\n");
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await cursorDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("ready");
      expect(report.version).toBe("2026.07.16-899851b");
      expect(report.models.map((m) => m.id)).toEqual(["auto", "composer-2"]);
      expect(report.recommendedModel).toBe("auto");
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeDiscoveryAdapter } from "./claude-code.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type { DiscoveryExec, DiscoveryExecResult } from "./contract.js";

/**
 * Contract tests for the Claude Code discovery adapter. Every case runs
 * through an injected `DiscoveryExec` (or a fake `claude` executable on PATH
 * for the real-boundary test) — no real `claude` binary, no subscription.
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

const VERSION_OK = execResult({ stdout: "2.1.263 (Claude Code)\n" });
/** `claude auth status` signed-in shape (JSON is the default output). */
const AUTH_SIGNED_IN = execResult({
  stdout:
    '{\n  "loggedIn": true,\n  "authMethod": "oauth",\n  "apiProvider": "firstParty",\n  "analyticsDisabled": false,\n  "projectsDirectory": "/Users/dev/.claude/projects"\n}\n',
});
/** Captured logged-out shape (fixtures/claude/auth-status.txt). */
const AUTH_SIGNED_OUT = execResult({
  stdout:
    '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty",\n  "analyticsDisabled": false,\n  "projectsDirectory": "/Users/dev/.claude/projects"\n}\n',
  exitCode: 1,
});

const readyExec = () =>
  makeFakeExec({
    "claude --version": VERSION_OK,
    "claude auth status": AUTH_SIGNED_IN,
  });

describe("claudeCodeDiscoveryAdapter", () => {
  it("reports a ready agent with an empty catalog (no model-list command)", async () => {
    const { exec, calls } = readyExec();
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("claude-code");
    expect(report.executable).toBe("claude");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("2.1.263");
    expect(report.fingerprint).toBe("2.1.263 (Claude Code)");
    expect(report.authDetail).toContain("loggedIn: true");
    expect(report.authDetail).toContain("oauth");
    // No catalog command exists — the report must stay honest: empty model
    // list, no recommended model, and guidance explaining the model is
    // unverifiable (never a bundled list presented as current).
    expect(report.models).toEqual([]);
    expect(report.recommendedModel).toBeUndefined();
    expect(report.guidance).toContain("không có lệnh liệt kê model");
    expect(calls).toEqual(["claude --version", "claude auth status"]);
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "claude --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("claude.ai/install.sh");
    // Discovery stops at the fingerprint — no auth probe ran.
    expect(calls).toEqual(["claude --version"]);
  });

  it("rejects an executable whose fingerprint is a different product", async () => {
    const { exec, calls } = makeFakeExec({
      "claude --version": execResult({
        stdout: "grok 1.0.30 (04b7ffed98c6)\n",
      }),
    });
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    expect(report.guidance).toContain("không phải Claude Code");
    expect(calls).toEqual(["claude --version"]);
  });

  it("reports unauthenticated on the logged-out auth-status shape", async () => {
    const { exec } = makeFakeExec({
      "claude --version": VERSION_OK,
      "claude auth status": AUTH_SIGNED_OUT,
    });
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("2.1.263");
    expect(report.guidance).toContain("claude auth login");
    expect(report.guidance).not.toContain("API key");
    expect(report.models).toEqual([]);
  });

  it("reports unauthenticated when auth status is not parseable JSON", async () => {
    const { exec } = makeFakeExec({
      "claude --version": VERSION_OK,
      "claude auth status": execResult({
        stderr: "Not logged in\n",
        exitCode: 1,
      }),
    });
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.guidance).toContain("claude auth login");
  });

  it("reports an error when the version probe times out", async () => {
    const { exec } = makeFakeExec({
      "claude --version": execResult({ exitCode: null, timedOut: true }),
    });
    const report = await claudeCodeDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance).toContain("không phản hồi");
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await claudeCodeDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });

  it("discovers a fake claude executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    const shimPath = join(shimDir, "claude");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}
if (key === "auth status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth" }));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report =
        await claudeCodeDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("ready");
      expect(report.version).toBe("2.1.263");
      expect(report.models).toEqual([]);
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

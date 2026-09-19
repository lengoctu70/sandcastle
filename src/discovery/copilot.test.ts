import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copilotDiscoveryAdapter } from "./copilot.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type {
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";

/**
 * Contract tests for the Copilot discovery adapter. Copilot CLI has no
 * login-status or model-list command — auth is verified through the
 * documented credential chain (token env vars, then the `gh` CLI fallback)
 * and a verified agent reports `ready` with an empty catalog.
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
    return handlers[key] ?? execResult({ stderr: "unknown command", exitCode: 1 });
  };
  return { exec, calls };
};

/** Newer builds print the product name in `--version`. */
const VERSION_PRODUCT = execResult({
  stdout: "GitHub Copilot CLI 0.0.400.\nRun 'copilot update' to check for updates.\n",
});
/** Older/lo-res builds print a bare version plus a Commit line — no product. */
const VERSION_BARE = execResult({ stdout: "0.0.367\nCommit: 9b421b4\n" });
const COPILOT_HELP = execResult({
  stdout: `GitHub Copilot CLI — brings the Copilot coding agent to your terminal

Usage: copilot [options] [command]

Commands:
  login           Authenticate with Copilot via the OAuth device flow
  version         Display version information and check for updates
`,
});

const GH_SIGNED_IN = execResult({
  stdout:
    "github.com\n  ✓ Logged in to github.com account dev (keyring)\n  - Active account: true\n",
});
const GH_SIGNED_OUT = execResult({
  stderr: "You are not logged into any GitHub hosts.\n",
  exitCode: 1,
});
const GH_MISSING = execResult({ exitCode: null, spawnError: "ENOENT" });

const TOKEN_VARS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

describe("copilotDiscoveryAdapter", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const name of TOKEN_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of TOKEN_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it("reports ready via a token env var, with an empty catalog", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const { exec, calls } = makeFakeExec({
      "copilot --version": VERSION_PRODUCT,
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("copilot");
    expect(report.executable).toBe("copilot");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("0.0.400");
    expect(report.fingerprint).toBe("GitHub Copilot CLI 0.0.400.");
    expect(report.authDetail).toContain("GITHUB_TOKEN");
    // No catalog command exists — empty models, unverified guidance.
    expect(report.models).toEqual([]);
    expect(report.recommendedModel).toBeUndefined();
    expect(report.guidance).toContain("không có lệnh liệt kê model");
    // Product mark was already in --version: no --help probe needed.
    expect(calls).toEqual(["copilot --version"]);
  });

  it("reports ready via the documented `gh` auth fallback", async () => {
    const { exec, calls } = makeFakeExec({
      "copilot --version": VERSION_PRODUCT,
      "gh auth status": GH_SIGNED_IN,
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.authDetail).toContain("gh");
    expect(report.authDetail).toContain("Logged in");
    expect(calls).toEqual(["copilot --version", "gh auth status"]);
  });

  it("falls back to `copilot --help` when --version lacks the product mark", async () => {
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_test";
    const { exec, calls } = makeFakeExec({
      "copilot --version": VERSION_BARE,
      "copilot --help": COPILOT_HELP,
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.version).toBe("0.0.367");
    expect(calls).toContain("copilot --help");
  });

  it("rejects an executable that is not GitHub Copilot", async () => {
    const { exec, calls } = makeFakeExec({
      "copilot --version": execResult({ stdout: "other-cli 9.9.9\n" }),
      "copilot --help": execResult({ stdout: "Usage: other-cli\n" }),
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("other-cli 9.9.9");
    expect(report.guidance).toContain("không phải GitHub Copilot");
    expect(calls).not.toContain("gh auth status");
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "copilot --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("npm install -g @github/copilot");
    expect(calls).toEqual(["copilot --version"]);
  });

  it("reports unauthenticated when no token env and `gh` is logged out", async () => {
    const { exec } = makeFakeExec({
      "copilot --version": VERSION_PRODUCT,
      "gh auth status": GH_SIGNED_OUT,
    });
    const report = await copilotDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("0.0.400");
    expect(report.guidance).toContain("copilot login");
  });

  it("reports unauthenticated when `gh` itself is not installed", async () => {
    const { exec } = makeFakeExec({
      "copilot --version": VERSION_PRODUCT,
      "gh auth status": GH_MISSING,
    });
    const report = await copilotDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
    expect(report.guidance).toContain("copilot login");
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await copilotDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });

  it("discovers a fake copilot executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_test";
    const shimDir = await mkdtemp(join(tmpdir(), "fake-copilot-"));
    const shimPath = join(shimDir, "copilot");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("GitHub Copilot CLI 0.0.400.");
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await copilotDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("ready");
      expect(report.version).toBe("0.0.400");
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

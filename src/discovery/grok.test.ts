import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokDiscoveryAdapter } from "./grok.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type {
  DiscoveryExec,
  DiscoveryExecOptions,
  DiscoveryExecResult,
} from "./contract.js";

/**
 * Contract tests for the Grok discovery adapter. Every case runs through an
 * injected `DiscoveryExec` — no real `grok`/`agent` binary, no subscription,
 * no network. Fixture contents are the verbatim CLI captures from
 * `fixtures/grok/` and `fixtures/agent/` (grok 1.0.30).
 */

const FIXTURES = join(import.meta.dirname, "fixtures");

const readFixture = (name: string): Promise<string> =>
  readFile(join(FIXTURES, name), "utf-8");

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

const ENOENT = execResult({ exitCode: null, spawnError: "ENOENT" });

type Handler = (
  args: readonly string[],
  options?: DiscoveryExecOptions,
) => DiscoveryExecResult;

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

/** A fake where `grok` answers like the real grok 1.0.30 and `models` is authed. */
const readyExec = async (modelsFixture = "grok/models-authenticated.txt") =>
  makeFakeExec({
    "grok --version": execResult({
      stdout: await readFixture("grok/version.txt"),
    }),
    "grok --help": execResult({
      stdout: await readFixture("grok/help.txt"),
    }),
    "grok models": execResult({ stdout: await readFixture(modelsFixture) }),
  });

describe("grokDiscoveryAdapter", () => {
  it("reports a ready agent with the live model catalog", async () => {
    const { exec } = await readyExec();
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("grok");
    expect(report.executable).toBe("grok");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("1.0.30");
    expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    expect(report.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(report.recommendedModel).toBe("grok-4.6");
    // Effort capability detected from --help's --reasoning-effort flag.
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // The list is an observed suggestion set, not the CLI's authoritative
    // catalog — models say so explicitly so the picker accepts unlisted
    // values as unverified rather than rejecting them.
    expect(report.models[0]!.effortChoicesExhaustive).toBe(false);
    expect(report.models[1]!.effortChoicesExhaustive).toBe(false);
  });

  it("degrades a Default model that is not a catalog member to a real entry", async () => {
    // `Default model:` may print an alias the `Available models:` list does
    // not contain — recommending it would crash the headless picker on the
    // effort lookup, so the report falls back to a catalog member (F018).
    const { exec } = makeFakeExec({
      "grok --version": execResult({
        stdout: await readFixture("grok/version.txt"),
      }),
      "grok --help": execResult({
        stdout: await readFixture("grok/help.txt"),
      }),
      "grok models": execResult({
        stdout:
          "Default model: grok-next-beta\n\n" +
          "Available models:\n" +
          "  * grok-4.6\n" +
          "  - grok-4.5\n",
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(report.recommendedModel).toBe("grok-4.6");
    expect(report.models.some((m) => m.id === report.recommendedModel)).toBe(
      true,
    );
  });

  it("reports unauthenticated when `models` prints the not-authenticated marker", async () => {
    const { exec, calls } = makeFakeExec({
      "grok --version": execResult({
        stdout: await readFixture("grok/version.txt"),
      }),
      "grok --help": execResult({
        stdout: await readFixture("grok/help.txt"),
      }),
      "grok models": execResult({
        stdout: await readFixture("grok/models-unauthenticated.txt"),
        exitCode: 1,
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("1.0.30");
    expect(report.guidance).toContain("grok login");
    expect(report.authDetail).toBe("You are not authenticated.");
    expect(calls).toContain("grok models");
  });

  it("reports not-installed when neither grok nor agent exists", async () => {
    const { exec, calls } = makeFakeExec({
      "grok --version": ENOENT,
      "agent --version": ENOENT,
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("x.ai/cli/install.sh");
    expect(calls).toEqual(["grok --version", "agent --version"]);
  });

  it("discovers Grok through the `agent` alias when `grok` is absent", async () => {
    // On the design machine `agent` is a symlink to the same Grok binary —
    // identity comes from the observed output, never the executable name.
    const { exec } = makeFakeExec({
      "grok --version": ENOENT,
      "agent --version": execResult({
        stdout: await readFixture("agent/version.txt"),
      }),
      "agent --help": execResult({
        stdout: await readFixture("agent/help.txt"),
      }),
      "agent models": execResult({
        stdout: await readFixture("grok/models-authenticated.txt"),
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.executable).toBe("agent");
    expect(report.version).toBe("1.0.30");
    expect(report.recommendedModel).toBe("grok-4.6");
  });

  it("does not claim a non-Grok `agent` executable (the Cursor collision)", async () => {
    // A Cursor CLI answering on `agent` must never satisfy Grok discovery —
    // and Grok must stay not-installed rather than adopt a foreign binary.
    const { exec, calls } = makeFakeExec({
      "grok --version": ENOENT,
      "agent --version": execResult({
        stdout: "Cursor Agent 2025.09.12\n",
      }),
      "agent --help": execResult({
        stdout: "Cursor Agent CLI\nUsage: agent [options]\n",
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("x.ai/cli/install.sh");
    expect(report.detail).toContain("Cursor Agent 2025.09.12");
    // `agent models` is never invoked on a non-Grok executable.
    expect(calls).not.toContain("agent models");
  });

  it("reports wrong-product when `grok` answers as a different product", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({ stdout: "acme-agent-cli 9.9\n" }),
      "grok --help": execResult({ stdout: "Acme Agent CLI\n" }),
      "agent --version": ENOENT,
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("acme-agent-cli 9.9");
    expect(report.guidance).toContain("không phải Grok CLI");
  });

  it("still identifies Grok when version output lacks the marker but help has the TUI banner", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({ stdout: "1.0.30\n" }),
      "grok --help": execResult({
        stdout: await readFixture("grok/help.txt"),
      }),
      "grok models": execResult({
        stdout: await readFixture("grok/models-authenticated.txt"),
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.executable).toBe("grok");
  });

  it("omits effort choices when --help lacks --reasoning-effort", async () => {
    const help = (await readFixture("grok/help.txt")).replace(
      "--reasoning-effort <EFFORT>",
      "--brainpower <EFFORT>",
    );
    const { exec } = makeFakeExec({
      "grok --version": execResult({
        stdout: await readFixture("grok/version.txt"),
      }),
      "grok --help": execResult({ stdout: help }),
      "grok models": execResult({
        stdout: await readFixture("grok/models-authenticated.txt"),
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models[0]!.effortChoices).toEqual([]);
  });

  it("reports an error when `models` fails without the auth marker", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({
        stdout: await readFixture("grok/version.txt"),
      }),
      "grok --help": execResult({
        stdout: await readFixture("grok/help.txt"),
      }),
      "grok models": execResult({
        stderr: "network unreachable",
        exitCode: 1,
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance).toContain("models");
  });

  it("reports an error on an empty models catalog", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({
        stdout: await readFixture("grok/version.txt"),
      }),
      "grok --help": execResult({
        stdout: await readFixture("grok/help.txt"),
      }),
      "grok models": execResult({ stdout: "\n\n" }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("catalog");
  });

  it("reports an error when the executable exists but will not run", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({
        exitCode: null,
        spawnError: "EACCES",
      }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance).toContain("EACCES");
  });

  it("reports an error when --version times out", async () => {
    const { exec } = makeFakeExec({
      "grok --version": execResult({ exitCode: null, timedOut: true }),
    });
    const report = await grokDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance).toContain("không phản hồi");
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await grokDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });

  it("discovers a fake grok executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-grok-"));
    const shimPath = join(shimDir, "grok");
    // Sidecar data files keep the 7 KB help text out of the shell source —
    // its backticks/`$()`s would otherwise be interpreted inside quotes.
    await Promise.all([
      readFixture("grok/version.txt").then((c) =>
        writeFile(join(shimDir, "version.txt"), c),
      ),
      readFixture("grok/help.txt").then((c) =>
        writeFile(join(shimDir, "help.txt"), c),
      ),
      readFixture("grok/models-authenticated.txt").then((c) =>
        writeFile(join(shimDir, "models.txt"), c),
      ),
    ]);
    await writeFile(
      shimPath,
      `#!/bin/sh
case "$1" in
  --version) cat "$(dirname "$0")/version.txt" ;;
  --help) cat "$(dirname "$0")/help.txt" ;;
  models) cat "$(dirname "$0")/models.txt" ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await grokDiscoveryAdapter.discover(nodeDiscoveryExec);
      expect(report.state).toBe("ready");
      expect(report.version).toBe("1.0.30");
      expect(report.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

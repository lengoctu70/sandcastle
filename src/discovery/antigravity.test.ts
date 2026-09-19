import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { antigravityDiscoveryAdapter } from "./antigravity.js";
import type { DiscoveryExec, DiscoveryExecResult } from "./contract.js";

/**
 * Contract tests for the Antigravity discovery adapter. Every case runs
 * through an injected `DiscoveryExec` — no real `agy` binary, no
 * subscription, no network. The real `agy models` catalog lives in
 * `fixtures/agy-models.txt`.
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

const AGY_HELP = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  --input-format                  Input format for print mode (text, stream-json)
  --model                         Model for the current CLI session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session

Available subcommands:
  agent           List available agents
  changelog       Show changelog and release notes
  mic-serve       Serve this machine's microphone to a CLI on another host
  models          List available models
  update          Update CLI
`;

const MODELS_TSV = `Fetching available models...
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium	GPT-OSS 120B (Medium)
`;

type Handler = (args: readonly string[]) => DiscoveryExecResult;

/** Build a fake boundary keyed on `agy <args>` strings. */
const makeFakeExec = (
  handlers: Record<string, Handler | DiscoveryExecResult>,
): { exec: DiscoveryExec; calls: string[] } => {
  const calls: string[] = [];
  const exec: DiscoveryExec = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const handler = handlers[key];
    if (handler === undefined) {
      return execResult({
        stdout: "",
        stderr: `unknown command: ${key}`,
        exitCode: 1,
      });
    }
    return typeof handler === "function" ? handler(args) : handler;
  };
  return { exec, calls };
};

const READY_HANDLERS: Record<string, DiscoveryExecResult> = {
  "agy --version": execResult({ stdout: "1.2.7\n" }),
  "agy --help": execResult({ stdout: AGY_HELP }),
  "agy models": execResult({ stdout: MODELS_TSV }),
};

describe("antigravityDiscoveryAdapter", () => {
  it("reports ready with the live catalog, recommended model, and effort", async () => {
    const { exec } = makeFakeExec(READY_HANDLERS);
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.agent).toBe("antigravity");
    expect(report.executable).toBe("agy");
    expect(report.version).toBe("1.2.7");
    expect(report.fingerprint).toBe("Usage of agy:");
    expect(report.recommendedModel).toBe("gemini-3.8-flash-high");
    expect(report.recommendedEffort).toBe("high");
    expect(report.models.map((m) => m.id)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium",
    ]);
  });

  it("infers effort choices from the model slug suffix", async () => {
    const { exec } = makeFakeExec(READY_HANDLERS);
    const report = await antigravityDiscoveryAdapter.discover(exec);
    const byId = new Map(report.models.map((m) => [m.id, m]));
    // Suffixed models accept exactly their encoded effort.
    expect(byId.get("gemini-3.8-flash-high")?.effortChoices).toEqual([
      { id: "high" },
    ]);
    expect(byId.get("gemini-3.8-flash-high")?.defaultEffort).toBe("high");
    expect(byId.get("gpt-oss-120b-medium")?.effortChoices).toEqual([
      { id: "medium" },
    ]);
    // Non-suffixed models reject --effort entirely — expose no choices.
    expect(byId.get("claude-sonnet-4-6")?.effortChoices).toEqual([]);
    expect(byId.get("claude-sonnet-4-6")?.defaultEffort).toBeUndefined();
  });

  it("parses the real captured catalog fixture end-to-end", async () => {
    const fixture = await readFile(
      join(__dirname, "fixtures", "agy-models.txt"),
      "utf-8",
    );
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({ stdout: fixture }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.models).toHaveLength(14);
    expect(report.models.map((m) => m.id)).toContain(
      "claude-opus-4-6-thinking",
    );
    // "-thinking" is not an effort suffix — no effort choices.
    expect(
      report.models.find((m) => m.id === "claude-opus-4-6-thinking")
        ?.effortChoices,
    ).toEqual([]);
  });

  it("reports not-installed on ENOENT", async () => {
    const { exec } = makeFakeExec({
      "agy --version": execResult({ spawnError: "ENOENT", exitCode: null }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("antigravity.google/cli/install.sh");
  });

  it("reports wrong-product when --help lacks agy markers", async () => {
    const { exec } = makeFakeExec({
      "agy --version": execResult({ stdout: "2.0.1\n" }),
      "agy --help": execResult({
        stdout: "Usage: agy [options]\n  --frobnicate   Frobnicate things\n",
      }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("Usage: agy [options]");
    expect(report.guidance).toContain("không phải Antigravity CLI");
  });

  it("does not accept a bare numeric --version as identity proof", async () => {
    // A foreign `agy` that happens to print a version but is not Antigravity.
    const { exec } = makeFakeExec({
      "agy --version": execResult({ stdout: "1.2.7\n" }),
      "agy --help": execResult({
        stdout: "some other tool\n(no agy flags here)\n",
      }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("wrong-product");
  });

  it("reports unauthenticated when models asks for sign-in", async () => {
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({
        stdout:
          "Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
      }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
    expect(report.authDetail).toContain("Please sign in");
    expect(report.guidance).toContain("Chạy `agy`");
    expect(report.version).toBe("1.2.7");
  });

  it("reports error on a malformed catalog row", async () => {
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({ stdout: "gemini-3.8-flash-high\t\n" }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail).toContain("không hợp lệ");
  });

  it("reports error on an empty catalog", async () => {
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({ stdout: "Fetching available models...\n" }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail).toContain("catalog rỗng");
  });

  it("reports error when agy models exits non-zero without rows or a sign-in marker", async () => {
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({
        stderr: "dial tcp: connection refused",
        exitCode: 1,
      }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.detail).toContain("thất bại");
  });

  it("reports error when agy --help fails with no output", async () => {
    const { exec } = makeFakeExec({
      "agy --version": execResult({ stdout: "1.2.7\n" }),
      "agy --help": execResult({ exitCode: 2 }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
  });

  it("reports error on spawn failures and timeouts", async () => {
    const { exec: spawnExec } = makeFakeExec({
      "agy --version": execResult({ spawnError: "EACCES", exitCode: null }),
    });
    expect((await antigravityDiscoveryAdapter.discover(spawnExec)).state).toBe(
      "error",
    );

    const { exec: timeoutExec } = makeFakeExec({
      "agy --version": execResult({ timedOut: true, exitCode: null }),
    });
    expect(
      (await antigravityDiscoveryAdapter.discover(timeoutExec)).state,
    ).toBe("error");

    const { exec: slowCatalog } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": execResult({ timedOut: true, exitCode: null }),
    });
    expect(
      (await antigravityDiscoveryAdapter.discover(slowCatalog)).state,
    ).toBe("error");
  });

  it("tolerates a missing/odd --version while still reporting ready", async () => {
    const { exec } = makeFakeExec({
      "agy --version": execResult({ stdout: "\n" }),
      "agy --help": execResult({ stdout: AGY_HELP }),
      "agy models": execResult({ stdout: MODELS_TSV }),
    });
    const report = await antigravityDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("ready");
    expect(report.version).toBeUndefined();
  });

  it("never rejects — a throwing boundary becomes an error report", async () => {
    const throwing: DiscoveryExec = async () => {
      throw new Error("spawn imploded");
    };
    const report = await antigravityDiscoveryAdapter.discover(throwing);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("spawn imploded");
  });

  it("reflects a changing live catalog between runs", async () => {
    let catalog = MODELS_TSV;
    const { exec } = makeFakeExec({
      ...READY_HANDLERS,
      "agy models": () => execResult({ stdout: catalog }),
    });
    const first = await antigravityDiscoveryAdapter.discover(exec);
    expect(first.models.map((m) => m.id)).toContain("gemini-3.8-flash-high");

    catalog = "gemini-9.9-flash-high\tGemini 9.9 Flash (High)\n";
    const second = await antigravityDiscoveryAdapter.discover(exec);
    expect(second.models.map((m) => m.id)).toEqual(["gemini-9.9-flash-high"]);
    expect(second.recommendedModel).toBe("gemini-9.9-flash-high");
  });
});

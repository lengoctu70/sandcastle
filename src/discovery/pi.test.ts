import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piDiscoveryAdapter } from "./pi.js";
import type {
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";

/**
 * Contract tests for the Pi discovery adapter. Every case runs through an
 * injected `DiscoveryExec` — no real `pi` binary, no subscription, no
 * network. Fixture files under `fixtures/pi/` are verbatim captures from a
 * real `pi` 0.84.4 install (`--version`, `--help`, the unauthenticated
 * `--list-models` message, `auth check --json` payloads); the authenticated
 * `--list-models` table and the `ready` auth check are synthesized in pi's
 * documented output shape because the capture machine had no provider
 * configured.
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "pi");
const fixture = (name: string) => readFile(join(FIXTURES, name), "utf-8");

/** The extension noise this pi install emits on stderr for every command. */
const PASEO_LINE = "[paseo-team] PASEO_PI_ROLE unset — extension passive\n";

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

type Handler = (args: readonly string[]) => DiscoveryExecResult;

/**
 * Build a fake boundary keyed on `pi <args>`. Any command without a handler
 * exits 1 with no output — like an unrecognized subcommand.
 */
const makeFakeExec = (
  handlers: Record<string, Handler | DiscoveryExecResult>,
) => {
  const calls: string[] = [];
  const exec: DiscoveryExec = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const handler = handlers[key];
    if (typeof handler === "function") return handler(args);
    if (handler !== undefined) return handler;
    return execResult({ stderr: "unknown command", exitCode: 1 });
  };
  return { exec, calls };
};

/** `pi auth check --provider <p> --json --no-refresh` handler keyed by provider. */
const authCheckHandler =
  (byProvider: Record<string, DiscoveryExecResult>): Handler =>
  (args) => {
    const provider = args[args.indexOf("--provider") + 1];
    return (
      byProvider[provider ?? ""] ??
      execResult({
        stdout: JSON.stringify({
          status: "not_ready",
          provider,
          reason: "provider_not_found",
        }),
      })
    );
  };

const authCheckResult = (provider: string, ready = true) =>
  execResult({
    stdout: ready
      ? JSON.stringify({ status: "ready", provider, authType: "api_key" })
      : JSON.stringify({
          status: "not_ready",
          provider,
          reason: "credentials_not_configured",
        }),
  });

/** Handlers for a fully working, authenticated pi at version 0.84.4. */
const readyHandlers = async (listModelsStdout?: string) => {
  const [version, help, models] = await Promise.all([
    fixture("version.txt"),
    fixture("help.txt"),
    listModelsStdout !== undefined
      ? Promise.resolve(listModelsStdout)
      : fixture("list-models.txt"),
  ]);
  return {
    "pi --version": execResult({ stdout: version, stderr: PASEO_LINE }),
    "pi --help": execResult({ stdout: help, stderr: PASEO_LINE }),
    "pi --list-models": execResult({ stdout: models, stderr: PASEO_LINE }),
    "pi auth check --provider anthropic --json --no-refresh":
      authCheckResult("anthropic"),
    "pi auth check --provider google --json --no-refresh": authCheckResult(
      "google",
    ),
    "pi auth check --provider openai --json --no-refresh": authCheckResult(
      "openai",
    ),
  };
};

const ALL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

describe("piDiscoveryAdapter", () => {
  it("reports a ready agent with the provider-grouped live catalog", async () => {
    const { exec, calls } = makeFakeExec(await readyHandlers());
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("pi");
    expect(report.executable).toBe("pi");
    expect(report.state).toBe("ready");
    // Bare version + the `pi - AI coding assistant…` help line as fingerprint.
    expect(report.version).toBe("0.84.4");
    expect(report.fingerprint).toBe(
      "pi - AI coding assistant with read, bash, edit, write tools",
    );

    // Models keep catalog order (provider-sorted) and carry their provider
    // so init can group them; ids are the canonical `provider/model` form.
    expect(report.models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4-5",
      "google/gemini-3-pro-preview",
      "openai/gpt-4o-mini",
      "openai/gpt-5.2",
    ]);
    expect(report.models[0]!.provider).toBe("anthropic");
    expect(report.models[2]!.provider).toBe("google");

    // Pi's default provider is google — its first model is recommended.
    expect(report.recommendedModel).toBe("google/gemini-3-pro-preview");
    expect(report.recommendedEffort).toBe("medium");

    // Thinking-capable models expose the CLI's full thinking-level list as
    // effort choices, defaulting to pi's built-in "medium".
    const sonnet = report.models.find(
      (m) => m.id === "anthropic/claude-sonnet-4-5",
    )!;
    expect(sonnet.effortChoices.map((e) => e.id)).toEqual(ALL_THINKING_LEVELS);
    expect(sonnet.defaultEffort).toBe("medium");
    // A non-reasoning model exposes no effort choices.
    const mini = report.models.find((m) => m.id === "openai/gpt-4o-mini")!;
    expect(mini.effortChoices).toEqual([]);
    expect(mini.defaultEffort).toBeUndefined();

    // One read-only auth check ran per catalog provider — evidence, not a
    // second auth gate.
    expect(calls).toContain(
      "pi auth check --provider anthropic --json --no-refresh",
    );
    expect(calls).toContain(
      "pi auth check --provider google --json --no-refresh",
    );
    expect(calls).toContain(
      "pi auth check --provider openai --json --no-refresh",
    );
    expect(report.authDetail).toContain("anthropic: ready");
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "pi --version": execResult({ exitCode: null, spawnError: "ENOENT" }),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain(
      "npm install -g @earendil-works/pi-coding-agent",
    );
    // Discovery stops at the version probe — no help or catalog probes ran.
    expect(calls).toEqual(["pi --version"]);
  });

  it("rejects an executable whose --help lacks the product fingerprint", async () => {
    // A different `pi` binary (e.g. some unrelated tool) answers --version
    // with a bare number but cannot produce the help fingerprint.
    const { exec, calls } = makeFakeExec({
      "pi --version": execResult({ stdout: "3.1.4\n" }),
      "pi --help": execResult({
        stdout: "Usage: pi [options] <query>\nA perimeter calculator.\n",
      }),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("Usage: pi [options] <query>");
    expect(report.guidance).toContain("không phải Pi coding agent");
    expect(calls).not.toContain("pi --list-models");
  });

  it("reports unauthenticated distinctly from installed and ready", async () => {
    const models = await fixture("models-unauthenticated.txt");
    const { exec, calls } = makeFakeExec({
      "pi --version": execResult({ stdout: "0.84.4\n", stderr: PASEO_LINE }),
      "pi --help": execResult({ stdout: await fixture("help.txt") }),
      "pi --list-models": execResult({ stdout: models, stderr: PASEO_LINE }),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("0.84.4");
    expect(report.authDetail).toContain("No models available");
    expect(report.guidance).toContain("/login");
    // No providers are known, so no auth-check probes ran.
    expect(calls.filter((c) => c.startsWith("pi auth check"))).toHaveLength(0);
  });

  it("reports an error on catalog output with no recognizable shape", async () => {
    const { exec } = makeFakeExec({
      "pi --version": execResult({ stdout: "0.84.4\n" }),
      "pi --help": execResult({ stdout: await fixture("help.txt") }),
      "pi --list-models": execResult({ stdout: "??? not a table ???\n" }),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("list-models");
  });

  it("reports an error when the catalog header has no parseable rows", async () => {
    const { exec } = makeFakeExec({
      "pi --version": execResult({ stdout: "0.84.4\n" }),
      "pi --help": execResult({ stdout: await fixture("help.txt") }),
      "pi --list-models": execResult({
        stdout: "provider  model  context  max-out  thinking  images\n",
      }),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("list-models");
  });

  it("tolerates extension noise and non-table lines around the catalog", async () => {
    // The [paseo-team] stderr line accompanies every command; stdout may also
    // carry stray extension lines that must not become fake models.
    const noisyTable =
      "[paseo-team] PASEO_PI_ROLE unset — extension passive\n" +
      "provider  model  context  max-out  thinking  images\n" +
      "anthropic  claude-sonnet-4-5  200K  64K  yes  yes\n" +
      "Some extension footer — not a model row\n" +
      "openai  gpt-5.2  400K  128K  yes  yes\n";
    const { exec } = makeFakeExec({
      "pi --version": execResult({ stdout: "0.84.4\n", stderr: PASEO_LINE }),
      "pi --help": execResult({
        stdout: await fixture("help.txt"),
        stderr: PASEO_LINE,
      }),
      "pi --list-models": execResult({ stdout: noisyTable, stderr: PASEO_LINE }),
      "pi auth check --provider anthropic --json --no-refresh":
        authCheckResult("anthropic"),
      "pi auth check --provider openai --json --no-refresh":
        authCheckResult("openai"),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.2",
    ]);
  });

  it("survives an inconclusive auth check without failing discovery", async () => {
    // The catalog is pi's own auth filter; a check that errors out only
    // degrades the evidence line.
    const { exec } = makeFakeExec({
      ...(await readyHandlers()),
      "pi auth check --provider anthropic --json --no-refresh": execResult({
        stderr: "spawn blew up",
        exitCode: 1,
      }),
      "pi auth check --provider google --json --no-refresh": authCheckResult(
        "google",
      ),
      "pi auth check --provider openai --json --no-refresh": authCheckResult(
        "openai",
      ),
    });
    const report = await piDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.authDetail).toContain("google: ready");
  });

  it("reflects a changing catalog between runs", async () => {
    let table =
      "provider   model                 context  max-out  thinking  images\n" +
      "anthropic  claude-sonnet-4-5     200K     64K      yes       yes\n" +
      "google     gemini-3-pro-preview  1M       64K      yes       yes\n";
    const handlers = await readyHandlers();
    const exec: DiscoveryExec = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "pi --list-models") {
        return execResult({ stdout: table });
      }
      const handler = handlers[key as keyof typeof handlers];
      return handler !== undefined && typeof handler !== "function"
        ? handler
        : authCheckHandler({})(args);
    };

    const first = await piDiscoveryAdapter.discover(exec);
    table =
      "provider  model           context  max-out  thinking  images\n" +
      "xai       grok-4-fast     2M       64K      yes       yes\n";
    const second = await piDiscoveryAdapter.discover(exec);

    expect(first.recommendedModel).toBe("google/gemini-3-pro-preview");
    expect(second.recommendedModel).toBe("xai/grok-4-fast");
    expect(second.models.map((m) => m.id)).toEqual(["xai/grok-4-fast"]);
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await piDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });
});

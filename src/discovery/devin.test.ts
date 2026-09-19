import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devinDiscoveryAdapter } from "./devin.js";
import type { DiscoveryExec, DiscoveryExecResult } from "./contract.js";

/**
 * Contract tests for the Devin discovery adapter. Every case runs through an
 * injected `DiscoveryExec` — no real `devin` binary, no Devin account, no
 * network. Captured output lives in `fixtures/` (sanitized): the model
 * catalog is a representative subset of a real `devin models list --format
 * json` response, the auth status a sanitized `devin auth status` capture.
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

const VERSION_LINE = "devin 3000.10.31 (b98cc431)\n";
const AUTH_STATUS_PATH = join(
  import.meta.dirname,
  "fixtures",
  "devin-auth-status.txt",
);
const CATALOG_PATH = join(import.meta.dirname, "fixtures", "devin-models.json");

const readFixture = (path: string) => readFile(path, "utf-8");

type Handler = (args: readonly string[]) => DiscoveryExecResult;

/** Build a fake boundary; any command without a handler exits 1 quietly. */
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

const readyExec = async (catalogStdout?: string) =>
  makeFakeExec({
    "devin --version": execResult({ stdout: VERSION_LINE }),
    "devin auth status": execResult({
      stdout: await readFixture(AUTH_STATUS_PATH),
    }),
    "devin models list --format json": execResult({
      stdout: catalogStdout ?? (await readFixture(CATALOG_PATH)),
    }),
  });

describe("devinDiscoveryAdapter", () => {
  it("reports a ready agent with the live account model catalog", async () => {
    const { exec, calls } = await readyExec();
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.agent).toBe("devin");
    expect(report.executable).toBe("devin");
    expect(report.state).toBe("ready");
    expect(report.version).toBe("3000.10.31");
    expect(report.fingerprint).toBe("devin 3000.10.31 (b98cc431)");
    expect(report.authDetail).toBe("Logged in (via Devin).");

    // Families map to models in catalog order; the catalog's first family is
    // the recommended pick.
    expect(report.models.map((m) => m.id)).toEqual([
      "claude-opus-5",
      "gemini-3.8-flash",
      "adaptive",
      "gpt-5.2",
      "claude-haiku-4.5",
    ]);
    expect(report.models.map((m) => m.displayName)).toEqual([
      "Claude Opus 5",
      "Gemini 3.8 Flash",
      "Adaptive",
      "GPT-5.2",
      "Claude Haiku 4.5",
    ]);
    expect(report.recommendedModel).toBe("claude-opus-5");

    // Aliases surface as the picker hint description.
    expect(report.models[0]!.description).toBe("Alias: opus");
    expect(report.models[1]!.description).toBe("Alias: gemini");
    expect(report.models[2]!.description).toBeUndefined();

    // Variants map to effort choices whose ids are the exact model_uids —
    // the values `--model` accepts back unchanged.
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "claude-opus-5-medium",
      "claude-opus-5-low",
      "claude-opus-5-high",
      "claude-opus-5-xhigh",
      "claude-opus-5-max",
      "claude-opus-5-low-fast",
      "claude-opus-5-medium-fast",
      "claude-opus-5-high-fast",
      "claude-opus-5-xhigh-fast",
      "claude-opus-5-max-fast",
    ]);
    expect(report.models[0]!.effortChoices[0]!.description).toContain(
      "Claude Opus 5 Medium",
    );

    // Enum-style UIDs (GPT) and opaque UIDs (MODEL_PRIVATE_11) pass through
    // as-is — discovery never rewrites the selectable identifier.
    expect(report.models[3]!.effortChoices.map((e) => e.id)).toEqual([
      "MODEL_GPT_5_2_LOW",
      "MODEL_GPT_5_2_MEDIUM",
      "MODEL_GPT_5_2_NONE",
      "MODEL_GPT_5_2_HIGH",
      "MODEL_GPT_5_2_XHIGH",
    ]);
    expect(report.models[4]!.effortChoices.map((e) => e.id)).toEqual([
      "MODEL_PRIVATE_11",
    ]);

    expect(calls).toEqual([
      "devin --version",
      "devin auth status",
      "devin models list --format json",
    ]);
  });

  it("reports not-installed when the executable is missing", async () => {
    const { exec, calls } = makeFakeExec({
      "devin --version": execResult({
        exitCode: null,
        spawnError: "ENOENT",
      }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("not-installed");
    expect(report.guidance).toContain("cli.devin.ai/install.sh");
    // Discovery stops at the fingerprint — no auth or catalog probes ran.
    expect(calls).toEqual(["devin --version"]);
  });

  it("rejects an executable whose fingerprint is a different product", async () => {
    // PATH collision case: something answers to `devin` but identifies as a
    // different product.
    const { exec } = makeFakeExec({
      "devin --version": execResult({ stdout: "grok 1.0.30 (04b7ffed98c6)\n" }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("wrong-product");
    expect(report.fingerprint).toBe("grok 1.0.30 (04b7ffed98c6)");
    expect(report.guidance).toContain("không phải Devin CLI");
  });

  it("reports unauthenticated when the account is not logged in", async () => {
    const { exec, calls } = makeFakeExec({
      "devin --version": execResult({ stdout: VERSION_LINE }),
      "devin auth status": execResult({
        stderr: "Not logged in\n",
        exitCode: 1,
      }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("unauthenticated");
    expect(report.version).toBe("3000.10.31");
    expect(report.guidance).toContain("devin auth login");
    // No catalog fetch is attempted for an agent the user cannot run.
    expect(calls).not.toContain("devin models list --format json");
  });

  it("does not confuse 'Not logged in' with a logged-in line", async () => {
    const { exec } = makeFakeExec({
      "devin --version": execResult({ stdout: VERSION_LINE }),
      "devin auth status": execResult({
        stdout: "Not logged in\n",
        exitCode: 1,
      }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("unauthenticated");
  });

  it("tolerates unknown catalog fields at every level", async () => {
    const catalog = {
      families: [
        {
          family_label: "Claude Opus 5",
          family_uid: "claude-opus-5",
          slug: "claude-opus-5",
          aliases: ["opus"],
          someFutureField: { nested: true },
          variants: [
            {
              model_uid: "claude-opus-5-medium",
              label: "Claude Opus 5 Medium",
              anotherNewThing: [1, 2, 3],
            },
          ],
        },
      ],
      futureResponseField: "yes",
    };
    const { exec } = await readyExec(JSON.stringify(catalog));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(report.models[0]!.effortChoices.map((e) => e.id)).toEqual([
      "claude-opus-5-medium",
    ]);
  });

  it("accepts a family with no variants array", async () => {
    const catalog = {
      families: [
        {
          family_label: "Future Model",
          family_uid: "future-1",
          slug: "future-1",
        },
      ],
    };
    const { exec } = await readyExec(JSON.stringify(catalog));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("ready");
    expect(report.models[0]!.effortChoices).toEqual([]);
    expect(report.models[0]!.defaultEffort).toBeUndefined();
  });

  it("reports a discovery error when the catalog is not valid JSON", async () => {
    const { exec } = await readyExec("not json at all\n");
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance ?? report.detail).toContain("JSON");
  });

  it("reports a discovery error when the catalog lacks the families array", async () => {
    const { exec } = await readyExec(JSON.stringify({ models: [] }));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("families");
  });

  it("reports a discovery error on malformed required family fields", async () => {
    const catalog = {
      families: [{ family_label: "No Slug", variants: [] }],
    };
    const { exec } = await readyExec(JSON.stringify(catalog));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("slug");
  });

  it("reports a discovery error on a variant missing model_uid", async () => {
    const catalog = {
      families: [
        {
          family_label: "Claude Opus 5",
          slug: "claude-opus-5",
          variants: [{ label: "Claude Opus 5 Medium" }],
        },
      ],
    };
    const { exec } = await readyExec(JSON.stringify(catalog));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("model_uid");
  });

  it("reports a discovery error when the catalog is empty", async () => {
    const { exec } = await readyExec(JSON.stringify({ families: [] }));
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.detail ?? report.guidance).toContain("rỗng");
  });

  it("reports a discovery error when the catalog probe times out", async () => {
    const { exec } = makeFakeExec({
      "devin --version": execResult({ stdout: VERSION_LINE }),
      "devin auth status": execResult({ stdout: "Logged in (via Devin).\n" }),
      "devin models list --format json": execResult({
        exitCode: null,
        timedOut: true,
      }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);

    // A timed-out catalog is an honest error — never a stale fallback.
    expect(report.state).toBe("error");
    expect(report.guidance ?? report.detail).toContain("hết thời gian chờ");
  });

  it("reports a discovery error when the catalog probe exits non-zero", async () => {
    const { exec } = makeFakeExec({
      "devin --version": execResult({ stdout: VERSION_LINE }),
      "devin auth status": execResult({ stdout: "Logged in (via Devin).\n" }),
      "devin models list --format json": execResult({
        stderr: "Error: failed to list models: unauthorized\n",
        exitCode: 1,
      }),
    });
    const report = await devinDiscoveryAdapter.discover(exec);

    expect(report.state).toBe("error");
    expect(report.guidance ?? report.detail).toContain("models list");
  });

  it("reflects a changing catalog between runs (no stale fallback)", async () => {
    let catalog: unknown = {
      families: [
        { family_label: "Claude Opus 5", slug: "claude-opus-5", variants: [] },
      ],
    };
    const exec: DiscoveryExec = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "devin --version") {
        return execResult({ stdout: VERSION_LINE });
      }
      if (key === "devin auth status") {
        return execResult({ stdout: "Logged in (via Devin).\n" });
      }
      if (key === "devin models list --format json") {
        return execResult({ stdout: JSON.stringify(catalog) });
      }
      return execResult({ exitCode: 1 });
    };

    const first = await devinDiscoveryAdapter.discover(exec);
    catalog = {
      families: [
        { family_label: "GPT-6 Astra", slug: "gpt-6-astra", variants: [] },
      ],
    };
    const second = await devinDiscoveryAdapter.discover(exec);

    expect(first.recommendedModel).toBe("claude-opus-5");
    expect(second.recommendedModel).toBe("gpt-6-astra");
    expect(second.models.map((m) => m.id)).toEqual(["gpt-6-astra"]);
  });

  it("never rejects — unexpected exec failures become an error report", async () => {
    const exec: DiscoveryExec = async () => {
      throw new Error("boundary blew up");
    };
    const report = await devinDiscoveryAdapter.discover(exec);
    expect(report.state).toBe("error");
    expect(report.guidance).toContain("boundary blew up");
  });
});

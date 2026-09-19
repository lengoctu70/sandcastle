import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverAgent,
  discoverAgents,
  getDiscoveryAdapter,
  listDiscoveryAdapters,
} from "./registry.js";
import { nodeDiscoveryExec } from "./nodeExec.js";
import type { DiscoveryExecResult } from "./contract.js";

const ok = (stdout: string): DiscoveryExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

const READY_EXEC = async (
  command: string,
  args: readonly string[],
  options?: { stdin?: string },
): Promise<DiscoveryExecResult> => {
  const key = `${command} ${args.join(" ")}`;
  if (key === "codex --version") return ok("codex-cli 0.150.1\n");
  if (key === "codex login status") return ok("Logged in using ChatGPT\n");
  if (key === "codex app-server") {
    const out = (options?.stdin ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        const msg = JSON.parse(l) as {
          id?: unknown;
          method?: string;
        };
        if (msg.id === undefined) return [];
        if (msg.method === "initialize") {
          return [
            JSON.stringify({
              id: msg.id,
              result: {
                codexHome: "/tmp",
                platformFamily: "unix",
                platformOs: "macos",
                userAgent: "fake",
              },
            }),
          ];
        }
        if (msg.method === "model/list") {
          return [
            JSON.stringify({
              id: msg.id,
              result: {
                data: [
                  {
                    id: "gpt-5.6-sol",
                    model: "gpt-5.6-sol",
                    displayName: "GPT-5.6-Sol",
                    description: "Everyday workhorse",
                    isDefault: true,
                    hidden: false,
                    defaultReasoningEffort: "medium",
                    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
                  },
                ],
                nextCursor: null,
              },
            }),
          ];
        }
        return [];
      });
    return ok(out.join("\n"));
  }
  return { stdout: "", stderr: "unknown", exitCode: 1 };
};

describe("discovery registry", () => {
  it("registers the Codex adapter", () => {
    const adapters = listDiscoveryAdapters();
    expect(adapters.map((a) => a.agent)).toContain("codex");
    const codex = getDiscoveryAdapter("codex");
    expect(codex?.executable).toBe("codex");
    expect(codex?.installGuidance).toContain("npm install -g");
    expect(codex?.loginGuidance).toContain("codex login");
  });

  it("registers the OpenCode adapter", () => {
    const opencode = getDiscoveryAdapter("opencode");
    expect(opencode?.executable).toBe("opencode");
    expect(opencode?.installGuidance).toContain("opencode-ai");
    expect(opencode?.loginGuidance).toContain("opencode auth login");
  });

  it("returns undefined for agents without an adapter", async () => {
    expect(getDiscoveryAdapter("claude-code")).toBeUndefined();
    // Pi, Claude & friends are later tickets — they resolve to `undefined`
    // so init keeps them on the static path for now.
    expect(await discoverAgent("pi", READY_EXEC)).toBeUndefined();
  });

  it("discovers a ready codex through the injected boundary", async () => {
    const report = await discoverAgent("codex", READY_EXEC);
    expect(report?.state).toBe("ready");
    expect(report?.recommendedModel).toBe("gpt-5.6-sol");
  });

  it("discovers every registered agent in parallel", async () => {
    const reports = await discoverAgents(READY_EXEC);
    expect(reports).toHaveLength(listDiscoveryAdapters().length);
    expect(reports[0]?.agent).toBe("codex");
  });

  it("converts a throwing boundary into an error report instead of rejecting", async () => {
    const throwing: typeof READY_EXEC = async () => {
      throw new Error("spawn imploded");
    };
    const report = await discoverAgent("codex", throwing);
    expect(report?.state).toBe("error");
    expect(report?.guidance).toContain("spawn imploded");
  });

  it("discovers a fake codex executable on PATH through the real boundary", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    const shimPath = join(shimDir, "codex");
    // A node-script fake that answers every probe the adapter runs —
    // including the app-server JSON-RPC exchange over stdin/stdout.
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.join(" ");
if (key === "--version") {
  console.log("codex-cli 0.150.1");
  process.exit(0);
}
if (key === "login status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (key === "app-server") {
  let buf = "";
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => {
    for (const line of buf.split("\\n")) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") {
        console.log(JSON.stringify({ id: msg.id, result: {
          codexHome: "/tmp", platformFamily: "unix",
          platformOs: "macos", userAgent: "fake-codex" } }));
      } else if (msg.method === "model/list") {
        console.log(JSON.stringify({ id: msg.id, result: { data: [{
          id: "gpt-5.6-sol", model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol", description: "Everyday workhorse",
          isDefault: true, hidden: false, defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" }],
        }], nextCursor: null } }));
      }
    }
    // No process.exit — let the loop drain so piped stdout fully flushes,
    // then the process exits on its own once stdin is closed.
  });
} else {
  process.exit(1);
}
`,
    );
    await chmod(shimPath, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    try {
      const report = await discoverAgent("codex", nodeDiscoveryExec);
      expect(report?.state).toBe("ready");
      expect(report?.version).toBe("0.150.1");
      expect(report?.models.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
    } finally {
      process.env.PATH = oldPath;
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});

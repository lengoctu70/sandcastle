import { describe, expect, it } from "vitest";
import type {
  DiscoveryExec,
  DiscoveryExecResult,
} from "./discovery/contract.js";
import { createSandcastleLabel, probeGhReadiness } from "./githubSetup.js";

/**
 * Typed-outcome tests for the init/run `gh` probes (F044/F069) and label
 * creation. Every case injects a fake {@link DiscoveryExec} — the default
 * exec is the shell-free `nodeGhRunner` adapter covered in
 * githubIssues.test.ts.
 */

type Probe = Partial<DiscoveryExecResult>;

/** Fake exec answering per `command args` key, unmatched calls fail loudly. */
const execOf = (
  answers: Record<string, Probe>,
): { readonly exec: DiscoveryExec; readonly calls: string[] } => {
  const calls: string[] = [];
  const exec: DiscoveryExec = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const res = answers[key];
    if (res === undefined) {
      throw new Error(`unexpected exec: ${key}`);
    }
    return { stdout: "", stderr: "", exitCode: 0, ...res };
  };
  return { exec, calls };
};

const versionOk: Probe = {
  exitCode: 0,
  stdout: "gh version 2.90.0 (2026-04-16)",
};

const AUTH_OK_STDOUT = `github.com
  ✓ Logged in to github.com account monalisa (keyring)
  ✓ Active account: true
  ✓ Git operations protocol: https
`;

describe("probeGhReadiness", () => {
  it("gh missing on PATH → not-installed", async () => {
    const { exec } = execOf({
      "gh --version": { exitCode: null, spawnError: "ENOENT" },
    });
    await expect(probeGhReadiness(exec)).resolves.toEqual({
      kind: "not-installed",
    });
  });

  it("gh --version spawn failure other than ENOENT → error", async () => {
    const { exec } = execOf({
      "gh --version": { exitCode: null, spawnError: "EACCES" },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.detail).toContain("EACCES");
  });

  it("gh --version timeout → error (not mislabeled)", async () => {
    const { exec } = execOf({
      "gh --version": { exitCode: null, timedOut: true },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.detail).toContain("hết thời gian");
  });

  it("gh --version non-zero exit → error", async () => {
    const { exec } = execOf({
      "gh --version": { exitCode: 1, stderr: "boom" },
    });
    const res = await probeGhReadiness(exec);
    expect(res).toEqual({ kind: "error", detail: "boom" });
  });

  it("gh auth status timeout → error, NOT unauthenticated (no false login advice)", async () => {
    const { exec } = execOf({
      "gh --version": versionOk,
      "gh auth status": { exitCode: null, timedOut: true },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.detail).toContain("hết thời gian");
  });

  it("gh auth status spawn failure → error, NOT unauthenticated", async () => {
    const { exec } = execOf({
      "gh --version": versionOk,
      "gh auth status": { exitCode: null, spawnError: "ENOENT" },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("error");
  });

  it("gh auth status non-zero → unauthenticated with gh's detail", async () => {
    const { exec } = execOf({
      "gh --version": versionOk,
      "gh auth status": {
        exitCode: 1,
        stderr: "You are not logged into any GitHub hosts.",
      },
    });
    const res = await probeGhReadiness(exec);
    expect(res).toEqual({
      kind: "unauthenticated",
      detail: "You are not logged into any GitHub hosts.",
    });
  });

  it("ready → authDetail names the account AND host, not just the hostname", async () => {
    const { exec } = execOf({
      "gh --version": versionOk,
      "gh auth status": { exitCode: 0, stdout: AUTH_OK_STDOUT },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("ready");
    if (res.kind !== "ready") return;
    expect(res.version).toBe("2.90.0");
    expect(res.authDetail).toContain("monalisa");
    expect(res.authDetail).toContain("github.com");
    // Credentials are never surfaced — the logged-in line carries no token.
    expect(res.authDetail).not.toMatch(/gho_|ghp_|token=/i);
  });

  it("ready → authDetail falls back to the first output line when no logged-in line exists", async () => {
    const { exec } = execOf({
      "gh --version": versionOk,
      "gh auth status": { exitCode: 0, stdout: "github.com\n  some detail" },
    });
    const res = await probeGhReadiness(exec);
    expect(res.kind).toBe("ready");
    if (res.kind === "ready") {
      expect(res.authDetail).toBe("github.com");
    }
  });
});

describe("createSandcastleLabel", () => {
  const LABEL_CREATE =
    "gh label create Sandcastle --description Issues for Sandcastle to work on --color F9A825";

  it("exit 0 → created", async () => {
    const { exec, calls } = execOf({ [LABEL_CREATE]: { exitCode: 0 } });
    await expect(createSandcastleLabel(exec)).resolves.toEqual({
      kind: "created",
    });
    expect(calls).toEqual([LABEL_CREATE]);
  });

  it("'already exists' → already-exists (a fine outcome)", async () => {
    const { exec } = execOf({
      [LABEL_CREATE]: {
        exitCode: 1,
        stderr: "the label 'Sandcastle' already exists",
      },
    });
    await expect(createSandcastleLabel(exec)).resolves.toEqual({
      kind: "already-exists",
    });
  });

  it("HTTP 403 → forbidden — a distinct typed permission outcome", async () => {
    const { exec } = execOf({
      [LABEL_CREATE]: {
        exitCode: 1,
        stderr: "gh: Resource not accessible by integration (HTTP 403)",
      },
    });
    const res = await createSandcastleLabel(exec);
    expect(res.kind).toBe("forbidden");
    expect(res.kind === "forbidden" && res.detail).toContain("HTTP 403");
  });

  it("other failures → failed with gh's error line", async () => {
    const { exec } = execOf({
      [LABEL_CREATE]: {
        exitCode: 1,
        stderr: "gh: failed to create label: no git remote found",
      },
    });
    const res = await createSandcastleLabel(exec);
    expect(res.kind).toBe("failed");
    expect(res.kind === "failed" && res.detail).toContain("no git remote");
  });

  it("timeout → error transport outcome, not a verdict", async () => {
    const { exec } = execOf({
      [LABEL_CREATE]: { exitCode: null, timedOut: true },
    });
    const res = await createSandcastleLabel(exec);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.detail).toContain("hết thời gian");
  });

  it("spawn failure → error transport outcome", async () => {
    const { exec } = execOf({
      [LABEL_CREATE]: { exitCode: null, spawnError: "ENOENT" },
    });
    const res = await createSandcastleLabel(exec);
    expect(res.kind).toBe("error");
  });
});

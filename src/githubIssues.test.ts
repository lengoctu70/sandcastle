import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryExecResult } from "./discovery/contract.js";
import {
  GithubCliError,
  hasSandcastleLabel,
  makeGithubIssueOps,
  nodeGhRunner,
  type GithubCliErrorKind,
  type GhRunner,
} from "./githubIssues.js";

/**
 * Runner-seam tests for the `gh` boundary (F001/F029/F032/F043).
 *
 * Two layers are covered:
 * - `makeGithubIssueOps` through an injected fake {@link GhRunner} — asserts
 *   literal argv and stdin on every platform (CI is ubuntu-only, but these
 *   tests are platform-agnostic, so the same contract also runs on Windows
 *   CI): report bodies travel via `--body-file -`/stdin and are never
 *   interpolated into a command string.
 * - `nodeGhRunner` against a real PATH shim — asserts `spawn` is invoked
 *   with NO `shell` option (so Windows never gets `cmd.exe` either) and that
 *   an adversarial body cannot trigger secondary command execution.
 */

// Wrap real spawn so tests can inspect the options nodeGhRunner passes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnMock = vi.mocked(spawn);

// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly args: readonly string[];
  readonly stdin?: string;
}

/** A fake {@link GhRunner} recording every call and answering via `handler`. */
const fakeRunner = (
  handler: (args: readonly string[]) => Partial<DiscoveryExecResult>,
): { readonly calls: RecordedCall[]; readonly runner: GhRunner } => {
  const calls: RecordedCall[] = [];
  const runner: GhRunner = async (args, options) => {
    calls.push({ args, stdin: options.stdin });
    return { stdout: "", stderr: "", exitCode: 0, ...handler(args) };
  };
  return { calls, runner };
};

const ok = (stdout: string): Partial<DiscoveryExecResult> => ({
  stdout,
  exitCode: 0,
});

const expectGhError = async (
  promise: Promise<unknown>,
  kind: GithubCliErrorKind,
): Promise<GithubCliError> => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GithubCliError);
  expect((err as GithubCliError).kind).toBe(kind);
  return err as GithubCliError;
};

const ISSUE_5_JSON = JSON.stringify({
  number: 5,
  title: "Add a greeting file",
  body: "Please add a greeting.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/5",
});

// ---------------------------------------------------------------------------

describe("postComment", () => {
  it("sends the body on stdin via --body-file -, verbatim, with nothing on the command line", async () => {
    const { calls, runner } = fakeRunner(() => ok("commented"));
    const ops = makeGithubIssueOps("/repo", runner);
    // Multiline, shell metacharacters, percent signs, Unicode, and a payload
    // beyond the Windows 8,191-char command-line limit.
    const body =
      "## ✅ Sandcastle đã hoàn thành\n" +
      "line <tag> & | ^ ` $(x) %PATH% 100% — tiếng Việt 中文 🚀\n" +
      "& touch /tmp/should-never-exist\n" +
      "x".repeat(9_000);

    await ops.postComment(5, body);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "issue",
      "comment",
      "5",
      "--body-file",
      "-",
    ]);
    expect(calls[0]!.args).not.toContain("--body");
    expect(calls[0]!.stdin).toBe(body);
  });
});

describe("labelExists", () => {
  const labelArgs = (calls: RecordedCall[]) => calls[0]!.args.join(" ");

  it("queries with --search (not a blanket 200-label page) and matches case-insensitively", async () => {
    const { calls, runner } = fakeRunner(() =>
      ok(JSON.stringify([{ name: "sandcastle" }, { name: "other" }])),
    );
    const ops = makeGithubIssueOps("/repo", runner);

    await expect(ops.labelExists()).resolves.toBe(true);
    expect(labelArgs(calls)).toContain("--search Sandcastle");
  });

  it("returns false when no returned label matches, still case-insensitively", async () => {
    const { runner } = fakeRunner(() =>
      ok(JSON.stringify([{ name: "sandcastle-extra" }, { name: "bug" }])),
    );
    const ops = makeGithubIssueOps("/repo", runner);
    await expect(ops.labelExists()).resolves.toBe(false);
  });

  it("throws a typed malformed-json error instead of reporting the label missing", async () => {
    const { runner } = fakeRunner(() => ok("<html>proxy error</html>"));
    const ops = makeGithubIssueOps("/repo", runner);
    const err = await expectGhError(ops.labelExists(), "malformed-json");
    expect(err.message).toContain("JSON");
  });
});

describe("listEligibleIssues / viewIssue", () => {
  it("listEligibleIssues maps issue JSON, tolerating entry shape drift", async () => {
    const { runner } = fakeRunner(() => ok(`[${ISSUE_5_JSON}]`));
    const ops = makeGithubIssueOps("/repo", runner);
    const issues = await ops.listEligibleIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      number: 5,
      title: "Add a greeting file",
      labels: ["Sandcastle"],
    });
  });

  it("listEligibleIssues reports malformed JSON as a typed GithubCliError", async () => {
    const { runner } = fakeRunner(() => ok("not json at all"));
    const ops = makeGithubIssueOps("/repo", runner);
    await expectGhError(ops.listEligibleIssues(), "malformed-json");
  });

  it("viewIssue reports malformed JSON as a typed GithubCliError", async () => {
    const { runner } = fakeRunner(() => ok("{not json"));
    const ops = makeGithubIssueOps("/repo", runner);
    await expectGhError(ops.viewIssue(5), "malformed-json");
  });

  it("viewIssue reports a valid-JSON-but-wrong-shape response as malformed-json", async () => {
    const { runner } = fakeRunner(() => ok(`{"title":"no number"}`));
    const ops = makeGithubIssueOps("/repo", runner);
    await expectGhError(ops.viewIssue(5), "malformed-json");
  });

  it("viewIssue parses a full issue payload", async () => {
    const { runner } = fakeRunner(() => ok(ISSUE_5_JSON));
    const ops = makeGithubIssueOps("/repo", runner);
    const issue = await ops.viewIssue(5);
    expect(issue).toMatchObject({ number: 5, state: "OPEN" });
  });
});

describe("typed gh failures", () => {
  const failing = (res: Partial<DiscoveryExecResult>) =>
    fakeRunner(() => res).runner;

  it("timeout → kind 'timeout' with retry guidance", async () => {
    const ops = makeGithubIssueOps(
      "/repo",
      failing({ exitCode: null, timedOut: true }),
    );
    const err = await expectGhError(ops.viewIssue(5), "timeout");
    expect(err.message).toContain("hết thời gian");
  });

  it("spawn failure → kind 'spawn-failure' with install guidance", async () => {
    const ops = makeGithubIssueOps(
      "/repo",
      failing({ exitCode: null, spawnError: "ENOENT" }),
    );
    const err = await expectGhError(ops.labelExists(), "spawn-failure");
    expect(err.message).toContain("ENOENT");
    expect(err.message).toContain("PATH");
  });

  it("auth diagnostics → kind 'unauthenticated' with `gh auth login` guidance", async () => {
    const ops = makeGithubIssueOps(
      "/repo",
      failing({
        exitCode: 1,
        stderr:
          "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
      }),
    );
    const err = await expectGhError(ops.postComment(5, "x"), "unauthenticated");
    expect(err.message).toContain("gh auth login");
  });

  it("HTTP 403 diagnostics → kind 'permission' with repository-access guidance", async () => {
    const ops = makeGithubIssueOps(
      "/repo",
      failing({
        exitCode: 1,
        stderr: "gh: Resource not accessible by integration (HTTP 403)",
      }),
    );
    const err = await expectGhError(ops.closeIssue(5), "permission");
    expect(err.message).toContain("quyền");
  });

  it("other non-zero exits → kind 'exit' carrying gh's own error line", async () => {
    const ops = makeGithubIssueOps(
      "/repo",
      failing({ exitCode: 1, stderr: "GraphQL: something else broke" }),
    );
    const err = await expectGhError(ops.closeIssue(5), "exit");
    expect(err.message).toContain("something else broke");
  });
});

describe("hasSandcastleLabel", () => {
  it("matches GitHub's case-insensitive label semantics", () => {
    expect(hasSandcastleLabel(["sandcastle"])).toBe(true);
    expect(hasSandcastleLabel(["SANDCASTLE"])).toBe(true);
    expect(hasSandcastleLabel(["Sandcastle"])).toBe(true);
    expect(hasSandcastleLabel(["bug", "sandcastle"])).toBe(true);
    expect(hasSandcastleLabel(["sandcastle-extra"])).toBe(false);
    expect(hasSandcastleLabel([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("nodeGhRunner (real spawn boundary)", () => {
  it("spawns gh with fixed argv, no shell, and delivers stdin verbatim", async () => {
    // POSIX shim only: on Windows a bare extensionless script cannot be
    // spawned (real gh is gh.exe). The spawn-options assertions below — no
    // `shell` key, piped stdin — are exactly the Windows contract too, and
    // the injected-runner tests above run on every platform.
    if (process.platform === "win32") return;
    spawnMock.mockClear();

    const shimDir = await mkdtemp(join(tmpdir(), "gh-shim-"));
    const captureFile = join(shimDir, "capture.json");
    const canary = join(shimDir, "secondary-command-executed");
    await writeFile(
      join(shimDir, "gh"),
      `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  process.exit(0);
});
`,
    );
    await chmod(join(shimDir, "gh"), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${prevPath ?? ""}`;
    try {
      const body =
        "dòng 1 <tag> & | ^ %PATH%\n" +
        `& touch ${canary}\n` +
        "x".repeat(9_000);
      const res = await nodeGhRunner(
        ["issue", "comment", "5", "--body-file", "-"],
        { cwd: shimDir, stdin: body },
      );

      expect(res.exitCode).toBe(0);
      const captured = JSON.parse(await readFile(captureFile, "utf-8")) as {
        argv: string[];
        stdin: string;
      };
      expect(captured.argv).toEqual([
        "issue",
        "comment",
        "5",
        "--body-file",
        "-",
      ]);
      expect(captured.stdin).toBe(body);
      // No secondary command execution: the metacharacter line stayed data.
      expect(existsSync(canary)).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }

    const call = spawnMock.mock.calls.find((c) => c[0] === "gh");
    expect(call).toBeDefined();
    const options = call![2] as Record<string, unknown>;
    // The whole point of the fix — there is no command shell on ANY platform.
    expect(options).not.toHaveProperty("shell");
    expect(options["stdio"]).toEqual(["pipe", "pipe", "pipe"]);
  });
});

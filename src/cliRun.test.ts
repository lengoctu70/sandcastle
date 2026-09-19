import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

// ---------------------------------------------------------------------------
// Fixtures — temporary git repo + fake `gh`/`claude` executables on PATH.
// No real GitHub account, agent CLI, or subscription is ever touched (the
// spec's testing decisions replace them at the process boundary).
// ---------------------------------------------------------------------------

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const git = async (dir: string, args: string) =>
  (await execAsync(`git ${args}`, { cwd: dir })).stdout.trim();

/** Minimal `.sandcastle/settings.json` for the github-issues + host-mode run. */
const writeSettings = async (
  dir: string,
  overrides: Record<string, unknown> = {},
) => {
  await mkdir(join(dir, ".sandcastle"), { recursive: true });
  await writeFile(
    join(dir, ".sandcastle", "settings.json"),
    JSON.stringify({
      version: 1,
      agent: "claude-code",
      model: "fake-model",
      modelSource: "manual-unverified",
      workflow: "simple-loop",
      sandbox: "host",
      verificationCommands: [],
      parallelism: 1,
      issueTracker: "github-issues",
      ...overrides,
    }),
  );
};

/** PATH with the shim dirs first plus node's own dir (for /usr/bin/env node). */
const shimmedPath = (...shimDirs: string[]) =>
  `${shimDirs.join(":")}:${dirname(process.execPath)}:${process.env.PATH}`;

/**
 * Fake `gh` — logs every invocation as `gh <args>` to $FAKE_GH_LOG so tests
 * can assert mutation order, and answers the exact subcommands the run
 * workflow issues. Driven by env:
 * - FAKE_GH_AUTH="1" → `auth status` succeeds
 * - FAKE_GH_LABEL="1" → `label list` reports the Sandcastle label
 * - FAKE_GH_ISSUES  → path to a JSON array of issues
 * - FAKE_GH_COMMENT_FAIL / FAKE_GH_CLOSE_FAIL → those mutations exit 1
 */
const writeFakeGh = async (dir: string) => {
  const shim = join(dir, "gh");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const key = args.join(" ");
const log = process.env.FAKE_GH_LOG;
if (log) fs.appendFileSync(log, "gh " + key + "\\n");
if (key === "--version") { console.log("gh version 2.90.0"); process.exit(0); }
if (key === "auth status") {
  if (process.env.FAKE_GH_AUTH === "1") {
    console.log("github.com\\n  ✓ Logged in to github.com as test");
    process.exit(0);
  }
  console.error("You are not logged into any GitHub hosts.");
  process.exit(1);
}
if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify(process.env.FAKE_GH_LABEL === "1" ? [{ name: "Sandcastle" }] : []));
  process.exit(0);
}
const issues = () => JSON.parse(fs.readFileSync(process.env.FAKE_GH_ISSUES, "utf-8"));
if (args[0] === "issue" && args[1] === "list") {
  const open = issues().filter((i) => i.state === "OPEN" && (i.labels || []).some((l) => l.name === "Sandcastle"));
  console.log(JSON.stringify(open));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const n = parseInt(args[2], 10);
  const issue = issues().find((i) => i.number === n);
  if (!issue) { console.error("no issue found"); process.exit(1); }
  console.log(JSON.stringify(issue));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "comment") {
  if (process.env.FAKE_GH_COMMENT_FAIL === "1") { console.error("comment denied"); process.exit(1); }
  console.log("commented");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  if (process.env.FAKE_GH_CLOSE_FAIL === "1") { console.error("close denied"); process.exit(1); }
  console.log("closed");
  process.exit(0);
}
console.error("unexpected gh args: " + key);
process.exit(1);
`,
  );
  await chmod(shim, 0o755);
};

/**
 * Fake `claude` — the claude-code print-mode contract: reads the prompt from
 * stdin, does the "implementation" (creates a file + commits it on the
 * current branch inside the worktree), then emits stream-json lines the
 * provider parses (init session_id, assistant text, result carrying the
 * completion signal). `FAKE_CLAUDE_FAIL=1` exits non-zero without committing.
 * Also appends `AGENT` to $FAKE_GH_LOG so the shared log orders
 * implement→verify→merge→report→close, and dumps the received prompt to
 * $FAKE_AGENT_PROMPT so tests can assert the immutable issue data arrived.
 */
const writeFakeClaude = async (dir: string) => {
  const shim = join(dir, "claude");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");
let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const log = process.env.FAKE_GH_LOG;
  if (log) fs.appendFileSync(log, "AGENT\\n");
  const promptOut = process.env.FAKE_AGENT_PROMPT;
  if (promptOut) fs.writeFileSync(promptOut, buf);
  if (process.env.FAKE_CLAUDE_FAIL === "1") {
    console.log(JSON.stringify({ type: "result", result: "agent exploded" }));
    process.exit(1);
  }
  const name = process.env.FAKE_AGENT_FILE || "agent-work.txt";
  fs.writeFileSync(name, "implemented\\n");
  cp.execSync("git add -A && git commit -m \\"implement the issue\\"", {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session-1" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "implemented the issue" }] } }));
  console.log(JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>", session_id: "fake-session-1" }));
});
`,
  );
  await chmod(shim, 0o755);
};

interface FixtureEnv {
  readonly repoDir: string;
  readonly shimDir: string;
  readonly logFile: string;
  readonly issuesFile: string;
  readonly promptFile: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Temp repo + fake gh/claude + a shared call log. `issues` may be empty. */
const makeFixture = async (
  issues: readonly Record<string, unknown>[],
  envOverrides: Record<string, string> = {},
): Promise<FixtureEnv> => {
  const repoDir = await mkdtemp(join(tmpdir(), "run-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");

  const shimDir = await mkdtemp(join(tmpdir(), "run-shims-"));
  await writeFakeGh(shimDir);
  await writeFakeClaude(shimDir);

  const logFile = join(repoDir, "calls.log");
  const issuesFile = join(repoDir, "issues.json");
  const promptFile = join(repoDir, "agent-prompt.txt");
  await writeFile(issuesFile, JSON.stringify(issues));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: shimmedPath(shimDir),
    FAKE_GH_LOG: logFile,
    FAKE_GH_ISSUES: issuesFile,
    FAKE_AGENT_PROMPT: promptFile,
    FAKE_GH_AUTH: "1",
    FAKE_GH_LABEL: "1",
    ...envOverrides,
  };
  return { repoDir, shimDir, logFile, issuesFile, promptFile, env };
};

const runCli = (args: string, cwd: string, env: NodeJS.ProcessEnv) =>
  execAsync(`node ${cliPath} ${args}`, { cwd, env });

const readLog = async (logFile: string): Promise<string[]> =>
  (await readFile(logFile, "utf-8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const ISSUE_5 = {
  number: 5,
  title: "Add a greeting file",
  body: "Please add a greeting.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/5",
};

// ---------------------------------------------------------------------------

describe("sandcastle run (CLI seam, fake gh + fake agent)", () => {
  it("happy path: implement → verify → merge → report → close, in that order", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}"`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    const { stdout } = await runCli("run --issue 5", repoDir, env);

    const log = await readLog(logFile);
    const ghCalls = log.filter((l) => l.startsWith("gh "));
    // Preflight order: install probe → auth probe → label check → issue view.
    expect(ghCalls[0]).toBe("gh --version");
    expect(ghCalls[1]).toBe("gh auth status");
    expect(ghCalls[2]).toContain("gh label list");
    expect(ghCalls[3]).toContain("gh issue view 5");

    // Mutation order: the agent ran before verification, verification ran
    // (source + integrated) before the report, and the issue closed last.
    const idx = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
    const agentIdx = idx("AGENT");
    const verifyIdxs = log
      .map((l, i) => (l === "VERIFY" ? i : -1))
      .filter((i) => i >= 0);
    const commentIdx = idx("gh issue comment");
    const closeIdx = idx("gh issue close");
    expect(agentIdx).toBeGreaterThan(-1);
    expect(verifyIdxs.length).toBe(2); // source worktree + integrated worktree
    expect(commentIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeLessThan(verifyIdxs[0]!);
    expect(verifyIdxs[0]!).toBeLessThan(verifyIdxs[1]!);
    expect(verifyIdxs[1]!).toBeLessThan(commentIdx);
    expect(commentIdx).toBeLessThan(closeIdx);

    // The report is posted before close and carries the landed sha (proof it
    // ran after landing). The body is multi-line, so check the raw log slice
    // between the comment call and the close call.
    const raw = await readFile(logFile, "utf-8");
    expect(raw).toContain("Sandcastle đã hoàn thành");
    const landedSha = await git(repoDir, "rev-parse refs/heads/main");
    const commentPos = raw.indexOf("gh issue comment");
    const closePos = raw.indexOf("gh issue close");
    expect(commentPos).toBeGreaterThan(-1);
    expect(closePos).toBeGreaterThan(commentPos);
    expect(raw.indexOf(landedSha.slice(0, 8))).toBeGreaterThan(commentPos);
    expect(raw.indexOf(landedSha.slice(0, 8))).toBeLessThan(closePos);

    // The agent received the immutable selected-issue identity — number,
    // title, body — plus the no-issue-mutation rule, and nothing else
    // (no template substitution markers leaked through).
    const agentPrompt = await readFile(
      join(repoDir, "agent-prompt.txt"),
      "utf-8",
    );
    expect(agentPrompt).toContain("issue #5");
    expect(agentPrompt).toContain("Add a greeting file");
    expect(agentPrompt).toContain("Please add a greeting.");
    expect(agentPrompt).toContain("Do NOT run `gh issue close`");
    expect(agentPrompt).toContain("sandcastle/issue-5");

    // Landing: the agent's commit is on main, temp state is cleaned up.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    const branches = await git(repoDir, "branch --list");
    expect(branches).not.toContain("sandcastle/issue-5");
    expect(branches).not.toContain("integrate");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);

    // Vietnamese completion status + non-interactive success exit.
    expect(stdout).toContain("Hoàn thành issue #5");
    expect(stdout).toContain("đã được đóng");
  });

  it("verification failure: posts a Vietnamese failure report, keeps the issue open, merges nothing", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    // Implement ran, verify failed, a comment was posted, close never ran.
    expect(log).toContain("AGENT");
    expect(log).toContain("VERIFY");
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);
    const commentLine = log.find((l) => l.startsWith("gh issue comment"))!;
    expect(commentLine).toContain("không hoàn thành");

    // Nothing landed on main; the failure state is preserved for recovery.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).not.toContain("agent-work.txt");
    const recovery = JSON.parse(
      await readFile(
        join(repoDir, ".sandcastle", "recovery", "issue-5.json"),
        "utf-8",
      ),
    );
    expect(recovery).toMatchObject({
      failurePhase: "verification",
      sourceBranch: "sandcastle/issue-5",
      issue: { number: 5 },
    });
    // The preserved source worktree stays on disk with the branch.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).toContain("sandcastle-issue-5");
    const settings = JSON.parse(
      await readFile(join(repoDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.verificationStatus).toBe("failed");
  });

  it("merge conflict: stops safely, never leaves the active checkout conflicted, issue stays open", async () => {
    const { repoDir, logFile, env } = await makeFixture([
      { ...ISSUE_5, number: 7 },
    ]);
    await writeSettings(repoDir);

    // Pre-seed the deterministic source branch with a commit that conflicts
    // with a newer commit on main — the integration merge must collide.
    await execAsync("git checkout -b sandcastle/issue-7", { cwd: repoDir });
    await commitFile(repoDir, "hello.txt", "branch version\n", "branch change");
    await execAsync("git checkout main", { cwd: repoDir });
    await commitFile(repoDir, "hello.txt", "main version\n", "main change");

    await expect(runCli("run --issue 7", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    expect(log.some((l) => l.startsWith("gh issue comment 7"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);

    // The active checkout is untouched and unconflicted — no unmerged index
    // entries, no MERGE_HEAD, main still has its own version of the file.
    expect(await git(repoDir, "ls-files -u")).toBe("");
    expect(
      await git(repoDir, "rev-parse -q --verify MERGE_HEAD").catch(
        () => "none",
      ),
    ).toBe("none");
    expect(await git(repoDir, "rev-parse --abbrev-ref HEAD")).toBe("main");
    const content = await readFile(join(repoDir, "hello.txt"), "utf-8");
    expect(content).toBe("main version\n");
    // No leftover integration worktree.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).not.toContain("integrate");
    // Recovery state preserves the failure for later retry.
    const recovery = JSON.parse(
      await readFile(
        join(repoDir, ".sandcastle", "recovery", "issue-7.json"),
        "utf-8",
      ),
    );
    expect(recovery.failurePhase).toBe("integration");
  });

  it("reports no eligible issues and exits 0 when the Sandcastle label has none", async () => {
    const { repoDir, env } = await makeFixture([]);
    await writeSettings(repoDir);

    const { stdout } = await runCli("run", repoDir, env);
    expect(stdout).toContain("Không có issue nào đang mở");
  });

  it("requires --issue in non-interactive mode when eligible issues exist", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);

    try {
      await runCli("run", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--issue");
    }
  });

  it("fails fast with login guidance when gh is unauthenticated", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5], {
      FAKE_GH_AUTH: "0",
    });
    await writeSettings(repoDir);

    try {
      await runCli("run --issue 5", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("gh auth login");
    }
    // Auth failure stops before any issue mutation.
    const log = await readLog(logFile);
    expect(log.some((l) => l.startsWith("gh issue comment"))).toBe(false);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);
  });

  it("fails fast when the Sandcastle label does not exist", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5], {
      FAKE_GH_LABEL: "0",
    });
    await writeSettings(repoDir);

    try {
      await runCli("run --issue 5", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain('label "Sandcastle"');
    }
  });

  it("rejects a --issue that lacks the Sandcastle label", async () => {
    const { repoDir, env } = await makeFixture([{ ...ISSUE_5, labels: [] }]);
    await writeSettings(repoDir);

    try {
      await runCli("run --issue 5", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("#5");
      expect(stdout + stderr).toContain("Sandcastle");
    }
  });

  it("run --help exposes --issue", async () => {
    const { stdout } = await runCli("run --help", process.cwd(), process.env);
    expect(stdout).toContain("--issue");
  });
});

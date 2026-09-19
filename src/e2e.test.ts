import { exec } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

// ---------------------------------------------------------------------------
// End-to-end tests for the complete non-code workflow (#21, spec #1):
//
//   install → `sandcastle init` (real CLI, non-interactive flags, host mode,
//   github-issues tracker, label) → `npm run sandcastle` / `sandcastle run
//   --issue N` → implement → verify → land → Vietnamese report → issue close
//   → (on failure) recovery record → status → retry → discard-level cleanup.
//
// Everything external is faked at the process boundary — a fake `gh` and a
// fake `claude` on PATH — so no real GitHub account, agent CLI, or
// subscription is ever touched. Unlike cliRun.test.ts, these tests never
// write settings.json by hand: the real `init` command produces it, which is
// what makes this an end-to-end check of the shipped journey.
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

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** PATH with the shim dir first plus node's own dir (for /usr/bin/env node). */
const shimmedPath = (shimDir: string) =>
  `${shimDir}:${dirname(process.execPath)}:${process.env.PATH}`;

/**
 * Fake `gh` covering BOTH the init and run command surfaces. Every invocation
 * is logged as `gh <args>` to $FAKE_GH_LOG so tests can assert call order.
 * Answers:
 * - `--version` / `auth status` (install + login probes)
 * - `label create` / `label list --json` (init label setup + run preflight)
 * - `issue list|view --json` (selection; data from $FAKE_GH_ISSUES)
 * - `issue comment` / `issue close` — `close` also mutates the issues file so
 *   the fake tracker honestly reflects the close mutation afterwards.
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
const issuesPath = () => process.env.FAKE_GH_ISSUES;
const issues = () => JSON.parse(fs.readFileSync(issuesPath(), "utf-8"));
if (key === "--version") { console.log("gh version 2.90.0"); process.exit(0); }
if (key === "auth status") {
  console.log("github.com\\n  ✓ Logged in to github.com as test");
  process.exit(0);
}
if (args[0] === "label" && args[1] === "create") {
  console.log("✓ Label created"); process.exit(0);
}
if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify([{ name: "Sandcastle" }]));
  process.exit(0);
}
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
  console.log("commented");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  const n = parseInt(args[2], 10);
  const all = issues().map((i) => (i.number === n ? { ...i, state: "CLOSED" } : i));
  fs.writeFileSync(issuesPath(), JSON.stringify(all));
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
 * Fake `claude` covering BOTH the init discovery probes (`--version` product
 * fingerprint, `auth status` JSON login check) and the print-mode contract
 * the run workflow uses (`claude --print … -p -` with the prompt on stdin):
 * it "implements" by creating a file and committing it in the worktree, then
 * emits the stream-json lines the provider parses (init session_id, result
 * carrying the completion signal).
 *
 * Session/resume bookkeeping mirrors the real CLI: each invocation writes
 * `$HOME/.claude/projects/<enc-cwd>/<session>.jsonl` so the resume precheck
 * finds it later, and `--resume <id>` is logged as `AGENT_RESUME <id>`.
 *
 * Verification-repair gate for the failure-then-retry test: a
 * `# Verification repair` prompt only writes `verify-ok.flag` when
 * `FAKE_AGENT_FIXED=1`, so the same agent "fixes" the verification failure
 * only once the test flips the env — modelling "the agent now fixed".
 */
const writeFakeClaude = async (dir: string) => {
  const shim = join(dir, "claude");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");
const path = require("path");
const args = process.argv.slice(2);
const key = args.join(" ");
// Discovery probes (sandcastle init, host mode).
if (key === "--version") {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}
if (key === "auth status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth" }));
  process.exit(0);
}
// Print mode — the run workflow's agent invocation (prompt on stdin).
let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const log = process.env.FAKE_GH_LOG;
  const prior = log && fs.existsSync(log)
    ? fs.readFileSync(log, "utf-8").split("\\n").filter((l) => l === "AGENT" || l.startsWith("AGENT_RESUME")).length
    : 0;
  const n = prior + 1;
  const sessionId = "fake-session-" + n;
  const resumeIdx = args.indexOf("--resume");
  const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
  if (log) fs.appendFileSync(log, resumed ? "AGENT_RESUME " + resumed + "\\n" : "AGENT\\n");
  const promptOut = process.env.FAKE_AGENT_PROMPT;
  if (promptOut) fs.appendFileSync(promptOut, "\\n===PROMPT " + n + "===\\n" + buf);
  const home = process.env.HOME;
  if (home) {
    const enc = process.cwd().replace(/^([A-Za-z]):/, "$1").replace(/[\\\\/]/g, "-");
    const dir = path.join(home, ".claude", "projects", enc);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId + ".jsonl"), JSON.stringify({ cwd: process.cwd() }) + "\\n");
  }
  const cwd = process.cwd();
  if (buf.includes("# Verification repair") && process.env.FAKE_AGENT_FIXED === "1") {
    fs.writeFileSync(path.join(cwd, "verify-ok.flag"), "ok\\n");
  }
  fs.writeFileSync(path.join(cwd, "agent-work.txt"), "implemented " + n + "\\n");
  cp.execSync("git add -A && git commit -m \\"agent work " + n + "\\"", { cwd, stdio: "ignore" });
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "worked" }] } }));
  console.log(JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>", session_id: sessionId }));
  process.exit(0);
});
`,
  );
  await chmod(shim, 0o755);
};

interface FixtureEnv {
  readonly repoDir: string;
  readonly shimDir: string;
  /** Fake $HOME — the fake agent writes resumable session files under it. */
  readonly fakeHome: string;
  readonly logFile: string;
  readonly issuesFile: string;
  readonly promptFile: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Temp repo + fake gh/claude + a shared call log + fake issue data. */
const makeFixture = async (
  issues: readonly Record<string, unknown>[],
  envOverrides: Record<string, string> = {},
): Promise<FixtureEnv> => {
  const repoDir = await mkdtemp(join(tmpdir(), "e2e-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  // A real project ignores node_modules — committed so the worktree's
  // `git add -A` never bundles host dependencies (or the .bin shim) into
  // the source branch, where they would collide at merge time.
  await commitFile(repoDir, ".gitignore", "node_modules/\n", "gitignore");

  const shimDir = await mkdtemp(join(tmpdir(), "e2e-shims-"));
  await writeFakeGh(shimDir);
  await writeFakeClaude(shimDir);

  // A private HOME so the fake agent's session files — and the resume
  // precheck's `~/.claude/projects/*/id.jsonl` scan — stay inside the fixture.
  const fakeHome = await mkdtemp(join(tmpdir(), "e2e-home-"));

  const logFile = join(repoDir, "calls.log");
  const issuesFile = join(repoDir, "issues.json");
  const promptFile = join(repoDir, "agent-prompt.txt");
  await writeFile(issuesFile, JSON.stringify(issues));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: shimmedPath(shimDir),
    HOME: fakeHome,
    FAKE_GH_LOG: logFile,
    FAKE_GH_ISSUES: issuesFile,
    FAKE_AGENT_PROMPT: promptFile,
    ...envOverrides,
  };
  return { repoDir, shimDir, fakeHome, logFile, issuesFile, promptFile, env };
};

const runCli = (args: string, cwd: string, env: NodeJS.ProcessEnv) =>
  execAsync(`node ${cliPath} ${args}`, { cwd, env });

const readLog = async (logFile: string): Promise<string[]> =>
  (await readFile(logFile, "utf-8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const readIssues = async (
  issuesFile: string,
): Promise<readonly Record<string, unknown>[]> =>
  JSON.parse(await readFile(issuesFile, "utf-8"));

const recoveryPath = (repoDir: string, issue: number) =>
  join(repoDir, ".sandcastle", "recovery", `issue-${issue}.json`);

const ISSUE_5 = {
  number: 5,
  title: "Add a greeting file",
  body: "Please add a greeting.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/5",
};

// ---------------------------------------------------------------------------

describe("end-to-end: install → init → run → recovery (#21)", () => {
  it("init (non-interactive, host mode, github-issues, label) → npm run sandcastle → implement → verify → land → report → close", async () => {
    if (process.platform === "win32") return; // POSIX shims only
    const { repoDir, logFile, issuesFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> ${logFile}`;

    // 1) The real `init` — fully non-interactive via flags, exactly the
    //    headless counterpart of the Vietnamese quickstart's guided path:
    //    host mode, claude-code agent, github-issues tracker, label create.
    const init = await runCli(
      `init --agent claude-code --model fake-model-1 --template simple-loop ` +
        `--sandbox host --issue-tracker github-issues --create-label true ` +
        `--verification-commands '${verifyCmd}'`,
      repoDir,
      env,
    );
    expect(init.stdout).toContain("Cảnh báo chế độ host");
    expect(init.stdout).toContain("Khởi tạo xong");

    // Init probed gh (install + auth) and created the label, in that order.
    const initLog = await readLog(logFile);
    expect(initLog[0]).toBe("gh --version");
    expect(initLog[1]).toBe("gh auth status");
    expect(initLog[2]).toContain("gh label create Sandcastle");

    // Init wrote a reloadable host-mode config — the run below reads it.
    const settings = JSON.parse(
      await readFile(join(repoDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "claude-code",
      model: "fake-model-1",
      modelSource: "manual-unverified",
      sandbox: "host",
      issueTracker: "github-issues",
      verificationCommands: [verifyCmd],
    });
    const main = await readFile(
      join(repoDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain("noSandbox()");

    // Init added the `"sandcastle": "sandcastle run"` package script — the
    // quickstart's `npm run sandcastle` launch. Wire the package bin so npm
    // resolves `sandcastle` to the REAL built CLI exactly as an installed
    // dependency would, then launch through npm itself.
    const pkg = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf-8"),
    );
    expect(pkg.scripts.sandcastle).toBe("sandcastle run");
    const binDir = join(repoDir, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const binShim = join(binDir, "sandcastle");
    await writeFile(binShim, `#!/bin/sh\nexec node "${cliPath}" "$@"\n`);
    await chmod(binShim, 0o755);

    // 2) `npm run sandcastle -- --issue 5` — the full quickstart path.
    const { stdout } = await execAsync("npm run sandcastle -- --issue 5", {
      cwd: repoDir,
      env,
    });
    expect(stdout).toContain("Hoàn thành issue #5");
    expect(stdout).toContain("đã được đóng");

    // 3) Ordering: gh preflight → agent implement → verify on source →
    //    verify on the integrated tree → completion report → issue close.
    const log = await readLog(logFile);
    const ghCalls = log.filter((l) => l.startsWith("gh "));
    const viewIdx = ghCalls.findIndex((l) => l.startsWith("gh issue view 5"));
    expect(viewIdx).toBeGreaterThan(-1);
    // Run preflight re-probed install/auth/label before viewing the issue.
    expect(ghCalls[viewIdx - 1]).toContain("gh label list");

    const idx = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
    const agentIdx = idx("AGENT");
    const verifyIdxs = log
      .map((l, i) => (l === "VERIFY" ? i : -1))
      .filter((i) => i >= 0);
    const commentIdx = idx("gh issue comment");
    const closeIdx = idx("gh issue close");
    expect(agentIdx).toBeGreaterThan(-1);
    expect(verifyIdxs.length).toBe(2); // source worktree + integrated worktree
    expect(agentIdx).toBeGreaterThan(idx("gh issue view 5"));
    expect(agentIdx).toBeLessThan(verifyIdxs[0]!);
    expect(verifyIdxs[0]!).toBeLessThan(verifyIdxs[1]!);
    expect(verifyIdxs[1]!).toBeLessThan(commentIdx);
    expect(commentIdx).toBeLessThan(closeIdx);

    // The completion report names the landed sha — posted only after
    // landing — and the issue was closed only after the report.
    const raw = await readFile(logFile, "utf-8");
    expect(raw).toContain("Sandcastle đã hoàn thành");
    const landedSha = await git(repoDir, "rev-parse refs/heads/main");
    const commentPos = raw.indexOf("gh issue comment");
    const closePos = raw.indexOf("gh issue close");
    expect(raw.indexOf(landedSha.slice(0, 8))).toBeGreaterThan(commentPos);
    expect(raw.indexOf(landedSha.slice(0, 8))).toBeLessThan(closePos);

    // The issue is actually CLOSED in the tracker — only after landing.
    const issues = await readIssues(issuesFile);
    expect(issues[0]).toMatchObject({ number: 5, state: "CLOSED" });

    // The implementation landed on main; temp branch/worktree are gone.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    const branches = await git(repoDir, "branch --list");
    expect(branches).not.toContain("sandcastle/issue-5");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
  }, 90_000);

  it("run fails verification beyond repair → record + open issue → status lists it → retry with agent fixed → lands, reports, closes → clean", async () => {
    if (process.platform === "win32") return; // POSIX shims only
    // FAKE_AGENT_FIXED unset: repair prompts never produce verify-ok.flag,
    // so the bounded repair budget is spent without fixing verification.
    const { repoDir, logFile, issuesFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd =
      `echo VERIFY >> ${logFile} && ` +
      `if [ ! -f verify-ok.flag ]; then echo "verify-ok.flag MISSING" >&2; exit 1; fi`;

    // init (same non-interactive surface as test 1 — real command, flags).
    const init = await runCli(
      `init --agent claude-code --model fake-model-1 --template simple-loop ` +
        `--sandbox host --issue-tracker github-issues --create-label false ` +
        `--verification-commands '${verifyCmd}'`,
      repoDir,
      env,
    );
    expect(init.stdout).toContain("Khởi tạo xong");

    // 1) The run fails: verification never passes and both bounded repairs
    //    are spent (implementation + 2 resumes, no third try).
    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    expect(
      log.filter((l) => l === "AGENT" || l.startsWith("AGENT_RESUME")).length,
    ).toBe(3);
    expect(log.filter((l) => l === "VERIFY").length).toBe(3);
    // A Vietnamese failure report was posted; the issue was never closed.
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);
    const issuesAfterFail = await readIssues(issuesFile);
    expect(issuesAfterFail[0]).toMatchObject({ number: 5, state: "OPEN" });
    // Nothing landed on main.
    expect(await git(repoDir, "ls-tree --name-only main")).not.toContain(
      "agent-work.txt",
    );

    // 2) The durable recovery record exists with the spent repair budget;
    //    the source branch/worktree are preserved for retry.
    const recovery = JSON.parse(
      await readFile(recoveryPath(repoDir, 5), "utf-8"),
    );
    expect(recovery).toMatchObject({
      failurePhase: "verification",
      sourceBranch: "sandcastle/issue-5",
      issue: { number: 5 },
      attempts: { implementation: 1, verificationRepair: 2 },
    });
    expect(await git(repoDir, "branch --list sandcastle/issue-5")).toContain(
      "sandcastle/issue-5",
    );
    const worktreesFail = await git(repoDir, "worktree list --porcelain");
    expect(worktreesFail).toContain("sandcastle-issue-5");

    // 3) `sandcastle status` — a separate process — lists the failed task.
    const status1 = await runCli("status", repoDir, env);
    expect(status1.stdout).toContain("Issue #5");
    expect(status1.stdout).toContain("xác minh 2/2");
    expect(status1.stdout).toContain("sandcastle/issue-5");

    // 4) `sandcastle retry 5` — separate process, agent now "fixed"
    //    (FAKE_AGENT_FIXED=1 → the repair writes verify-ok.flag). The retry
    //    re-enters at verification on the preserved worktree/branch: one
    //    more failed verify, one resumed repair, then verify → integrate →
    //    verify → land → report → close.
    const before = log.length;
    const retryEnv = { ...env, FAKE_AGENT_FIXED: "1" };
    const { stdout } = await runCli("retry 5", repoDir, retryEnv);
    expect(stdout).toContain("Hoàn thành issue #5");

    const delta = (await readLog(logFile)).slice(before);
    // No re-selection, no fresh implementation — the retry resumed the
    // recorded agent session for its single repair.
    expect(delta.some((l) => l.startsWith("gh issue list"))).toBe(false);
    expect(delta.filter((l) => l === "AGENT").length).toBe(0);
    expect(delta.some((l) => l.startsWith("AGENT_RESUME"))).toBe(true);
    // verify (fail) → repair → verify (pass) → integrated verify (pass).
    expect(delta.filter((l) => l === "VERIFY").length).toBe(3);
    expect(delta.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(delta.some((l) => l.startsWith("gh issue close 5"))).toBe(true);

    // Landed: agent work + the repair's flag are on main; the issue is
    // CLOSED in the tracker only after the landing + report.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    expect(files).toContain("verify-ok.flag");
    const issuesAfterRetry = await readIssues(issuesFile);
    expect(issuesAfterRetry[0]).toMatchObject({ number: 5, state: "CLOSED" });

    // 5) Bookkeeping removed: recovery record, source branch, and worktree.
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
    expect(await git(repoDir, "branch --list sandcastle/issue-5")).toBe("");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);

    // 6) `sandcastle status` is clean again.
    const status2 = await runCli("status", repoDir, env);
    expect(status2.stdout).toContain("Không có tác vụ thất bại");
  }, 90_000);
});

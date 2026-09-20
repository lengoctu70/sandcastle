import { exec } from "node:child_process";
import { existsSync } from "node:fs";
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
 *
 * Bounded-repair support (#18):
 * - Each invocation is numbered; the shared call log gets `AGENT` for a fresh
 *   run or `AGENT_RESUME <id>` when Sandcastle passed `--resume <id>`, so
 *   tests can assert native session resume vs. fresh repair invocations.
 * - A session JSONL is written to `$HOME/.claude/projects/<enc-cwd>/<id>.jsonl`
 *   before exiting — mirroring real Claude Code, which persists the session
 *   on disk as it runs — so the resume precheck finds it on the next repair.
 * - Every received prompt is appended to $FAKE_AGENT_PROMPT under a
 *   `===PROMPT N===` marker so tests can inspect each invocation's context.
 * - A `# Merge conflict repair` prompt resolves the in-progress merge in the
 *   integration worktree (writes resolved content, `git add`, `git commit`);
 *   `FAKE_AGENT_NO_RESOLVE=1` leaves the merge conflicted to exercise the
 *   post-repair state check.
 * - A `# Verification repair` prompt additionally creates `verify-ok.flag`,
 *   which a verification command can assert on to gate repair success.
 *
 * Queue support (#20):
 * - `AGENT_BEGIN <issue>` / `AGENT_END <issue>` markers are appended to the
 *   shared call log so tests can compute max in-flight agent concurrency.
 * - `FAKE_AGENT_DELAY_MS` sleeps inside the run so overlapping parallel
 *   issues are actually observed in flight; `FAKE_AGENT_DELAY_ISSUE_<n>`
 *   overrides it per issue so tests can order which run lands first.
 * - `FAKE_AGENT_FAIL_ISSUE=<n>` exits 1 (without committing) when the
 *   implementation prompt targets issue #<n> — repair prompts are unaffected,
 *   so the issue fails at the implementation phase and stays open.
 * - `FAKE_AGENT_PER_ISSUE_FILE=1` names the created file
 *   `agent-work-<issue>.txt` instead of `agent-work.txt`.
 */
const writeFakeClaude = async (dir: string) => {
  const shim = join(dir, "claude");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");
const path = require("path");
let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const log = process.env.FAKE_GH_LOG;
  const prior = log && fs.existsSync(log)
    ? fs.readFileSync(log, "utf-8").split("\\n").filter((l) => l === "AGENT" || l.startsWith("AGENT_RESUME")).length
    : 0;
  const n = prior + 1;
  const sessionId = "fake-session-" + n;
  const issueMatch = buf.match(/issue #(\\d+)/);
  const issueNo = issueMatch ? issueMatch[1] : "?";
  const resumeIdx = process.argv.indexOf("--resume");
  const resumed = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : null;
  if (log) fs.appendFileSync(log, resumed ? "AGENT_RESUME " + resumed + "\\n" : "AGENT\\n");
  if (log) fs.appendFileSync(log, "AGENT_BEGIN " + issueNo + "\\n");
  const endRun = (code) => {
    if (log) fs.appendFileSync(log, "AGENT_END " + issueNo + "\\n");
    process.exit(code);
  };
  const delayMs = parseInt(
    process.env["FAKE_AGENT_DELAY_ISSUE_" + issueNo] || process.env.FAKE_AGENT_DELAY_MS || "0",
    10,
  );
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, delayMs);
  const promptOut = process.env.FAKE_AGENT_PROMPT;
  if (promptOut) fs.appendFileSync(promptOut, "\\n===PROMPT " + n + "===\\n" + buf);
  const home = process.env.HOME;
  if (home) {
    const enc = process.cwd().replace(/^([A-Za-z]):/, "$1").replace(/[\\\\/]/g, "-");
    const dir = path.join(home, ".claude", "projects", enc);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId + ".jsonl"), JSON.stringify({ cwd: process.cwd() }) + "\\n");
  }
  if (process.env.FAKE_CLAUDE_FAIL === "1") {
    console.log(JSON.stringify({ type: "result", result: "agent exploded" }));
    endRun(1);
  }
  const failIssue = process.env.FAKE_AGENT_FAIL_ISSUE;
  if (failIssue && buf.includes("Implement GitHub issue #" + failIssue + ":")) {
    console.log(JSON.stringify({ type: "result", result: "agent exploded" }));
    endRun(1);
  }
  const cwd = process.cwd();
  if (buf.includes("# Merge conflict repair")) {
    if (process.env.FAKE_AGENT_NO_RESOLVE !== "1") {
      const unmerged = cp.execSync("git diff --name-only --diff-filter=U", { cwd })
        .toString().split("\\n").filter(Boolean);
      for (const f of unmerged) fs.writeFileSync(path.join(cwd, f), "resolved by agent\\n");
      cp.execSync("git add -A && git commit -m \\"resolve merge conflict\\"", { cwd, stdio: "ignore" });
    }
    // With FAKE_AGENT_NO_RESOLVE=1 the merge stays conflicted — Sandcastle's
    // post-repair state check must reject it.
  } else {
    if (buf.includes("# Verification repair")) {
      fs.writeFileSync(path.join(cwd, "verify-ok.flag"), "ok\\n");
    }
    const name = process.env.FAKE_AGENT_FILE
      || (process.env.FAKE_AGENT_PER_ISSUE_FILE === "1" && issueNo !== "?"
        ? "agent-work-" + issueNo + ".txt"
        : "agent-work.txt");
    fs.writeFileSync(path.join(cwd, name), "implemented " + n + "\\n");
    cp.execSync("git add -A && git commit -m \\"agent work " + n + "\\"", { cwd, stdio: "ignore" });
  }
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "worked" }] } }));
  console.log(JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>", session_id: sessionId }));
  endRun(0);
});
`,
  );
  await chmod(shim, 0o755);
};

/**
 * Fake `opencode` — a non-resumable provider (`captureSessions: false`, no
 * sessionStorage), so repair runs must be fresh invocations carrying the full
 * task + failure context. `opencode run` receives the prompt as the last argv
 * element and emits {type:"step_start"|"text"} JSON lines.
 */
const writeFakeOpencode = async (dir: string) => {
  const shim = join(dir, "opencode");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");
const path = require("path");
const prompt = process.argv[process.argv.length - 1] || "";
const log = process.env.FAKE_GH_LOG;
const prior = log && fs.existsSync(log)
  ? fs.readFileSync(log, "utf-8").split("\\n").filter((l) => l.startsWith("OPENCODE")).length
  : 0;
const n = prior + 1;
if (log) fs.appendFileSync(log, "OPENCODE\\n");
const promptOut = process.env.FAKE_AGENT_PROMPT;
if (promptOut) fs.appendFileSync(promptOut, "\\n===PROMPT " + n + "===\\n" + prompt);
const cwd = process.cwd();
if (prompt.includes("# Verification repair")) {
  fs.writeFileSync(path.join(cwd, "verify-ok.flag"), "ok\\n");
}
fs.writeFileSync(path.join(cwd, process.env.FAKE_AGENT_FILE || "agent-work.txt"), "implemented " + n + "\\n");
cp.execSync("git add -A && git commit -m \\"opencode work " + n + "\\"", { cwd, stdio: "ignore" });
console.log(JSON.stringify({ type: "step_start", sessionID: "oc-" + n }));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "done <promise>COMPLETE</promise>" } }));
`,
  );
  await chmod(shim, 0o755);
};

/**
 * Fake `git` — passes every call through to the real git binary, except at
 * the landing seam (`git merge --ff-only <branch>` or `git update-ref`),
 * where env vars let a test act as an external actor moving the target
 * branch or as a barrier inside the locked landing section:
 * - `FAKE_GIT_DRIFT=once`  → commits an "external-drift" commit on the
 *   checked-out target before the first real ref update only
 *   (`FAKE_GIT_DRIFT_MARKER` records that it fired), so the update refuses
 *   and the run must consume its bounded integration-rebuild budget.
 * - `FAKE_GIT_DRIFT=always` → drifts before every ref update, exhausting the
 *   budget — the run must stop safely, never force-updating.
 * - `FAKE_GIT_HOLD_ISSUE=<n>` + `FAKE_GIT_HELD_FILE`/`FAKE_GIT_RELEASE_FILE`
 *   → when the ref update targets issue <n>'s integration branch, the shim
 *   writes HELD_FILE, then blocks inside the locked landing section until
 *   RELEASE_FILE exists — a deterministic barrier proving what siblings may
 *   or may not do while the section is held.
 */
const writeFakeGit = async (dir: string) => {
  const { stdout: realGitOut } = await execAsync("command -v git");
  const realGit = realGitOut.trim();
  const shim = join(dir, "git");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const cp = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const isFfMerge = args[0] === "merge" && args.includes("--ff-only");
const isUpdateRef = args[0] === "update-ref";
if (isFfMerge || isUpdateRef) {
  const drift = process.env.FAKE_GIT_DRIFT;
  const marker = process.env.FAKE_GIT_DRIFT_MARKER;
  const doDrift =
    drift === "always" ||
    (drift === "once" && marker && !fs.existsSync(marker));
  if (doDrift) {
    if (marker) fs.writeFileSync(marker, "1");
    cp.execSync(realGit + " commit --allow-empty -qm external-drift", {
      stdio: "ignore",
    });
  }
  const holdIssue = process.env.FAKE_GIT_HOLD_ISSUE;
  const branch = args.find((a) => /issue-\\d+-integrate/.test(a));
  if (holdIssue && branch && branch.includes("issue-" + holdIssue + "-integrate")) {
    const heldFile = process.env.FAKE_GIT_HELD_FILE;
    const releaseFile = process.env.FAKE_GIT_RELEASE_FILE;
    if (heldFile) fs.writeFileSync(heldFile, "1");
    if (releaseFile) {
      const deadline = Date.now() + 120000;
      while (!fs.existsSync(releaseFile)) {
        if (Date.now() > deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 25);
      }
    }
  }
}
const r = cp.spawnSync(realGit, args, { stdio: "inherit" });
if (r.error) { console.error(String(r.error)); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
`,
  );
  await chmod(shim, 0o755);
};

/** Poll `cond` until it holds or `timeoutMs` elapses (deterministic test barriers). */
const waitFor = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
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

/** Temp repo + fake gh/claude/opencode + a shared call log. `issues` may be empty. */
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
  await writeFakeOpencode(shimDir);

  // A private HOME so the fake agent's session files — and the resume
  // precheck's `~/.claude/projects/*/id.jsonl` scan — stay inside the fixture.
  const fakeHome = await mkdtemp(join(tmpdir(), "run-home-"));

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
    FAKE_GH_AUTH: "1",
    FAKE_GH_LABEL: "1",
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

const ISSUE_5 = {
  number: 5,
  title: "Add a greeting file",
  body: "Please add a greeting.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/5",
};

const ISSUE_7 = {
  number: 7,
  title: "Add a farewell file",
  body: "Please add a farewell.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/7",
};

const ISSUE_9 = {
  number: 9,
  title: "Add a readme note",
  body: "Please add a note.",
  state: "OPEN",
  labels: [{ name: "Sandcastle" }],
  url: "https://example.test/issues/9",
};

/**
 * Max simultaneously in-flight fake-agent runs, computed from the
 * `AGENT_BEGIN <issue>`/`AGENT_END <issue>` markers the fake claude appends to
 * the shared call log (#20 concurrency-bound assertions).
 */
const maxAgentConcurrency = (log: readonly string[]): number => {
  let inFlight = 0;
  let max = 0;
  for (const l of log) {
    if (l.startsWith("AGENT_BEGIN")) {
      inFlight += 1;
      if (inFlight > max) max = inFlight;
    } else if (l.startsWith("AGENT_END")) {
      inFlight -= 1;
    }
  }
  return max;
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

  it("verification repair: feeds the failed command + output back and lands on retry", async () => {
    const { repoDir, logFile, promptFile, env } = await makeFixture([ISSUE_5]);
    // Fails until the agent's repair run creates verify-ok.flag — the fake
    // claude does that only for "# Verification repair" prompts.
    const verifyCmd =
      `echo VERIFY >> "${logFile}"; ` +
      `if [ ! -f verify-ok.flag ]; then echo "verify-ok.flag MISSING" >&2; exit 1; fi`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    const { stdout } = await runCli("run --issue 5", repoDir, env);

    const log = await readLog(logFile);
    // One implementation run, then ONE repair — a native session resume, since
    // claude is a resumable provider and the session file exists.
    expect(log.filter((l) => l === "AGENT").length).toBe(1);
    expect(log).toContain("AGENT_RESUME fake-session-1");
    // Verification ran on source (fail), source again (pass), and integrated.
    const verifyCount = log.filter((l) => l === "VERIFY").length;
    expect(verifyCount).toBe(3);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(true);

    // The repair prompt carried the exact failed command and its output.
    const prompts = await readFile(promptFile, "utf-8");
    const repairPrompt = prompts.split("===PROMPT 2===")[1] ?? "";
    expect(repairPrompt).toContain("# Verification repair");
    expect(repairPrompt).toContain("verify-ok.flag");
    expect(repairPrompt).toContain("verify-ok.flag MISSING");

    // The fix landed on main.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    expect(files).toContain("verify-ok.flag");
    expect(stdout).toContain("Hoàn thành issue #5");
  });

  it("verification repair with a non-resumable provider: fresh invocation with full context", async () => {
    const { repoDir, logFile, promptFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd =
      `echo VERIFY >> "${logFile}"; ` +
      `if [ ! -f verify-ok.flag ]; then echo "verify-ok.flag MISSING" >&2; exit 1; fi`;
    // opencode has no session storage — repair must be a fresh invocation.
    await writeSettings(repoDir, {
      agent: "opencode",
      verificationCommands: [verifyCmd],
    });

    await runCli("run --issue 5", repoDir, env);

    const log = await readLog(logFile);
    expect(log.filter((l) => l === "OPENCODE").length).toBe(2);
    expect(log.some((l) => l.startsWith("AGENT_RESUME"))).toBe(false);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(true);

    // The fresh repair invocation re-established the task + failure context.
    const prompts = await readFile(promptFile, "utf-8");
    const repairPrompt = prompts.split("===PROMPT 2===")[1] ?? "";
    expect(repairPrompt).toContain("# Verification repair");
    expect(repairPrompt).toContain(
      "A previous Sandcastle run implemented issue #5",
    );
    expect(repairPrompt).toContain("Add a greeting file");
    expect(repairPrompt).toContain("verify-ok.flag MISSING");
  });

  it("verification failure: after 2 bounded repairs posts a Vietnamese failure report, keeps the issue open, merges nothing", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    // Implementation + exactly two bounded repair attempts (both native
    // resumes), then the run stops — no third try.
    expect(log.filter((l) => l === "AGENT").length).toBe(1);
    expect(log).toContain("AGENT_RESUME fake-session-1");
    expect(log).toContain("AGENT_RESUME fake-session-2");
    expect(
      log.filter((l) => l === "AGENT" || l.startsWith("AGENT_RESUME")).length,
    ).toBe(3);
    // Initial verify + one re-run per repair = 3 invocations.
    expect(log.filter((l) => l === "VERIFY").length).toBe(3);
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);
    const raw = await readFile(logFile, "utf-8");
    expect(raw).toContain("không hoàn thành");
    // The attempt budget is visible in the report.
    expect(raw).toContain("xác minh 2/2");

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
      attempts: {
        implementation: 1,
        verificationRepair: 2,
        mergeConflictRepair: 0,
        integrationRebuild: 0,
      },
    });
    // The preserved source worktree stays on disk with the branch.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).toContain("sandcastle-issue-5");
    const settings = JSON.parse(
      await readFile(join(repoDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.verificationStatus).toBe("failed");
  });

  it("merge conflict: agent repairs the conflict in the integration worktree, then verify + land", async () => {
    const { repoDir, logFile, env } = await makeFixture([
      { ...ISSUE_5, number: 7 },
    ]);
    const verifyCmd = `echo VERIFY >> "${logFile}"`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    // Pre-seed the deterministic source branch with a commit that conflicts
    // with a newer commit on main — the integration merge must collide.
    await execAsync("git checkout -b sandcastle/issue-7", { cwd: repoDir });
    await commitFile(repoDir, "hello.txt", "branch version\n", "branch change");
    await execAsync("git checkout main", { cwd: repoDir });
    await commitFile(repoDir, "hello.txt", "main version\n", "main change");

    const { stdout } = await runCli("run --issue 7", repoDir, env);

    const log = await readLog(logFile);
    // Implementation ran on the source worktree; the conflict repair resumed
    // the same session inside the integration worktree.
    expect(log.filter((l) => l === "AGENT").length).toBe(1);
    expect(log).toContain("AGENT_RESUME fake-session-1");
    // All verification commands re-ran on the integrated tree after repair.
    expect(log.filter((l) => l === "VERIFY").length).toBe(2);
    expect(log.some((l) => l.startsWith("gh issue comment 7"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close 7"))).toBe(true);

    // The repair's resolution landed: the agent's conflict resolution and its
    // implementation commit are both on main.
    expect(await git(repoDir, "show main:hello.txt")).toBe("resolved by agent");
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");

    // Attempt counts are visible in the completion report.
    const raw = await readFile(logFile, "utf-8");
    expect(raw).toContain("1/1 lần sau xung đột merge");

    // Derived state cleaned up: no integration worktree or branch remains.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
    expect(stdout).toContain("đã được đóng");
  });

  it("merge conflict: exhausted repair stops safely, never leaves the active checkout conflicted, issue stays open", async () => {
    const { repoDir, logFile, env } = await makeFixture(
      [{ ...ISSUE_5, number: 7 }],
      { FAKE_AGENT_NO_RESOLVE: "1" },
    );
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
    // The one allowed repair ran (session resumed) and left the merge
    // conflicted — no second repair, no landing, no close.
    expect(log).toContain("AGENT_RESUME fake-session-1");
    expect(
      log.filter((l) => l === "AGENT" || l.startsWith("AGENT_RESUME")).length,
    ).toBe(2);
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
    // Recovery state preserves the failure and the spent repair budget.
    const recovery = JSON.parse(
      await readFile(
        join(repoDir, ".sandcastle", "recovery", "issue-7.json"),
        "utf-8",
      ),
    );
    expect(recovery.failurePhase).toBe("integration");
    expect(recovery.attempts).toMatchObject({
      implementation: 1,
      mergeConflictRepair: 1,
    });
  });

  it("target branch moved during integration: rebuilds once on the new tip and lands", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    // The verify command moves main — but only on its second invocation (the
    // first integrated-tree verification), so the freshness check fails once
    // and the rebuild's own verification then leaves the branch alone.
    const vcount = join(repoDir, ".vcount");
    const verifyCmd =
      `n=$(cat "${vcount}" 2>/dev/null || echo 0); echo $((n+1)) > "${vcount}"; ` +
      `echo VERIFY >> "${logFile}"; ` +
      `if [ "$n" = "1" ]; then git -C "${repoDir}" commit --allow-empty -qm moved; fi`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    const { stdout } = await runCli("run --issue 5", repoDir, env);

    const log = await readLog(logFile);
    // source verify → integrated verify (moves main) → rebuilt integrated verify.
    expect(log.filter((l) => l === "VERIFY").length).toBe(3);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(true);
    expect(stdout).toContain("dựng lại");

    // Both the agent's work and the racing "moved" commit are on main.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    const mainLog = await git(repoDir, "log --format=%s main");
    expect(mainLog).toContain("moved");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
  });

  it("target branch moved twice: rebuild budget exhausted → stops safely, never force-updates", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    // Every verification call moves main, so even the rebuilt integration
    // state is stale by the time its freshness check runs.
    const verifyCmd =
      `echo VERIFY >> "${logFile}" && ` +
      `git -C "${repoDir}" commit --allow-empty -qm moved`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    // source verify → integrated verify → rebuilt integrated verify → stop.
    expect(log.filter((l) => l === "VERIFY").length).toBe(3);
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);

    // The agent's work never landed — main still only has the racing commits.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).not.toContain("agent-work.txt");
    expect(await git(repoDir, "rev-parse --abbrev-ref HEAD")).toBe("main");

    // Recovery records the landing-phase stop with the spent rebuild budget.
    const recovery = JSON.parse(
      await readFile(
        join(repoDir, ".sandcastle", "recovery", "issue-5.json"),
        "utf-8",
      ),
    );
    expect(recovery.failurePhase).toBe("landing");
    expect(recovery.attempts).toMatchObject({
      implementation: 1,
      verificationRepair: 0,
      mergeConflictRepair: 0,
      integrationRebuild: 1,
    });
    // No leftover integration worktree; the source worktree is preserved.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).not.toContain("integrate");
    expect(worktrees).toContain("sandcastle-issue-5");
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

  it("run --help exposes --issue, --all, and --parallelism", async () => {
    const { stdout } = await runCli("run --help", process.cwd(), process.env);
    expect(stdout).toContain("--issue");
    expect(stdout).toContain("--all");
    expect(stdout).toContain("--parallelism");
  });
});

// ---------------------------------------------------------------------------

describe("sandcastle run --all (queued issues, #20)", () => {
  it("runs every eligible issue sequentially in issue-number order", async () => {
    const { repoDir, logFile, env } = await makeFixture(
      [ISSUE_9, ISSUE_5, ISSUE_7],
      { FAKE_AGENT_PER_ISSUE_FILE: "1" },
    );
    // parallelism 1 in the fixture settings = sequential mode.
    await writeSettings(repoDir);

    const { stdout } = await runCli("run --all", repoDir, env);

    const log = await readLog(logFile);
    // Queue preflight runs once (one --version/auth/label probe), then each
    // issue's own `issue view` — in ascending number order even though the
    // tracker returned them shuffled.
    expect(log.filter((l) => l === "gh --version").length).toBe(1);
    const views = log
      .filter((l) => l.startsWith("gh issue view"))
      .map((l) => l.split(" ")[3]);
    expect(views).toEqual(["5", "7", "9"]);

    // Sequential: at most one agent in flight, started in issue order.
    expect(maxAgentConcurrency(log)).toBe(1);
    const begins = log
      .filter((l) => l.startsWith("AGENT_BEGIN"))
      .map((l) => l.split(" ").pop());
    expect(begins).toEqual(["5", "7", "9"]);

    // Every issue landed on main and was closed.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work-5.txt");
    expect(files).toContain("agent-work-7.txt");
    expect(files).toContain("agent-work-9.txt");
    const closes = log
      .filter((l) => l.startsWith("gh issue close"))
      .map((l) => l.split(" ")[3]);
    expect(closes).toEqual(["5", "7", "9"]);

    // Vietnamese end-of-run summary lists all landed issues.
    expect(stdout).toContain("Hoàn thành tất cả 3 issue");
    expect(stdout).toContain("#5");
    expect(stdout).toContain("#7");
    expect(stdout).toContain("#9");
  });

  it("caps in-flight issues at --parallelism and still lands them all", async () => {
    const { repoDir, logFile, env } = await makeFixture(
      [ISSUE_9, ISSUE_5, ISSUE_7],
      { FAKE_AGENT_PER_ISSUE_FILE: "1", FAKE_AGENT_DELAY_MS: "600" },
    );
    await writeSettings(repoDir);

    const { stdout } = await runCli("run --all --parallelism 2", repoDir, env);

    const log = await readLog(logFile);
    // Bounded: exactly two agents overlapped — the flag overrode the
    // configured parallelism 1, and the delay made the overlap observable.
    expect(maxAgentConcurrency(log)).toBe(2);

    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work-5.txt");
    expect(files).toContain("agent-work-7.txt");
    expect(files).toContain("agent-work-9.txt");
    expect(log.filter((l) => l.startsWith("gh issue close")).length).toBe(3);
    expect(stdout).toContain("Hoàn thành tất cả 3 issue");
  });

  it("honors the configured parallelism setting for --all", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5, ISSUE_7], {
      FAKE_AGENT_PER_ISSUE_FILE: "1",
      FAKE_AGENT_DELAY_MS: "600",
    });
    await writeSettings(repoDir, { parallelism: 2 });

    const { stdout } = await runCli("run --all", repoDir, env);

    const log = await readLog(logFile);
    // No flag — the configured bound (2) applied and both issues overlapped.
    expect(maxAgentConcurrency(log)).toBe(2);
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work-5.txt");
    expect(files).toContain("agent-work-7.txt");
    expect(stdout).toContain("Hoàn thành tất cả 2 issue");
  });

  it("keeps going after a failed issue and reports landed vs failed", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5, ISSUE_7], {
      FAKE_AGENT_PER_ISSUE_FILE: "1",
      FAKE_AGENT_DELAY_MS: "400",
      FAKE_AGENT_FAIL_ISSUE: "5",
    });
    await writeSettings(repoDir, { parallelism: 2 });

    try {
      await runCli("run --all", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      // The summary names the landed issue, the failed one, and marks the run
      // failed — #5's failure did not stop #7 from landing.
      expect(stdout + stderr).toContain("#5");
      expect(stdout + stderr).toContain("#7");
      expect(stdout + stderr).toContain("thất bại");
    }

    const log = await readLog(logFile);
    // #7 landed and closed; #5 got a failure comment but was never closed.
    expect(log.some((l) => l.startsWith("gh issue close 7"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(false);
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work-7.txt");
    expect(files).not.toContain("agent-work-5.txt");

    // The failed issue's recovery state and source branch/worktree survive.
    const recovery = await readFile(
      join(repoDir, ".sandcastle", "recovery", "issue-5.json"),
      "utf-8",
    );
    expect(recovery).toContain('"issue"');
    const branches = await git(repoDir, "branch --list");
    expect(branches).toContain("sandcastle/issue-5");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).toContain("sandcastle-issue-5");
  });

  it("rejects --all combined with --issue", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5, ISSUE_7]);
    await writeSettings(repoDir);

    try {
      await runCli("run --all --issue 5", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--all");
      expect(stdout + stderr).toContain("--issue");
    }
  });

  it("rejects a --parallelism bound outside 1-4", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);

    try {
      await runCli("run --all --parallelism 5", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--parallelism");
    }
  });

  it("rejects --parallelism without --all in non-interactive mode", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);

    try {
      await runCli("run --issue 5 --parallelism 2", repoDir, env);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--parallelism");
      expect(stdout + stderr).toContain("--all");
    }
  });

  it("reports no eligible issues and exits 0 for --all when none are labeled", async () => {
    const { repoDir, env } = await makeFixture([]);
    await writeSettings(repoDir);

    const { stdout } = await runCli("run --all", repoDir, env);
    expect(stdout).toContain("Không có issue nào đang mở");
  });
});

// ---------------------------------------------------------------------------
// Coordinated integration (#32): Sandcastle-owned merges override user merge
// policy, the shared mutation lock covers only the mutation seams (agent +
// verification stay concurrent), drift inside the landing seam consumes the
// bounded rebuild budget, and cleanup is serialized with landings.
// ---------------------------------------------------------------------------

describe("sandcastle run — coordinated integration (#32)", () => {
  it("a user merge.ff=only policy cannot break the Sandcastle-owned integration merge", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);
    // User-level merge policy that refuses every non-fast-forward merge —
    // the integration merge must override it explicitly (F022).
    await execAsync("git config merge.ff only", { cwd: repoDir });

    // Pre-seed a diverged source branch so the integration merge is a real
    // 3-way merge — the case merge.ff=only aborts on.
    await execAsync("git checkout -b sandcastle/issue-5", { cwd: repoDir });
    await commitFile(repoDir, "seeded.txt", "branch\n", "seeded branch commit");
    await execAsync("git checkout main", { cwd: repoDir });
    await commitFile(repoDir, "other.txt", "main\n", "seeded main commit");

    const { stdout } = await runCli("run --issue 5", repoDir, env);

    // The run landed despite merge.ff=only — the integration merge commit
    // and both sides' content are on main.
    expect(stdout).toContain("đã được đóng");
    const merges = await git(repoDir, "rev-list --merges -1 main");
    expect(merges.length).toBeGreaterThan(0);
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    expect(files).toContain("seeded.txt");
    expect(files).toContain("other.txt");
    const log = await readLog(logFile);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(true);
  });

  it("target drift inside the landing seam consumes the rebuild budget and lands on the new tip", async () => {
    const { repoDir, shimDir, logFile, env } = await makeFixture([ISSUE_5]);
    await writeFakeGit(shimDir);
    await writeSettings(repoDir);
    // The fake git moves the target inside the first ref update — after the
    // freshness check, inside the locked landing section (F052).
    env.FAKE_GIT_DRIFT = "once";
    env.FAKE_GIT_DRIFT_MARKER = join(repoDir, ".drift-fired");

    const { stdout } = await runCli("run --issue 5", repoDir, env);

    // The refused ref update was diagnosed as drift, the integration state
    // was rebuilt once on the new tip, and the run landed.
    expect(stdout).toContain("dựng lại");
    const mainLog = await git(repoDir, "log --format=%s main");
    expect(mainLog).toContain("external-drift");
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    const log = await readLog(logFile);
    expect(log.some((l) => l.startsWith("gh issue close 5"))).toBe(true);
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
  });

  it("target drift on every landing attempt exhausts the budget — safe stop, no force-update, every created commit recorded", async () => {
    const { repoDir, shimDir, logFile, env } = await makeFixture([ISSUE_5]);
    await writeFakeGit(shimDir);
    await writeSettings(repoDir);
    env.FAKE_GIT_DRIFT = "always";

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });

    const log = await readLog(logFile);
    expect(log.some((l) => l.startsWith("gh issue comment 5"))).toBe(true);
    expect(log.some((l) => l.startsWith("gh issue close"))).toBe(false);

    // The agent's work never landed — main only carries the drift commits
    // and the active checkout is clean of tracked modifications/conflicts.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).not.toContain("agent-work.txt");
    expect(await git(repoDir, "rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(await git(repoDir, "status --porcelain --untracked-files=no")).toBe(
      "",
    );
    expect(await git(repoDir, "ls-files -u")).toBe("");

    // Recovery records the landing-phase stop with the spent rebuild budget
    // — and every commit the run created, including the deterministic
    // integration merge commits, not just the agent's (F053).
    const recovery = JSON.parse(
      await readFile(
        join(repoDir, ".sandcastle", "recovery", "issue-5.json"),
        "utf-8",
      ),
    );
    expect(recovery.failurePhase).toBe("landing");
    expect(recovery.attempts).toMatchObject({
      implementation: 1,
      mergeConflictRepair: 0,
      integrationRebuild: 1,
    });
    const implSha = await git(repoDir, "rev-parse sandcastle/issue-5");
    const commitShas = recovery.commits.map((c: { sha: string }) => c.sha);
    expect(commitShas).toContain(implSha);
    // impl commit + at least one deterministic merge commit per attempt.
    expect(commitShas.length).toBeGreaterThanOrEqual(2);

    // No leftover integration worktree; the source worktree is preserved.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees).not.toContain("integrate");
    expect(worktrees).toContain("sandcastle-issue-5");
  });

  it("queue: while one issue holds the landing lock a sibling still runs agent + verification, and the checkout never moves before landing", async () => {
    const { repoDir, shimDir, logFile, env } = await makeFixture(
      [ISSUE_5, ISSUE_7],
      { FAKE_AGENT_PER_ISSUE_FILE: "1" },
    );
    await writeFakeGit(shimDir);
    // Barrier pair: the fake git parks issue 5 inside its locked landing
    // section until .release-5 exists; issue 7's source-stage verification
    // (running in the `sandcastle-issue-7` worktree) cannot complete until
    // issue 5 is parked — so the marker below is proof the sibling ran its
    // verification while a landing section was held, i.e. verification is
    // outside the shared mutation lock (ADR 0025).
    const verifyCmd =
      `me=$(basename "$PWD"); ` +
      `if [ "$me" = "sandcastle-issue-7" ]; then ` +
      `i=0; while [ ! -f "${join(repoDir, ".held-5")}" ] && [ $i -lt 2400 ]; do sleep 0.05; i=$((i+1)); done; ` +
      `fi; ` +
      `echo "VERIFY $me" >> "${logFile}"`;
    await writeSettings(repoDir, {
      verificationCommands: [verifyCmd],
      parallelism: 2,
    });
    env.FAKE_GIT_HOLD_ISSUE = "5";
    env.FAKE_GIT_HELD_FILE = join(repoDir, ".held-5");
    env.FAKE_GIT_RELEASE_FILE = join(repoDir, ".release-5");

    const baseSha = await git(repoDir, "rev-parse refs/heads/main");
    const runPromise = runCli("run --all --parallelism 2", repoDir, env);

    // Barrier: issue 5 is now inside the locked landing section (freshness
    // check passed, ref update held by the shim).
    await waitFor(() => existsSync(join(repoDir, ".held-5")));

    // Issue 7's agent finished and its source verification ran — while the
    // landing lock was still held by issue 5.
    await waitFor(async () =>
      (await readLog(logFile)).some((l) => l === "VERIFY sandcastle-issue-7"),
    );
    const log = await readLog(logFile);
    expect(log).toContain("AGENT_END 7");

    // The active checkout is still untouched: target tip unchanged, no
    // unmerged paths, no tracked-file edits — it only moves at landing.
    expect(await git(repoDir, "rev-parse refs/heads/main")).toBe(baseSha);
    expect(await git(repoDir, "status --porcelain --untracked-files=no")).toBe(
      "",
    );
    expect(await git(repoDir, "ls-files -u")).toBe("");

    // Issue 5's own integration worktree still exists mid-landing — sibling
    // cleanup can never prune it (shared cleanup is inside the same lock).
    const midList = await git(repoDir, "worktree list --porcelain");
    expect(midList).toMatch(/issue-5-integrate/);

    await writeFile(join(repoDir, ".release-5"), "1");
    const { stdout } = await runPromise;

    // Both issues landed — serialized landings, concurrent work.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work-5.txt");
    expect(files).toContain("agent-work-7.txt");
    const finalLog = await readLog(logFile);
    expect(finalLog.some((l) => l.startsWith("gh issue close 5"))).toBe(true);
    expect(finalLog.some((l) => l.startsWith("gh issue close 7"))).toBe(true);
    expect(maxAgentConcurrency(finalLog)).toBe(2);
    // All derived worktrees cleaned — no sibling deleted another's mid-flight.
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
    void stdout;
  });
});

// ---------------------------------------------------------------------------
// Recovery commands — `status` / `retry` / `discard` run as SEPARATE CLI
// processes against the durable `.sandcastle/recovery/` records a failed
// `run` leaves behind (#19).
// ---------------------------------------------------------------------------

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const recoveryPath = (repoDir: string, issue: number) =>
  join(repoDir, ".sandcastle", "recovery", `issue-${issue}.json`);

const sourceWorktreePath = (repoDir: string, issue: number) =>
  join(repoDir, ".sandcastle", "worktrees", `sandcastle-issue-${issue}`);

describe("sandcastle status / retry / discard (CLI seam)", () => {
  it("run fails → status lists it → retry resumes at the failed phase, resumes the session, lands → status clean", async () => {
    const { repoDir, logFile, promptFile, env } = await makeFixture([ISSUE_5]);
    // Verification fails while the counter file holds >0 — four failures:
    // three inside the first run (initial + two bounded repairs), then one
    // more inside the retry so its repair pass is exercised too.
    const vfails = join(repoDir, ".vfails");
    await writeFile(vfails, "4");
    const verifyCmd =
      `c=$(cat "${vfails}" 2>/dev/null || echo 0); echo VERIFY >> "${logFile}"; ` +
      `if [ "$c" -gt 0 ]; then echo $((c-1)) > "${vfails}"; echo "gated failure $c" >&2; exit 1; fi`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    // 1) The run fails at verification after spending both repair attempts.
    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    const recovery = JSON.parse(
      await readFile(recoveryPath(repoDir, 5), "utf-8"),
    );
    expect(recovery).toMatchObject({
      failurePhase: "verification",
      sourceBranch: "sandcastle/issue-5",
      targetBranch: "main",
      issue: { number: 5 },
      sessionId: "fake-session-3",
      retryCount: 0,
      attempts: { implementation: 1, verificationRepair: 2 },
    });
    expect(typeof recovery.targetBaseSha).toBe("string");
    expect(recovery.targetBaseSha.length).toBeGreaterThan(0);

    // 2) `status` in a separate process lists the preserved task.
    const status1 = await runCli("status", repoDir, env);
    expect(status1.stdout).toContain("Issue #5");
    expect(status1.stdout).toContain("xác minh trên nhánh làm việc");
    expect(status1.stdout).toContain("xác minh 2/2");
    expect(status1.stdout).toContain("sandcastle/issue-5");
    expect(status1.stdout).toContain("sandcastle-issue-5");

    // 3) `retry` continues the preserved work: no new issue selection, no
    //    new implementation run — it re-enters at verification, hits the one
    //    remaining gate, and the repair RESUMES the recorded agent session.
    const before = await readLog(logFile);
    const { stdout } = await runCli("retry 5", repoDir, env);

    const after = await readLog(logFile);
    const delta = after.slice(before.length);
    // No re-selection: issue list/label probing never ran on retry.
    expect(delta.some((l) => l.startsWith("gh issue list"))).toBe(false);
    expect(delta.some((l) => l.startsWith("gh label list"))).toBe(false);
    // It re-viewed only the recorded issue.
    expect(delta.some((l) => l.startsWith("gh issue view 5"))).toBe(true);
    // No fresh implementation invocation — the retry resumed at
    // verification; its single repair resumed the recorded session.
    expect(delta.filter((l) => l === "AGENT").length).toBe(0);
    expect(delta).toContain("AGENT_RESUME fake-session-3");
    // verify (fail) → repair → verify (pass) → integrated verify (pass).
    expect(delta.filter((l) => l === "VERIFY").length).toBe(3);
    expect(delta.some((l) => l.startsWith("gh issue close 5"))).toBe(true);

    // The repair prompt carried the failed command + output context.
    const prompts = await readFile(promptFile, "utf-8");
    const repairPrompt = prompts.split("===PROMPT 4===")[1] ?? "";
    expect(repairPrompt).toContain("# Verification repair");
    expect(repairPrompt).toContain("gated failure");

    // Landed: agent's work is on main, source worktree/branch cleaned up,
    // the recovery record removed.
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    const branches = await git(repoDir, "branch --list");
    expect(branches).not.toContain("sandcastle/issue-5");
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);
    expect(stdout).toContain("Hoàn thành issue #5");

    // 4) `status` is clean again.
    const status2 = await runCli("status", repoDir, env);
    expect(status2.stdout).toContain("Không có tác vụ thất bại");
  });

  it("retry after an implementation-phase failure reuses the preserved worktree and lands", async () => {
    // FAKE_CLAUDE_FAIL makes the agent exit non-zero with no commits.
    const { repoDir, logFile, promptFile, env } = await makeFixture([ISSUE_5], {
      FAKE_CLAUDE_FAIL: "1",
    });
    await writeSettings(repoDir);

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    const recovery = JSON.parse(
      await readFile(recoveryPath(repoDir, 5), "utf-8"),
    );
    expect(recovery.failurePhase).toBe("implementation");
    expect(recovery.worktreePath).toContain("sandcastle-issue-5");

    // Retry with the agent healthy — the preserved worktree is reused and a
    // fresh implementation invocation carries the previous failure context
    // (no session id was captured from the crashed run).
    const env2 = { ...env, FAKE_CLAUDE_FAIL: "0" };
    const before = await readLog(logFile);
    const { stdout } = await runCli("retry 5", repoDir, env2);

    const delta = (await readLog(logFile)).slice(before.length);
    expect(delta.filter((l) => l === "AGENT").length).toBe(1);
    expect(delta.some((l) => l.startsWith("AGENT_RESUME"))).toBe(false);
    const prompts = await readFile(promptFile, "utf-8");
    const retryPrompt = prompts.split("===PROMPT 2===")[1] ?? "";
    expect(retryPrompt).toContain("# Task");
    expect(retryPrompt).toContain("issue #5");
    expect(retryPrompt).toContain("Previous attempt");

    expect(stdout).toContain("Hoàn thành issue #5");
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
  });

  it("retry rebuilds the preserved worktree when only the branch survived", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    // Simulate the worktree being deleted out from under git — the branch
    // and its commits remain.
    await execAsync(
      `git worktree remove --force "${sourceWorktreePath(repoDir, 5)}"`,
      { cwd: repoDir },
    );
    expect(await exists(sourceWorktreePath(repoDir, 5))).toBe(false);

    // Status marks it recoverable — worktree gone but the branch holds work.
    const statusOut = await runCli("status", repoDir, env);
    expect(statusOut.stdout).toContain("worktree đã mất");

    // Make verification pass now, then retry — the worktree is rebuilt from
    // the preserved branch and the run lands without any new agent call.
    await writeSettings(repoDir, {
      verificationCommands: [`echo VERIFY >> "${logFile}"`],
    });
    const before = await readLog(logFile);
    const { stdout } = await runCli("retry 5", repoDir, env);

    const delta = (await readLog(logFile)).slice(before.length);
    expect(delta.filter((l) => l === "AGENT").length).toBe(0);
    expect(delta.some((l) => l.startsWith("gh issue close 5"))).toBe(true);
    expect(stdout).toContain("dựng lại worktree");
    const files = await git(repoDir, "ls-tree --name-only main");
    expect(files).toContain("agent-work.txt");
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
  });

  it("discard without --yes refuses non-interactively and keeps everything; --yes removes record, worktree, and branch", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    expect(await exists(recoveryPath(repoDir, 5))).toBe(true);
    expect(await exists(sourceWorktreePath(repoDir, 5))).toBe(true);
    expect(await git(repoDir, "branch --list sandcastle/issue-5")).toContain(
      "sandcastle/issue-5",
    );

    // Declined/required confirmation: stdin is not a TTY here, so the command
    // must refuse without --yes and touch nothing.
    try {
      await runCli("discard 5", repoDir, env);
      expect.fail("Expected discard without --yes to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--yes");
    }
    expect(await exists(recoveryPath(repoDir, 5))).toBe(true);
    expect(await exists(sourceWorktreePath(repoDir, 5))).toBe(true);
    expect(await git(repoDir, "branch --list sandcastle/issue-5")).toContain(
      "sandcastle/issue-5",
    );

    // Confirmed: everything preserved is removed.
    const { stdout } = await runCli("discard 5 --yes", repoDir, env);
    expect(stdout).toContain("Đã xóa");
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
    expect(await exists(sourceWorktreePath(repoDir, 5))).toBe(false);
    expect(await git(repoDir, "branch --list sandcastle/issue-5")).toBe("");
    const worktrees = await git(repoDir, "worktree list --porcelain");
    expect(worktrees.match(/^worktree /gm)?.length).toBe(1);

    const statusOut = await runCli("status", repoDir, env);
    expect(statusOut.stdout).toContain("Không có tác vụ thất bại");
  });

  it("unknown issue number: retry and discard explain there is no record", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);

    try {
      await runCli("retry 99", repoDir, env);
      expect.fail("Expected retry to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("issue #99");
      expect(stdout + stderr).toContain("status");
    }
    try {
      await runCli("discard 99 --yes", repoDir, env);
      expect.fail("Expected discard to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("issue #99");
    }
  });

  it("corrupt record: status surfaces it, retry/discard refuse without deleting it", async () => {
    const { repoDir, env } = await makeFixture([ISSUE_5]);
    await writeSettings(repoDir);
    await mkdir(join(repoDir, ".sandcastle", "recovery"), { recursive: true });
    const corruptPath = recoveryPath(repoDir, 9);
    await writeFile(corruptPath, "{ not valid json !!!");

    const statusOut = await runCli("status", repoDir, env);
    expect(statusOut.stdout).toContain("BỊ HỎNG");
    expect(statusOut.stdout).toContain("issue-9.json");

    try {
      await runCli("retry 9", repoDir, env);
      expect.fail("Expected retry to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("bị hỏng");
    }
    try {
      await runCli("discard 9 --yes", repoDir, env);
      expect.fail("Expected discard to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("bị hỏng");
    }
    // The corrupt record is never silently deleted.
    expect(await exists(corruptPath)).toBe(true);
  });

  it("stale record (worktree and branch gone): status marks it, retry diagnoses and preserves the record", async () => {
    const { repoDir, logFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    await execAsync(
      `git worktree remove --force "${sourceWorktreePath(repoDir, 5)}"`,
      { cwd: repoDir },
    );
    await execAsync("git branch -D sandcastle/issue-5", { cwd: repoDir });

    const statusOut = await runCli("status", repoDir, env);
    expect(statusOut.stdout).toContain("Issue #5");
    expect(statusOut.stdout).toContain("Lỗi thời");

    try {
      await runCli("retry 5", repoDir, env);
      expect.fail("Expected retry to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("lỗi thời");
      expect(stdout + stderr).toContain("discard");
    }
    // The stale record is preserved, not silently deleted.
    expect(await exists(recoveryPath(repoDir, 5))).toBe(true);

    // Discard still cleans up the record itself.
    await runCli("discard 5 --yes", repoDir, env);
    expect(await exists(recoveryPath(repoDir, 5))).toBe(false);
  });

  it("stale record (issue now closed): retry refuses with a discard hint", async () => {
    const { repoDir, logFile, issuesFile, env } = await makeFixture([ISSUE_5]);
    const verifyCmd = `echo VERIFY >> "${logFile}" && false`;
    await writeSettings(repoDir, { verificationCommands: [verifyCmd] });

    await expect(runCli("run --issue 5", repoDir, env)).rejects.toMatchObject({
      code: 1,
    });
    // The issue was closed while the record persisted — the preserved work
    // may already have landed elsewhere, so continuing is unsafe.
    await writeFile(
      issuesFile,
      JSON.stringify([{ ...ISSUE_5, state: "CLOSED" }]),
    );

    try {
      await runCli("retry 5", repoDir, env);
      expect.fail("Expected retry to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("CLOSED");
      expect(stdout + stderr).toContain("discard");
    }
    expect(await exists(recoveryPath(repoDir, 5))).toBe(true);
  });
});

import { exec, execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import type {
  AgentProvider,
  ClaudeCodeOptions,
  CodexOptions,
  CopilotOptions,
  CursorOptions,
  OpenCodeOptions,
  PiOptions,
} from "./AgentProvider.js";
import { antigravity, type AntigravityOptions } from "./agents/antigravity.js";
import { devin, type DevinOptions } from "./agents/devin.js";
import { grok, type GrokOptions } from "./agents/grok.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import {
  createWorktree,
  type Worktree,
  type WorktreeRunResult,
} from "./createWorktree.js";
import type { DiscoveryExec } from "./discovery/contract.js";
import { nodeDiscoveryExec } from "./discovery/nodeExec.js";
import type { Severity } from "./Display.js";
import { probeGhReadiness } from "./githubSetup.js";
import {
  makeGithubIssueOps,
  nodeGhRunner,
  SANDCASTLE_LABEL,
  type GithubIssue,
  type GithubIssueOps,
  type GhRunner,
} from "./githubIssues.js";
import { getAgent, listAgents } from "./InitService.js";
import {
  loadProjectSettingsAsync,
  updateProjectSettingsAsync,
  type ProjectSettings,
  type VerificationStatus,
} from "./ProjectSettings.js";
import { resolveCwd } from "./resolveCwd.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import { docker } from "./sandboxes/docker.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { podman } from "./sandboxes/podman.js";
import * as WorktreeManager from "./WorktreeManager.js";

/**
 * The `sandcastle run` workflow service (ADR 0023/0024/0026).
 *
 * One `runIssueWorkflow` call implements a single GitHub Issue end to end:
 *
 *   select → implement in a dedicated source worktree → verify →
 *   merge in a separate integration worktree → verify again → land on the
 *   target branch → post a Vietnamese completion report → close the issue.
 *
 * Ordering guarantees that matter (ADR 0023):
 * - The implementation agent never sees issue-closing instructions — the
 *   prompt is built here from the immutable selected issue identity, so the
 *   `gh issue close` mutation stays inside Sandcastle (see
 *   {@link buildImplementationPrompt}).
 * - The completion report is posted only after the target branch has moved,
 *   and the issue is closed only after the report post succeeds.
 * - Every pre-landing failure leaves the issue open, keeps the source branch
 *   and implementation worktree on disk for recovery (#18/#19 build on this),
 *   and posts a Vietnamese failure report when the issue identity is known.
 * - The active checkout is never conflicted: merging happens only inside the
 *   integration worktree, and the target branch moves via `merge --ff-only`
 *   (when checked out here) or an atomic compare-and-swap `update-ref`.
 *
 * This module is the Promise-based seam the `run` CLI command calls — like
 * `run.ts`, Effect internals (WorktreeManager, copyToWorktree) are wrapped at
 * the boundary. It stays out of `index.ts` for now; the public programmatic
 * workflow API is a later surface.
 */

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a run stopped. Extension point for repair/retry phases (#18/#19). */
export type WorkflowRunPhase =
  | "preflight"
  | "implementation"
  | "verification"
  | "integration"
  | "integration-verification"
  | "landing"
  | "reporting";

/**
 * Per-run attempt counters (ADR 0024). Bounded repairs keep the failure
 * honest: the counters land in the result, the recovery record, and the
 * Vietnamese reports so a caller/test can see how much automatic repair was
 * spent before the run gave up or succeeded.
 */
export interface WorkflowRunAttempts {
  /** Implementation runs — always 1 while reselect/retry stays out of scope. */
  readonly implementation: number;
  /** Verification-failure repairs in the source worktree (≤2). */
  readonly verificationRepair: number;
  /** Merge-conflict repairs in the integration worktree (≤1). */
  readonly mergeConflictRepair: number;
  /** Integration-state rebuilds after target-branch movement (≤1). */
  readonly integrationRebuild: number;
}

/** Actual outcome of one verification command. */
export interface VerificationCommandResult {
  readonly command: string;
  /**
   * `"skipped"` means an earlier command in the same stage failed and this
   * command never ran — an honest record, distinct from init's
   * `verificationStatus: "skipped"` (the user declining verification).
   */
  readonly status: "passed" | "failed" | "skipped";
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Tail of combined stdout+stderr — feeds reports and failure detail. */
  readonly outputTail: string;
}

/** Structured result of one `sandcastle run` invocation. */
export interface WorkflowRunResult {
  readonly outcome: "landed" | "failed" | "no-issues";
  /** The phase a failure stopped at — set when outcome is "failed". */
  readonly failurePhase?: WorkflowRunPhase;
  /** The immutable selected issue identity (absent for "no-issues"). */
  readonly issue?: GithubIssue;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  /** Implementation worktree path (kept on disk after failures). */
  readonly worktreePath?: string;
  /** Set when a worktree was left behind (dirty after success, or any failure). */
  readonly preservedWorktreePath?: string;
  readonly integrationBranch?: string;
  /** Commits the agent produced on the source branch. */
  readonly commits: readonly { readonly sha: string }[];
  /** Verification results on the source worktree (empty when none configured). */
  readonly verification: readonly VerificationCommandResult[];
  /** Aggregate verification state — mirrors settings.verificationStatus. */
  readonly verificationStatus?: VerificationStatus;
  /** Verification results on the integrated tree (set when reached). */
  readonly integrationVerification?: readonly VerificationCommandResult[];
  readonly completionSignalSeen: boolean;
  /** The target branch's SHA after landing. */
  readonly landedSha?: string;
  /** `git log` one-liners for the commits landed onto the target branch. */
  readonly landedCommits?: readonly string[];
  /** `git diff --stat` block for the landed change — report material. */
  readonly changeStat?: string;
  /** Whether the Vietnamese report was posted to the issue. */
  readonly reportPosted: boolean;
  /** Whether the issue was closed (only ever true after landing + report). */
  readonly issueClosed: boolean;
  /** The report body posted (or attempted) — for tests and `status` surfaces. */
  readonly reportBody?: string;
  readonly logFilePath?: string;
  /** Agent session id when the provider reports one (resume material). */
  readonly sessionId?: string;
  /** Attempt counters — implementation plus bounded repair/rebuild counts. */
  readonly attempts: WorkflowRunAttempts;
  /** Vietnamese one-line summary for the CLI status line. */
  readonly message: string;
}

export interface RunIssueWorkflowOptions {
  /** Repo root — git and `.sandcastle/` anchor. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Deterministic issue selection (`--issue <number>`). */
  readonly issueNumber?: number;
  /**
   * Interactive issue picker — cli.ts injects a clack `select`. Returning
   * `undefined` aborts the run. When absent the run is non-interactive and
   * requires `issueNumber` once eligible issues exist.
   */
  readonly selectIssue?: (
    issues: readonly GithubIssue[],
  ) => Promise<number | undefined>;
  /** Vietnamese phase/status lines — cli.ts wires this to the Display service. */
  readonly onStatus?: (message: string, severity: Severity) => void;
  /** `gh` process boundary (tests substitute a fake executable on PATH). */
  readonly ghRunner?: GhRunner;
  /** Discovery-exec boundary used for the `gh` readiness probe. */
  readonly discoveryExec?: DiscoveryExec;
  /** Per-command timeout for verification steps (default 10 minutes). */
  readonly verificationTimeoutMs?: number;
}

/** A hard pre-run failure — thrown, never reported to the issue. */
export class WorkflowRunError extends Error {
  readonly _tag = "WorkflowRunError";
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunError";
  }
}

// ---------------------------------------------------------------------------
// Small host helpers
// ---------------------------------------------------------------------------

const GIT_ENV = { ...process.env, LC_ALL: "C" };

const git = async (args: readonly string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: GIT_ENV,
  });
  return stdout.trim();
};

/** Best-effort git — failures are swallowed (cleanup paths). */
const gitQuiet = async (
  args: readonly string[],
  cwd: string,
): Promise<void> => {
  try {
    await git(args, cwd);
  } catch {
    // best-effort
  }
};

/** Run an Effect that needs at most FileSystem, surfacing the inner error. */
const runEffect = async <A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";

const shortSha = (sha: string): string => sha.slice(0, 8);

const OUTPUT_TAIL_CHARS = 4000;
const tail = (text: string): string =>
  text.length <= OUTPUT_TAIL_CHARS
    ? text
    : `…${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;

const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Bounded repair limits (ADR 0024)
// ---------------------------------------------------------------------------

/** Verification-failure repairs in the source worktree. */
export const MAX_VERIFICATION_REPAIR_ATTEMPTS = 2;
/** Merge-conflict repairs in the integration worktree. */
export const MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS = 1;
/** Integration-state rebuilds after the target branch moved. */
export const MAX_TARGET_REBUILD_ATTEMPTS = 1;

// ---------------------------------------------------------------------------
// Settings → provider resolution
// ---------------------------------------------------------------------------

type AgentFactory = (
  model: string,
  options?: Record<string, unknown>,
) => AgentProvider;

/**
 * Registry `factoryImport` name → provider factory. Mirrors the generated-code
 * contract in `InitService`'s template rewriting: the persisted `settings.effort`
 * reaches the factory under the registry entry's `effortOption` field name.
 */
const AGENT_FACTORIES: Record<string, AgentFactory> = {
  claudeCode: (model, options) =>
    claudeCode(model, options as ClaudeCodeOptions | undefined),
  pi: (model, options) => pi(model, options as PiOptions | undefined),
  codex: (model, options) => codex(model, options as CodexOptions | undefined),
  cursor: (model, options) =>
    cursor(model, options as CursorOptions | undefined),
  opencode: (model, options) =>
    opencode(model, options as OpenCodeOptions | undefined),
  copilot: (model, options) =>
    copilot(model, options as CopilotOptions | undefined),
  devin: (model, options) => devin(model, options as DevinOptions | undefined),
  grok: (model, options) => grok(model, options as GrokOptions | undefined),
  antigravity: (model, options) =>
    antigravity(model, options as AntigravityOptions | undefined),
};

const resolveAgentProvider = (settings: ProjectSettings): AgentProvider => {
  const entry = getAgent(settings.agent);
  const factory =
    entry === undefined ? undefined : AGENT_FACTORIES[entry.factoryImport];
  if (entry === undefined || factory === undefined) {
    throw new WorkflowRunError(
      `Agent "${settings.agent}" trong settings không được hỗ trợ. ` +
        `Các agent khả dụng: ${listAgents()
          .map((a) => a.name)
          .join(", ")}. ` +
        "Chạy `sandcastle configure` hoặc sửa .sandcastle/settings.json.",
    );
  }
  const options =
    settings.effort !== undefined && entry.effortOption !== undefined
      ? { [entry.effortOption]: settings.effort }
      : undefined;
  return factory(settings.model, options);
};

const resolveSandboxProvider = (settings: ProjectSettings): SandboxProvider => {
  switch (settings.sandbox) {
    case "host":
      return noSandbox();
    case "podman":
      return podman();
    case "docker":
      return docker();
  }
};

// ---------------------------------------------------------------------------
// Prompt (ADR 0023 — issue closing lives with Sandcastle, never the agent)
// ---------------------------------------------------------------------------

export const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

/**
 * The implementation prompt for one selected issue. Built at run time rather
 * than read from a scaffolded template: the checked-in templates carry the
 * legacy "agent picks and closes issues" contract (`{{CLOSE_TASK_COMMAND}}`
 * etc.), while the run workflow must keep issue identity immutable and issue
 * closure out of the agent's reach. Inline prompts also bypass `` !`…` ``
 * shell expansion and `{{…}}` substitution, so issue bodies are passed to the
 * agent verbatim.
 */
export const buildImplementationPrompt = (params: {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly verificationCommands: readonly string[];
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } = params;
  const verificationBlock =
    verificationCommands.length > 0
      ? `\n## Verification\n\nAfter you finish, the following project commands will be run to check your work. Make sure they pass:\n\n${verificationCommands.map((c) => `- \`${c}\``).join("\n")}\n`
      : "";
  return `# Task

Implement GitHub issue #${issue.number}: ${issue.title}

${
  issue.body.trim().length > 0
    ? `## Issue description\n\n${issue.body}\n\n`
    : ""
}## Rules

- You are working on branch \`${sourceBranch}\` in a dedicated worktree. Keep all changes committed on this branch — Sandcastle verifies and merges them into \`${targetBranch}\` itself.
- The issue identity above is fixed for this run. Implement issue #${issue.number} and nothing else; do not pick a different task.
- Commit your work with clear commit messages before finishing.
- Do NOT run \`gh issue close\`, \`gh issue comment\`, or any other command that mutates the issue — Sandcastle verifies, merges, reports, and closes the issue after your work lands.
${verificationBlock}
When the work is fully implemented and committed, output exactly: ${DEFAULT_COMPLETION_SIGNAL}
`;
};

/**
 * The verification-repair prompt (ADR 0024): the exact failed command and its
 * output go back to the agent in the SAME worktree. `continuingSession`
 * distinguishes a native session resume — the agent still has the full
 * conversation — from a fresh invocation against the preserved worktree,
 * where the prompt must re-establish the task context itself.
 */
export const buildVerificationRepairPrompt = (params: {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly verificationCommands: readonly string[];
  readonly failure: VerificationCommandResult;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly continuingSession: boolean;
}): string => {
  const {
    issue,
    sourceBranch,
    targetBranch,
    verificationCommands,
    failure,
    attempt,
    maxAttempts,
    continuingSession,
  } = params;
  return `# Verification repair — attempt ${attempt}/${maxAttempts}

${
  continuingSession
    ? `Continue your current session: the work you just produced for issue #${issue.number} failed project verification.`
    : `A previous Sandcastle run implemented issue #${issue.number} on branch \`${sourceBranch}\` in THIS worktree. The implementation is committed, but project verification then failed — repair the existing work rather than starting over.`
}

## Task being implemented

Issue #${issue.number}: ${issue.title}
${issue.body.trim().length > 0 ? `\n${issue.body}\n` : ""}
## What failed

The verification command:

\`\`\`
${failure.command}
\`\`\`

exited with code ${failure.exitCode ?? "?"} and produced:

\`\`\`
${failure.outputTail.trim() || "(no output)"}
\`\`\`

## Rules

- Fix the work in this worktree so that ALL of the configured verification commands pass:
${verificationCommands.map((c) => `  - \`${c}\``).join("\n")}
- Commit your fixes on \`${sourceBranch}\` — Sandcastle re-runs verification, then merges into \`${targetBranch}\` itself.
- Do NOT run \`gh issue close\`, \`gh issue comment\`, or any other command that mutates the issue.
- Do not revert the existing implementation — repair it.

When the repair is committed, output exactly: ${DEFAULT_COMPLETION_SIGNAL}
`;
};

/**
 * The single allowed merge-conflict repair prompt (ADR 0024). The agent runs
 * inside the integration worktree where `git merge` stopped mid-merge; it
 * resolves the conflicted files and commits the merge there. After it
 * returns, Sandcastle checks the merge actually landed (no unmerged paths,
 * source branch is an ancestor) before re-running all verification commands
 * on the integrated tree.
 */
export const buildMergeConflictRepairPrompt = (params: {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly integrationBranch: string;
  readonly mergeOutput: string;
  readonly verificationCommands: readonly string[];
  readonly continuingSession: boolean;
}): string => {
  const {
    issue,
    sourceBranch,
    targetBranch,
    integrationBranch,
    mergeOutput,
    verificationCommands,
    continuingSession,
  } = params;
  return `# Merge conflict repair

${
  continuingSession
    ? `Continue your current session: merging the work you produced for issue #${issue.number} hit conflicts.`
    : `A previous Sandcastle run implemented issue #${issue.number} on branch \`${sourceBranch}\`.`
}

Sandcastle is merging \`${sourceBranch}\` into \`${targetBranch}\` inside THIS worktree (the throwaway integration branch \`${integrationBranch}\`). The merge stopped with conflicts and is still in progress.

## Merge output

\`\`\`
${mergeOutput.trim() || "(no output)"}
\`\`\`

## Rules

- Resolve every conflicted file in this worktree, keeping the intent of BOTH sides of the merge.
- \`git add\` each resolved file, then \`git commit\` to complete the in-progress merge — do NOT run \`git merge --abort\`, \`git reset\`, or \`git rebase\`.
- Do NOT run \`gh issue close\`, \`gh issue comment\`, or any other command that mutates the issue.${
    verificationCommands.length > 0
      ? `\n- After the merge commits, these verification commands must pass:\n${verificationCommands.map((c) => `  - \`${c}\``).join("\n")}`
      : ""
  }
- If the conflict cannot be resolved safely, leave the worktree as it is and explain why instead of committing a bad resolution.

When the merge is committed — or you are certain it cannot be resolved — output exactly: ${DEFAULT_COMPLETION_SIGNAL}
`;
};

// ---------------------------------------------------------------------------
// Vietnamese reports (ADR 0026 — presentation boundary)
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<WorkflowRunPhase, string> = {
  preflight: "kiểm tra điều kiện ban đầu",
  implementation: "chạy agent trên nhánh làm việc",
  verification: "xác minh trên nhánh làm việc",
  integration: "merge trong worktree tích hợp",
  "integration-verification": "xác minh lại sau khi merge",
  landing: "cập nhật nhánh đích",
  reporting: "đăng báo cáo",
};

const formatVerificationLines = (
  stageLabel: string,
  results: readonly VerificationCommandResult[] | undefined,
  configured: boolean,
): string[] => {
  if (!configured) {
    return [`- ${stageLabel}: không có lệnh xác minh nào được cấu hình.`];
  }
  if (results === undefined || results.length === 0) {
    return [`- ${stageLabel}: chưa chạy.`];
  }
  return [
    `- ${stageLabel}:`,
    ...results.map(
      (r) =>
        `  - \`${r.command}\` — ${
          r.status === "passed"
            ? "đã pass"
            : r.status === "failed"
              ? `thất bại (exit ${r.exitCode ?? "?"})`
              : "bị bỏ qua"
        }`,
    ),
  ];
};

const REPORT_TAIL_CHARS = 3000;

/** The Vietnamese completion report posted to the issue after landing. */
export const buildCompletionReport = (params: {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly landedSha: string;
  readonly landedCommits: readonly string[];
  readonly changeStat?: string;
  readonly verification: readonly VerificationCommandResult[];
  readonly integrationVerification?: readonly VerificationCommandResult[];
  readonly verificationConfigured: boolean;
  readonly cautions: readonly string[];
}): string => {
  const {
    issue,
    sourceBranch,
    targetBranch,
    landedSha,
    landedCommits,
    changeStat,
    verification,
    integrationVerification,
    verificationConfigured,
    cautions,
  } = params;

  const commitLines =
    landedCommits.length > 0
      ? landedCommits.map((c) => `- ${c}`)
      : ["- (không có commit mới — nhánh đích đã chứa kết quả)"];

  const changeBlock =
    changeStat !== undefined && changeStat.trim().length > 0
      ? `\n\`\`\`\n${tail(changeStat.trim())}\n\`\`\`\n`
      : "";

  return `## ✅ Sandcastle đã hoàn thành

**Kết quả:** issue #${issue.number} đã được implement, xác minh và merge vào nhánh \`${targetBranch}\` (HEAD: \`${shortSha(landedSha)}\`).

**Thay đổi** (các commit đã merge):
${commitLines.join("\n")}
${changeBlock}
**Tác động:** thay đổi đã nằm trên nhánh \`${targetBranch}\` của dự án — kiểm tra bằng \`git log\`/\`git show ${shortSha(landedSha)}\` nếu cần chi tiết.

**Xác minh đã chạy:**
${formatVerificationLines(`trên nhánh làm việc \`${sourceBranch}\``, verification, verificationConfigured).join("\n")}
${formatVerificationLines("sau khi merge vào nhánh đích", integrationVerification, verificationConfigured).join("\n")}

**Lưu ý:**
${cautions.length > 0 ? cautions.map((c) => `- ${c}`).join("\n") : "- Không có."}
`;
};

/** The Vietnamese failure report posted when a run stops before landing. */
export const buildFailureReport = (params: {
  readonly issue: GithubIssue;
  readonly phase: WorkflowRunPhase;
  readonly error: string;
  readonly verification: readonly VerificationCommandResult[];
  readonly integrationVerification?: readonly VerificationCommandResult[];
  readonly verificationConfigured: boolean;
  readonly sourceBranch?: string;
  readonly worktreePath?: string;
  /** Attempt counters — shown so an exhausted repair reads as bounded, not lazy. */
  readonly attempts?: WorkflowRunAttempts;
}): string => {
  const {
    issue,
    phase,
    error,
    verification,
    integrationVerification,
    verificationConfigured,
    sourceBranch,
    worktreePath,
    attempts,
  } = params;

  const attemptsLine =
    attempts !== undefined &&
    (attempts.verificationRepair > 0 ||
      attempts.mergeConflictRepair > 0 ||
      attempts.integrationRebuild > 0)
      ? `**Tự động sửa đã thử:** xác minh ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS} lần, xung đột merge ${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS} lần, dựng lại tích hợp ${attempts.integrationRebuild}/${MAX_TARGET_REBUILD_ATTEMPTS} lần.\n\n`
      : "";

  const recoveryLine =
    sourceBranch !== undefined && worktreePath !== undefined
      ? `Nhánh \`${sourceBranch}\` và worktree \`${worktreePath}\` được giữ lại để kiểm tra hoặc chạy lại sau.`
      : sourceBranch !== undefined
        ? `Nhánh \`${sourceBranch}\` được giữ lại để kiểm tra hoặc chạy lại sau.`
        : "";

  return `## ⚠️ Sandcastle không hoàn thành issue này

**Bước thất bại:** ${PHASE_LABEL[phase]}

**Chi tiết:**
\`\`\`
${tail(error.trim() || "(không có chi tiết)")}
\`\`\`

${attemptsLine}**Xác minh đã chạy:**
${formatVerificationLines("trên nhánh làm việc", verification, verificationConfigured).join("\n")}
${integrationVerification !== undefined ? formatVerificationLines("sau khi merge", integrationVerification, verificationConfigured).join("\n") : ""}

**Trạng thái:** issue #${issue.number} vẫn mở — không có thay đổi nào được merge vào nhánh đích. ${recoveryLine}
`;
};

// ---------------------------------------------------------------------------
// Verification runner
// ---------------------------------------------------------------------------

/**
 * Run verification commands sequentially in `cwd`, stopping at the first
 * failure. Commands after a failure are recorded as `"skipped"` so the
 * per-command record is honest about what actually ran.
 */
export const runVerificationCommands = async (
  commands: readonly string[],
  cwd: string,
  timeoutMs: number = VERIFICATION_TIMEOUT_MS,
): Promise<VerificationCommandResult[]> => {
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      results.push({
        command,
        status: "passed",
        exitCode: 0,
        durationMs: Date.now() - started,
        outputTail: tail(`${stdout}${stderr}`),
      });
    } catch (e) {
      const err = e as {
        code?: unknown;
        stdout?: string;
        stderr?: string;
      };
      results.push({
        command,
        status: "failed",
        exitCode: typeof err.code === "number" ? err.code : null,
        durationMs: Date.now() - started,
        outputTail: tail(
          `${err.stdout ?? ""}${err.stderr ?? ""}` ||
            (e instanceof Error ? e.message : String(e)),
        ),
      });
      for (const rest of commands.slice(results.length)) {
        results.push({
          command: rest,
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          outputTail: "",
        });
      }
      break;
    }
  }
  return results;
};

const hasFailedVerification = (
  results: readonly VerificationCommandResult[],
): boolean => results.some((r) => r.status === "failed");

/** Aggregate stage status for settings + the result record. */
const aggregateVerificationStatus = (
  configuredCount: number,
  results: readonly VerificationCommandResult[],
  configuredButEmptyStatus: VerificationStatus | undefined,
): VerificationStatus =>
  configuredCount === 0
    ? (configuredButEmptyStatus ?? "unavailable")
    : hasFailedVerification(results)
      ? "failed"
      : "passed";

/** Best-effort `settings.verificationStatus` write — never sinks a run. */
const persistVerificationStatus = async (
  cwd: string,
  status: VerificationStatus,
): Promise<void> => {
  try {
    await updateProjectSettingsAsync(cwd, { verificationStatus: status });
  } catch {
    // A settings write failure must not fail the run itself.
  }
};

// ---------------------------------------------------------------------------
// Recovery state (ADR 0024 — durable record for `status`/`retry`/`discard`)
// ---------------------------------------------------------------------------

/** Durable record written on failure so later `status`/`retry` can pick up. */
export interface RecoveryState {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly worktreePath?: string;
  readonly failurePhase: WorkflowRunPhase;
  readonly error: string;
  readonly verification: readonly VerificationCommandResult[];
  readonly integrationVerification?: readonly VerificationCommandResult[];
  readonly commits: readonly { readonly sha: string }[];
  readonly sessionId?: string;
  readonly logFilePath?: string;
  /** Bounded-repair counters spent before this failure (#18). */
  readonly attempts: WorkflowRunAttempts;
  readonly failedAt: string;
}

export const recoveryStatePath = (cwd: string, issueNumber: number): string =>
  join(cwd, ".sandcastle", "recovery", `issue-${issueNumber}.json`);

const writeRecoveryState = async (
  cwd: string,
  state: RecoveryState,
): Promise<void> => {
  const dir = join(cwd, ".sandcastle", "recovery");
  await mkdir(dir, { recursive: true });
  await writeFile(
    recoveryStatePath(cwd, state.issue.number),
    JSON.stringify(state, null, 2) + "\n",
  );
  // Recovery state is machine-local — keep it out of git. Append to the
  // scaffolded .sandcastle/.gitignore when present; create a minimal one when
  // not (a fresh file only adds ignores, it cannot un-ignore anything).
  const gitignorePath = join(cwd, ".sandcastle", ".gitignore");
  try {
    const content = await readFile(gitignorePath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim());
    if (!lines.includes("recovery/")) {
      await appendFile(
        gitignorePath,
        `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}recovery/\n`,
      );
    }
  } catch {
    await writeFile(gitignorePath, "recovery/\n").catch(() => {});
  }
};

const clearRecoveryState = async (
  cwd: string,
  issueNumber: number,
): Promise<void> => {
  await rm(recoveryStatePath(cwd, issueNumber), { force: true }).catch(
    () => {},
  );
};

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

export const runIssueWorkflow = async (
  options: RunIssueWorkflowOptions,
): Promise<WorkflowRunResult> => {
  const cwd = options.cwd ?? process.cwd();
  const status = (message: string, severity: Severity = "info") =>
    options.onStatus?.(message, severity);
  const gh: GithubIssueOps = makeGithubIssueOps(
    cwd,
    options.ghRunner ?? nodeGhRunner,
  );
  const verificationTimeoutMs =
    options.verificationTimeoutMs ?? VERIFICATION_TIMEOUT_MS;
  const verificationConfigured = (): boolean =>
    settings.verificationCommands.length > 0;

  // ---- Preflight: settings, gh auth, label (ADR 0026 — fail before work) ---

  const settings = await loadProjectSettingsAsync(cwd);
  if (settings.issueTracker !== "github-issues") {
    throw new WorkflowRunError(
      `\`sandcastle run\` hiện chỉ hỗ trợ issue tracker "github-issues" — ` +
        `dự án này đang dùng "${settings.issueTracker}". ` +
        "Chạy `sandcastle init` lại và chọn github-issues nếu muốn dùng workflow này.",
    );
  }

  status("Đang kiểm tra GitHub CLI (gh) và label…");
  const readiness = await probeGhReadiness(
    options.discoveryExec ?? nodeDiscoveryExec,
  );
  if (readiness.kind !== "ready") {
    throw new WorkflowRunError(
      readiness.kind === "not-installed"
        ? "Chưa tìm thấy GitHub CLI (`gh`). Cài đặt từ https://cli.github.com/ (ví dụ `brew install gh`), sau đó chạy `gh auth login`."
        : readiness.kind === "unauthenticated"
          ? "`gh` đã được cài đặt nhưng chưa đăng nhập GitHub. Chạy `gh auth login` để đăng nhập."
          : `Không kiểm tra được gh: ${readiness.detail ?? "lỗi không xác định"}.`,
    );
  }

  let labelExists = false;
  try {
    labelExists = await gh.labelExists();
  } catch (e) {
    throw new WorkflowRunError(
      `Không kiểm tra được label GitHub: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!labelExists) {
    throw new WorkflowRunError(
      `Repository chưa có label "${SANDCASTLE_LABEL}". Chạy \`sandcastle init\` ` +
        `để tạo label, hoặc tạo thủ công: gh label create ${SANDCASTLE_LABEL}.`,
    );
  }

  // ---- Issue selection — immutable once chosen (ADR 0026) -------------------

  const assertEligible = (issue: GithubIssue): void => {
    if (issue.state !== "OPEN") {
      throw new WorkflowRunError(
        `Issue #${issue.number} không ở trạng thái mở (state: ${issue.state || "unknown"}).`,
      );
    }
    if (!issue.labels.includes(SANDCASTLE_LABEL)) {
      throw new WorkflowRunError(
        `Issue #${issue.number} không có label "${SANDCASTLE_LABEL}" — ` +
          "chỉ các issue được gắn label này mới được Sandcastle thực hiện.",
      );
    }
  };

  let issue: GithubIssue;
  if (options.issueNumber !== undefined) {
    try {
      issue = await gh.viewIssue(options.issueNumber);
    } catch (e) {
      throw new WorkflowRunError(
        `Không đọc được issue #${options.issueNumber}: ` +
          `${e instanceof Error ? e.message : String(e)}.`,
      );
    }
    assertEligible(issue);
  } else {
    let issues: GithubIssue[];
    try {
      issues = await gh.listEligibleIssues();
    } catch (e) {
      throw new WorkflowRunError(
        `Không lấy được danh sách issue: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (issues.length === 0) {
      return {
        outcome: "no-issues",
        commits: [],
        verification: [],
        completionSignalSeen: false,
        reportPosted: false,
        issueClosed: false,
        attempts: {
          implementation: 0,
          verificationRepair: 0,
          mergeConflictRepair: 0,
          integrationRebuild: 0,
        },
        message: `Không có issue nào đang mở với label "${SANDCASTLE_LABEL}".`,
      };
    }
    if (options.selectIssue === undefined) {
      throw new WorkflowRunError(
        "Chế độ không tương tác cần `--issue <number>` để chọn issue " +
          "(ví dụ `sandcastle run --issue 5`).",
      );
    }
    const picked = await options.selectIssue(issues);
    if (picked === undefined) {
      throw new WorkflowRunError("Đã hủy — chưa chọn issue nào.");
    }
    // Re-view for the canonical fresh identity — list data can be stale.
    try {
      issue = await gh.viewIssue(picked);
    } catch (e) {
      throw new WorkflowRunError(
        `Không đọc được issue #${picked}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    assertEligible(issue);
  }

  status(`Đã chọn issue #${issue.number}: ${issue.title}`);

  // ---- Resolve agent + sandbox from persisted settings ----------------------

  const agent = resolveAgentProvider(settings);
  const sandbox = resolveSandboxProvider(settings);
  // The resolved repo root, matching what createWorktree/wt.run use to key
  // host-side session storage — needed by the resume precheck for repairs.
  const hostRepoDir = await runEffect(resolveCwd(cwd));

  const targetBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (targetBranch === "HEAD") {
    throw new WorkflowRunError(
      "Repository đang ở trạng thái detached HEAD — hãy checkout một nhánh trước khi chạy `sandcastle run`.",
    );
  }
  const sourceBranch = `sandcastle/issue-${issue.number}`;

  // ---- Failure path — one closure used by every phase after selection -------

  let phase: WorkflowRunPhase = "implementation";
  let wt: Worktree | undefined;
  let integrationWt: Worktree | undefined;
  let verification: VerificationCommandResult[] = [];
  let integrationVerification: VerificationCommandResult[] | undefined;
  let integrationBranch: string | undefined;
  let integrationPath: string | undefined;

  // Bounded-repair bookkeeping (ADR 0024): every agent invocation after the
  // first implementation run bumps a counter that is reported, persisted to
  // the recovery record, and asserted by tests.
  const attempts = {
    implementation: 0,
    verificationRepair: 0,
    mergeConflictRepair: 0,
    integrationRebuild: 0,
  };
  // Accumulated across all agent runs (implementation + repairs): each wt.run
  // returns only that invocation's commits/session.
  const allCommits: { sha: string }[] = [];
  let lastSessionId: string | undefined;
  let lastCompletionSignal: string | undefined;
  let lastLogFilePath: string | undefined;

  const recordAgentRun = (r: WorktreeRunResult): void => {
    // Dedupe by sha: the merge-conflict repair runs inside the integration
    // worktree, where commit collection re-reports the source commits that
    // arrived via the merge.
    for (const c of r.commits) {
      if (!allCommits.some((known) => known.sha === c.sha)) allCommits.push(c);
    }
    const sid = r.iterations.at(-1)?.sessionId;
    if (sid !== undefined) lastSessionId = sid;
    if (r.completionSignal !== undefined)
      lastCompletionSignal = r.completionSignal;
    if (r.logFilePath !== undefined) lastLogFilePath = r.logFilePath;
  };

  /**
   * The session id to resume for a repair run, or `undefined` when a fresh
   * invocation must carry the full context instead: non-resumable provider
   * (no sessionStorage / captureSessions off), no session id captured, or the
   * recorded session no longer exists on the host (ADR 0024 — "agents without
   * resumable session storage can still retry because the code, branch,
   * failure output, and task identity are preserved").
   */
  const resumableSession = async (): Promise<string | undefined> => {
    if (lastSessionId === undefined) return undefined;
    if (!agent.captureSessions || agent.sessionStorage === undefined) {
      return undefined;
    }
    try {
      await assertResumeSessionExists({
        provider: agent,
        sandboxTag: sandbox.tag,
        hostRepoDir,
        resumeSession: lastSessionId,
      });
      return lastSessionId;
    } catch {
      return undefined;
    }
  };

  const cleanupIntegration = async (): Promise<void> => {
    if (integrationPath !== undefined) {
      await gitQuiet(["merge", "--abort"], integrationPath);
      await gitQuiet(["worktree", "remove", "--force", integrationPath], cwd);
      integrationPath = undefined;
    }
    if (integrationBranch !== undefined) {
      await gitQuiet(["branch", "-D", integrationBranch], cwd);
      integrationBranch = undefined;
    }
    integrationWt = undefined;
  };

  /**
   * The one allowed merge-conflict repair (ADR 0024): run the agent inside the
   * integration worktree while the merge is still in progress, then prove the
   * merge actually committed before re-verifying. Returns false when the
   * failure isn't a resolvable conflict or the repair budget is spent —
   * callers then abort the merge and fail with the original error. Throws for
   * post-repair states that still aren't a completed merge.
   */
  const repairMergeConflict = async (mergeError: unknown): Promise<boolean> => {
    if (
      integrationPath === undefined ||
      integrationWt === undefined ||
      integrationBranch === undefined
    ) {
      return false;
    }
    const unmerged = await git(["ls-files", "-u"], integrationPath).catch(
      () => "",
    );
    if (unmerged.trim().length === 0) return false; // not a content conflict
    if (attempts.mergeConflictRepair >= MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS) {
      return false; // budget spent — caller aborts and reports the merge error
    }
    attempts.mergeConflictRepair++;
    const resumeSession = await resumableSession();
    status(
      `Merge bị xung đột — agent đang giải quyết trong worktree tích hợp ` +
        `(lần ${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS}` +
        `${resumeSession !== undefined ? ", tiếp tục phiên agent" : ", phiên mới"})…`,
      "warn",
    );
    const repair = await integrationWt.run({
      agent,
      sandbox,
      prompt: buildMergeConflictRepairPrompt({
        issue,
        sourceBranch,
        targetBranch,
        integrationBranch,
        mergeOutput:
          mergeError instanceof Error ? mergeError.message : String(mergeError),
        verificationCommands: settings.verificationCommands,
        continuingSession: resumeSession !== undefined,
      }),
      name: `issue-${issue.number}-integrate`,
      maxIterations: 1,
      completionSignal: DEFAULT_COMPLETION_SIGNAL,
      ...(resumeSession !== undefined ? { resumeSession } : {}),
    });
    recordAgentRun(repair);

    // The merge only counts as repaired once the worktree is clean of
    // unmerged paths AND the source branch is an ancestor of HEAD.
    const stillUnmerged = await git(["ls-files", "-u"], integrationPath).catch(
      () => "",
    );
    if (stillUnmerged.trim().length > 0) {
      throw new Error(
        `Merge vẫn còn file xung đột sau ${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS} ` +
          `lần sửa tự động:\n${stillUnmerged.trim()}`,
      );
    }
    const mergeHead = await git(
      ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
      integrationPath,
    ).catch(() => "");
    if (mergeHead !== "") {
      // The agent staged the resolution but left the merge open — finishing
      // it here is deterministic (same message git would have used).
      await git(["commit", "--no-edit"], integrationPath);
    }
    const merged = await git(
      ["merge-base", "--is-ancestor", sourceBranch, "HEAD"],
      integrationPath,
    ).then(
      () => true,
      () => false,
    );
    if (!merged) {
      throw new Error(
        `Agent kết thúc nhưng \`${sourceBranch}\` không nằm trong kết quả merge ` +
          "(có thể merge đã bị abort thay vì resolve) — dừng lại để kiểm tra.",
      );
    }
    return true;
  };

  const fail = async (error: unknown): Promise<WorkflowRunResult> => {
    const detail = error instanceof Error ? error.message : String(error);
    // The integration worktree/branch is derived state — always discarded;
    // the source branch and implementation worktree keep the actual work.
    await cleanupIntegration();
    const reportBody = buildFailureReport({
      issue,
      phase,
      error: detail,
      verification,
      integrationVerification,
      verificationConfigured: verificationConfigured(),
      sourceBranch,
      worktreePath: wt?.worktreePath,
      attempts,
    });
    let reportPosted = false;
    try {
      await gh.postComment(issue.number, reportBody);
      reportPosted = true;
    } catch {
      // A failure to report must not sink the cleanup path.
    }
    const state: RecoveryState = {
      issue,
      sourceBranch,
      targetBranch,
      ...(wt !== undefined ? { worktreePath: wt.worktreePath } : {}),
      failurePhase: phase,
      error: detail,
      verification,
      ...(integrationVerification !== undefined
        ? { integrationVerification }
        : {}),
      commits: allCommits,
      ...(lastSessionId !== undefined ? { sessionId: lastSessionId } : {}),
      ...(lastLogFilePath !== undefined
        ? { logFilePath: lastLogFilePath }
        : {}),
      attempts,
      failedAt: new Date().toISOString(),
    };
    await writeRecoveryState(cwd, state).catch(() => {});
    const repairSummary =
      attempts.verificationRepair > 0 ||
      attempts.mergeConflictRepair > 0 ||
      attempts.integrationRebuild > 0
        ? ` Đã thử sửa tự động: xác minh ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS}, ` +
          `xung đột merge ${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS}, ` +
          `dựng lại tích hợp ${attempts.integrationRebuild}/${MAX_TARGET_REBUILD_ATTEMPTS}.`
        : "";
    return {
      outcome: "failed",
      failurePhase: phase,
      issue,
      sourceBranch,
      targetBranch,
      worktreePath: wt?.worktreePath,
      // Failure always preserves the worktree for recovery — it stays on disk.
      preservedWorktreePath: wt?.worktreePath,
      integrationBranch,
      commits: allCommits,
      verification,
      verificationStatus: aggregateVerificationStatus(
        settings.verificationCommands.length,
        verification,
        settings.verificationStatus,
      ),
      ...(integrationVerification !== undefined
        ? { integrationVerification }
        : {}),
      completionSignalSeen: lastCompletionSignal !== undefined,
      reportPosted,
      issueClosed: false,
      reportBody,
      logFilePath: lastLogFilePath,
      sessionId: lastSessionId,
      attempts,
      message:
        `Thất bại ở bước "${PHASE_LABEL[phase]}": ${firstLine(detail)}.` +
        `${repairSummary} ` +
        `Issue #${issue.number} vẫn mở; nhánh \`${sourceBranch}\` và worktree được giữ lại.` +
        (reportPosted ? "" : " (Không đăng được báo cáo thất bại lên GitHub.)"),
    };
  };

  // ---- Implementation -------------------------------------------------------

  try {
    wt = await createWorktree({
      cwd,
      branchStrategy: {
        type: "branch",
        branch: sourceBranch,
        baseBranch: targetBranch,
      },
      copyToWorktree: ["node_modules"],
    });
  } catch (e) {
    return fail(e);
  }

  status(
    `Đang chạy agent cho issue #${issue.number} trên nhánh \`${sourceBranch}\`…`,
  );
  attempts.implementation = 1;
  try {
    const implResult = await wt.run({
      agent,
      sandbox,
      prompt: buildImplementationPrompt({
        issue,
        sourceBranch,
        targetBranch,
        verificationCommands: settings.verificationCommands,
      }),
      name: `issue-${issue.number}`,
      maxIterations: 1,
      completionSignal: DEFAULT_COMPLETION_SIGNAL,
    });
    recordAgentRun(implResult);
  } catch (e) {
    return fail(e);
  }

  if (allCommits.length === 0) {
    return fail(
      new Error(
        "Agent kết thúc nhưng không tạo commit nào trên nhánh làm việc — " +
          "không có thay đổi nào để xác minh hay merge.",
      ),
    );
  }

  // ---- Verification on the source worktree -----------------------------------
  //
  // A failed command goes back to the agent in the SAME worktree — resuming
  // the same session when the provider supports it, else a fresh invocation
  // against the preserved code with the task + failure inlined. Bounded at
  // MAX_VERIFICATION_REPAIR_ATTEMPTS; every repair re-runs ALL commands.

  phase = "verification";
  if (verificationConfigured()) {
    status("Đang chạy lệnh xác minh…");
    verification = await runVerificationCommands(
      settings.verificationCommands,
      wt.worktreePath,
      verificationTimeoutMs,
    );
    await persistVerificationStatus(
      cwd,
      hasFailedVerification(verification) ? "failed" : "passed",
    );

    while (hasFailedVerification(verification)) {
      const failed = verification.find((r) => r.status === "failed")!;
      if (attempts.verificationRepair >= MAX_VERIFICATION_REPAIR_ATTEMPTS) {
        return fail(
          new Error(
            `Lệnh xác minh vẫn thất bại sau ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS} ` +
              `lần sửa tự động: \`${failed.command}\` (exit ${failed.exitCode ?? "?"})\n${failed.outputTail}`,
          ),
        );
      }
      attempts.verificationRepair++;
      const resumeSession = await resumableSession();
      status(
        `Xác minh thất bại — agent đang sửa trong cùng worktree ` +
          `(lần ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS}` +
          `${resumeSession !== undefined ? ", tiếp tục phiên agent" : ", phiên mới"})…`,
        "warn",
      );
      try {
        const repair = await wt.run({
          agent,
          sandbox,
          prompt: buildVerificationRepairPrompt({
            issue,
            sourceBranch,
            targetBranch,
            verificationCommands: settings.verificationCommands,
            failure: failed,
            attempt: attempts.verificationRepair,
            maxAttempts: MAX_VERIFICATION_REPAIR_ATTEMPTS,
            continuingSession: resumeSession !== undefined,
          }),
          name: `issue-${issue.number}`,
          maxIterations: 1,
          completionSignal: DEFAULT_COMPLETION_SIGNAL,
          ...(resumeSession !== undefined ? { resumeSession } : {}),
        });
        recordAgentRun(repair);
      } catch (e) {
        return fail(e);
      }
      status("Đang chạy lại lệnh xác minh sau khi sửa…");
      verification = await runVerificationCommands(
        settings.verificationCommands,
        wt.worktreePath,
        verificationTimeoutMs,
      );
      await persistVerificationStatus(
        cwd,
        hasFailedVerification(verification) ? "failed" : "passed",
      );
    }
  } else {
    status(
      `Không có lệnh xác minh nào được cấu hình — bỏ qua bước xác minh (trạng thái: ${settings.verificationStatus ?? "unavailable"}).`,
      "warn",
    );
  }

  // ---- Integration in a separate worktree (ADR 0024) --------------------------
  //
  // One loop iteration = build a disposable integration worktree on the
  // target's CURRENT tip → merge → (one bounded conflict repair) → re-run all
  // verification → freshness check → land. A moved target branch discards the
  // integrated state and rebuilds it once; a second movement stops safely
  // instead of force-updating the user's branch.

  let integrationBaseSha: string | undefined;
  let landedSha: string | undefined;

  for (;;) {
    phase = "integration";
    status(
      `Đang merge \`${sourceBranch}\` vào \`${targetBranch}\` trong worktree tích hợp…`,
    );
    try {
      // Base = the target's CURRENT tip, captured right before the merge — the
      // freshness check before landing compares against this.
      integrationBaseSha = await git(
        ["rev-parse", `refs/heads/${targetBranch}`],
        cwd,
      );
      integrationBranch = WorktreeManager.generateTempBranchName(
        `issue-${issue.number}-integrate`,
      );
      integrationWt = await createWorktree({
        cwd,
        branchStrategy: {
          type: "branch",
          branch: integrationBranch,
          baseBranch: targetBranch,
        },
      });
      integrationPath = integrationWt.worktreePath;
      await runEffect(
        copyToWorktree(["node_modules"], cwd, integrationPath),
      ).catch(() => {
        // Dependency copies are best-effort — verification still runs.
      });
      await git(["merge", "--no-edit", sourceBranch], integrationPath);
    } catch (e) {
      try {
        const repaired = await repairMergeConflict(e);
        if (!repaired) {
          // Abort any in-progress merge so the worktree is removable; the
          // active checkout was never touched.
          if (integrationPath !== undefined) {
            await gitQuiet(["merge", "--abort"], integrationPath);
          }
          return fail(e);
        }
      } catch (repairError) {
        return fail(repairError);
      }
    }

    const integPath = integrationPath;
    const integBranch = integrationBranch;
    if (integPath === undefined || integBranch === undefined) {
      return fail(new Error("Không tạo được worktree tích hợp để merge."));
    }

    // ---- Re-verify the integrated result ------------------------------------

    phase = "integration-verification";
    if (verificationConfigured()) {
      status("Đang xác minh lại kết quả sau khi merge…");
      integrationVerification = await runVerificationCommands(
        settings.verificationCommands,
        integPath,
        verificationTimeoutMs,
      );
      await persistVerificationStatus(
        cwd,
        hasFailedVerification(integrationVerification) ? "failed" : "passed",
      );
      const failed = integrationVerification.find((r) => r.status === "failed");
      if (failed !== undefined) {
        return fail(
          new Error(
            `Lệnh xác minh thất bại sau khi merge: \`${failed.command}\` ` +
              `(exit ${failed.exitCode ?? "?"})\n${failed.outputTail}`,
          ),
        );
      }
    }

    // ---- Landing — freshness check, then a non-conflicting update -----------

    phase = "landing";
    status(`Đang cập nhật nhánh \`${targetBranch}\`…`);
    try {
      const integrationHead = await git(["rev-parse", "HEAD"], integPath);
      const currentTargetSha = await git(
        ["rev-parse", `refs/heads/${targetBranch}`],
        cwd,
      );
      if (currentTargetSha !== integrationBaseSha) {
        // The target moved while we integrated. Rebuild the integration state
        // on the new tip once (ADR 0024); if it moved again, stop safely —
        // the user's branch is never force-updated.
        if (attempts.integrationRebuild < MAX_TARGET_REBUILD_ATTEMPTS) {
          attempts.integrationRebuild++;
          status(
            `Nhánh \`${targetBranch}\` đã di chuyển ` +
              `(${shortSha(integrationBaseSha ?? "")} → ${shortSha(currentTargetSha)}) — ` +
              `đang dựng lại worktree tích hợp trên đầu nhánh mới ` +
              `(lần ${attempts.integrationRebuild}/${MAX_TARGET_REBUILD_ATTEMPTS})…`,
            "warn",
          );
          await cleanupIntegration();
          continue;
        }
        return fail(
          new Error(
            `Nhánh \`${targetBranch}\` đã di chuyển trong khi Sandcastle đang chạy ` +
              `(${shortSha(integrationBaseSha ?? "")} → ${shortSha(currentTargetSha)}) — ` +
              "dừng an toàn, không ghi đè công việc mới.",
          ),
        );
      }
      const headBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      if (headBranch === targetBranch) {
        // Target is the active checkout — a fast-forward merge can never
        // conflict and never leaves the checkout mid-merge.
        await git(["merge", "--ff-only", integBranch], cwd);
      } else {
        // Target isn't checked out here — move it atomically. update-ref with
        // the expected old value is a compare-and-swap: it refuses when the
        // branch moved after our check, and also when the branch is checked
        // out in another worktree.
        await git(
          [
            "update-ref",
            `refs/heads/${targetBranch}`,
            integrationHead,
            currentTargetSha,
          ],
          cwd,
        );
      }
      landedSha = await git(["rev-parse", `refs/heads/${targetBranch}`], cwd);
      break;
    } catch (e) {
      return fail(e);
    }
  }

  if (landedSha === undefined) {
    // Unreachable — the loop only exits via break after a successful landing.
    return fail(new Error("Landing kết thúc mà không cập nhật nhánh đích."));
  }
  const landedTargetSha: string = landedSha;
  const finalIntegrationBaseSha: string = integrationBaseSha ?? landedSha;

  // ---- Success cleanup — integration + implementation state --------------------

  await cleanupIntegration();
  const closeResult = await wt.close().catch(() => ({
    preservedWorktreePath: wt?.worktreePath,
  }));
  const preservedWorktreePath = closeResult.preservedWorktreePath;
  if (preservedWorktreePath === undefined) {
    // Worktree removed — the source branch's content is now on the target, so
    // force-delete is safe (and required: `-d` would refuse when the current
    // checkout isn't the target).
    await gitQuiet(["branch", "-D", sourceBranch], cwd);
  }
  await clearRecoveryState(cwd, issue.number);

  // ---- Report, then close (ADR 0023 ordering) ---------------------------------

  phase = "reporting";
  const landedCommits = await git(
    ["log", "--format=%h %s", `${finalIntegrationBaseSha}..${landedTargetSha}`],
    cwd,
  )
    .then((out) => out.split("\n").filter((l) => l.trim().length > 0))
    .catch(() => [] as string[]);
  const changeStat = await git(
    ["diff", "--stat", finalIntegrationBaseSha, landedTargetSha],
    cwd,
  ).catch(() => "");

  const cautions: string[] = [];
  if (lastCompletionSignal === undefined) {
    cautions.push(
      "Agent kết thúc mà không phát tín hiệu hoàn thành — hãy kiểm tra lại kết quả nếu cần.",
    );
  }
  if (
    attempts.verificationRepair > 0 ||
    attempts.mergeConflictRepair > 0 ||
    attempts.integrationRebuild > 0
  ) {
    cautions.push(
      `Kết quả cần sửa tự động: ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS} lần sau lỗi xác minh, ` +
        `${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS} lần sau xung đột merge, ` +
        `${attempts.integrationRebuild}/${MAX_TARGET_REBUILD_ATTEMPTS} lần dựng lại tích hợp.`,
    );
  }
  if (preservedWorktreePath !== undefined) {
    cautions.push(
      `Worktree \`${preservedWorktreePath}\` còn thay đổi chưa được commit nên được giữ lại (nhánh \`${sourceBranch}\` vẫn tồn tại).`,
    );
  }
  if (!verificationConfigured()) {
    cautions.push(
      `Không có lệnh xác minh nào được cấu hình — kết quả chưa được kiểm tra tự động (trạng thái: ${settings.verificationStatus ?? "unavailable"}).`,
    );
  }

  const reportBody = buildCompletionReport({
    issue,
    sourceBranch,
    targetBranch,
    landedSha: landedTargetSha,
    landedCommits,
    changeStat: changeStat.trim().length > 0 ? changeStat : undefined,
    verification,
    integrationVerification,
    verificationConfigured: verificationConfigured(),
    cautions,
  });

  let reportPosted = false;
  let issueClosed = false;
  let ghError: string | undefined;
  status("Đang đăng báo cáo hoàn thành lên issue…");
  try {
    await gh.postComment(issue.number, reportBody);
    reportPosted = true;
  } catch (e) {
    ghError = e instanceof Error ? e.message : String(e);
  }
  if (reportPosted) {
    status(`Đang đóng issue #${issue.number}…`);
    try {
      await gh.closeIssue(issue.number);
      issueClosed = true;
    } catch (e) {
      ghError = e instanceof Error ? e.message : String(e);
    }
  }

  const baseMessage = `Hoàn thành issue #${issue.number} — đã merge vào \`${targetBranch}\` (\`${shortSha(landedTargetSha)}\`).`;
  const message = issueClosed
    ? `${baseMessage} Issue đã được đóng.`
    : reportPosted
      ? `${baseMessage} Không đóng được issue trên GitHub: ${ghError ?? ""} — hãy đóng thủ công.`
      : `${baseMessage} Không đăng được báo cáo lên GitHub: ${ghError ?? ""} — issue vẫn mở, hãy đăng báo cáo và đóng thủ công.`;

  return {
    outcome: "landed",
    issue,
    sourceBranch,
    targetBranch,
    worktreePath: wt.worktreePath,
    ...(preservedWorktreePath !== undefined ? { preservedWorktreePath } : {}),
    commits: allCommits,
    verification,
    verificationStatus: aggregateVerificationStatus(
      settings.verificationCommands.length,
      integrationVerification ?? verification,
      settings.verificationStatus,
    ),
    ...(integrationVerification !== undefined
      ? { integrationVerification }
      : {}),
    completionSignalSeen: lastCompletionSignal !== undefined,
    landedSha: landedTargetSha,
    landedCommits,
    changeStat: changeStat.trim().length > 0 ? changeStat : undefined,
    reportPosted,
    issueClosed,
    reportBody,
    logFilePath: lastLogFilePath,
    sessionId: lastSessionId,
    attempts,
    message,
  };
};

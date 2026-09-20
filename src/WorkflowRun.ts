import { exec, execFile } from "node:child_process";
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
  MAX_PARALLELISM,
  MIN_PARALLELISM,
  updateProjectSettingsAsync,
  type ProjectSettings,
  type VerificationStatus,
  type WorkflowRole,
} from "./ProjectSettings.js";
import {
  RECOVERY_STATE_VERSION,
  clearRecoveryState,
  probeRecoveryArtifacts,
  writeRecoveryState,
  type RecoveryState,
} from "./recovery.js";
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
 * `runIssueQueueWorkflow` extends the same pipeline to every eligible issue
 * at once (#20): it lists the open `Sandcastle`-labeled issues in ascending
 * issue-number order, then runs each through `runIssueWorkflow` —
 * sequentially (parallelism 1) or with bounded parallelism (the configured
 * `parallelism`, 1–4). Concurrent runs share one FIFO lock
 * ({@link createWorkflowRunLock}) that serializes worktree creation and the
 * integrate → re-verify → land section, so parallel issues can never prune
 * each other's half-created worktrees or race the target branch. A failing
 * issue never aborts the others; the queue ends with a Vietnamese summary of
 * landed vs failed issues.
 *
 * Ordering guarantees that matter (ADR 0023):
 * - The implementation agent never sees issue-closing instructions — the
 *   prompt is built here from the immutable selected issue identity, so the
 *   `gh issue close` mutation stays inside Sandcastle (see
 *   {@link buildImplementationPrompt}).
 * - The completion report is posted only after the target branch has moved,
 *   and the issue is closed only after the report post succeeds.
 * - Every pre-landing failure leaves the issue open, keeps the source branch
 *   and implementation worktree on disk for recovery (`status`/`retry`/
 *   `discard` build on the persisted record — see `recovery.ts`),
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

/**
 * Where a run stopped. `"planning"`/`"review"` exist only for workflows that
 * dispatch those optional phases (see {@link workflowDispatch}); the rest is
 * the shared pipeline plus the repair/retry phases (#18/#19).
 */
export type WorkflowRunPhase =
  | "preflight"
  | "planning"
  | "implementation"
  | "review"
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
   * Resume a preserved failed run (`sandcastle retry <issue>`): the issue
   * identity, branches, and worktree come from the record — selection is
   * never re-run — and the workflow re-enters at the recorded failure phase
   * instead of implementing from scratch. The recorded agent session is
   * resumed natively when the provider supports it.
   */
  readonly resume?: RecoveryState;
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
  /**
   * Shared FIFO lock serializing shared-repo git mutations across concurrent
   * queued runs (#20). A queue run (`runIssueQueueWorkflow`) creates one lock
   * and hands it to every issue's run; a standalone run leaves it unset and
   * gets the no-op default. The locked sections are worktree creation
   * (`pruneStale` inside `createWorktree` could otherwise delete a sibling's
   * half-created worktree) and the whole integrate → re-verify → land loop
   * (the target-branch freshness check and ref update must never interleave
   * with a sibling's landing).
   */
  readonly sharedLock?: WorkflowRunLock;
  /**
   * Pre-computed preflight (settings + gh ops) — a queue run computes it once
   * and hands it to every issue's run so the `gh` install/auth/label probes
   * happen once per queue instead of once per issue (#20). Leave unset for
   * standalone runs.
   */
  readonly preflight?: WorkflowRunPreflight;
}

// Re-exported so existing `WorkflowRun.js` importers keep working — the
// record type and its persistence helpers now live in `recovery.ts`.
export type { RecoveryState } from "./recovery.js";
export { recoveryStatePath } from "./recovery.js";

/** A hard pre-run failure — thrown, never reported to the issue. */
export class WorkflowRunError extends Error {
  readonly _tag = "WorkflowRunError";
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunError";
  }
}

/**
 * A FIFO async mutex serializing shared-repo git mutations across concurrent
 * queued issue runs (#20). `fn` sections run one at a time, in the order they
 * were submitted; `onWait` fires once at submission time when the section
 * will actually wait behind a sibling — used for a Vietnamese status line so
 * a queued issue explains its pause instead of sitting silent.
 */
export interface WorkflowRunLock {
  readonly withLock: <A>(
    fn: () => Promise<A>,
    onWait?: () => void,
  ) => Promise<A>;
}

/**
 * Create the lock shared by every issue run in one queue. Implemented as a
 * promise chain: each submitted section chains onto the previous one's
 * settlement, so sections execute sequentially in submission order and a
 * rejected section never wedges the queue.
 */
export const createWorkflowRunLock = (): WorkflowRunLock => {
  let tail: Promise<unknown> = Promise.resolve();
  // Queued-or-running section count — read at submission time to decide
  // whether the new section will have to wait.
  let pending = 0;
  return {
    withLock: (fn, onWait) => {
      if (pending > 0) onWait?.();
      pending++;
      const result = tail.then(fn);
      result.then(
        () => {
          pending--;
        },
        () => {
          pending--;
        },
      );
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
};

/** No-op lock for standalone single-issue runs. */
const NO_LOCK: WorkflowRunLock = { withLock: (fn) => fn() };

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
 *
 * Kept deliberately separate from `AGENT_REGISTRY` (scaffold metadata —
 * dockerfile/env/template strings) and `DISCOVERY_ADAPTERS` (live host-CLI
 * probes): each facet lives behind a different module boundary, and folding
 * them into one registry would pull every provider implementation into
 * `InitService`'s import graph for a ~15-line saving.
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

/**
 * One resolved role→provider binding: the provider instance plus the
 * effective registry agent name (session-resume capability checks key on the
 * provider, and a persisted session id only makes sense under the agent that
 * produced it).
 */
interface ResolvedRoleAgent {
  readonly provider: AgentProvider;
  /** Effective registry agent name after applying the role override. */
  readonly agentName: string;
}

/**
 * Resolve one workflow role's effective agent provider (ADR 0025, #27).
 * Layering is `roleOverrides[role]` over the shared `agent`/`model`/`effort`;
 * each role resolves independently, so a planner override never leaks into
 * the implementer. The persisted `agentExecutable` only applies while the
 * role resolves to the shared agent — it names *that* agent's probed binary
 * (e.g. Grok fingerprinted under its `agent` alias) and would be wrong for
 * any override that swaps providers.
 */
const resolveRoleAgent = (
  settings: ProjectSettings,
  role: WorkflowRole,
): ResolvedRoleAgent => {
  const override = settings.roleOverrides?.[role];
  const agentName = override?.agent ?? settings.agent;
  const model = override?.model ?? settings.model;
  const effort = override?.effort ?? settings.effort;
  const entry = getAgent(agentName);
  const factory =
    entry === undefined ? undefined : AGENT_FACTORIES[entry.factoryImport];
  if (entry === undefined || factory === undefined) {
    throw new WorkflowRunError(
      `Agent "${agentName}"` +
        (override?.agent !== undefined
          ? ` (ghi đè cho vai trò "${role}")`
          : "") +
        ` trong settings không được hỗ trợ. ` +
        `Các agent khả dụng: ${listAgents()
          .map((a) => a.name)
          .join(", ")}. ` +
        "Chạy `sandcastle configure` hoặc sửa .sandcastle/settings.json.",
    );
  }
  const options: Record<string, unknown> = {};
  if (effort !== undefined && entry.effortOption !== undefined) {
    options[entry.effortOption] = effort;
  }
  if (
    settings.agentExecutable !== undefined &&
    agentName === settings.agent &&
    entry.executableOption !== undefined
  ) {
    options[entry.executableOption] = settings.agentExecutable;
  }
  return {
    provider: factory(
      model,
      Object.keys(options).length > 0 ? options : undefined,
    ),
    agentName,
  };
};

/**
 * Which optional agent phases the persisted `settings.workflow` adds around
 * the shared implement → verify → integrate → land pipeline (#27, F050):
 *
 * - `plan` — the planner-role agent analyzes the selected issue in the source
 *   worktree before implementation; its plan text is injected into the
 *   implementation prompt (`parallel-planner`, `parallel-planner-with-review`).
 * - `review` — the reviewer-role agent reviews the branch diff after the
 *   implementation commits and may commit corrections on the same branch
 *   (`sequential-reviewer`, `parallel-planner-with-review`).
 *
 * `simple-loop` and `blank` run the base pipeline. An unknown identifier —
 * e.g. a user-authored workflow name — also falls back to the base pipeline,
 * with `known: false` so the run can say so instead of silently substituting.
 */
const workflowDispatch = (
  workflow: string,
): { plan: boolean; review: boolean; known: boolean } => {
  switch (workflow) {
    case "parallel-planner":
      return { plan: true, review: false, known: true };
    case "parallel-planner-with-review":
      return { plan: true, review: true, known: true };
    case "sequential-reviewer":
      return { plan: false, review: true, known: true };
    case "simple-loop":
    case "blank":
      return { plan: false, review: false, known: true };
    default:
      return { plan: false, review: false, known: false };
  }
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

/**
 * The agent's final message text, recovered by replaying the run's stdout
 * through the provider's own stream parser — `result` events carry the final
 * message for stream-json providers, and a text-only provider's deltas are
 * the fallback. The planner's plan comes out of this rather than raw stdout,
 * so stream-json framing never leaks into the implementation prompt.
 *
 * `run()` already collapses its `stdout` to the result-event text when the
 * provider emits one (Orchestrator), so for result-capable providers the
 * input is the final message itself — not raw stream lines — and the replay
 * finds nothing. In that case the verbatim text IS the message; only
 * JSON-framed leftovers that parsed to nothing count as "no plan".
 */
const lastAgentMessageText = (
  provider: AgentProvider,
  stdout: string,
): string => {
  let streamed = "";
  let resultText = "";
  for (const line of stdout.split("\n")) {
    for (const event of provider.parseStreamLine(line)) {
      if (event.type === "result") {
        resultText = event.result;
      } else if (event.type === "text") {
        streamed += event.text;
      }
    }
  }
  const parsed = (resultText.length > 0 ? resultText : streamed).trim();
  if (parsed.length > 0) return parsed;
  // Raw stream-json that parsed to nothing has no message to extract —
  // returning it would leak framing into the implementation prompt.
  const trimmed = stdout.trim();
  return trimmed.startsWith("{") ? "" : trimmed;
};

// ---------------------------------------------------------------------------
// Prompt (ADR 0023 — issue closing lives with Sandcastle, never the agent)
// ---------------------------------------------------------------------------

export const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

/**
 * The task context every run-phase prompt shares: the immutable selected
 * issue, the source branch its work lives on, the target branch Sandcastle
 * lands it on, and the project's verification commands. Bundled once per run
 * (in {@link runIssueWorkflow}) so the three prompt builders stay in lockstep
 * instead of repeating the same four parameters.
 */
export interface WorkflowPromptContext {
  readonly issue: GithubIssue;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly verificationCommands: readonly string[];
}

/**
 * The implementation prompt for one selected issue. Built at run time rather
 * than read from a scaffolded template: the checked-in templates carry a
 * close-command substitution slot (`{{CLOSE_TASK_INSTRUCTION}}` and friends)
 * whose value depends on the configured tracker, while the run workflow is
 * GitHub-only and must keep issue identity immutable and issue closure out
 * of the agent's reach. Inline prompts also bypass `` !`…` `` shell expansion
 * and `{{…}}` substitution, so issue bodies are passed to the agent verbatim.
 */
export const buildImplementationPrompt = (params: {
  readonly context: WorkflowPromptContext;
  /**
   * Set when `sandcastle retry` continues a run that stopped during
   * implementation: the recorded failure of the previous attempt. The
   * preserved worktree may already hold partial work — the prompt tells the
   * agent to continue it rather than start over.
   */
  readonly resumeError?: string;
  /**
   * The planner phase's output (planner workflows only) — injected as a
   * `## Plan` section so the implementer follows it instead of re-deriving
   * an approach.
   */
  readonly plan?: string;
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } =
    params.context;
  const { resumeError, plan } = params;
  const verificationBlock =
    verificationCommands.length > 0
      ? `\n## Verification\n\nAfter you finish, the following project commands will be run to check your work. Make sure they pass:\n\n${verificationCommands.map((c) => `- \`${c}\``).join("\n")}\n`
      : "";
  const resumeBlock =
    resumeError !== undefined
      ? `\n## Previous attempt\n\nA previous Sandcastle run already started this task in this worktree and stopped with:\n\n\`\`\`\n${tail(resumeError.trim())}\n\`\`\`\n\nWhatever it produced is still here — committed or uncommitted. Continue and finish that work rather than starting over.\n`
      : "";
  const planBlock =
    plan !== undefined && plan.trim().length > 0
      ? `\n## Plan\n\nA planning agent analyzed this issue and this repository and produced the implementation plan below. Follow it unless the code proves it wrong.\n\n${plan.trim()}\n`
      : "";
  return `# Task

Implement GitHub issue #${issue.number}: ${issue.title}
${resumeBlock}${planBlock}
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
 * The planning prompt for planner workflows (`parallel-planner`,
 * `parallel-planner-with-review`): the planner-role agent analyzes the
 * selected issue inside the source worktree and returns a plan — text that
 * is injected into the implementation prompt as `## Plan`. It is explicitly
 * forbidden from touching the tree: the worktree must stay clean so the
 * implementer starts from the pristine branch.
 */
export const buildPlanningPrompt = (params: {
  readonly context: WorkflowPromptContext;
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } =
    params.context;
  return `# Task — plan

Analyze GitHub issue #${issue.number}: ${issue.title} in this repository and produce a concrete implementation plan for the agent that will implement it.

${
  issue.body.trim().length > 0
    ? `## Issue description\n\n${issue.body}\n\n`
    : ""
}## Rules

- You are working on branch \`${sourceBranch}\` in a dedicated worktree — read whatever code you need, but do NOT modify files, do NOT commit, and do NOT create branches. Your only output is the plan text itself.
- The issue identity above is fixed for this run. Plan for issue #${issue.number} and nothing else.
- Do NOT run \`gh issue close\`, \`gh issue comment\`, or any other command that mutates the issue — Sandcastle implements, verifies, merges into \`${targetBranch}\`, reports, and closes the issue itself.
- Cover: which files/modules to touch, the approach, edge cases to handle,${
    verificationCommands.length > 0
      ? ` and how the work will be checked — these verification commands run afterwards:\n${verificationCommands.map((c) => `  - \`${c}\``).join("\n")}`
      : " and how the work should be checked."
  }

When the plan is complete, output it, then output exactly: ${DEFAULT_COMPLETION_SIGNAL}
`;
};

/**
 * The review prompt for reviewed workflows (`sequential-reviewer`,
 * `parallel-planner-with-review`): the reviewer-role agent inspects the
 * implementation diff in the SAME worktree and may commit corrections on the
 * source branch — they flow through the same verification and integration
 * path as the implementer's own commits. Like every run-phase prompt it
 * keeps issue closure out of the agent's reach.
 */
export const buildReviewPrompt = (params: {
  readonly context: WorkflowPromptContext;
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } =
    params.context;
  return `# Task — review

Review the implementation of GitHub issue #${issue.number}: ${issue.title} committed on branch \`${sourceBranch}\`.

${
  issue.body.trim().length > 0
    ? `## Issue description\n\n${issue.body}\n\n`
    : ""
}## What to review

Inspect the change with \`git diff ${targetBranch}...HEAD\` and \`git log ${targetBranch}..HEAD --oneline\` in this worktree.

- Check correctness first: does the implementation match the issue's intent? Are edge cases handled? Are there unsafe casts, unchecked assumptions, injection or credential risks?
- Then improve clarity, consistency, and maintainability — fix real problems rather than restyling, and never change what the code does.
- Follow the project's coding standards when it declares them (e.g. .sandcastle/CODING_STANDARDS.md).

## Rules

- Commit any corrections on \`${sourceBranch}\` — Sandcastle verifies and merges them into \`${targetBranch}\` itself.
- If the implementation is already sound, make no changes at all.
- Do NOT run \`gh issue close\`, \`gh issue comment\`, or any other command that mutates the issue.
${
  verificationCommands.length > 0
    ? `- These verification commands will run after your review — do not leave the tree in a state that fails them:\n${verificationCommands.map((c) => `  - \`${c}\``).join("\n")}\n`
    : ""
}When the review is done — changes committed or none needed — output exactly: ${DEFAULT_COMPLETION_SIGNAL}
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
  readonly context: WorkflowPromptContext;
  readonly failure: VerificationCommandResult;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly continuingSession: boolean;
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } =
    params.context;
  const { failure, attempt, maxAttempts, continuingSession } = params;
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
  readonly context: WorkflowPromptContext;
  readonly integrationBranch: string;
  readonly mergeOutput: string;
  readonly continuingSession: boolean;
}): string => {
  const { issue, sourceBranch, targetBranch, verificationCommands } =
    params.context;
  const { integrationBranch, mergeOutput, continuingSession } = params;
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

/** Vietnamese label per workflow phase — reports and `sandcastle status`. */
export const PHASE_LABEL: Record<WorkflowRunPhase, string> = {
  preflight: "kiểm tra điều kiện ban đầu",
  planning: "lập kế hoạch triển khai",
  implementation: "chạy agent trên nhánh làm việc",
  review: "review thay đổi trên nhánh làm việc",
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
// Shared preflight — settings, gh auth, label (ADR 0026 — fail before work)
// ---------------------------------------------------------------------------

export interface WorkflowRunPreflight {
  readonly settings: ProjectSettings;
  readonly gh: GithubIssueOps;
}

/**
 * The gate every `sandcastle run` path passes before touching issues:
 * settings load + issue-tracker check, `gh` install/auth probe, and the
 * `Sandcastle` label check. Shared by {@link runIssueWorkflow} (one issue)
 * and {@link runIssueQueueWorkflow} (the `--all` queue) so both fail before
 * any agent work with identical diagnostics.
 */
const workflowRunPreflight = async (options: {
  readonly cwd: string;
  readonly ghRunner?: GhRunner;
  readonly discoveryExec?: DiscoveryExec;
  readonly onStatus?: (message: string, severity: Severity) => void;
  /**
   * `true` when the run resumes a preserved failure (`sandcastle retry`) —
   * the label check gates *selection*, which a retry never re-runs, so the
   * probe is skipped (a label removed since the run must not block
   * continuing the preserved work).
   */
  readonly resume?: boolean;
}): Promise<WorkflowRunPreflight> => {
  const gh: GithubIssueOps = makeGithubIssueOps(
    options.cwd,
    options.ghRunner ?? nodeGhRunner,
  );
  const settings = await loadProjectSettingsAsync(options.cwd);
  if (settings.issueTracker !== "github-issues") {
    throw new WorkflowRunError(
      `\`sandcastle run\` hiện chỉ hỗ trợ issue tracker "github-issues" — ` +
        `dự án này đang dùng "${settings.issueTracker}". ` +
        "Chạy `sandcastle init` lại và chọn github-issues nếu muốn dùng workflow này.",
    );
  }

  options.onStatus?.(
    options.resume === true
      ? "Đang kiểm tra GitHub CLI (gh)…"
      : "Đang kiểm tra GitHub CLI (gh) và label…",
    "info",
  );
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

  // The label check gates *selection* — a retry never selects (the record
  // proves the issue was chosen), so a label removed since the run must not
  // block continuing the preserved work.
  if (options.resume !== true) {
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
  }

  return { settings, gh };
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
  const verificationTimeoutMs =
    options.verificationTimeoutMs ?? VERIFICATION_TIMEOUT_MS;
  const lock = options.sharedLock ?? NO_LOCK;
  // `sandcastle retry` hands in the durable record of a failed run — issue
  // identity, branches, and worktree come from it and selection never runs.
  const resume = options.resume;

  const { settings, gh } =
    options.preflight ??
    (await workflowRunPreflight({
      cwd,
      ghRunner: options.ghRunner,
      discoveryExec: options.discoveryExec,
      onStatus: options.onStatus,
      resume: resume !== undefined,
    }));
  const verificationConfigured = (): boolean =>
    settings.verificationCommands.length > 0;

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
  if (resume !== undefined) {
    // Retry: identity comes from the recovery record — the issue is re-viewed
    // only to prove it is still open (a closed issue means the work already
    // landed or was abandoned elsewhere, making the record stale).
    try {
      issue = await gh.viewIssue(resume.issue.number);
    } catch (e) {
      throw new WorkflowRunError(
        `Không đọc được issue #${resume.issue.number} trên GitHub: ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          `Nếu issue không còn tồn tại, chạy \`sandcastle discard ${resume.issue.number}\` để xóa bản ghi phục hồi.`,
      );
    }
    if (issue.state !== "OPEN") {
      throw new WorkflowRunError(
        `Issue #${issue.number} đã ở trạng thái "${issue.state || "unknown"}" — ` +
          "bản ghi phục hồi cho issue này đã lỗi thời (có thể công việc đã được merge hoặc issue đã đóng). " +
          `Kiểm tra lại trên GitHub, rồi chạy \`sandcastle discard ${issue.number}\` để xóa bản ghi và công việc được giữ lại.`,
      );
    }
  } else if (options.issueNumber !== undefined) {
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
        "Chế độ không tương tác cần `--issue <number>` hoặc `--all` để chọn issue " +
          "(ví dụ `sandcastle run --issue 5`, `sandcastle run --all`).",
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

  status(
    resume === undefined
      ? `Đã chọn issue #${issue.number}: ${issue.title}`
      : `Đang tiếp tục issue #${issue.number} từ bản ghi phục hồi ` +
          `(dừng ở bước "${PHASE_LABEL[resume.failurePhase]}"` +
          `${resume.retryCount > 0 ? `, đã retry ${resume.retryCount} lần` : ""})…`,
  );

  // ---- Resolve agents + sandbox from persisted settings ---------------------
  //
  // Every workflow role resolves independently (roleOverrides over the shared
  // agent/model/effort) — the planner, reviewer, and merger only differ from
  // the implementer when a `roleOverrides` entry says so.
  const agents = {
    planner: resolveRoleAgent(settings, "planner"),
    implementer: resolveRoleAgent(settings, "implementer"),
    reviewer: resolveRoleAgent(settings, "reviewer"),
    merger: resolveRoleAgent(settings, "merger"),
  };
  const sandbox = resolveSandboxProvider(settings);

  // The persisted workflow decides which optional phases run around the
  // shared pipeline (F050) — never a hard-coded or regenerated choice.
  const dispatch = workflowDispatch(settings.workflow);
  if (!dispatch.known) {
    status(
      `Workflow "${settings.workflow}" không phải workflow Sandcastle đã biết — ` +
        "chạy pipeline chuẩn (implement → xác minh → merge) như simple-loop.",
      "warn",
    );
  }
  // The resolved repo root, matching what createWorktree/wt.run use to key
  // host-side session storage — needed by the resume precheck for repairs.
  const hostRepoDir = await runEffect(resolveCwd(cwd));

  // A retry lands on the branch the failed run was targeting, even when the
  // checkout has since moved — the landing uses `update-ref` CAS then.
  const targetBranch =
    resume?.targetBranch ??
    (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd));
  if (resume === undefined && targetBranch === "HEAD") {
    throw new WorkflowRunError(
      "Repository đang ở trạng thái detached HEAD — hãy checkout một nhánh trước khi chạy `sandcastle run`.",
    );
  }
  // The target base is recorded in the recovery record so `status`/`retry`
  // can compare what the run integrated against (the landing freshness check
  // re-reads the live tip separately).
  const targetBaseSha = await git(
    ["rev-parse", "-q", "--verify", `refs/heads/${targetBranch}`],
    cwd,
  ).catch(() => "");
  if (targetBaseSha === "") {
    throw new WorkflowRunError(
      resume !== undefined
        ? `Nhánh đích \`${targetBranch}\` trong bản ghi phục hồi không còn tồn tại — ` +
            `bản ghi cho issue #${issue.number} đã lỗi thời. ` +
            `Kiểm tra lại repo, rồi chạy \`sandcastle discard ${issue.number}\` để xóa bản ghi.`
        : `Không xác định được SHA đầu nhánh \`${targetBranch}\`.`,
    );
  }
  const sourceBranch =
    resume?.sourceBranch ?? `sandcastle/issue-${issue.number}`;

  // The shared prompt context — bundled once so every agent invocation this
  // run (implementation + both repair paths) speaks of the same issue,
  // branches, and verification contract.
  const promptContext: WorkflowPromptContext = {
    issue,
    sourceBranch,
    targetBranch,
    verificationCommands: settings.verificationCommands,
  };

  // ---- Failure path — one closure used by every phase after selection -------

  let phase: WorkflowRunPhase = "implementation";
  let wt: Worktree | undefined;
  let integrationWt: Worktree | undefined;
  // A retry that re-enters at integration carries the recorded source-stage
  // verification forward so reports still show what was checked.
  let verification: VerificationCommandResult[] =
    resume !== undefined ? [...resume.verification] : [];
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
  // Retry seeds the recorded agent session/log so repair invocations resume
  // the same session across process restarts when the provider supports it.
  let lastSessionId: string | undefined = resume?.sessionId;
  let lastCompletionSignal: string | undefined;
  let lastLogFilePath: string | undefined = resume?.logFilePath;

  const recordAgentRun = (
    r: WorktreeRunResult,
    opts?: { readonly trackSession?: boolean },
  ): void => {
    // Dedupe by sha: the merge-conflict repair runs inside the integration
    // worktree, where commit collection re-reports the source commits that
    // arrived via the merge.
    for (const c of r.commits) {
      if (!allCommits.some((known) => known.sha === c.sha)) allCommits.push(c);
    }
    // Planner/reviewer runs record their commits but must not overwrite the
    // implementer-lineage session/log — `sandcastle retry` resumes the
    // implementation session, not a phase agent's.
    if (opts?.trackSession === false) return;
    const sid = r.iterations.at(-1)?.sessionId;
    if (sid !== undefined) lastSessionId = sid;
    if (r.completionSignal !== undefined)
      lastCompletionSignal = r.completionSignal;
    if (r.logFilePath !== undefined) lastLogFilePath = r.logFilePath;
  };

  /**
   * The session id to resume for a repair run under `provider`, or
   * `undefined` when a fresh invocation must carry the full context instead:
   * non-resumable provider (no sessionStorage / captureSessions off), no
   * session id captured, the recorded session no longer exists on the host,
   * or the role resolved to a different agent whose session storage cannot
   * hold it (ADR 0024 — "agents without resumable session storage can still
   * retry because the code, branch, failure output, and task identity are
   * preserved").
   */
  const resumableSession = async (
    provider: AgentProvider,
  ): Promise<string | undefined> => {
    if (lastSessionId === undefined) return undefined;
    if (!provider.captureSessions || provider.sessionStorage === undefined) {
      return undefined;
    }
    try {
      await assertResumeSessionExists({
        provider,
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
    const resumeSession = await resumableSession(agents.merger.provider);
    status(
      `Merge bị xung đột — agent đang giải quyết trong worktree tích hợp ` +
        `(lần ${attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS}` +
        `${resumeSession !== undefined ? ", tiếp tục phiên agent" : ", phiên mới"})…`,
      "warn",
    );
    const repair = await integrationWt.run({
      // The merger role owns conflict resolution — a `roleOverrides.merger`
      // entry can give it a different agent/model/effort entirely.
      agent: agents.merger.provider,
      sandbox,
      prompt: buildMergeConflictRepairPrompt({
        context: promptContext,
        integrationBranch,
        mergeOutput:
          mergeError instanceof Error ? mergeError.message : String(mergeError),
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
      version: RECOVERY_STATE_VERSION,
      issue,
      sourceBranch,
      targetBranch,
      targetBaseSha,
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
      // Each retry that itself fails rewrites the record with the count
      // incremented, so `status` shows how often the task was retried.
      retryCount: (resume?.retryCount ?? 0) + (resume !== undefined ? 1 : 0),
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

  // ---- Retry resume: validate the preserved artifacts, seed commits ---------
  //
  // A stale record never silently proceeds and is never deleted here — the
  // diagnosis points at `sandcastle discard`, the only command that removes
  // preserved work (and only after confirmation).
  const preservedCommits: string[] = [];
  let preservedWorktreeUsable = false;
  if (resume !== undefined) {
    const artifacts = await probeRecoveryArtifacts(cwd, resume);
    preservedWorktreeUsable = artifacts.worktreeUsable;
    preservedCommits.push(...artifacts.preservedCommits);
    if (!preservedWorktreeUsable && preservedCommits.length === 0) {
      // No committed work on the branch (never committed, reset, or already
      // merged elsewhere) and no usable worktree — nothing to continue.
      throw new WorkflowRunError(
        `Bản ghi phục hồi cho issue #${issue.number} đã lỗi thời: ` +
          (artifacts.branchExists
            ? `nhánh \`${sourceBranch}\` không còn commit nào chưa merge ` +
              "(có thể đã merge ở nơi khác hoặc đã bị reset)"
            : `nhánh \`${sourceBranch}\` không còn tồn tại`) +
          (resume.worktreePath !== undefined
            ? `, và worktree \`${resume.worktreePath}\` đã mất`
            : "") +
          `. Không có công việc nào để tiếp tục — chạy \`sandcastle discard ${issue.number}\` để xóa bản ghi.`,
      );
    }
    if (
      resume.worktreePath !== undefined &&
      !preservedWorktreeUsable &&
      artifacts.branchExists
    ) {
      status(
        `Worktree \`${resume.worktreePath}\` không còn — đang dựng lại worktree từ nhánh \`${sourceBranch}\` đã được giữ.`,
        "warn",
      );
    }
    // Drop stale worktree registrations (e.g. the preserved dir was deleted
    // out from under git) so `createWorktree` sees the real on-disk state.
    await git(["worktree", "prune"], cwd).catch(() => {});
    for (const sha of preservedCommits) allCommits.push({ sha });
  }

  // A retry re-enters the workflow at the recorded failure phase instead of
  // starting over: "implementation" only when there is no committed work to
  // verify (a planning failure also re-enters there — the planner re-runs as
  // part of the stage), "review" to redo just the review pass,
  // "verification" to re-run the checks (with a fresh bounded repair
  // budget), and straight into the integration loop for anything later —
  // the recorded source-stage verification already passed by then.
  const startPhase: WorkflowRunPhase =
    resume === undefined ||
    preservedCommits.length === 0 ||
    resume.failurePhase === "implementation" ||
    resume.failurePhase === "planning" ||
    resume.failurePhase === "preflight"
      ? "implementation"
      : resume.failurePhase === "review"
        ? "review"
        : resume.failurePhase === "verification"
          ? "verification"
          : "integration";
  phase = startPhase;

  // ---- Worktree — create fresh on a normal run, re-attach on retry ----------
  //
  // `createWorktree` reuses a managed worktree already checked out on the
  // source branch, so the preserved worktree is picked up in place; when it
  // is gone, a new worktree is created on the preserved branch (its commits
  // are the work).

  try {
    // Locked: `pruneStale` inside createWorktree removes unmanaged-looking
    // directories under .sandcastle/worktrees/ — without the lock it could
    // delete a sibling run's half-created worktree (#20).
    wt = await lock.withLock(
      () =>
        createWorktree({
          cwd,
          branchStrategy: {
            type: "branch",
            branch: sourceBranch,
            baseBranch: targetBranch,
          },
          // A reused preserved worktree already carries its dependency copies.
          ...(preservedWorktreeUsable
            ? {}
            : { copyToWorktree: ["node_modules"] }),
        }),
      () => status("Đang chờ một issue khác khởi tạo worktree…"),
    );
  } catch (e) {
    return fail(e);
  }

  // ---- Implementation (skipped when a retry resumes past it) -----------------
  //
  // Planner workflows prepend a planning pass in the same worktree: the
  // planner-role agent analyzes the issue and returns a plan, which is then
  // injected into the implementer prompt — a per-issue reading of the
  // parallel-planner templates' plan→execute ordering.

  if (startPhase === "implementation") {
    let plan: string | undefined;
    if (dispatch.plan) {
      phase = "planning";
      status(`Đang lập kế hoạch cho issue #${issue.number}…`);
      try {
        const planRun = await wt.run({
          agent: agents.planner.provider,
          sandbox,
          prompt: buildPlanningPrompt({ context: promptContext }),
          name: `issue-${issue.number}-plan`,
          maxIterations: 1,
          completionSignal: DEFAULT_COMPLETION_SIGNAL,
        });
        recordAgentRun(planRun, { trackSession: false });
        const planText = lastAgentMessageText(
          agents.planner.provider,
          planRun.stdout,
        )
          .replaceAll(DEFAULT_COMPLETION_SIGNAL, "")
          .trim();
        if (planText.length > 0) {
          plan = planText;
        } else {
          status(
            "Planner không sinh kế hoạch nào — agent sẽ implement trực tiếp.",
            "warn",
          );
        }
      } catch (e) {
        return fail(e);
      }
    }

    phase = "implementation";
    status(
      resume === undefined
        ? `Đang chạy agent cho issue #${issue.number} trên nhánh \`${sourceBranch}\`…`
        : `Đang tiếp tục agent cho issue #${issue.number} trên nhánh \`${sourceBranch}\` được giữ lại…`,
    );
    attempts.implementation = 1;
    // Resume the recorded session when possible — the agent keeps its prior
    // reasoning. Without one, the prompt itself carries the context.
    const resumeSession =
      resume !== undefined
        ? await resumableSession(agents.implementer.provider)
        : undefined;
    try {
      const implResult = await wt.run({
        agent: agents.implementer.provider,
        sandbox,
        prompt: buildImplementationPrompt({
          context: promptContext,
          ...(resume !== undefined ? { resumeError: resume.error } : {}),
          ...(plan !== undefined ? { plan } : {}),
        }),
        name: `issue-${issue.number}`,
        maxIterations: 1,
        completionSignal: DEFAULT_COMPLETION_SIGNAL,
        ...(resumeSession !== undefined ? { resumeSession } : {}),
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
  }

  // ---- Review (skipped unless the workflow dispatches it) ---------------------
  //
  // The reviewer-role agent inspects the committed diff in the same source
  // worktree and may commit corrections on the branch — they flow through
  // verification and integration exactly like the implementer's own work.
  // A retry that recorded a review failure re-enters here; anything later
  // skips it entirely.

  if (
    dispatch.review &&
    (startPhase === "implementation" || startPhase === "review")
  ) {
    phase = "review";
    status(`Đang review thay đổi cho issue #${issue.number}…`);
    try {
      const reviewRun = await wt.run({
        agent: agents.reviewer.provider,
        sandbox,
        prompt: buildReviewPrompt({ context: promptContext }),
        name: `issue-${issue.number}-review`,
        maxIterations: 1,
        completionSignal: DEFAULT_COMPLETION_SIGNAL,
      });
      recordAgentRun(reviewRun, { trackSession: false });
    } catch (e) {
      return fail(e);
    }
  }

  // ---- Verification on the source worktree -----------------------------------
  //
  // A failed command goes back to the agent in the SAME worktree — resuming
  // the same session when the provider supports it, else a fresh invocation
  // against the preserved code with the task + failure inlined. Bounded at
  // MAX_VERIFICATION_REPAIR_ATTEMPTS; every repair re-runs ALL commands.
  // Skipped when a retry resumes at integration — the recorded results
  // already passed and the merged tree is re-verified anyway.

  if (
    startPhase === "implementation" ||
    startPhase === "review" ||
    startPhase === "verification"
  ) {
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
        const resumeSession = await resumableSession(
          agents.implementer.provider,
        );
        status(
          `Xác minh thất bại — agent đang sửa trong cùng worktree ` +
            `(lần ${attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS}` +
            `${resumeSession !== undefined ? ", tiếp tục phiên agent" : ", phiên mới"})…`,
          "warn",
        );
        try {
          const repair = await wt.run({
            agent: agents.implementer.provider,
            sandbox,
            prompt: buildVerificationRepairPrompt({
              context: promptContext,
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
  }

  // ---- Integration in a separate worktree (ADR 0024) --------------------------
  //
  // One loop iteration = build a disposable integration worktree on the
  // target's CURRENT tip → merge → (one bounded conflict repair) → re-run all
  // verification → freshness check → land. A moved target branch discards the
  // integrated state and rebuilds it once; a second movement stops safely
  // instead of force-updating the user's branch.
  //
  // The whole section mutates shared-repo state (a new worktree, merges, and
  // finally the target-branch ref): under a queue run the shared lock
  // serializes it across concurrent issues so a sibling's landing can never
  // interleave with the freshness check or ref update, and integration
  // worktree creation stays serialized with every other worktree
  // create/prune (#20). Standalone runs see NO_LOCK — identical behavior.

  let integrationBaseSha: string | undefined;
  let landedSha: string | undefined;

  const integrationFailure = await lock.withLock(
    async (): Promise<WorkflowRunResult | undefined> => {
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

        // ---- Re-verify the integrated result --------------------------------

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
            hasFailedVerification(integrationVerification)
              ? "failed"
              : "passed",
          );
          const failed = integrationVerification.find(
            (r) => r.status === "failed",
          );
          if (failed !== undefined) {
            return fail(
              new Error(
                `Lệnh xác minh thất bại sau khi merge: \`${failed.command}\` ` +
                  `(exit ${failed.exitCode ?? "?"})\n${failed.outputTail}`,
              ),
            );
          }
        }

        // ---- Landing — freshness check, then a non-conflicting update -------

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
          const headBranch = await git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd,
          );
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
          landedSha = await git(
            ["rev-parse", `refs/heads/${targetBranch}`],
            cwd,
          );
          return undefined;
        } catch (e) {
          return fail(e);
        }
      }
    },
    () =>
      status(`Đang chờ một issue khác hoàn tất merge vào \`${targetBranch}\`…`),
  );
  if (integrationFailure !== undefined) return integrationFailure;

  if (landedSha === undefined) {
    // Unreachable — the locked section only resolves undefined after a
    // successful landing.
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

// ---------------------------------------------------------------------------
// Queue execution (#20) — all eligible issues, sequential or bounded parallel
// ---------------------------------------------------------------------------

export interface RunIssueQueueOptions {
  /** Repo root — git and `.sandcastle/` anchor. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Bounded parallelism for this queue (integer 1–4). Defaults to the
   * configured `settings.parallelism`. `1` is the sequential mode — at most
   * one issue active at a time; there is no unbounded option (ADR 0025).
   */
  readonly parallelism?: number;
  /** Vietnamese phase/status lines — cli.ts wires this to the Display service. */
  readonly onStatus?: (message: string, severity: Severity) => void;
  /** `gh` process boundary (tests substitute a fake executable on PATH). */
  readonly ghRunner?: GhRunner;
  /** Discovery-exec boundary used for the `gh` readiness probe. */
  readonly discoveryExec?: DiscoveryExec;
  /** Per-command timeout for verification steps (default 10 minutes). */
  readonly verificationTimeoutMs?: number;
}

/** Structured result of one queued `sandcastle run --all` invocation. */
export interface WorkflowQueueResult {
  /**
   * `"landed"` — every queued issue landed. `"failed"` — at least one issue
   * failed (per-issue results carry the details; landed issues still landed
   * and were closed). `"no-issues"` — the eligible list was empty.
   */
  readonly outcome: "landed" | "failed" | "no-issues";
  /** The concurrency bound actually applied (1–4). */
  readonly parallelism: number;
  /** Per-issue results in queue order (issue number ascending). */
  readonly results: readonly WorkflowRunResult[];
  /** Vietnamese summary listing landed vs failed issues. */
  readonly message: string;
}

/**
 * Map `fn` over `items` with at most `limit` invocations in flight, worker
 * style: each worker pulls the next index (atomic in a single-threaded
 * runtime), so starts happen in input order and results land in input order.
 * `fn` must settle its own failures — a thrown rejection abandons the
 * remaining work for that worker only.
 */
const mapWithConcurrency = async <A, R>(
  items: readonly A[],
  limit: number,
  fn: (item: A) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as A);
    }
  };
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

/**
 * Run every open `Sandcastle`-labeled issue through the same single-issue
 * pipeline as {@link runIssueWorkflow} (`--all` / interactive "all" mode,
 * #20). The queue is deterministic — issues run in ascending issue-number
 * order — and bounded: `parallelism` (default `settings.parallelism`, 1–4)
 * caps how many issues are active at once; `1` is the sequential mode.
 *
 * Every issue still gets its own `sandcastle/issue-<N>` branch, worktree,
 * integration worktree, verification, landing, report, and recovery record —
 * the per-issue run is the full `runIssueWorkflow`, so the guarantees are
 * identical to a single run. Concurrent runs share one
 * {@link createWorkflowRunLock}: worktree creation and the whole
 * integrate → re-verify → land section are serialized, which is also what
 * protects the common target branch from merge races.
 *
 * A failing issue never aborts the others: in-flight issues finish and the
 * queue continues, then the Vietnamese summary names landed vs failed
 * issues. The outcome is `"failed"` when at least one issue failed, so the
 * CLI can exit non-zero while landed issues stay landed.
 */
export const runIssueQueueWorkflow = async (
  options: RunIssueQueueOptions,
): Promise<WorkflowQueueResult> => {
  const cwd = options.cwd ?? process.cwd();
  const status = (message: string, severity: Severity = "info") =>
    options.onStatus?.(message, severity);
  const { settings, gh } = await workflowRunPreflight({
    cwd,
    ghRunner: options.ghRunner,
    discoveryExec: options.discoveryExec,
    onStatus: options.onStatus,
  });

  let issues: GithubIssue[];
  try {
    issues = await gh.listEligibleIssues();
  } catch (e) {
    throw new WorkflowRunError(
      `Không lấy được danh sách issue: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Deterministic queue order — issue number ascending.
  const queue = [...issues].sort((a, b) => a.number - b.number);
  if (queue.length === 0) {
    return {
      outcome: "no-issues",
      parallelism: 1,
      results: [],
      message: `Không có issue nào đang mở với label "${SANDCASTLE_LABEL}".`,
    };
  }

  const parallelism = options.parallelism ?? settings.parallelism;
  if (
    !Number.isInteger(parallelism) ||
    parallelism < MIN_PARALLELISM ||
    parallelism > MAX_PARALLELISM
  ) {
    throw new WorkflowRunError(
      `Giới hạn song song không hợp lệ: ${parallelism} — ` +
        `phải là số nguyên từ ${MIN_PARALLELISM} đến ${MAX_PARALLELISM} ` +
        "(sửa `parallelism` trong .sandcastle/settings.json hoặc bỏ --parallelism).",
    );
  }

  const issueNumbers = queue.map((i) => `#${i.number}`).join(", ");
  status(
    parallelism === 1
      ? `Chạy tuần tự ${queue.length} issue: ${issueNumbers}.`
      : `Chạy ${queue.length} issue — tối đa ${parallelism} issue song song cùng lúc: ${issueNumbers}.`,
  );

  const lock = createWorkflowRunLock();
  const results = await mapWithConcurrency(
    queue,
    parallelism,
    async (issue) => {
      const issueStatus = (message: string, severity: Severity = "info") =>
        status(`[#${issue.number}] ${message}`, severity);
      try {
        // The per-issue run is the unchanged single-issue pipeline: own branch,
        // worktree, integration worktree, verification, landing, report, and
        // recovery state — sharedLock guards the shared-repo sections.
        const result = await runIssueWorkflow({
          cwd,
          issueNumber: issue.number,
          onStatus: issueStatus,
          ghRunner: options.ghRunner,
          discoveryExec: options.discoveryExec,
          verificationTimeoutMs: options.verificationTimeoutMs,
          sharedLock: lock,
          // One preflight per queue — the per-issue run skips its own probes.
          preflight: { settings, gh },
        });
        issueStatus(
          result.message,
          result.outcome === "landed" ? "success" : "warn",
        );
        return result;
      } catch (e) {
        // A pre-pipeline failure (e.g. the issue went stale between listing and
        // its turn) must not abort the queue — record it as a failed issue.
        const detail = e instanceof Error ? e.message : String(e);
        issueStatus(`Thất bại: ${firstLine(detail)}`, "warn");
        return {
          outcome: "failed" as const,
          failurePhase: "preflight" as const,
          issue,
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
          message: `Issue #${issue.number} thất bại: ${firstLine(detail)}`,
        };
      }
    },
  );

  const landed = results.filter((r) => r.outcome === "landed");
  const failed = results.filter((r) => r.outcome !== "landed");
  const targetBranch = results
    .map((r) => r.targetBranch)
    .find((b): b is string => b !== undefined);
  const issueList = (rs: readonly WorkflowRunResult[]): string =>
    rs.map((r) => `#${r.issue?.number ?? "?"}`).join(", ");
  const landedTarget =
    targetBranch !== undefined ? ` vào \`${targetBranch}\`` : "";

  const message =
    failed.length === 0
      ? `Hoàn thành tất cả ${landed.length} issue — đã merge${landedTarget}: ${issueList(landed)}.`
      : landed.length === 0
        ? `Cả ${failed.length} issue đều thất bại: ${issueList(failed)} — không có thay đổi nào được merge. ` +
          "Các issue vẫn mở và giữ recovery state để retry."
        : `Hoàn thành ${landed.length}/${results.length} issue — ` +
          `đã merge${landedTarget}: ${issueList(landed)}; ` +
          `thất bại: ${issueList(failed)} (vẫn mở, giữ recovery state để retry).`;

  return {
    outcome: failed.length === 0 ? "landed" : "failed",
    parallelism,
    results,
    message,
  };
};

import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { atomicWriteFile } from "./atomicFile.js";
import type { GithubIssue } from "./githubIssues.js";
import type {
  VerificationCommandResult,
  WorkflowRunAttempts,
  WorkflowRunPhase,
} from "./WorkflowRun.js";

/**
 * Durable recovery records for failed `sandcastle run` tasks (ADR 0024, #19).
 *
 * A run that stops before landing writes `.sandcastle/recovery/issue-<N>.json`
 * through {@link writeRecoveryState}; the file survives process exit so later,
 * separate CLI invocations can inspect (`sandcastle status`), continue
 * (`sandcastle retry`), or explicitly delete (`sandcastle discard`) the
 * preserved work. Success clears the record through {@link clearRecoveryState}.
 *
 * The module is Promise-based and Effect-free (like `githubIssues.ts`) so both
 * the run service and the CLI commands share one read/write path. Records are
 * machine-local bookkeeping — never issue-facing data — and the reader is
 * deliberately tolerant: fields added later parse as absent, while the
 * essential identity/phase fields are validated so a truncated or hand-edited
 * file surfaces as `corrupt` rather than a half-populated state. Nothing in
 * this module ever deletes a record it could not parse.
 */

const execFileAsync = promisify(execFile);

const GIT_ENV = { ...process.env, LC_ALL: "C" };

const git = async (args: readonly string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: GIT_ENV,
  });
  return stdout.trim();
};

/** Best-effort git — resolves `undefined` on any failure. */
const gitOrUndefined = async (
  args: readonly string[],
  cwd: string,
): Promise<string | undefined> => {
  try {
    return await git(args, cwd);
  } catch {
    return undefined;
  }
};

/** Current record schema version. Older records without it parse as 1. */
export const RECOVERY_STATE_VERSION = 1;

/**
 * The durable record of one failed task. `version` and `retryCount` were added
 * for #19 — {@link parseRecoveryState} fills defaults so records written
 * before those fields existed still load.
 */
export interface RecoveryState {
  /** Record schema version — always {@link RECOVERY_STATE_VERSION} when written. */
  readonly version: number;
  /** The immutable selected issue identity from the failed run. */
  readonly issue: GithubIssue;
  /** The preserved implementation branch (`sandcastle/issue-<N>`). */
  readonly sourceBranch: string;
  /** The branch the run was landing into. */
  readonly targetBranch: string;
  /** The target branch's tip when the run started — the landing base. */
  readonly targetBaseSha?: string;
  /** Preserved implementation worktree path (absent if creation failed). */
  readonly worktreePath?: string;
  /** Where the run stopped — retry re-enters the workflow at this phase. */
  readonly failurePhase: WorkflowRunPhase;
  /** The failure detail (first lines feed reports and `status`). */
  readonly error: string;
  readonly verification: readonly VerificationCommandResult[];
  readonly integrationVerification?: readonly VerificationCommandResult[];
  /**
   * Commits the run produced — the agent's source-branch commits plus every
   * commit the integration machinery created (merge commit, repair commits,
   * deterministic merge completion), deduped by sha.
   */
  readonly commits: readonly { readonly sha: string }[];
  /** Last captured agent session id — native resume material. */
  readonly sessionId?: string;
  readonly logFilePath?: string;
  /** Bounded-repair counters spent by the run that produced this record. */
  readonly attempts: WorkflowRunAttempts;
  /**
   * How many `sandcastle retry` runs have consumed this record. `0` on the
   * first failure; each retry that itself fails rewrites the record with the
   * counter incremented.
   */
  readonly retryCount: number;
  /** ISO timestamp of the failure that wrote this record. */
  readonly failedAt: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const RECOVERY_DIR_NAME = "recovery";

const recoveryDir = (cwd: string): string =>
  join(cwd, ".sandcastle", RECOVERY_DIR_NAME);

/** Absolute path of the recovery record for one issue. */
export const recoveryStatePath = (cwd: string, issueNumber: number): string =>
  join(recoveryDir(cwd), `issue-${issueNumber}.json`);

// ---------------------------------------------------------------------------
// Parse / validate
// ---------------------------------------------------------------------------

const WORKFLOW_PHASES: ReadonlySet<string> = new Set([
  "preflight",
  "planning",
  "implementation",
  "review",
  "verification",
  "integration",
  "integration-verification",
  "landing",
  "reporting",
]);

export type ParseRecoveryResult =
  | { readonly ok: true; readonly state: RecoveryState }
  | { readonly ok: false; readonly detail: string };

const asIssue = (raw: unknown): GithubIssue | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const number = obj["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return {
    number,
    title: typeof obj["title"] === "string" ? obj["title"] : "",
    body: typeof obj["body"] === "string" ? obj["body"] : "",
    state: typeof obj["state"] === "string" ? obj["state"] : "",
    labels: Array.isArray(obj["labels"])
      ? (obj["labels"] as unknown[]).filter(
          (l): l is string => typeof l === "string",
        )
      : [],
    ...(typeof obj["url"] === "string" ? { url: obj["url"] } : {}),
  };
};

const asVerificationResults = (
  raw: unknown,
): VerificationCommandResult[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: VerificationCommandResult[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const obj = entry as Record<string, unknown>;
    const status = obj["status"];
    if (
      typeof obj["command"] !== "string" ||
      (status !== "passed" && status !== "failed" && status !== "skipped")
    ) {
      return undefined;
    }
    const outputTail =
      typeof obj["outputTail"] === "string" ? obj["outputTail"] : "";
    out.push({
      command: obj["command"],
      status,
      exitCode: typeof obj["exitCode"] === "number" ? obj["exitCode"] : null,
      durationMs: typeof obj["durationMs"] === "number" ? obj["durationMs"] : 0,
      outputTail,
      // The fuller repair diagnostic — records written before the field
      // existed fall back to the short tail, still the best evidence a
      // retry's repair prompt can offer.
      output: typeof obj["output"] === "string" ? obj["output"] : outputTail,
      // Optional in the record shape — older recovery files simply lack it.
      ...(obj["timedOut"] === true ? { timedOut: true as const } : {}),
    });
  }
  return out;
};

const asAttempts = (raw: unknown): WorkflowRunAttempts | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const counter = (key: string): number => {
    const v = obj[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return {
    implementation: counter("implementation"),
    verificationRepair: counter("verificationRepair"),
    mergeConflictRepair: counter("mergeConflictRepair"),
    integrationRebuild: counter("integrationRebuild"),
  };
};

const asCommits = (raw: unknown): { readonly sha: string }[] => {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((c) =>
      typeof c === "object" && c !== null
        ? (c as Record<string, unknown>)["sha"]
        : undefined,
    )
    .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
    .map((sha) => ({ sha }));
};

const optionalString = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined;

/**
 * Validate an already-parsed JSON value into a {@link RecoveryState}.
 * Essential identity/phase fields are strict; later additions
 * (`version`, `targetBaseSha`, `retryCount`, `sessionId`, `logFilePath`,
 * `worktreePath`, `integrationVerification`) tolerate absence so records
 * written by earlier versions still load.
 */
export const parseRecoveryState = (raw: unknown): ParseRecoveryResult => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, detail: "bản ghi không phải là một JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== undefined && typeof obj["version"] !== "number") {
    return { ok: false, detail: "trường `version` không phải là số" };
  }
  const issue = asIssue(obj["issue"]);
  if (issue === undefined) {
    return { ok: false, detail: "thiếu hoặc sai trường `issue.number`" };
  }
  const sourceBranch = optionalString(obj["sourceBranch"]);
  const targetBranch = optionalString(obj["targetBranch"]);
  if (sourceBranch === undefined || targetBranch === undefined) {
    return {
      ok: false,
      detail: "thiếu trường `sourceBranch`/`targetBranch`",
    };
  }
  const failurePhase = obj["failurePhase"];
  if (typeof failurePhase !== "string" || !WORKFLOW_PHASES.has(failurePhase)) {
    return { ok: false, detail: "trường `failurePhase` không hợp lệ" };
  }
  if (typeof obj["error"] !== "string") {
    return { ok: false, detail: "thiếu trường `error`" };
  }
  const attempts = asAttempts(obj["attempts"]);
  if (attempts === undefined) {
    return { ok: false, detail: "trường `attempts` không hợp lệ" };
  }
  const verification = asVerificationResults(obj["verification"] ?? []);
  if (verification === undefined) {
    return { ok: false, detail: "trường `verification` không hợp lệ" };
  }
  const integrationVerification = asVerificationResults(
    obj["integrationVerification"],
  );
  if (
    obj["integrationVerification"] !== undefined &&
    integrationVerification === undefined
  ) {
    return {
      ok: false,
      detail: "trường `integrationVerification` không hợp lệ",
    };
  }
  const retryCount = obj["retryCount"];
  return {
    ok: true,
    state: {
      version:
        typeof obj["version"] === "number"
          ? obj["version"]
          : RECOVERY_STATE_VERSION,
      issue,
      sourceBranch,
      targetBranch,
      ...(optionalString(obj["targetBaseSha"]) !== undefined
        ? { targetBaseSha: optionalString(obj["targetBaseSha"]) }
        : {}),
      ...(optionalString(obj["worktreePath"]) !== undefined
        ? { worktreePath: optionalString(obj["worktreePath"]) }
        : {}),
      failurePhase: failurePhase as WorkflowRunPhase,
      error: obj["error"] as string,
      verification,
      ...(integrationVerification !== undefined
        ? { integrationVerification }
        : {}),
      commits: asCommits(obj["commits"]),
      ...(optionalString(obj["sessionId"]) !== undefined
        ? { sessionId: optionalString(obj["sessionId"]) }
        : {}),
      ...(optionalString(obj["logFilePath"]) !== undefined
        ? { logFilePath: optionalString(obj["logFilePath"]) }
        : {}),
      attempts,
      retryCount:
        typeof retryCount === "number" &&
        Number.isInteger(retryCount) &&
        retryCount >= 0
          ? retryCount
          : 0,
      failedAt: optionalString(obj["failedAt"]) ?? "",
    },
  };
};

// ---------------------------------------------------------------------------
// Read / list / write / clear
// ---------------------------------------------------------------------------

export type RecoveryReadResult =
  | { readonly kind: "ok"; readonly state: RecoveryState }
  | { readonly kind: "missing" }
  | {
      readonly kind: "corrupt";
      readonly path: string;
      readonly detail: string;
    };

/**
 * Read the recovery record for one issue. Missing and corrupt are distinct
 * results — a corrupt record is surfaced, never silently treated as absent.
 */
export const readRecoveryState = async (
  cwd: string,
  issueNumber: number,
): Promise<RecoveryReadResult> => {
  const path = recoveryStatePath(cwd, issueNumber);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { kind: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return {
      kind: "corrupt",
      path,
      detail: `JSON không hợp lệ — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const parsed = parseRecoveryState(raw);
  if (!parsed.ok) {
    return { kind: "corrupt", path, detail: parsed.detail };
  }
  return { kind: "ok", state: parsed.state };
};

export type RecoveryListEntry =
  | { readonly kind: "ok"; readonly state: RecoveryState }
  | {
      readonly kind: "corrupt";
      readonly fileName: string;
      readonly path: string;
      readonly detail: string;
    };

/**
 * List every recovery record under `.sandcastle/recovery/`, including corrupt
 * files (a file Sandcastle cannot parse is still reported — silently dropping
 * it would hide preserved work).
 */
export const listRecoveryStates = async (
  cwd: string,
): Promise<RecoveryListEntry[]> => {
  let files: string[];
  try {
    files = await readdir(recoveryDir(cwd));
  } catch {
    return [];
  }
  const entries: RecoveryListEntry[] = [];
  for (const fileName of files.filter((f) => f.endsWith(".json")).sort()) {
    const path = join(recoveryDir(cwd), fileName);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf-8"));
    } catch (e) {
      entries.push({
        kind: "corrupt",
        fileName,
        path,
        detail: `JSON không hợp lệ — ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const parsed = parseRecoveryState(raw);
    if (!parsed.ok) {
      entries.push({
        kind: "corrupt",
        fileName,
        path,
        detail: parsed.detail,
      });
      continue;
    }
    entries.push({ kind: "ok", state: parsed.state });
  }
  entries.sort((a, b) => {
    const an = a.kind === "ok" ? a.state.issue.number : Number.MAX_SAFE_INTEGER;
    const bn = b.kind === "ok" ? b.state.issue.number : Number.MAX_SAFE_INTEGER;
    return an - bn;
  });
  return entries;
};

/**
 * Persist a recovery record. The record is written through
 * {@link atomicWriteFile} — a same-directory temp file, fsynced, then
 * atomically renamed into place — so an interruption can never leave the
 * sole durable record truncated or half-written, and a failed replacement
 * leaves the previously written record intact (F064).
 *
 * Also keeps `recovery/` ignored by appending it to the scaffolded
 * `.sandcastle/.gitignore` — recovery state is machine-local.
 */
export const writeRecoveryState = async (
  cwd: string,
  state: RecoveryState,
): Promise<void> => {
  const dir = recoveryDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = recoveryStatePath(cwd, state.issue.number);
  try {
    await atomicWriteFile(path, JSON.stringify(state, null, 2) + "\n");
  } catch (e) {
    throw new Error(
      `Không ghi được bản ghi phục hồi tại "${path}": ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        "Bản ghi cũ (nếu có) được giữ nguyên — kiểm tra quyền ghi và dung " +
        "lượng ổ đĩa rồi chạy lại.",
    );
  }
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

/** Remove the record for one issue (no-op when absent). */
export const clearRecoveryState = async (
  cwd: string,
  issueNumber: number,
): Promise<void> => {
  await rm(recoveryStatePath(cwd, issueNumber), { force: true }).catch(
    () => {},
  );
};

// ---------------------------------------------------------------------------
// Per-issue retry exclusion (F065)
//
// `sandcastle retry <N>` mutates the preserved worktree and the repository's
// Git index — two concurrent retries for the same issue would collide on
// both. The lock is a lock FILE at `.sandcastle/recovery/issue-<N>.lock`
// created with `O_EXCL` (`wx`), which is atomic on every supported platform
// (no lockfile dependency). The `.lock` suffix keeps it out of the
// `listRecoveryStates` `.json` glob, so a held lock never surfaces as a
// corrupt record.
//
// The file records the holder's pid + start time for diagnostics. A lock
// whose recorded process is gone is treated as stale: it is re-inspected by
// inode (to be sure it is still the same file) and removed, then acquisition
// is retried once. A lock held by a live process — or one whose contents
// cannot be attributed to a process at all — rejects the retry with a
// {@link RetryLockHeldError} that names the lock file for manual cleanup;
// an unattributable file is never silently deleted.
// ---------------------------------------------------------------------------

/** Absolute path of the per-issue retry lock file. */
export const retryLockPath = (cwd: string, issueNumber: number): string =>
  join(recoveryDir(cwd), `issue-${issueNumber}.lock`);

/**
 * Raised when another process already holds the retry lock for an issue —
 * or when a leftover lock file cannot be attributed to a process. The
 * message names the lock path so a stale file can be removed by hand.
 */
export class RetryLockHeldError extends Error {
  readonly _tag: "RetryLockHeldError" = "RetryLockHeldError";
  constructor(
    readonly lockPath: string,
    readonly issueNumber: number,
    readonly holderDetail: string,
  ) {
    super(
      `Đã có một tiến trình retry khác đang giữ khóa cho issue #${issueNumber} ` +
        `(${holderDetail}) — chạy đồng thời hai lần retry trên cùng một ` +
        "worktree sẽ làm hỏng Git index và commit. Đợi tiến trình kia xong; " +
        `nếu nó đã dừng đột ngột, xóa tệp khóa \`${lockPath}\` rồi chạy lại ` +
        `\`sandcastle retry ${issueNumber}\`.`,
    );
    this.name = "RetryLockHeldError";
  }
}

/** A held retry lock. Call {@link RetryLock.release} exactly once. */
export interface RetryLock {
  /** Path of the lock file this process created. */
  readonly path: string;
  /**
   * Remove the lock file — but only while it still holds THIS acquisition's
   * payload, so a release can never delete a newer holder's lock.
   */
  readonly release: () => Promise<void>;
}

interface LockPayload {
  readonly pid: number;
  readonly startedAt?: string;
}

const parseLockPayload = (content: string): LockPayload | undefined => {
  try {
    const raw: unknown = JSON.parse(content);
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as Record<string, unknown>)["pid"] === "number"
    ) {
      const pid = (raw as Record<string, unknown>)["pid"] as number;
      const startedAt = (raw as Record<string, unknown>)["startedAt"];
      return {
        pid,
        ...(typeof startedAt === "string" ? { startedAt } : {}),
      };
    }
  } catch {
    // Unparseable — the holder cannot be identified.
  }
  return undefined;
};

/**
 * Is `pid` a live process? Signal 0 probes existence without delivering a
 * signal; EPERM means the process exists but is owned by someone else (still
 * held), ESRCH means it is gone (stale lock).
 */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const describeHolder = (payload: LockPayload | undefined): string =>
  payload === undefined
    ? "tệp khóa không đọc được tiến trình giữ"
    : `pid ${payload.pid}` +
      (payload.startedAt !== undefined
        ? `, bắt đầu lúc ${payload.startedAt}`
        : "");

/**
 * Acquire the per-issue retry lock. Resolves with a {@link RetryLock} once
 * the lock file is created; rejects with {@link RetryLockHeldError} when
 * another live process holds it, or with the raw filesystem error when the
 * lock file cannot be created at all.
 *
 * This is an advisory lock: the stale-breaking path re-stats by inode before
 * unlinking, which narrows — but cannot fully eliminate — the window where a
 * lock is replaced between inspection and removal. Callers must treat
 * acquisition as the single retry gate: acquire BEFORE mutating the worktree
 * or Git index, and release when done (including on failure).
 */
export const acquireRetryLock = async (
  cwd: string,
  issueNumber: number,
): Promise<RetryLock> => {
  const dir = recoveryDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = retryLockPath(cwd, issueNumber);
  const payload =
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) +
    "\n";

  for (let attempt = 0; ; attempt++) {
    try {
      // O_EXCL create — atomic cross-platform; fails EEXIST when held.
      await writeFile(path, payload, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      const [content, st] = await Promise.all([
        readFile(path, "utf-8").catch(() => undefined),
        stat(path).catch(() => undefined),
      ]);
      const holder =
        content !== undefined ? parseLockPayload(content) : undefined;

      if (
        attempt === 0 &&
        holder !== undefined &&
        !pidAlive(holder.pid) &&
        st !== undefined
      ) {
        // Stale lock from a dead process. Re-stat and remove ONLY if it is
        // still the exact file we inspected — if another process already
        // broke it and wrote its own, the inode/mtime differ and the next
        // loop iteration will see that live lock and refuse.
        const again = await stat(path).catch(() => undefined);
        if (
          again !== undefined &&
          again.ino === st.ino &&
          again.mtimeMs === st.mtimeMs
        ) {
          await rm(path, { force: true }).catch(() => {});
        }
        continue;
      }
      throw new RetryLockHeldError(path, issueNumber, describeHolder(holder));
    }

    return {
      path,
      release: async () => {
        const current = await readFile(path, "utf-8").catch(() => undefined);
        // Gone already, or still ours → remove. Anything else means another
        // holder replaced it — leave that file alone.
        if (current === undefined || current === payload) {
          await rm(path, { force: true }).catch(() => {});
        }
      },
    };
  }
};

// ---------------------------------------------------------------------------
// Artifact probing — worktree / branch / landing state on disk
// ---------------------------------------------------------------------------

/** Live state of the artifacts a recovery record points at. */
export interface RecoveryArtifacts {
  /** `refs/heads/<sourceBranch>` still resolves. */
  readonly branchExists: boolean;
  /** The recorded worktree path is still a directory on disk. */
  readonly worktreeExists: boolean;
  /**
   * The recorded worktree is a live git worktree currently checked out on the
   * source branch — i.e. directly usable for a retry.
   */
  readonly worktreeUsable: boolean;
  /** `refs/heads/<targetBranch>` still resolves. */
  readonly targetBranchExists: boolean;
  /** Commits on the source branch that are not on the target branch. */
  readonly preservedCommits: readonly string[];
  /**
   * The source branch has no commits the target lacks — the work either
   * already landed elsewhere or was never committed. A stale signal.
   */
  readonly landedOrEmpty: boolean;
}

/**
 * Probe the repo for the current state of a record's preserved artifacts.
 * Purely observational — nothing is removed or created.
 */
export const probeRecoveryArtifacts = async (
  cwd: string,
  state: RecoveryState,
): Promise<RecoveryArtifacts> => {
  const branchExists =
    (await gitOrUndefined(
      ["rev-parse", "-q", "--verify", `refs/heads/${state.sourceBranch}`],
      cwd,
    )) !== undefined;
  const targetBranchExists =
    (await gitOrUndefined(
      ["rev-parse", "-q", "--verify", `refs/heads/${state.targetBranch}`],
      cwd,
    )) !== undefined;

  let worktreeExists = false;
  let worktreeUsable = false;
  if (state.worktreePath !== undefined) {
    const path = state.worktreePath;
    worktreeExists = await stat(path)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (worktreeExists) {
      worktreeUsable =
        (await gitOrUndefined(["rev-parse", "--abbrev-ref", "HEAD"], path)) ===
        state.sourceBranch;
    }
  }

  const preservedCommits = branchExists
    ? ((
        await gitOrUndefined(
          [
            "rev-list",
            "--reverse",
            `${state.targetBranch}..${state.sourceBranch}`,
          ],
          cwd,
        )
      )
        ?.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0) ?? [])
    : [];

  return {
    branchExists,
    worktreeExists,
    worktreeUsable,
    targetBranchExists,
    preservedCommits,
    landedOrEmpty: branchExists && preservedCommits.length === 0,
  };
};

// ---------------------------------------------------------------------------
// Discard — explicit removal of preserved work (after confirmation upstream)
// ---------------------------------------------------------------------------

export interface DiscardOutcome {
  /** Every targeted artifact is gone (or was already absent) and the record was deleted. */
  readonly ok: boolean;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly recordRemoved: boolean;
  /** Human-readable detail of each removal that failed. */
  readonly failures: readonly string[];
}

const isInsideDir = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Remove everything a recovery record tracks: the preserved worktree, the
 * source branch, and finally the record itself. The record is deleted LAST —
 * when a removal fails the record survives so the work stays discoverable via
 * `sandcastle status` and a later `discard`.
 *
 * The caller is responsible for confirmation; this function performs the
 * deletion it is asked to perform. It only ever touches the recorded
 * worktree when it lives under `.sandcastle/worktrees/` — a path pointing
 * outside the managed directory is reported, not removed.
 */
export const discardRecoveryWork = async (
  cwd: string,
  state: RecoveryState,
): Promise<DiscardOutcome> => {
  const failures: string[] = [];
  const artifacts = await probeRecoveryArtifacts(cwd, state);

  // Let git drop stale worktree metadata first so `worktree remove` below
  // sees the real on-disk situation.
  await gitOrUndefined(["worktree", "prune"], cwd);

  let worktreeRemoved = false;
  if (state.worktreePath !== undefined && artifacts.worktreeExists) {
    const path = state.worktreePath;
    const managedRoot = join(cwd, ".sandcastle", "worktrees");
    if (!isInsideDir(path, managedRoot)) {
      failures.push(
        `worktree \`${path}\` nằm ngoài .sandcastle/worktrees/ — không tự xóa`,
      );
    } else {
      const removed = await gitOrUndefined(
        ["worktree", "remove", "--force", path],
        cwd,
      );
      if (removed !== undefined) {
        worktreeRemoved = true;
      } else {
        // The directory exists but is no longer a registered worktree (e.g.
        // metadata was pruned while the dir stayed). Removing the leftover
        // dir + pruning achieves the same end state.
        const rmFailed = await rm(path, { recursive: true, force: true }).then(
          () => undefined,
          (e) => (e instanceof Error ? e.message : String(e)),
        );
        if (rmFailed === undefined) {
          worktreeRemoved = true;
          await gitOrUndefined(["worktree", "prune"], cwd);
        } else {
          failures.push(`không xóa được worktree \`${path}\`: ${rmFailed}`);
        }
      }
    }
  }

  let branchRemoved = false;
  if (artifacts.branchExists) {
    const err = await git(["branch", "-D", state.sourceBranch], cwd).then(
      () => undefined,
      (e) => (e instanceof Error ? e.message : String(e)),
    );
    if (err === undefined) {
      branchRemoved = true;
    } else {
      failures.push(`không xóa được nhánh \`${state.sourceBranch}\`: ${err}`);
    }
  }

  let recordRemoved = false;
  if (failures.length === 0) {
    const err = await rm(recoveryStatePath(cwd, state.issue.number), {
      force: true,
    }).then(
      () => undefined,
      (e) => (e instanceof Error ? e.message : String(e)),
    );
    if (err === undefined) {
      recordRemoved = true;
    } else {
      failures.push(`không xóa được bản ghi phục hồi: ${err}`);
    }
  }

  return {
    ok: failures.length === 0,
    worktreeRemoved,
    branchRemoved,
    recordRemoved,
    failures,
  };
};

import { spawn } from "node:child_process";
import type { DiscoveryExecResult } from "./discovery/contract.js";

/**
 * `gh` CLI boundary for `sandcastle run` issue operations (ADR 0023/0026).
 *
 * Every GitHub mutation and query the run workflow needs goes through the
 * injectable {@link GhRunner} process boundary, so tests substitute a fake
 * `gh` executable on PATH and never touch real repositories or accounts.
 * Authentication/installation probing lives in `githubSetup.ts`
 * (`probeGhReadiness`) — this module assumes `gh` is ready and only reports
 * per-call failures as {@link GithubCliError}.
 *
 * Like `githubSetup.ts`, this module is Promise-based and Effect-free.
 * User-facing report *content* is Vietnamese (built in `WorkflowRun.ts`);
 * gh arguments and identifiers stay English.
 */

/** One GitHub issue as the workflow needs it (immutable per run). */
export interface GithubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly url?: string;
}

/**
 * The process boundary for `gh` calls. Runs `gh <args>` to completion with
 * the given cwd (gh resolves the repo from cwd/remotes) and resolves with the
 * captured output — non-zero exits, timeouts, and spawn failures are data on
 * the result, never throws. Same contract shape as `DiscoveryExec`, but
 * repo-scoped calls need an explicit cwd so the service is not bound to
 * `process.cwd()`.
 */
export type GhRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs?: number },
) => Promise<DiscoveryExecResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 500;

/**
 * The real {@link GhRunner} — `spawn("gh", …)` without a shell (except on
 * Windows, where `.cmd` shims need `cmd`). Forces the C locale so callers can
 * match git/gh's English diagnostics reliably.
 */
export const nodeGhRunner: GhRunner = (
  args,
  options,
): Promise<DiscoveryExecResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn("gh", [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        SIGKILL_GRACE_MS,
      );
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    const settle = (result: DiscoveryExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error: NodeJS.ErrnoException) =>
      settle({
        stdout,
        stderr,
        exitCode: null,
        spawnError: error.code ?? error.message,
      }),
    );
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) =>
      settle({ stdout, stderr, exitCode: code, timedOut }),
    );
  });

/** A `gh` call failed (non-zero exit, timeout, or spawn failure). */
export class GithubCliError extends Error {
  readonly _tag = "GithubCliError";
  constructor(
    readonly args: readonly string[],
    readonly detail: string,
  ) {
    super(`gh ${args.join(" ")} failed: ${detail}`);
    this.name = "GithubCliError";
  }
}

const firstLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

/** Run `gh <args>` and fail with {@link GithubCliError} on any non-zero outcome. */
const ghOk = async (
  runner: GhRunner,
  cwd: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> => {
  const res = await runner(args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    throw new GithubCliError(
      args,
      res.timedOut
        ? `timed out after ${timeoutMs}ms`
        : (firstLine(res.stderr) ??
            firstLine(res.stdout) ??
            (res.spawnError !== undefined
              ? `spawn failed (${res.spawnError})`
              : `exited with code ${res.exitCode ?? "null"}`)),
    );
  }
  return res.stdout;
};

/** Parse one `gh issue … --json` entry into a {@link GithubIssue}. */
const toIssue = (raw: unknown): GithubIssue | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["number"] !== "number") return undefined;
  const labels = Array.isArray(obj["labels"])
    ? (obj["labels"] as unknown[])
        .map((l) =>
          typeof l === "object" && l !== null
            ? (l as Record<string, unknown>)["name"]
            : undefined,
        )
        .filter((n): n is string => typeof n === "string")
    : [];
  return {
    number: obj["number"],
    title: typeof obj["title"] === "string" ? obj["title"] : "",
    body: typeof obj["body"] === "string" ? obj["body"] : "",
    state: typeof obj["state"] === "string" ? obj["state"] : "",
    labels,
    ...(typeof obj["url"] === "string" ? { url: obj["url"] } : {}),
  };
};

/** The issue/query/comment/close operations the run workflow needs. */
export interface GithubIssueOps {
  /** Whether the `Sandcastle` label exists on the repository. */
  readonly labelExists: () => Promise<boolean>;
  /** Open issues carrying the `Sandcastle` label (selection candidates). */
  readonly listEligibleIssues: () => Promise<GithubIssue[]>;
  /** Canonical fresh view of one issue (for `--issue` identity + validation). */
  readonly viewIssue: (issueNumber: number) => Promise<GithubIssue>;
  /** Post a comment on an issue (completion/failure reports). */
  readonly postComment: (issueNumber: number, body: string) => Promise<void>;
  /** Close an issue — only ever called after landing + report (ADR 0023). */
  readonly closeIssue: (issueNumber: number) => Promise<void>;
}

/** The label the run workflow selects issues by. */
export const SANDCASTLE_LABEL = "Sandcastle";

const ISSUE_JSON_FIELDS = "number,title,body,state,labels,url";
const ISSUE_LIST_LIMIT = 100;
const LABEL_LIST_LIMIT = 200;

/**
 * Bind the issue operations to a repository directory. `cwd` is handed to
 * every `gh` invocation so repo resolution never depends on `process.cwd()`.
 */
export const makeGithubIssueOps = (
  cwd: string,
  runner: GhRunner = nodeGhRunner,
): GithubIssueOps => ({
  labelExists: async () => {
    const stdout = await ghOk(runner, cwd, [
      "label",
      "list",
      "--json",
      "name",
      "--limit",
      String(LABEL_LIST_LIMIT),
    ]);
    try {
      const entries = JSON.parse(stdout) as unknown;
      return (
        Array.isArray(entries) &&
        entries.some(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            (e as Record<string, unknown>)["name"] === SANDCASTLE_LABEL,
        )
      );
    } catch {
      return false;
    }
  },

  listEligibleIssues: async () => {
    const stdout = await ghOk(runner, cwd, [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      SANDCASTLE_LABEL,
      "--json",
      ISSUE_JSON_FIELDS,
      "--limit",
      String(ISSUE_LIST_LIMIT),
    ]);
    const raw: unknown = JSON.parse(stdout);
    if (!Array.isArray(raw)) return [];
    return raw.map(toIssue).filter((i): i is GithubIssue => i !== undefined);
  },

  viewIssue: async (issueNumber) => {
    const stdout = await ghOk(runner, cwd, [
      "issue",
      "view",
      String(issueNumber),
      "--json",
      ISSUE_JSON_FIELDS,
    ]);
    const issue = toIssue(JSON.parse(stdout));
    if (issue === undefined) {
      throw new GithubCliError(
        ["issue", "view", String(issueNumber)],
        "unexpected response shape (missing issue number)",
      );
    }
    return issue;
  },

  postComment: async (issueNumber, body) => {
    await ghOk(runner, cwd, [
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      body,
    ]);
  },

  closeIssue: async (issueNumber) => {
    await ghOk(runner, cwd, ["issue", "close", String(issueNumber)]);
  },
});

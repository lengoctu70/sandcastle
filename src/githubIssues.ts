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
  options: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    /**
     * Text written to the process's stdin, after which stdin is closed.
     * Untrusted report content travels this way (`gh … --body-file -`) so it
     * is never interpolated into a command line — multiline text, shell
     * metacharacters, percent signs, Unicode, and bodies longer than the
     * Windows command-line limit all survive literally.
     */
    readonly stdin?: string;
  },
) => Promise<DiscoveryExecResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 500;

/**
 * The real {@link GhRunner} — `spawn("gh", …)` with a fixed executable plus
 * argv and **no command shell on any platform**. Real `gh` is a native
 * binary (`gh.exe` on Windows), so no `.cmd` shim indirection is ever
 * needed; without a shell, argv reaches the process literally and
 * metacharacters in arguments cannot spawn secondary commands. Forces the C
 * locale so callers can match git/gh's English diagnostics reliably.
 */
export const nodeGhRunner: GhRunner = (
  args,
  options,
): Promise<DiscoveryExecResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn("gh", [...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
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

    // If the process exits before we finish writing, stdin errors (EPIPE)
    // are uninteresting — the captured output already explains the outcome.
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

/**
 * Why a `gh` call failed — each kind maps to a distinct user action, so the
 * workflow never collapses them into one opaque "gh failed" message.
 */
export type GithubCliErrorKind =
  /** The process exceeded `timeoutMs` and was killed (network stalls, …). */
  | "timeout"
  /** `gh` could not be started at all (ENOENT, EACCES, …). */
  | "spawn-failure"
  /** gh reported the active account is not signed in to the host. */
  | "unauthenticated"
  /** gh reported the account lacks permission for the operation. */
  | "permission"
  /** gh answered but stdout was not the JSON the operation needs. */
  | "malformed-json"
  /** Any other non-zero exit. */
  | "exit";

/**
 * A `gh` call failed. `kind` distinguishes the typed cause (timeout, spawn
 * failure, unauthenticated, permission, malformed JSON, other exit) and
 * `detail` carries actionable Vietnamese guidance — callers surface
 * `message` verbatim inside their own Vietnamese diagnostics (ADR 0026).
 */
export class GithubCliError extends Error {
  readonly _tag = "GithubCliError";
  constructor(
    readonly args: readonly string[],
    readonly kind: GithubCliErrorKind,
    readonly detail: string,
  ) {
    super(`gh ${args.join(" ")} thất bại: ${detail}`);
    this.name = "GithubCliError";
  }
}

const firstLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);

/** gh's "not signed in" diagnostics (auth status report, API 401, …). */
const UNAUTHENTICATED_PATTERN =
  /not logged in|no github hosts|authentication required|requires authentication|bad credentials|http 401|gh auth login/i;

/** gh's "missing permission" diagnostics (HTTP 403, GraphQL forbids, …). */
const PERMISSION_PATTERN =
  /http 403|forbidden|resource not accessible|insufficient|permission|not authorized|must have \w+ access/i;

/**
 * Fold a failed {@link DiscoveryExecResult} into a typed {@link GithubCliError}.
 * Timeout and spawn failure are checked before output parsing so they can
 * never be misreported as an auth problem, and auth/permission signatures in
 * gh's own diagnostics select the matching Vietnamese next step.
 */
const classifyGhFailure = (
  args: readonly string[],
  res: DiscoveryExecResult,
  timeoutMs: number,
): GithubCliError => {
  if (res.timedOut) {
    return new GithubCliError(
      args,
      "timeout",
      `hết thời gian chờ sau ${timeoutMs}ms — kiểm tra kết nối mạng rồi thử lại.`,
    );
  }
  if (res.spawnError !== undefined) {
    return new GithubCliError(
      args,
      "spawn-failure",
      `không khởi động được gh (${res.spawnError}) — kiểm tra gh đã được cài đặt và nằm trên PATH.`,
    );
  }
  const output = `${res.stderr}\n${res.stdout}`;
  const line =
    firstLine(res.stderr) ??
    firstLine(res.stdout) ??
    `thoát với mã ${res.exitCode ?? "null"}`;
  if (UNAUTHENTICATED_PATTERN.test(output)) {
    return new GithubCliError(
      args,
      "unauthenticated",
      `${line} — chạy \`gh auth login\` để đăng nhập GitHub.`,
    );
  }
  if (PERMISSION_PATTERN.test(output)) {
    return new GithubCliError(
      args,
      "permission",
      `${line} — tài khoản gh thiếu quyền cho thao tác này trên repository (cần quyền Issues: write).`,
    );
  }
  return new GithubCliError(args, "exit", line);
};

/** Run `gh <args>` and fail with {@link GithubCliError} on any non-zero outcome. */
const ghOk = async (
  runner: GhRunner,
  cwd: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly stdin?: string } = {},
): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await runner(args, { cwd, timeoutMs, stdin: options.stdin });
  if (res.exitCode !== 0) {
    throw classifyGhFailure(args, res, timeoutMs);
  }
  return res.stdout;
};

/**
 * Parse a `gh … --json` response. gh writing non-JSON (proxy error pages,
 * upgrade banners, truncated output) is a typed {@link GithubCliError}
 * (`"malformed-json"`), never a raw `SyntaxError` or a silent empty result.
 */
const parseGhJson = (args: readonly string[], stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new GithubCliError(
      args,
      "malformed-json",
      `gh trả về dữ liệu JSON không hợp lệ (${e instanceof Error ? e.message : String(e)}) — ` +
        "kiểm tra phiên bản gh (`gh --version`) và kết nối mạng, rồi thử lại.",
    );
  }
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

/**
 * Case-insensitive `Sandcastle`-label check — GitHub treats labels as
 * case-insensitively unique, so a repository label named `sandcastle` must
 * satisfy every Sandcastle lookup exactly like `Sandcastle` does.
 */
export const hasSandcastleLabel = (labels: readonly string[]): boolean =>
  labels.some((l) => l.toLowerCase() === SANDCASTLE_LABEL.toLowerCase());

const ISSUE_JSON_FIELDS = "number,title,body,state,labels,url";
const ISSUE_LIST_LIMIT = 100;
/**
 * Cap on the `--search`-filtered label query — a specific search, not an
 * arbitrary page of every label, so large repositories stay correct.
 */
const LABEL_SEARCH_LIMIT = 100;

/**
 * Bind the issue operations to a repository directory. `cwd` is handed to
 * every `gh` invocation so repo resolution never depends on `process.cwd()`.
 */
export const makeGithubIssueOps = (
  cwd: string,
  runner: GhRunner = nodeGhRunner,
): GithubIssueOps => ({
  labelExists: async () => {
    const args = [
      "label",
      "list",
      "--search",
      SANDCASTLE_LABEL,
      "--json",
      "name",
      "--limit",
      String(LABEL_SEARCH_LIMIT),
    ] as const;
    const stdout = await ghOk(runner, cwd, args);
    const entries = parseGhJson(args, stdout);
    return (
      Array.isArray(entries) &&
      entries.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as Record<string, unknown>)["name"] === "string" &&
          hasSandcastleLabel([
            (e as Record<string, unknown>)["name"] as string,
          ]),
      )
    );
  },

  listEligibleIssues: async () => {
    const args = [
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
    ] as const;
    const stdout = await ghOk(runner, cwd, args);
    const raw = parseGhJson(args, stdout);
    if (!Array.isArray(raw)) return [];
    return raw.map(toIssue).filter((i): i is GithubIssue => i !== undefined);
  },

  viewIssue: async (issueNumber) => {
    const args = [
      "issue",
      "view",
      String(issueNumber),
      "--json",
      ISSUE_JSON_FIELDS,
    ] as const;
    const stdout = await ghOk(runner, cwd, args);
    const issue = toIssue(parseGhJson(args, stdout));
    if (issue === undefined) {
      throw new GithubCliError(
        args,
        "malformed-json",
        "gh trả về issue thiếu trường `number` — kiểm tra phiên bản gh (`gh --version`) rồi thử lại.",
      );
    }
    return issue;
  },

  postComment: async (issueNumber, body) => {
    // The report body is untrusted multiline content — it travels on stdin
    // (`--body-file -`), never on the command line, so newlines, shell
    // metacharacters, percent signs, Unicode, and bodies beyond the Windows
    // command-line limit all reach GitHub literally.
    await ghOk(
      runner,
      cwd,
      ["issue", "comment", String(issueNumber), "--body-file", "-"],
      { stdin: body },
    );
  },

  closeIssue: async (issueNumber) => {
    await ghOk(runner, cwd, ["issue", "close", String(issueNumber)]);
  },
});

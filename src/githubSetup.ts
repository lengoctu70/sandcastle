import type { DiscoveryExec } from "./discovery/contract.js";
import { nodeGhRunner } from "./githubIssues.js";

/**
 * GitHub CLI readiness checks for `sandcastle init` (ADR 0026).
 *
 * When the `github-issues` tracker is selected, init verifies `gh` is
 * installed and authenticated on the host *before* anything is scaffolded —
 * issue operations must not fail after agent work has already completed.
 * Every probe goes through the injected {@link DiscoveryExec} process
 * boundary (same seam as agent discovery), so tests substitute fake
 * executables on PATH and never touch real GitHub accounts.
 *
 * User-facing strings (`detail`, messages built from these results in
 * cli.ts) are Vietnamese per ADR 0026; command names stay English.
 */

/** Ready state of the host's `gh` executable. */
export type GhReadiness =
  | {
      readonly kind: "ready";
      /** Parsed `gh --version` line, e.g. `"2.90.0"`. */
      readonly version?: string;
      /**
       * The `Logged in to <host> account <user>` line from `gh auth status`
       * — names the host AND the active account, never any credential.
       */
      readonly authDetail?: string;
    }
  /** `gh` is not on PATH (spawn ENOENT). */
  | { readonly kind: "not-installed" }
  /** `gh` exists but `gh auth status` reports no usable login. */
  | { readonly kind: "unauthenticated"; readonly detail?: string }
  /** The CLI answered unexpectedly (non-zero `--version`, timeout, …). */
  | { readonly kind: "error"; readonly detail?: string };

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Default process boundary for the `gh` probes in this module — shell-free
 * spawn via {@link nodeGhRunner} (every probe here invokes `gh`; the exec is
 * only injectable so tests can substitute fakes). `nodeDiscoveryExec` is
 * deliberately not reused: it enables a `cmd.exe` shell on Windows, and no
 * GitHub operation may go through a command shell.
 */
const shellFreeGhExec: DiscoveryExec = (_command, args, options) =>
  nodeGhRunner(args, {
    cwd: process.cwd(),
    timeoutMs: options?.timeoutMs,
    stdin: options?.stdin,
  });

const firstLine = (text: string): string | undefined => {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line;
};

/**
 * `gh auth status` prints one block per host — a bare hostname line first,
 * then `✓ Logged in to <host> account <user> (…)`. Surface that logged-in
 * line so the displayed identity names the host AND the active account;
 * token sources (`GH_TOKEN`, keyring) never appear on it.
 */
const GH_LOGGED_IN_PATTERN = /logged\s+in\s+to/i;

const authStatusDetail = (
  stdout: string,
  stderr: string,
): string | undefined => {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.find((l) => GH_LOGGED_IN_PATTERN.test(l)) ?? lines[0];
};

/**
 * Parse the `gh --version` banner (`"gh version 2.90.0 (2026-04-16)"`) down
 * to the bare version for status messages.
 */
const parseGhVersion = (stdout: string): string | undefined => {
  const match = stdout.match(/gh version (\S+)/);
  return match?.[1] ?? firstLine(stdout);
};

/**
 * Probe `gh --version` then `gh auth status`. Never throws — every outcome
 * is data on {@link GhReadiness}. `gh auth status` exits non-zero when no
 * host is authenticated; its report goes to stderr on failure.
 */
export const probeGhReadiness = async (
  exec: DiscoveryExec = shellFreeGhExec,
): Promise<GhReadiness> => {
  const version = await exec("gh", ["--version"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (version.spawnError !== undefined) {
    return version.spawnError === "ENOENT"
      ? { kind: "not-installed" }
      : {
          kind: "error",
          detail: `không khởi động được gh (${version.spawnError}) — kiểm tra cài đặt gh.`,
        };
  }
  if (version.timedOut) {
    return {
      kind: "error",
      detail: `gh --version hết thời gian chờ sau ${PROBE_TIMEOUT_MS}ms — kiểm tra gh rồi thử lại.`,
    };
  }
  if (version.exitCode !== 0) {
    return {
      kind: "error",
      detail:
        firstLine(version.stderr) ??
        `gh --version exited with code ${version.exitCode ?? "null"}`,
    };
  }

  const auth = await exec("gh", ["auth", "status"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  // Transport failures (timeout, spawn error) are NOT auth failures — they
  // must not send the user to `gh auth login` for a network problem.
  if (auth.spawnError !== undefined) {
    return {
      kind: "error",
      detail: `không khởi động được gh auth status (${auth.spawnError}) — kiểm tra cài đặt gh.`,
    };
  }
  if (auth.timedOut) {
    return {
      kind: "error",
      detail: `gh auth status hết thời gian chờ sau ${PROBE_TIMEOUT_MS}ms — kiểm tra kết nối mạng rồi thử lại.`,
    };
  }
  if (auth.exitCode === 0) {
    return {
      kind: "ready",
      version: parseGhVersion(version.stdout),
      authDetail: authStatusDetail(auth.stdout, auth.stderr),
    };
  }
  return {
    kind: "unauthenticated",
    detail: firstLine(auth.stderr) ?? firstLine(auth.stdout),
  };
};

/** Outcome of attempting `gh label create "Sandcastle"`. */
export type SandcastleLabelResult =
  | { readonly kind: "created" }
  | { readonly kind: "already-exists" }
  /**
   * The account authenticated but lacks write permission (HTTP 403, …) —
   * reported distinctly so the guidance points at repository access, not at
   * re-running setup blindly.
   */
  | { readonly kind: "forbidden"; readonly detail: string }
  /**
   * Transport-level failure — the CLI could not be reached to a verdict
   * (spawn failure, timeout). `detail` carries Vietnamese guidance.
   */
  | { readonly kind: "error"; readonly detail: string }
  /** Creation failed — `detail` carries gh's own error line. */
  | { readonly kind: "failed"; readonly detail: string };

/** gh's "missing permission" diagnostics on `label create` (HTTP 403, …). */
const LABEL_FORBIDDEN_PATTERN =
  /http 403|forbidden|resource not accessible|insufficient|permission|not authorized|must have \w+ access/i;

/**
 * Create the `Sandcastle` label on the current repository. Runs in the
 * caller's working directory (gh resolves the repo from cwd/remotes). An
 * already-existing label is reported separately — it is a fine outcome, not
 * an error. Permission failures return `forbidden`; any other failure (no
 * remote, network, timeout) returns `failed` — both carry the CLI's error
 * line for a Vietnamese report upstream.
 */
export const createSandcastleLabel = async (
  exec: DiscoveryExec = shellFreeGhExec,
): Promise<SandcastleLabelResult> => {
  const res = await exec(
    "gh",
    [
      "label",
      "create",
      "Sandcastle",
      "--description",
      "Issues for Sandcastle to work on",
      "--color",
      "F9A825",
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (res.exitCode === 0) return { kind: "created" };
  // Transport failures are checked before output parsing so a timed-out or
  // unstartable CLI can never be misreported as an existence/permission verdict.
  if (res.spawnError !== undefined) {
    return {
      kind: "error",
      detail: `không khởi động được gh (${res.spawnError}) — kiểm tra cài đặt gh.`,
    };
  }
  if (res.timedOut) {
    return {
      kind: "error",
      detail: `gh label create hết thời gian chờ sau ${PROBE_TIMEOUT_MS}ms — kiểm tra kết nối mạng rồi thử lại.`,
    };
  }
  const output = `${res.stderr}\n${res.stdout}`.trim();
  if (/already exists/i.test(output)) return { kind: "already-exists" };
  const detail =
    firstLine(res.stderr) ??
    firstLine(res.stdout) ??
    `gh label create exited with code ${res.exitCode ?? "null"}`;
  if (LABEL_FORBIDDEN_PATTERN.test(output)) {
    return { kind: "forbidden", detail };
  }
  return { kind: "failed", detail };
};

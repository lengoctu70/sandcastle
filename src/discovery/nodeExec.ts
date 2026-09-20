import { spawn, spawnSync } from "node:child_process";
import type { DiscoveryExec, DiscoveryExecResult } from "./contract.js";

/**
 * Default timeout for discovery calls that don't pass one. Discovery probes
 * are local CLI calls and should answer in seconds — this bound keeps a hung
 * CLI from wedging init forever.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 500;

/**
 * cmd.exe's missing-executable diagnostic. With `shell: true` (Windows) a
 * missing executable never reaches `child.on("error")` — cmd.exe itself
 * spawns fine, writes this to stderr, and exits 1.
 */
const CMD_NOT_RECOGNIZED_PATTERN =
  /is not recognized as an internal or external command/i;

/**
 * `spawnError` for a shell-routed probe exit, or `undefined` when the exit
 * is not a missing executable. On Windows `shell: true` suppresses the real
 * ENOENT — cmd.exe answers exit 1 with "not recognized" on stderr instead —
 * so the stderr pattern is the only signal that keeps a missing CLI on the
 * `not-installed` path instead of `wrong-product` (see contract.ts). Other
 * platforms report ENOENT through `child.on("error")` directly.
 */
export const shellExitSpawnError = (
  platform: string,
  exitCode: number | null,
  stderr: string,
): "ENOENT" | undefined =>
  platform === "win32" &&
  exitCode !== null &&
  exitCode !== 0 &&
  CMD_NOT_RECOGNIZED_PATTERN.test(stderr)
    ? "ENOENT"
    : undefined;

/**
 * The real {@link DiscoveryExec} implementation — `child_process.spawn`
 * without a shell (except on Windows, where `.cmd`/`.ps1` shims need `cmd`).
 *
 * Resolves for every process outcome — non-zero exits, timeouts, and spawn
 * failures are all data on {@link DiscoveryExecResult}; it never rejects.
 * stdin is always closed after writing `options.stdin` (or immediately), so
 * probes like `codex login status` can never block waiting for input.
 *
 * Settlement is bounded by a hard deadline: `close` only fires once stdio
 * reaches EOF, so a probe whose descendant kept the inherited pipes open
 * could otherwise hold the result forever. At `timeoutMs` the whole process
 * tree is signalled; after a short SIGKILL grace the owned streams are
 * dropped and the promise settles exactly once with `timedOut: true`,
 * independent of any EOF.
 */
export const nodeDiscoveryExec: DiscoveryExec = (
  command,
  args,
  options,
): Promise<DiscoveryExecResult> =>
  new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isWindows = process.platform === "win32";
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // `.cmd`/`.ps1` shims (e.g. npm-installed CLIs on Windows) cannot be
      // spawned directly — go through cmd.exe there. Discovery args are
      // simple literals with no spaces, so this is safe.
      shell: isWindows,
      windowsHide: true,
      // POSIX: make the probe a process-group leader so a descendant that
      // inherited the stdio pipes stays inside the signalling boundary at
      // the deadline (same scheme as no-sandbox.ts). Descendants that
      // deliberately re-daemonize (setsid) escape the group; nothing can
      // reap those.
      detached: !isWindows,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let childExited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: DiscoveryExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
    };

    /**
     * Signal the probe's whole process tree — best-effort, never throws.
     * Windows: `taskkill /PID /T /F` covers the cmd.exe wrapper, the probed
     *   CLI, and every descendant it started.
     * POSIX: `detached` made `child.pid` the process-group id. When the
     *   leader already exited, probe the group first — while it exists its
     *   members are necessarily our descendants, so a lingering pipe-holder
     *   is still signalled but a dead (possibly reused) pgid never is. That
     *   is the same argument as `signalTree` in no-sandbox.ts.
     */
    const signalTree = (signal: "SIGTERM" | "SIGKILL"): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (isWindows) {
        try {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          /* best-effort — the tree may already be gone */
        }
        return;
      }
      if (childExited) {
        try {
          process.kill(-pid, 0);
        } catch {
          return; // group is gone — nothing of ours left to signal
        }
      }
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        // The probe ignored SIGTERM or a descendant still holds the stdio
        // pipes — `close` cannot be awaited. Force-kill the tree, drop our
        // end of every owned stream so EOF cannot be owed to anyone, and
        // settle the typed timeout result exactly once.
        signalTree("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        settle({ stdout, stderr, exitCode: null, timedOut: true });
      }, SIGKILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    child.on("exit", () => {
      childExited = true;
    });
    child.on("error", (err) => {
      // Spawn failure — e.g. ENOENT (not installed), EACCES (not executable).
      settle({
        stdout,
        stderr,
        exitCode: null,
        spawnError: (err as NodeJS.ErrnoException).code ?? "SPAWN_ERROR",
      });
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      // A missing Windows executable surfaces here, not via "error" — map
      // cmd.exe's "not recognized" answer back to ENOENT so it stays on the
      // `not-installed` path. A timed-out probe keeps its timeout result.
      const spawnError = timedOut
        ? undefined
        : shellExitSpawnError(process.platform, code, stderr);
      settle({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });

    // If the process exits before we finish writing, stdin errors (EPIPE) are
    // uninteresting — the captured output already explains the outcome.
    child.stdin.on("error", () => {});
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

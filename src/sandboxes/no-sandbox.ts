/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 *
 * Process-tree teardown: every process spawned through the handle is tracked
 * for the handle's lifetime. On POSIX the shell is spawned `detached`, making
 * it a process-group leader, so `close()` — and cancellation, idle timeout,
 * and completion timeout, which abort the exec's AbortSignal — can signal
 * the whole group (shell, agent, and every descendant) via `kill(-pgid)`.
 * On Windows there are no process groups, so termination shells out to
 * `taskkill /PID <pid> /T /F` which walks the process tree.
 * `close()` sends SIGTERM first, then SIGKILLs whatever is still alive after
 * `terminationGraceMs`.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

/** Default delay between SIGTERM and SIGKILL when tearing down a host process tree. */
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

/**
 * Map a child "close" event's `(code, signal)` pair to a truthful exit code.
 * Signal termination (`code === null`) is never success: report the
 * conventional `128 + n` (SIGKILL → 137, SIGTERM → 143), or 1 for any other
 * signal.
 */
const exitCodeFromClose = (
  code: number | null,
  signal: NodeJS.Signals | null,
): number => {
  if (code !== null) return code;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  return 1;
};

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
  /**
   * Grace period in milliseconds between SIGTERM and SIGKILL when a host
   * process tree is terminated (default: 1000). Processes that ignore SIGTERM
   * are force-killed once this elapses. On Windows termination goes straight
   * to `taskkill /F` — the option only bounds how long `close()` waits for
   * the tree to die.
   */
  readonly terminationGraceMs?: number;
}

/**
 * A process spawned through the no-sandbox handle, tracked until its "close"
 * event fires (process exited AND stdio streams drained).
 */
interface TrackedProcess {
  readonly proc: ChildProcess;
  /**
   * POSIX process group id captured at spawn — equal to `proc.pid` because the
   * child was spawned `detached`, making it a process-group leader.
   * `undefined` for non-detached children (interactive exec on POSIX) and on
   * Windows, where process groups do not exist.
   */
  readonly pgid?: number;
  /** True once the child's "exit" event fired — the leader has been reaped. */
  exited: boolean;
  /** True once the child's "close" event fired. */
  closed: boolean;
  /** Resolves when the child's "close" event fires. */
  readonly closedPromise: Promise<void>;
}

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const terminationGraceMs =
      options?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const isWindows = process.platform === "win32";

    // Every process spawned through this handle, keyed for teardown. Entries
    // are removed when the child's "close" event fires, so a process that has
    // fully exited is never signalled — that is what keeps close() from
    // hitting reused pids after a normal, successful exec.
    const tracked = new Set<TrackedProcess>();
    let closed = false;
    let closePromise: Promise<void> | undefined;

    /**
     * Send a signal to a tracked process tree. Never throws — teardown is
     * best-effort and must stay safe when the process already exited.
     *
     * POSIX + pgid: signal the whole process group via `kill(-pgid)`.
     *   - If the leader (our direct child) is still running, the group is
     *     ours by construction — we spawned it detached.
     *   - If the leader was reaped but "close" has not fired, a descendant is
     *     still holding the stdio pipes open (the classic hanging-process
     *     case). We probe the group with `kill(-pgid, 0)` first: while the
     *     group exists its members are necessarily our descendants — a dead
     *     group's id cannot be observed, and an unrelated process can only
     *     reuse the pgid after the last member (our descendant) is gone, at
     *     which point the probe fails with ESRCH and we skip.
     * POSIX, no pgid (interactive exec): signal only the direct child — its
     *   descendants share OUR process group, so a group signal would kill
     *   Sandcastle itself. There is deliberately no `kill(-pid)` fallback:
     *   a non-detached child was never a group leader, so if it already
     *   exited its pid may have been recycled as an unrelated group's pgid
     *   and signalling it would kill unrelated host processes.
     * Windows: `taskkill /PID <pid> /T /F` kills the process and every
     *   descendant it started. `spawnSync` keeps it usable from the
     *   synchronous shutdown callback.
     */
    const signalTree = (
      entry: TrackedProcess,
      signal: "SIGTERM" | "SIGKILL",
    ): void => {
      if (entry.closed) return;
      const pid = entry.proc.pid;
      if (pid === undefined) return;
      if (isWindows) {
        try {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort — the process may already be gone */
        }
        return;
      }
      if (entry.pgid !== undefined) {
        if (entry.exited) {
          try {
            process.kill(-entry.pgid, 0);
          } catch {
            return; // group is gone — nothing of ours left to signal
          }
        }
        try {
          process.kill(-entry.pgid, signal);
        } catch {
          /* ESRCH — group already gone */
        }
        return;
      }
      try {
        entry.proc.kill(signal);
      } catch {
        /* already exited */
      }
    };

    /**
     * Terminate a tracked tree: SIGTERM now, SIGKILL after the grace period
     * if it is still alive. The escalation timer is unref'd so it never keeps
     * the host process alive on its own.
     */
    const terminate = (entry: TrackedProcess): void => {
      if (entry.closed) return;
      signalTree(entry, "SIGTERM");
      if (isWindows) return; // taskkill /F is already unconditional
      const timer = setTimeout(() => {
        signalTree(entry, "SIGKILL");
      }, terminationGraceMs);
      timer.unref?.();
      void entry.closedPromise.then(() => clearTimeout(timer));
    };

    const track = (proc: ChildProcess, pgid?: number): TrackedProcess => {
      let markClosed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const entry: TrackedProcess = {
        proc,
        pgid,
        exited: false,
        closed: false,
        closedPromise,
      };
      proc.on("exit", () => {
        entry.exited = true;
      });
      const markFullyClosed = () => {
        entry.exited = true;
        entry.closed = true;
        tracked.delete(entry);
        markClosed();
      };
      proc.on("close", markFullyClosed);
      // A failed spawn emits "error" and may never reach "close" — untrack it
      // so close() never waits on or signals a process that never started.
      // An error on a running process keeps it tracked so it is still killed.
      proc.on("error", () => {
        if (proc.pid === undefined) markFullyClosed();
      });
      tracked.add(entry);
      return entry;
    };

    /** Kill every tracked tree synchronously — used by the shutdown registry. */
    const killAllSync = (): void => {
      for (const entry of tracked) {
        signalTree(entry, "SIGKILL");
      }
    };
    const unregisterShutdown = registerShutdown(killAllSync);

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
          stdin?: string;
          signal?: AbortSignal;
        },
      ): Promise<ExecResult> => {
        if (closed) {
          return Promise.reject(
            new Error("exec called on a closed no-sandbox handle"),
          );
        }
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;
        // PowerShell and cmd.exe don't ship `sh`, so on Windows route the
        // command string through cmd.exe instead. `/d` skips AutoRun, `/s`
        // preserves the quoted command verbatim, `/c` runs it and exits.
        // `windowsVerbatimArguments` keeps Node from re-quoting our args.
        const shellCmd = isWindows ? "cmd.exe" : "sh";
        const shellArgs = isWindows
          ? ["/d", "/s", "/c", command]
          : ["-c", command];

        return new Promise((resolve, reject) => {
          const proc = spawn(shellCmd, shellArgs, {
            cwd,
            env: processEnv,
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
            windowsVerbatimArguments: isWindows,
            // POSIX: put the shell in its own process group so the whole
            // spawned tree — agent, gh/git children, MCP servers — can be
            // signalled at once via kill(-pid). Descendants that deliberately
            // re-daemonize (setsid) escape the group; nothing can reap those.
            detached: !isWindows,
          });
          // With detached:true on POSIX the child is a group leader, so its
          // pid IS the pgid — captured here at spawn, before it can be
          // confused with a later pid reuse.
          const entry = track(proc, isWindows ? undefined : proc.pid);

          // AbortSignal support: aborting terminates this exec's whole
          // process tree immediately rather than waiting for close().
          if (opts?.signal) {
            const signal = opts.signal;
            if (signal.aborted) {
              terminate(entry);
            } else {
              const onAbort = () => terminate(entry);
              signal.addEventListener("abort", onAbort, { once: true });
              void entry.closedPromise.then(() =>
                signal.removeEventListener("abort", onAbort),
              );
            }
          }

          // The child may exit while the prompt is still being written,
          // surfacing as an EPIPE error on proc.stdin. Capture it instead of
          // letting it crash the host as an unhandled stream error; the close
          // handler folds it into a non-zero invocation result.
          let stdinError: Error | undefined;
          if (opts?.stdin !== undefined) {
            proc.stdin!.on("error", (error: Error) => {
              stdinError = error;
            });
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          const finish = (
            stdout: string,
            stderr: string,
            code: number | null,
            signal: NodeJS.Signals | null,
          ): void => {
            const exitCode = exitCodeFromClose(code, signal);
            resolve({
              stdout,
              stderr:
                stdinError === undefined
                  ? stderr
                  : `${stderr}\nstdin write failed: ${stdinError.message}`,
              // A prompt that never reached the child is an invocation
              // failure even when the child's own exit code was 0.
              exitCode:
                stdinError !== undefined && exitCode === 0 ? 1 : exitCode,
            });
          };

          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutTail.push(line);
              onLine(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            proc.on("close", (code, signal) => {
              finish(
                stdoutTail.toString(),
                stderrTail.toString(),
                code,
                signal,
              );
            });
          } else {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });
            proc.on("close", (code, signal) => {
              finish(
                stdoutChunks.join(""),
                stderrChunks.join(""),
                code,
                signal,
              );
            });
          }
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        if (closed) {
          return Promise.reject(
            new Error("interactiveExec called on a closed no-sandbox handle"),
          );
        }
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          // Agent CLIs on Windows are typically installed as `.cmd`/`.ps1`
          // npm wrappers; bare `spawn("claude", …)` only resolves `.exe`
          // without `shell: true`, so let cmd.exe handle PATHEXT lookup.
          //
          // POSIX: deliberately NOT detached — the interactive TUI keeps our
          // controlling terminal so /dev/tty access and Ctrl+C delivery keep
          // working. The trade-off is that teardown can only signal the
          // direct child, not a process group.
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            shell: isWindows,
          });
          track(proc);

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on(
            "close",
            (code: number | null, signal: NodeJS.Signals | null) => {
              resolve({ exitCode: exitCodeFromClose(code, signal) });
            },
          );
        });
      },

      close: (): Promise<void> => {
        // Idempotent — every caller, concurrent or repeated, shares the one
        // teardown pass. Safe even after all tracked processes already exited.
        if (closePromise) return closePromise;
        closed = true;
        unregisterShutdown();
        closePromise = (async () => {
          const entries = [...tracked];
          if (entries.length === 0) return;
          const waitForClosed = (timeoutMs: number): Promise<void> =>
            Promise.race([
              Promise.all(entries.map((entry) => entry.closedPromise)),
              new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
            ]).then(() => undefined);
          // Graceful first — give agents a chance to flush state — then force.
          for (const entry of entries) signalTree(entry, "SIGTERM");
          await waitForClosed(terminationGraceMs);
          for (const entry of entries) {
            if (!entry.closed) signalTree(entry, "SIGKILL");
          }
          await waitForClosed(terminationGraceMs);
        })();
        return closePromise;
      },
    };

    return handle;
  },
});

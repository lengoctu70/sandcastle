import { spawn } from "node:child_process";
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
 * The real {@link DiscoveryExec} implementation — `child_process.spawn`
 * without a shell (except on Windows, where `.cmd`/`.ps1` shims need `cmd`).
 *
 * Resolves for every process outcome — non-zero exits, timeouts, and spawn
 * failures are all data on {@link DiscoveryExecResult}; it never rejects.
 * stdin is always closed after writing `options.stdin` (or immediately), so
 * probes like `codex login status` can never block waiting for input.
 */
export const nodeDiscoveryExec: DiscoveryExec = (
  command,
  args,
  options,
): Promise<DiscoveryExecResult> =>
  new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // `.cmd`/`.ps1` shims (e.g. npm-installed CLIs on Windows) cannot be
      // spawned directly — go through cmd.exe there. Discovery args are
      // simple literals with no spaces, so this is safe.
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
      settle({ stdout, stderr, exitCode: code, timedOut });
    });

    // If the process exits before we finish writing, stdin errors (EPIPE) are
    // uninteresting — the captured output already explains the outcome.
    child.stdin.on("error", () => {});
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

/**
 * Test helper: creates a local (filesystem-based) SandboxService for unit tests.
 * This replaces FilesystemSandbox which has been removed.
 */
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BoundedTail, MAX_TAIL_CHARS } from "./boundedTail.js";
import { CopyError, ExecError } from "./errors.js";
import { type ExecResult, type SandboxService } from "./SandboxFactory.js";

/**
 * Creates an isolated git global config env so that test sandbox
 * `git config --global` writes don't corrupt the developer's real ~/.gitconfig.
 */
const createIsolatedGitEnv = (): Record<string, string> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
  const globalConfigPath = join(tmpDir, ".gitconfig");
  writeFileSync(globalConfigPath, "");
  return { GIT_CONFIG_GLOBAL: globalConfigPath };
};

/**
 * Mirror of the no-sandbox provider's close-code mapping: signal termination
 * (`code === null`) is never a successful exit.
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

export const makeLocalSandbox = (sandboxDir: string): SandboxService => {
  const gitEnv = createIsolatedGitEnv();
  const env = { ...process.env, ...gitEnv };

  return {
    exec: (command, options) => {
      return Effect.async<ExecResult, ExecError>((resume) => {
        const proc = spawn("sh", ["-c", command], {
          cwd: options?.cwd ?? sandboxDir,
          stdio: [
            options?.stdin !== undefined ? "pipe" : "ignore",
            "pipe",
            "pipe",
          ],
          env,
        });

        // Capture stdin write failures (early child exit → EPIPE) so they
        // surface as an invocation failure, not an unhandled stream error.
        let stdinError: Error | undefined;
        if (options?.stdin !== undefined) {
          proc.stdin!.on("error", (error: Error) => {
            stdinError = error;
          });
          proc.stdin!.write(options.stdin);
          proc.stdin!.end();
        }

        proc.on("error", (error) => {
          resume(
            Effect.fail(
              new ExecError({
                command,
                message: `Failed to exec: ${error.message}`,
              }),
            ),
          );
        });

        const finish = (
          stdout: string,
          stderr: string,
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          const exitCode = exitCodeFromClose(code, signal);
          resume(
            Effect.succeed({
              stdout,
              stderr:
                stdinError === undefined
                  ? stderr
                  : `${stderr}\nstdin write failed: ${stdinError.message}`,
              // A prompt that never reached the child is an invocation
              // failure even when the child's own exit code was 0.
              exitCode:
                stdinError !== undefined && exitCode === 0 ? 1 : exitCode,
            }),
          );
        };

        if (options?.onLine) {
          const onLine = options.onLine;
          const stdoutTail = new BoundedTail(MAX_TAIL_CHARS, "\n");
          const stderrTail = new BoundedTail(MAX_TAIL_CHARS, "");
          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutTail.push(line);
            onLine(line);
          });
          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrTail.push(chunk.toString());
          });
          proc.on("close", (code, signal) => {
            finish(stdoutTail.toString(), stderrTail.toString(), code, signal);
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
            finish(stdoutChunks.join(""), stderrChunks.join(""), code, signal);
          });
        }
      });
    },

    copyIn: (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${e}`,
          }),
      }),

    copyFileOut: (sandboxPath, hostPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${e}`,
          }),
      }),
  };
};

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox } from "./no-sandbox.js";
import { run } from "../run.js";
import type { AgentProvider } from "../AgentProvider.js";

const itPosix = process.platform === "win32" ? it.skip : it;
const itWindows = process.platform === "win32" ? it : it.skip;

const execAsync = promisify(exec);

/** Whether a pid currently belongs to a live (or zombie) process. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll a condition until it holds or the deadline passes. */
const waitFor = async (
  cond: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
};

const readPid = async (path: string): Promise<number> =>
  parseInt((await readFile(path, "utf-8")).trim(), 10);

/**
 * Wait for the named pid files to appear in `dir`, then read them. The
 * commands under test write their own pid and their descendants' pids into
 * these files so assertions can target the whole process tree.
 */
const waitForPids = async (
  dir: string,
  ...names: string[]
): Promise<Record<string, number>> => {
  const paths = names.map((name) => join(dir, name));
  const ready = await waitFor(() => paths.every((p) => existsSync(p)));
  if (!ready) {
    throw new Error(`Timed out waiting for pid files: ${paths.join(", ")}`);
  }
  const pids = await Promise.all(paths.map(readPid));
  return Object.fromEntries(names.map((name, i) => [name, pids[i]!]));
};

/** Assert every pid dies within the polling window. */
const expectTreeDead = async (pids: Record<string, number>) => {
  for (const [name, pid] of Object.entries(pids)) {
    expect(
      await waitFor(() => !pidAlive(pid)),
      `expected ${name} (pid ${pid}) to be dead`,
    ).toBe(true);
  }
};

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, "README.md"), "# test\n");
  await execAsync("git add README.md && git commit -m init", { cwd: dir });
};

/**
 * A fake agent provider whose print command is an arbitrary shell command —
 * the no-sandbox provider runs it via `sh -c`, which lets tests drive real
 * host process trees through the full `run()` pipeline.
 */
const shellAgent = (command: string): AgentProvider => ({
  name: "shell-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command }),
  parseStreamLine: (line) => [{ type: "result", result: line }],
});

/**
 * A command that writes the exec'd shell's pid plus two levels of descendant
 * pids into `dir` and then blocks: `shell.pid` is the `sh` child,
 * `child.pid` a nested `sh` (grandchild), `grandchild.pid` a `sleep` inside
 * it (great-grandchild).
 */
const treeCommand = (dir: string) =>
  `echo $$ > "${join(dir, "shell.pid")}"; ` +
  `sh -c 'sleep 60 & echo $! > "${join(dir, "grandchild.pid")}"; wait' & ` +
  `echo $! > "${join(dir, "child.pid")}"; ` +
  `wait`;

describe("noSandbox", () => {
  it("returns a provider with tag 'none'", () => {
    const provider = noSandbox();
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("no-sandbox");
    expect(provider.env).toEqual({});
  });

  it("merges env from options", () => {
    const provider = noSandbox({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  describe("handle", () => {
    it("exec runs a command on the host and returns output", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec('echo "hello world"');
      expect(result.stdout).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("exec returns non-zero exit code on failure", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    itPosix("exec supports onLine streaming callback", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec('echo "line1"; echo "line2"', {
        onLine: (line) => lines.push(line),
      });

      expect(lines).toEqual(["line1", "line2"]);
      expect(result.stdout).toContain("line1");
      expect(result.exitCode).toBe(0);
    });

    itPosix(
      "exec delivers raw stdout bytes via onData while the process still runs (unterminated lines included)",
      async () => {
        const provider = noSandbox();
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: {},
        });

        // printf emits no newline — a line reader holds these bytes until
        // EOF. `onData` must see them live instead (ADR 0027).
        const chunks: string[] = [];
        let firstChunkAt = 0;
        const result = await handle.exec(
          'printf "chunk-one"; sleep 0.3; printf "chunk-two"',
          {
            onData: (chunk) => {
              if (firstChunkAt === 0) firstChunkAt = Date.now();
              chunks.push(chunk);
            },
          },
        );
        const endedAt = Date.now();

        expect(chunks.join("")).toBe("chunk-onechunk-two");
        expect(result.stdout).toBe("chunk-onechunk-two");
        expect(result.exitCode).toBe(0);
        // The first bytes arrived while the process was still sleeping —
        // not in one flush at exit.
        expect(firstChunkAt).toBeGreaterThan(0);
        expect(endedAt - firstChunkAt).toBeGreaterThanOrEqual(150);
      },
    );

    itPosix("exec respects cwd option", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: "/tmp",
        env: {},
      });

      const result = await handle.exec("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe("/tmp");
    });

    it("exec ignores sudo option (no-op)", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // sudo is a no-op — the command should still run successfully
      const result = await handle.exec('echo "test"', { sudo: true });
      expect(result.stdout).toContain("test");
      expect(result.exitCode).toBe(0);
    });

    itPosix("exec passes env vars to spawned processes", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: { MY_TEST_VAR: "sandcastle_test_value" },
      });

      const result = await handle.exec("echo $MY_TEST_VAR");
      expect(result.stdout.trim()).toBe("sandcastle_test_value");
    });

    itWindows(
      "exec passes env vars to spawned processes (cmd.exe)",
      async () => {
        // Doubles as the regression test for issue #800: `%VAR%` only expands
        // when the command runs through cmd.exe — if `exec` were still spawning
        // `sh -c`, this would either fail with `spawn sh ENOENT` (no `sh` on a
        // stock Windows PATH) or echo back the literal `%MY_TEST_VAR%`.
        const provider = noSandbox();
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: { MY_TEST_VAR: "sandcastle_test_value" },
        });

        const result = await handle.exec("echo %MY_TEST_VAR%");
        expect(result.stdout.trim()).toBe("sandcastle_test_value");
      },
    );

    itPosix(
      "interactiveExec spawns process and returns exit code",
      async () => {
        const provider = noSandbox();
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: {},
        });

        const result = await handle.interactiveExec(["sh", "-c", "exit 0"], {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
        });

        expect(result.exitCode).toBe(0);
      },
    );

    itWindows(
      "interactiveExec spawns process and returns exit code",
      async () => {
        const provider = noSandbox();
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: {},
        });

        const result = await handle.interactiveExec(
          ["cmd.exe", "/d", "/s", "/c", "exit 0"],
          {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
          },
        );

        expect(result.exitCode).toBe(0);
      },
    );

    itPosix(
      "bounds streamed stdout to the configured tail without dropping live lines",
      async () => {
        const provider = noSandbox({ maxOutputTailChars: 100 });
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: {},
        });

        const lines: string[] = [];
        const result = await handle.exec(
          'for i in $(seq 1 5000); do echo "line-$i"; done',
          { onLine: (line) => lines.push(line) },
        );

        // The process survives and exits cleanly — no RangeError crash.
        expect(result.exitCode).toBe(0);
        // Every line is delivered live to onLine, regardless of the tail bound.
        expect(lines.length).toBe(5000);
        expect(lines[0]).toBe("line-1");
        expect(lines[lines.length - 1]).toBe("line-5000");
        // The returned stdout is bounded to the configured tail.
        expect(result.stdout.length).toBeLessThanOrEqual(100);
        // ...and it is the tail, so the most recent line is present.
        expect(result.stdout).toContain("line-5000");
      },
    );

    itPosix("bounds streamed stderr to the configured tail", async () => {
      const provider = noSandbox({ maxOutputTailChars: 100 });
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // onLine selects the streaming branch; stderr is accumulated there too.
      const result = await handle.exec(
        'for i in $(seq 1 5000); do echo "err-$i" >&2; done',
        { onLine: () => {} },
      );

      expect(result.exitCode).toBe(0);
      // The returned stderr is bounded to the configured tail...
      expect(result.stderr.length).toBeLessThanOrEqual(100);
      // ...and it is the tail, so the most recent output is present.
      expect(result.stderr).toContain("err-5000");
    });

    it("close resolves when nothing is running and is idempotent", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      await expect(handle.close()).resolves.toBeUndefined();
      await expect(handle.close()).resolves.toBeUndefined();
    });
  });

  /**
   * Process-tree termination. The commands under test write their own pid
   * and their descendants' pids into files inside the worktree directory so
   * the tests can verify that the whole tree — not just the direct child —
   * is gone after teardown:
   *   shell.pid      = the exec'd `sh` (direct child of the host process)
   *   child.pid      = a nested `sh` (grandchild)
   *   grandchild.pid = a `sleep` inside the nested `sh` (great-grandchild)
   */
  describe("process tree termination", () => {
    itPosix("close() kills the shell and every descendant", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-kill-"));
      try {
        const handle = await noSandbox().create({ worktreePath: dir, env: {} });
        const execPromise = handle.exec(treeCommand(dir));
        const pids = await waitForPids(
          dir,
          "shell.pid",
          "child.pid",
          "grandchild.pid",
        );
        expect(pidAlive(pids["shell.pid"]!)).toBe(true);
        expect(pidAlive(pids["child.pid"]!)).toBe(true);
        expect(pidAlive(pids["grandchild.pid"]!)).toBe(true);

        await handle.close();
        // The pending exec resolves once the tree is dead — it must not hang.
        await execPromise;
        await expectTreeDead(pids);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix(
      "aborting the exec signal terminates the whole process tree",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-abort-"));
        try {
          const handle = await noSandbox().create({
            worktreePath: dir,
            env: {},
          });
          const ac = new AbortController();
          const execPromise = handle.exec(treeCommand(dir), {
            signal: ac.signal,
          });
          const pids = await waitForPids(
            dir,
            "shell.pid",
            "child.pid",
            "grandchild.pid",
          );

          ac.abort();
          await execPromise;
          await expectTreeDead(pids);
          // close() afterwards is still safe.
          await handle.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    itPosix("escalates to SIGKILL when the tree ignores SIGTERM", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-sigkill-"));
      try {
        const handle = await noSandbox({ terminationGraceMs: 100 }).create({
          worktreePath: dir,
          env: {},
        });
        // The outer shell ignores SIGTERM and loops forever — only SIGKILL
        // can reap it. If close() never escalated, this test would fail on
        // the still-alive shell.
        const execPromise = handle.exec(
          `trap "" TERM; echo $$ > "${join(dir, "shell.pid")}"; ` +
            `while :; do sleep 60; done`,
        );
        const pids = await waitForPids(dir, "shell.pid");
        expect(pidAlive(pids["shell.pid"]!)).toBe(true);

        await handle.close();
        await execPromise;
        await expectTreeDead(pids);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix("close() is idempotent while a process is running", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-idem-"));
      try {
        const handle = await noSandbox().create({ worktreePath: dir, env: {} });
        const execPromise = handle.exec(treeCommand(dir));
        const pids = await waitForPids(
          dir,
          "shell.pid",
          "child.pid",
          "grandchild.pid",
        );

        // Concurrent and repeated calls must all resolve without throwing.
        await Promise.all([handle.close(), handle.close()]);
        await handle.close();
        await execPromise;
        await expectTreeDead(pids);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix(
      "close() after a successful exec does not signal unrelated processes",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-success-"));
        const unrelated = spawn("sleep", ["60"], {
          detached: true,
          stdio: "ignore",
        });
        try {
          const handle = await noSandbox().create({
            worktreePath: dir,
            env: {},
          });
          const result = await handle.exec("echo done");
          expect(result.exitCode).toBe(0);

          await handle.close();
          // The finished exec is no longer tracked, so teardown must not
          // touch this process — it shares nothing with the handle.
          expect(pidAlive(unrelated.pid!)).toBe(true);
        } finally {
          try {
            process.kill(-unrelated.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    itPosix("close() kills a running interactiveExec process", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-interactive-"));
      try {
        const handle = await noSandbox({ terminationGraceMs: 100 }).create({
          worktreePath: dir,
          env: {},
        });
        const resultPromise = handle.interactiveExec(
          ["sh", "-c", `echo $$ > "${join(dir, "shell.pid")}"; sleep 60`],
          {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
          },
        );
        const pids = await waitForPids(dir, "shell.pid");
        expect(pidAlive(pids["shell.pid"]!)).toBe(true);

        await handle.close();
        await resultPromise;
        await expectTreeDead(pids);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix("exec on a closed handle rejects instead of leaking", async () => {
      const handle = await noSandbox().create({
        worktreePath: process.cwd(),
        env: {},
      });
      await handle.close();
      await expect(handle.exec("sleep 60")).rejects.toThrow(/closed/);
    });

    itWindows(
      "close() terminates a running exec tree via taskkill",
      async () => {
        const handle = await noSandbox().create({
          worktreePath: process.cwd(),
          env: {},
        });
        const execPromise = handle.exec("ping -n 60 127.0.0.1 > NUL");
        // Give cmd.exe a moment to spawn the ping child.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await handle.close();
        await expect(execPromise).resolves.toBeDefined();
      },
    );
  });

  /**
   * Invocation outcome truthfulness: stream errors, signal termination, and
   * mid-teardown states must all surface as honest results — never a crash
   * or a disguised success.
   */
  describe("invocation outcomes", () => {
    itPosix(
      "early child exit during stdin write resolves as a non-zero failure, not a crash",
      async () => {
        const handle = await noSandbox().create({
          worktreePath: process.cwd(),
          env: {},
        });
        // The child closes its stdin and exits immediately, so the prompt
        // write fails with EPIPE. That must surface as an invocation
        // failure — never an unhandled stream error.
        const result = await handle.exec("exec 0<&-; exit 0", {
          stdin: "x".repeat(1 << 20),
          onLine: () => {},
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("stdin write failed");
      },
    );

    itPosix(
      "early child exit during stdin write fails the non-streaming exec too",
      async () => {
        const handle = await noSandbox().create({
          worktreePath: process.cwd(),
          env: {},
        });
        const result = await handle.exec("exec 0<&-; exit 0", {
          stdin: "x".repeat(1 << 20),
        });
        expect(result.exitCode).not.toBe(0);
      },
    );

    itWindows(
      "early child exit during stdin write does not crash",
      async () => {
        const handle = await noSandbox().create({
          worktreePath: process.cwd(),
          env: {},
        });
        // cmd.exe exits while a large prompt is still being written; the
        // exec must resolve — never an unhandled EPIPE.
        await expect(
          handle.exec("exit 0", { stdin: "x".repeat(1 << 20) }),
        ).resolves.toBeDefined();
      },
    );

    itPosix("signal termination reports a non-zero exit code", async () => {
      const handle = await noSandbox().create({
        worktreePath: process.cwd(),
        env: {},
      });

      const termResult = await handle.exec("kill -TERM $$");
      expect(termResult.exitCode).toBe(143);
      const killResult = await handle.exec("kill -KILL $$");
      expect(killResult.exitCode).toBe(137);
    });

    itPosix(
      "abort escalates to SIGKILL when the tree ignores SIGTERM",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-abort-kill-"));
        try {
          const handle = await noSandbox({ terminationGraceMs: 100 }).create({
            worktreePath: dir,
            env: {},
          });
          const ac = new AbortController();
          // TERM is ignored — only the escalated SIGKILL can reap it.
          const execPromise = handle.exec(
            `trap "" TERM; echo $$ > "${join(dir, "shell.pid")}"; sleep 60`,
            { signal: ac.signal },
          );
          const pids = await waitForPids(dir, "shell.pid");
          expect(pidAlive(pids["shell.pid"]!)).toBe(true);

          ac.abort();
          const result = await execPromise;
          // Killed by SIGKILL — mapped to 137, never reported as success.
          expect(result.exitCode).toBe(137);
          await expectTreeDead(pids);
          await handle.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  });

  /**
   * End-to-end wiring: run()'s cancellation and timeout paths must reach the
   * no-sandbox handle's termination — nothing may be left running on the host.
   */
  describe("run() cancellation and timeouts", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
      consoleSpy.mockRestore();
    });

    itPosix("idle timeout terminates the host process tree", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-idle-"));
      await initRepo(dir);
      try {
        const runPromise = run({
          agent: shellAgent(
            `echo $$ > "${join(dir, "shell.pid")}"; ` +
              `sleep 60 & echo $! > "${join(dir, "child.pid")}"; wait`,
          ),
          sandbox: noSandbox({ terminationGraceMs: 100 }),
          prompt: "work",
          cwd: dir,
          idleTimeoutSeconds: 0.3,
          logging: { type: "file", path: join(dir, "run.log") },
        });
        const pids = await waitForPids(dir, "shell.pid", "child.pid");
        // run() surfaces Effect failures as FiberFailure — the embedded cause
        // message still names the idle timeout.
        await expect(runPromise).rejects.toThrowError(/idle/i);
        await expectTreeDead(pids);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix(
      "completion timeout terminates the hanging host process tree",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-completion-"));
        await initRepo(dir);
        try {
          const result = await run({
            agent: shellAgent(
              `echo "<promise>COMPLETE</promise>"; ` +
                `echo $$ > "${join(dir, "shell.pid")}"; ` +
                `sleep 60 & echo $! > "${join(dir, "child.pid")}"; wait`,
            ),
            sandbox: noSandbox({ terminationGraceMs: 100 }),
            prompt: "work",
            cwd: dir,
            idleTimeoutSeconds: 30,
            completionTimeoutSeconds: 0.2,
            logging: { type: "file", path: join(dir, "run.log") },
          });
          // The run force-completes successfully while the process is still
          // alive; teardown in the release phase must have reaped the tree.
          expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
          const pids = await waitForPids(dir, "shell.pid", "child.pid");
          await expectTreeDead(pids);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    itPosix(
      "abort terminates the host process tree before rejecting",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-abort-"));
        await initRepo(dir);
        try {
          const ac = new AbortController();
          const runPromise = run({
            agent: shellAgent(treeCommand(dir)),
            sandbox: noSandbox({ terminationGraceMs: 100 }),
            prompt: "work",
            cwd: dir,
            signal: ac.signal,
            idleTimeoutSeconds: 30,
            logging: { type: "file", path: join(dir, "run.log") },
          });
          const pids = await waitForPids(
            dir,
            "shell.pid",
            "child.pid",
            "grandchild.pid",
          );
          ac.abort();
          await expect(runPromise).rejects.toThrow(/abort/i);
          await expectTreeDead(pids);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    itPosix("a successful run leaves no host processes behind", async () => {
      const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-ok-"));
      await initRepo(dir);
      try {
        const result = await run({
          agent: shellAgent(`echo "<promise>COMPLETE</promise>"`),
          sandbox: noSandbox(),
          prompt: "work",
          cwd: dir,
          idleTimeoutSeconds: 30,
          logging: { type: "file", path: join(dir, "run.log") },
        });
        expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itPosix(
      "completion timeout kills a descendant that inherited the stdout pipe",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-pipes-"));
        await initRepo(dir);
        try {
          const result = await run({
            // The leader emits the signal and exits; the backgrounded sleep
            // holds the inherited stdout pipe open so "close" never fires —
            // the classic ADR 0019 hang. The completion timeout must abort
            // the exec and reap the whole tree before the run returns.
            agent: shellAgent(
              `echo "<promise>COMPLETE</promise>"; ` +
                `sleep 60 & echo $! > "${join(dir, "sleeper.pid")}"; ` +
                `exit 0`,
            ),
            sandbox: noSandbox({ terminationGraceMs: 100 }),
            prompt: "work",
            cwd: dir,
            idleTimeoutSeconds: 30,
            completionTimeoutSeconds: 0.2,
            logging: { type: "file", path: join(dir, "run.log") },
          });
          expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
          const pids = await waitForPids(dir, "sleeper.pid");
          await expectTreeDead(pids);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    itPosix(
      "trailing output keeps resetting the completion silence window (ADR 0019)",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "no-sandbox-run-trail-"));
        await initRepo(dir);
        try {
          const result = await run({
            // Output lands every ~0.2s — each line inside the 0.4s silence
            // window resets it, so the run exits naturally with everything
            // captured instead of force-completing mid-stream.
            agent: shellAgent(
              `echo "<promise>COMPLETE</promise>"; ` +
                `sleep 0.2; echo "TRAIL1"; ` +
                `sleep 0.25; echo "TRAIL2"; ` +
                `sleep 0.1`,
            ),
            sandbox: noSandbox({ terminationGraceMs: 100 }),
            prompt: "work",
            cwd: dir,
            idleTimeoutSeconds: 30,
            completionTimeoutSeconds: 0.4,
            logging: { type: "file", path: join(dir, "run.log") },
          });
          expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
          // Emitted after the first silence window would have expired —
          // only present because each trailing line reset the timer.
          expect(result.stdout).toContain("TRAIL2");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  });
});

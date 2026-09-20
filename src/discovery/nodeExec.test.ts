import { describe, expect, it } from "vitest";
import { nodeDiscoveryExec, shellExitSpawnError } from "./nodeExec.js";

/**
 * Tests for the real {@link DiscoveryExec} implementation. These spawn the
 * `node` binary running the test suite (always on PATH) plus deliberately
 * missing executables — no agent CLI or subscription is ever touched.
 */

const itPosix = process.platform === "win32" ? it.skip : it;

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

describe("nodeDiscoveryExec", () => {
  it("captures stdout and a zero exit code", async () => {
    const res = await nodeDiscoveryExec("node", [
      "-e",
      "console.log('hello from child')",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello from child\n");
    expect(res.spawnError).toBeUndefined();
    expect(res.timedOut).not.toBe(true);
  });

  it("captures stderr and non-zero exits as data, not rejections", async () => {
    const res = await nodeDiscoveryExec("node", [
      "-e",
      "console.error('oops'); process.exit(3)",
    ]);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("oops");
  });

  it("reports a missing executable via spawnError, never by throwing", async () => {
    const res = await nodeDiscoveryExec(
      "definitely-not-a-real-command-sandcastle-test",
      ["--version"],
    );
    expect(res.spawnError).toBe("ENOENT");
    expect(res.exitCode).toBeNull();
  });

  it("pipes options.stdin and closes it so probes cannot block", async () => {
    const res = await nodeDiscoveryExec(
      "node",
      [
        "-e",
        "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{console.log(s.trim().toUpperCase());})",
      ],
      { stdin: "hello\n" },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("HELLO\n");
  });

  it("kills a hung process at timeoutMs and marks timedOut", async () => {
    const res = await nodeDiscoveryExec(
      "node",
      ["-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 200 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  itPosix(
    "settles once at the deadline when a descendant keeps the stdio pipes, and kills the whole tree",
    async () => {
      // The probed child spawns a same-group descendant that inherits the
      // stdio pipes and ignores SIGTERM, reports the descendant's pid on
      // stdout, then exits. `close` can never fire while the descendant
      // lives — the classic wedge — so settlement must come from the
      // deadline, and the deadline must reap the descendant too.
      const timeoutMs = 300;
      const started = Date.now();
      const res = await nodeDiscoveryExec(
        "node",
        [
          "-e",
          `const c = require("node:child_process").spawn(
            process.execPath,
            ["-e", 'process.on("SIGTERM",()=>{});setTimeout(()=>{},6e4)'],
            { stdio: "inherit" },
          );
          console.log("DESCENDANT_PID=" + c.pid);
          c.unref();`,
        ],
        { timeoutMs },
      );
      const elapsed = Date.now() - started;

      // Bounded settlement: timeout + SIGKILL grace + scheduling slack —
      // never the descendant's 60s lifetime.
      expect(elapsed).toBeLessThan(timeoutMs + 3_000);
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBeNull();
      expect(res.spawnError).toBeUndefined();

      const descendantPid = Number(
        res.stdout.match(/DESCENDANT_PID=(\d+)/)?.[1],
      );
      expect(descendantPid).toBeGreaterThan(0);
      // Full teardown — no surviving member of the probe's process tree.
      expect(await waitFor(() => !pidAlive(descendantPid))).toBe(true);
    },
  );
});

describe("shellExitSpawnError", () => {
  const cmdNotRecognized =
    "'nonexistent_xyz' is not recognized as an internal or external command,\r\n" +
    "operable program or batch file.\r\n";

  it("maps cmd.exe's 'not recognized' exit-1 to ENOENT on win32", () => {
    expect(shellExitSpawnError("win32", 1, cmdNotRecognized)).toBe("ENOENT");
  });

  it("matches the message case-insensitively and on any non-zero exit", () => {
    expect(
      shellExitSpawnError(
        "win32",
        9009,
        "'agy' IS NOT RECOGNIZED as an internal or external command",
      ),
    ).toBe("ENOENT");
  });

  it("leaves other platforms alone — spawn reports ENOENT itself there", () => {
    expect(shellExitSpawnError("linux", 1, cmdNotRecognized)).toBeUndefined();
    expect(shellExitSpawnError("darwin", 1, cmdNotRecognized)).toBeUndefined();
  });

  it("does not mangle clean exits, signal kills, or ordinary CLI errors", () => {
    expect(shellExitSpawnError("win32", 0, cmdNotRecognized)).toBeUndefined();
    expect(
      shellExitSpawnError("win32", null, cmdNotRecognized),
    ).toBeUndefined();
    expect(
      shellExitSpawnError("win32", 2, "error: unknown option --foo"),
    ).toBeUndefined();
    expect(shellExitSpawnError("win32", 1, "")).toBeUndefined();
  });
});

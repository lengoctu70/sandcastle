import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRetryLock,
  listRecoveryStates,
  readRecoveryState,
  recoveryStatePath,
  retryLockPath,
  RetryLockHeldError,
  writeRecoveryState,
  RECOVERY_STATE_VERSION,
  type RecoveryState,
} from "./recovery.js";

const makeDir = () => mkdtemp(join(tmpdir(), "recovery-"));

const repoRoot = join(import.meta.dirname, "..");
const recoveryModule = join(repoRoot, "src", "recovery.ts");

const makeState = (issueNumber: number): RecoveryState => ({
  version: RECOVERY_STATE_VERSION,
  issue: {
    number: issueNumber,
    title: "Some issue",
    body: "",
    state: "OPEN",
    labels: [],
  },
  sourceBranch: `sandcastle/issue-${issueNumber}`,
  targetBranch: "main",
  failurePhase: "verification",
  error: "boom",
  verification: [],
  commits: [{ sha: "deadbeef" }],
  attempts: {
    implementation: 1,
    verificationRepair: 0,
    mergeConflictRepair: 0,
    integrationRebuild: 0,
  },
  retryCount: 0,
  failedAt: new Date().toISOString(),
});

const exists = async (path: string): Promise<boolean> =>
  readFile(path)
    .then(() => true)
    .catch(() => false);

// ---------------------------------------------------------------------------
// Durable writes (F064)
// ---------------------------------------------------------------------------

describe("writeRecoveryState durability", () => {
  it("round-trips a record that lists and reads back intact", async () => {
    const dir = await makeDir();
    await writeRecoveryState(dir, makeState(5));

    const read = await readRecoveryState(dir, 5);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.state.issue.number).toBe(5);
      expect(read.state.sourceBranch).toBe("sandcastle/issue-5");
    }
    const listed = await listRecoveryStates(dir);
    expect(listed.length).toBe(1);
    // No temp files survive a successful write.
    const names = await readdir(join(dir, ".sandcastle", "recovery"));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("readers never observe a truncated record while a writer replaces it", async () => {
    const dir = await makeDir();
    const state = makeState(3);
    await writeRecoveryState(dir, state);
    // A large payload widens the window where an in-place write would be
    // observed mid-truncation — atomic rename makes it impossible.
    const pad = "y".repeat(128 * 1024);
    let done = false;

    const writer = (async () => {
      for (let i = 1; i <= 40; i++) {
        await writeRecoveryState(dir, {
          ...state,
          error: `boom ${i} ${pad}`,
          retryCount: i,
        });
      }
      done = true;
    })();
    const reader = (async () => {
      let reads = 0;
      while (!done) {
        const res = await readRecoveryState(dir, 3);
        // Missing would mean the rename dropped the file; corrupt would mean
        // a truncated document was observed. Neither may ever happen.
        expect(res.kind).toBe("ok");
        if (res.kind === "ok") {
          expect(res.state.issue.number).toBe(3);
        }
        // The raw bytes are always complete JSON too.
        JSON.parse(await readFile(recoveryStatePath(dir, 3), "utf-8"));
        reads++;
      }
      expect(reads).toBeGreaterThan(0);
    })();

    await Promise.all([writer, reader]);
    const final = await readRecoveryState(dir, 3);
    expect(final).toMatchObject({ kind: "ok", state: { retryCount: 40 } });
  });

  it("a failed write preserves the prior record and reports an actionable error", async () => {
    const dir = await makeDir();
    const state = makeState(7);
    await writeRecoveryState(dir, state);
    const before = await readFile(recoveryStatePath(dir, 7), "utf-8");

    const recDir = join(dir, ".sandcastle", "recovery");
    await chmod(recDir, 0o555);
    // Probe — as root (or on a filesystem without POSIX perms) the dir stays
    // writable and the fault cannot be injected; stand down instead of
    // asserting nothing.
    const writable = await writeFile(join(recDir, ".probe"), "x").then(
      () => true,
      () => false,
    );
    try {
      if (writable) return;

      const err = await writeRecoveryState(dir, {
        ...state,
        error: "new boom",
      }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      // The diagnostic names the durable record path — not the temp file —
      // and states the prior record was preserved.
      expect(err!.message).toContain(recoveryStatePath(dir, 7));
      expect(err!.message).toContain("được giữ nguyên");

      expect(await readFile(recoveryStatePath(dir, 7), "utf-8")).toBe(before);
      const names = await readdir(recDir);
      expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    } finally {
      await chmod(recDir, 0o755).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Per-issue retry exclusion (F065)
// ---------------------------------------------------------------------------

describe("acquireRetryLock", () => {
  it("rejects a second acquisition while held and frees the issue on release", async () => {
    const dir = await makeDir();
    const lock = await acquireRetryLock(dir, 5);
    expect(lock.path).toBe(retryLockPath(dir, 5));
    expect(await exists(lock.path)).toBe(true);
    // The holder's pid is recorded for diagnostics.
    expect(await readFile(lock.path, "utf-8")).toContain(
      `"pid":${process.pid}`,
    );

    // Even in-process, the exclusion holds — the recorded pid is alive.
    const err = await acquireRetryLock(dir, 5).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryLockHeldError);
    expect((err as RetryLockHeldError).lockPath).toBe(lock.path);
    expect((err as Error).message).toContain("issue-5.lock");
    expect((err as Error).message).toContain(String(process.pid));

    await lock.release();
    expect(await exists(lock.path)).toBe(false);

    const again = await acquireRetryLock(dir, 5);
    await again.release();
  });

  it("keeps lock files out of the recovery record listing", async () => {
    const dir = await makeDir();
    await writeRecoveryState(dir, makeState(5));
    const lock = await acquireRetryLock(dir, 5);

    const listed = await listRecoveryStates(dir);
    // Only the .json record is listed — the .lock file is not a record and
    // must never surface as a corrupt entry.
    expect(listed.length).toBe(1);
    expect(listed[0]!.kind).toBe("ok");

    await lock.release();
  });

  it("a lock whose recorded process is dead is broken as stale", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle", "recovery"), { recursive: true });
    // A pid that has already exited: spawn a trivial child and wait for it.
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", ""]);
      child.on("exit", () => resolve(child.pid!));
      child.on("error", reject);
    });
    await writeFile(
      retryLockPath(dir, 5),
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
    );

    const lock = await acquireRetryLock(dir, 5);
    expect(await readFile(lock.path, "utf-8")).toContain(
      `"pid":${process.pid}`,
    );
    await lock.release();
  });

  it("an unattributable lock file refuses without deleting it", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle", "recovery"), { recursive: true });
    const lockPath = retryLockPath(dir, 5);
    await writeFile(lockPath, "garbage — not a lock payload");

    const err = await acquireRetryLock(dir, 5).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryLockHeldError);
    expect((err as Error).message).toContain(lockPath);
    // Never silently deleted — the user is told which file to remove.
    expect(await exists(lockPath)).toBe(true);
  });

  it("different issues do not contend", async () => {
    const dir = await makeDir();
    const a = await acquireRetryLock(dir, 5);
    const b = await acquireRetryLock(dir, 7);
    await a.release();
    await b.release();
  });

  it("release never removes a newer holder's lock", async () => {
    const dir = await makeDir();
    const stale = await acquireRetryLock(dir, 5);
    // Simulate the file being broken and re-acquired by someone else while
    // the original holder still believes it owns the lock.
    await writeFile(
      retryLockPath(dir, 5),
      JSON.stringify({ pid: process.pid + 999_000, startedAt: "elsewhere" }),
      { flag: "w" },
    );

    await stale.release();
    // The replacement content is still there — release did not delete it.
    expect(await readFile(retryLockPath(dir, 5), "utf-8")).toContain(
      "elsewhere",
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-process exclusion — a second real process must be rejected (F065)
// ---------------------------------------------------------------------------

/**
 * Helper process driving the real acquireRetryLock through tsx.
 * Prints "ACQUIRED" then either exits (mode "once", leaving a stale lock) or
 * holds until killed (mode "hold"). Prints "HELD" on RetryLockHeldError.
 */
const HELPER_SOURCE = `import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.RECOVERY_MODULE).href);
const [mode, cwd, issue] = process.argv.slice(2);
try {
  await mod.acquireRetryLock(cwd, Number(issue));
  console.log("ACQUIRED");
  if (mode === "hold") setTimeout(() => {}, 60000);
} catch (e) {
  console.log(e && e.name === "RetryLockHeldError" ? "HELD" : "ERR:" + (e && e.message));
}
`;

const runHelper = (
  helperPath: string,
  mode: "once" | "hold",
  cwd: string,
  issue: number,
) =>
  spawn(
    process.execPath,
    ["--import", "tsx", helperPath, mode, cwd, String(issue)],
    {
      cwd: repoRoot,
      env: { ...process.env, RECOVERY_MODULE: recoveryModule },
    },
  );

const childOutput = (child: ReturnType<typeof spawn>) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("exit", () => resolve(out));
    child.on("error", reject);
  });

const waitForLine = (
  child: ReturnType<typeof spawn>,
  marker: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onData = (d: unknown) => {
      if (String(d).includes(marker)) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`helper exited before ${marker}`)));
  });

describe("acquireRetryLock across processes", () => {
  it("a retry held by a live external process is rejected; once it dies the lock is broken", async () => {
    const dir = await makeDir();
    const helperPath = join(dir, "lock-helper.mjs");
    await writeFile(helperPath, HELPER_SOURCE);

    const holder = runHelper(helperPath, "hold", dir, 5);
    try {
      await waitForLine(holder, "ACQUIRED");

      // While the external process holds the lock, this process must refuse.
      const err = await acquireRetryLock(dir, 5).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RetryLockHeldError);
      expect((err as Error).message).toContain(String(holder.pid));
    } finally {
      holder.kill("SIGKILL");
    }
    await new Promise((r) => holder.on("exit", r));

    // The crashed holder left a stale lock — the next acquisition breaks it.
    const lock = await acquireRetryLock(dir, 5);
    await lock.release();
  });

  it("only one of two contending external processes acquires the lock", async () => {
    const dir = await makeDir();
    const helperPath = join(dir, "lock-helper.mjs");
    await writeFile(helperPath, HELPER_SOURCE);

    const first = runHelper(helperPath, "hold", dir, 9);
    try {
      await waitForLine(first, "ACQUIRED");
      const second = runHelper(helperPath, "once", dir, 9);
      expect(await childOutput(second)).toContain("HELD");
    } finally {
      first.kill("SIGKILL");
      await new Promise((r) => first.on("exit", r));
    }
  });
});

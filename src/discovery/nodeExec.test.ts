import { describe, expect, it } from "vitest";
import { nodeDiscoveryExec } from "./nodeExec.js";

/**
 * Tests for the real {@link DiscoveryExec} implementation. These spawn the
 * `node` binary running the test suite (always on PATH) plus deliberately
 * missing executables — no agent CLI or subscription is ever touched.
 */

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
});

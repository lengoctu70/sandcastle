import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GithubIssue } from "./githubIssues.js";
import {
  buildCompletionReport,
  buildFailureReport,
  buildImplementationPrompt,
  runVerificationCommands,
} from "./WorkflowRun.js";

const issue: GithubIssue = {
  number: 42,
  title: "Add a greeting command",
  body: "The CLI should greet the user.",
  state: "OPEN",
  labels: ["Sandcastle"],
};

describe("buildImplementationPrompt", () => {
  const prompt = buildImplementationPrompt({
    issue,
    sourceBranch: "sandcastle/issue-42",
    targetBranch: "main",
    verificationCommands: ["npm test"],
  });

  it("embeds the immutable issue identity and branches", () => {
    expect(prompt).toContain("issue #42");
    expect(prompt).toContain("Add a greeting command");
    expect(prompt).toContain("The CLI should greet the user.");
    expect(prompt).toContain("sandcastle/issue-42");
    expect(prompt).toContain("`main`");
  });

  it("keeps issue closure out of the agent's reach (ADR 0023)", () => {
    // The prompt forbids issue mutations rather than carrying the legacy
    // agent-closes-issue contract ({{CLOSE_TASK_COMMAND}} etc.).
    expect(prompt).toContain("Do NOT run `gh issue close`");
    expect(prompt).not.toContain("CLOSE_TASK_COMMAND");
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("!`");
  });

  it("lists the configured verification commands and the completion signal", () => {
    expect(prompt).toContain("`npm test`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("omits the verification block when no commands are configured", () => {
    const bare = buildImplementationPrompt({
      issue,
      sourceBranch: "sandcastle/issue-42",
      targetBranch: "main",
      verificationCommands: [],
    });
    expect(bare).not.toContain("## Verification");
  });
});

describe("buildCompletionReport", () => {
  it("summarizes outcome, changes, verification, and cautions in Vietnamese", () => {
    const report = buildCompletionReport({
      issue,
      sourceBranch: "sandcastle/issue-42",
      targetBranch: "main",
      landedSha: "abcdef1234567890",
      landedCommits: ["abc1234 implement greeting"],
      changeStat: " src/cli.ts | 2 +-\n 1 file changed",
      verification: [
        {
          command: "npm test",
          status: "passed",
          exitCode: 0,
          durationMs: 100,
          outputTail: "",
        },
      ],
      integrationVerification: [
        {
          command: "npm test",
          status: "passed",
          exitCode: 0,
          durationMs: 90,
          outputTail: "",
        },
      ],
      verificationConfigured: true,
      cautions: [],
    });

    expect(report).toContain("## ✅ Sandcastle đã hoàn thành");
    expect(report).toContain("#42");
    expect(report).toContain("`main`");
    expect(report).toContain("abcdef12");
    expect(report).toContain("abc1234 implement greeting");
    expect(report).toContain("1 file changed");
    expect(report).toContain("`npm test` — đã pass");
    expect(report).toContain("Không có.");
  });

  it("is honest when no verification is configured", () => {
    const report = buildCompletionReport({
      issue,
      sourceBranch: "sandcastle/issue-42",
      targetBranch: "main",
      landedSha: "abcdef1234567890",
      landedCommits: ["abc1234 work"],
      verification: [],
      verificationConfigured: false,
      cautions: [
        "Không có lệnh xác minh nào được cấu hình — kết quả chưa được kiểm tra tự động.",
      ],
    });
    expect(report).toContain("không có lệnh xác minh nào được cấu hình");
    expect(report).toContain(
      "Không có lệnh xác minh nào được cấu hình — kết quả chưa được kiểm tra tự động.",
    );
  });
});

describe("buildFailureReport", () => {
  it("reports the failed phase, keeps the issue open, names preserved state", () => {
    const report = buildFailureReport({
      issue,
      phase: "verification",
      error: "Lệnh xác minh thất bại: `npm test` (exit 1)",
      verification: [
        {
          command: "npm test",
          status: "failed",
          exitCode: 1,
          durationMs: 50,
          outputTail: "boom",
        },
      ],
      verificationConfigured: true,
      sourceBranch: "sandcastle/issue-42",
      worktreePath: "/tmp/repo/.sandcastle/worktrees/sandcastle-issue-42",
    });

    expect(report).toContain("## ⚠️ Sandcastle không hoàn thành");
    expect(report).toContain("xác minh trên nhánh làm việc");
    expect(report).toContain("npm test");
    expect(report).toContain("vẫn mở");
    expect(report).toContain("sandcastle/issue-42");
    expect(report).toContain(".sandcastle/worktrees/sandcastle-issue-42");
  });
});

describe("runVerificationCommands", () => {
  // Commands stay portable (echo/exit work on both sh and cmd).
  it("runs commands in order and records pass/fail per command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-"));
    const results = await runVerificationCommands(["echo a", "echo b"], dir);
    expect(results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(results[0]!.exitCode).toBe(0);
  });

  it("stops at the first failure and marks the rest skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-"));
    const results = await runVerificationCommands(
      ["exit 1", "echo a", "echo b"],
      dir,
    );
    expect(results.map((r) => r.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
    expect(results[0]!.exitCode).not.toBe(0);
  });

  it("captures command output tails for the report", async () => {
    if (process.platform === "win32") return; // POSIX shell redirection only
    const dir = await mkdtemp(join(tmpdir(), "verify-"));
    const results = await runVerificationCommands(
      ["echo out && echo err 1>&2 && exit 1"],
      dir,
    );
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.outputTail).toContain("out");
    expect(results[0]!.outputTail).toContain("err");
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GithubIssue } from "./githubIssues.js";
import {
  buildCompletionReport,
  buildFailureReport,
  buildImplementationPrompt,
  buildMergeConflictRepairPrompt,
  buildVerificationRepairPrompt,
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

describe("buildVerificationRepairPrompt", () => {
  const failure = {
    command: "npm test",
    status: "failed" as const,
    exitCode: 1,
    durationMs: 120,
    outputTail: "1 test failed: greeting.test.ts",
  };

  const base = {
    issue,
    sourceBranch: "sandcastle/issue-42",
    targetBranch: "main",
    verificationCommands: ["npm test", "npm run typecheck"],
    failure,
    attempt: 1,
    maxAttempts: 2,
  };

  it("embeds the exact failed command, exit code, and output tail", () => {
    const prompt = buildVerificationRepairPrompt({
      ...base,
      continuingSession: true,
    });
    expect(prompt).toContain("# Verification repair — attempt 1/2");
    expect(prompt).toContain("`npm test`");
    expect(prompt).toContain("npm test\n"); // the failed command, verbatim
    expect(prompt).toContain("exited with code 1");
    expect(prompt).toContain("1 test failed: greeting.test.ts");
    expect(prompt).toContain("`npm run typecheck`");
  });

  it("marks a native resume as continuing the session", () => {
    const prompt = buildVerificationRepairPrompt({
      ...base,
      continuingSession: true,
    });
    expect(prompt).toContain("Continue your current session");
    expect(prompt).not.toContain("A previous Sandcastle run");
  });

  it("re-establishes task context for a fresh invocation", () => {
    const prompt = buildVerificationRepairPrompt({
      ...base,
      continuingSession: false,
    });
    expect(prompt).toContain("A previous Sandcastle run implemented issue #42");
    expect(prompt).toContain("Add a greeting command");
    expect(prompt).toContain("The CLI should greet the user.");
  });

  it("keeps issue closure out of the agent's reach", () => {
    const prompt = buildVerificationRepairPrompt({
      ...base,
      continuingSession: false,
    });
    expect(prompt).toContain("Do NOT run `gh issue close`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });
});

describe("buildMergeConflictRepairPrompt", () => {
  const base = {
    issue,
    sourceBranch: "sandcastle/issue-42",
    targetBranch: "main",
    integrationBranch: "sandcastle/issue-42-integrate/20260101-000000-ab12",
    mergeOutput: "CONFLICT (content): Merge conflict in hello.txt",
    verificationCommands: ["npm test"],
  };

  it("describes the in-progress merge, its output, and the one-shot rules", () => {
    const prompt = buildMergeConflictRepairPrompt({
      ...base,
      continuingSession: false,
    });
    expect(prompt).toContain("# Merge conflict repair");
    expect(prompt).toContain("CONFLICT (content): Merge conflict in hello.txt");
    expect(prompt).toContain("still in progress");
    expect(prompt).toContain(
      "`sandcastle/issue-42-integrate/20260101-000000-ab12`",
    );
    expect(prompt).toContain("git merge --abort");
    expect(prompt).toContain("Do NOT run `gh issue close`");
    expect(prompt).toContain("`npm test`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("marks a native resume as continuing the session", () => {
    const prompt = buildMergeConflictRepairPrompt({
      ...base,
      continuingSession: true,
    });
    expect(prompt).toContain("Continue your current session");
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

  it("surfaces the bounded-repair counters when repairs were spent", () => {
    const report = buildFailureReport({
      issue,
      phase: "verification",
      error: "Lệnh xác minh vẫn thất bại sau 2/2 lần sửa tự động",
      verification: [],
      verificationConfigured: true,
      sourceBranch: "sandcastle/issue-42",
      attempts: {
        implementation: 1,
        verificationRepair: 2,
        mergeConflictRepair: 1,
        integrationRebuild: 1,
      },
    });
    expect(report).toContain("Tự động sửa đã thử");
    expect(report).toContain("xác minh 2/2 lần");
    expect(report).toContain("xung đột merge 1/1 lần");
    expect(report).toContain("dựng lại tích hợp 1/1 lần");
  });

  it("omits the attempts line when no repair ran", () => {
    const report = buildFailureReport({
      issue,
      phase: "implementation",
      error: "agent exploded",
      verification: [],
      verificationConfigured: false,
      attempts: {
        implementation: 1,
        verificationRepair: 0,
        mergeConflictRepair: 0,
        integrationRebuild: 0,
      },
    });
    expect(report).not.toContain("Tự động sửa đã thử");
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

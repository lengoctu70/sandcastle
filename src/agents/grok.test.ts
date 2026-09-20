import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { grok } from "./grok.js";
import {
  TOOL_ARG_DISPLAY_MAX_CHARS,
  type AgentCommandOptions,
} from "../AgentProvider.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";
import {
  encodeGrokSessionDir,
  transferGrokSessionFile,
} from "../SessionStore.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("grok factory", () => {
  it("returns a provider with name 'grok' and session storage", () => {
    const provider = grok("grok-4.6");
    expect(provider.name).toBe("grok");
    expect(provider.sessionStorage).toBeDefined();
    expect(provider.captureSessions).toBe(true);
  });

  it("buildPrintCommand uses streaming-json with the model and stdin prompt-file", () => {
    const provider = grok("grok-4.6");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("grok");
    expect(command).toContain("--output-format streaming-json");
    expect(command).toContain("--model 'grok-4.6'");
    // `-p -` is a literal prompt on Grok — stdin goes through --prompt-file.
    expect(command).toContain("--prompt-file /dev/stdin");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand adds --always-approve for unattended runs", () => {
    const provider = grok("grok-4.6");
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command).toContain("--always-approve");
  });

  it("buildPrintCommand omits --always-approve when permissions are not skipped", () => {
    const provider = grok("grok-4.6");
    const { command } = provider.buildPrintCommand({
      prompt: "x",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--always-approve");
    expect(command).not.toContain("--permission-mode");
  });

  it("permissionMode replaces --always-approve like Claude's contract", () => {
    const provider = grok("grok-4.6", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command).toContain("--permission-mode auto");
    expect(command).not.toContain("--always-approve");
  });

  it("buildPrintCommand shell-escapes model and effort", () => {
    const provider = grok("grok-4'6", { effort: "hi'gh" });
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command).toContain("--model 'grok-4'\\''6'");
    expect(command).toContain("--reasoning-effort 'hi'\\''gh'");
  });

  it("buildPrintCommand adds --resume and --fork-session", () => {
    const provider = grok("grok-4.6");
    const { command } = provider.buildPrintCommand({
      ...opts("x"),
      resumeSession: "01a0b967-2d10-77a0-8fab-9a2c0f7a8409",
    });
    expect(command).toContain(
      "--resume '01a0b967-2d10-77a0-8fab-9a2c0f7a8409'",
    );
    expect(command).not.toContain("--fork-session");

    const forked = provider.buildPrintCommand({
      ...opts("x"),
      resumeSession: "01a0b967-2d10-77a0-8fab-9a2c0f7a8409",
      forkSession: true,
    });
    expect(forked.command).toContain("--fork-session");
  });

  it("--fork-session is ignored without --resume", () => {
    const provider = grok("grok-4.6");
    const { command } = provider.buildPrintCommand({
      ...opts("x"),
      forkSession: true,
    });
    expect(command).not.toContain("--fork-session");
  });

  it("honours a custom executable (the `agent` alias of the same binary)", () => {
    const provider = grok("grok-4.6", { executable: "agent" });
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command.startsWith("agent ")).toBe(true);
    expect(provider.buildInteractiveArgs!(opts(""))[0]).toBe("agent");
  });

  // --- execPlatform: prompt delivery follows the exec shell, not the host ---

  /** Extract the quoted --prompt-file path from a win32 command. */
  const promptFileOf = (command: string): string => {
    const match = /--prompt-file "([^"]+)"/.exec(command);
    expect(match, `no quoted --prompt-file in: ${command}`).not.toBeNull();
    return match![1]!;
  };

  const cleanupPromptFile = (path: string | undefined): void => {
    if (path !== undefined && existsSync(path)) unlinkSync(path);
  };

  it("a win32 exec delivers the prompt through a real temp file, not /dev/stdin", () => {
    const provider = grok("grok-4.6", { execPlatform: "win32" });
    const prompt = "dịch tiếng Việt — multibyte ✓ and a newline\ninside";
    const { command, stdin } = provider.buildPrintCommand(opts(prompt));
    const promptPath = promptFileOf(command);
    try {
      // cmd.exe gets a real file path; /dev/stdin does not exist there.
      expect(command).not.toContain("/dev/stdin");
      expect(stdin).toBeUndefined();
      // The file carries the exact UTF-8 prompt and is deleted by the
      // command itself after Grok exits (success or failure — `&` always
      // runs `del`).
      expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
      expect(command).toContain(`& del "${promptPath}"`);
    } finally {
      cleanupPromptFile(promptPath);
    }
  });

  it("a win32 exec still uses the discovered executable alias", () => {
    const provider = grok("grok-4.6", {
      execPlatform: "win32",
      executable: "agent",
    });
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command.startsWith("agent ")).toBe(true);
    cleanupPromptFile(/--prompt-file "([^"]+)"/.exec(command)?.[1]);
  });

  it("a non-win32 execPlatform keeps the POSIX stdin device (container on Windows host)", () => {
    // Docker/Podman on a Windows host exec through sh — callers pass a
    // non-"win32" platform and get /dev/stdin + stdin delivery back.
    for (const execPlatform of ["linux", "darwin"]) {
      const provider = grok("grok-4.6", { execPlatform });
      const { command, stdin } = provider.buildPrintCommand(opts("x"));
      expect(command).toContain("--prompt-file /dev/stdin");
      expect(command).not.toContain("& del ");
      expect(stdin).toBe("x");
    }
  });

  it("buildInteractiveArgs passes model, effort, permission mode and prompt", () => {
    const provider = grok("grok-4.5", { effort: "high" });
    const args = provider.buildInteractiveArgs!(opts("fix the bug"));
    expect(args).toEqual([
      "grok",
      "--always-approve",
      "--model",
      "grok-4.5",
      "--reasoning-effort",
      "high",
      "fix the bug",
    ]);
  });

  it("env option is surfaced on the provider", () => {
    const provider = grok("grok-4.6", { env: { XAI_API_KEY: "k" } });
    expect(provider.env).toEqual({ XAI_API_KEY: "k" });
  });
});

describe("grok parseStreamLine", () => {
  it("emits text events for streaming deltas", () => {
    const provider = grok("grok-4.6");
    expect(
      provider.parseStreamLine(JSON.stringify({ type: "text", data: "Hello" })),
    ).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("emits tool_call with the mapped rawInput field", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-1",
      title: "run_terminal_command",
      kind: "execute",
      status: "pending",
      toolName: "run_terminal_command",
      rawInput: {
        command: "echo hello-world",
        description: "Run echo hello-world in terminal",
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "run_terminal_command",
        args: "echo hello-world",
      },
    ]);
  });

  it("falls back to a JSON dump for unmapped tool inputs", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "scheduler_create",
      rawInput: { cron: "* * * * *", prompt: "check" },
    });
    const [event] = provider.parseStreamLine(line);
    expect(event?.type).toBe("tool_call");
    expect(event).toMatchObject({ name: "scheduler_create" });
    if (event?.type === "tool_call") {
      expect(event.args).toContain("cron");
    }
  });

  it("bounds an oversized mapped rawInput field with a visible ellipsis", () => {
    const provider = grok("grok-4.6");
    const command = `echo ${"x".repeat(1000)}`;
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-big-1",
      toolName: "run_terminal_command",
      rawInput: { command },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "run_terminal_command",
        args: `${command.slice(0, TOOL_ARG_DISPLAY_MAX_CHARS)}…`,
      },
    ]);
  });

  it("bounds the JSON-dump fallback for unmapped tools", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-big-2",
      toolName: "scheduler_create",
      rawInput: { cron: "* * * * *", prompt: "y".repeat(1000) },
    });
    const [event] = provider.parseStreamLine(line);
    expect(event?.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(event.args.length).toBe(TOOL_ARG_DISPLAY_MAX_CHARS + 1);
      expect(event.args.endsWith("…")).toBe(true);
    }
  });

  it("uses title when toolName is absent", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-3",
      title: "Read",
      rawInput: { path: "src/main.ts" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "Read",
        args: JSON.stringify({ path: "src/main.ts" }),
      },
    ]);
  });

  it("ignores tool_call_update events (no duplicate tool calls)", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { output_for_prompt: "hello-world\n" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("maps usage events to IterationUsage", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "usage",
      messageId: "msg-1",
      stopReason: "end_turn",
      usage: {
        input_tokens: 6257,
        output_tokens: 36,
        cache_read_input_tokens: 10624,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 22,
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 6257,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 10624,
          outputTokens: 36,
        },
      },
    ]);
  });

  it("emits session_id + total usage + accumulated result on end", () => {
    const provider = grok("grok-4.6");
    provider.parseStreamLine(JSON.stringify({ type: "text", data: "All " }));
    provider.parseStreamLine(JSON.stringify({ type: "text", data: "done." }));
    const events = provider.parseStreamLine(
      JSON.stringify({
        type: "end",
        stopReason: "end_turn",
        sessionId: "01a0b967-b2cc-7233-80c2-172626ddc572",
        usage: {
          input_tokens: 17043,
          cache_read_input_tokens: 16640,
          output_tokens: 95,
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "session_id",
        sessionId: "01a0b967-b2cc-7233-80c2-172626ddc572",
      },
      {
        type: "usage",
        usage: {
          inputTokens: 17043,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 16640,
          outputTokens: 95,
        },
      },
      { type: "result", result: "All done." },
    ]);
  });

  it("result carries only the final response, not earlier turn text", () => {
    const provider = grok("grok-4.6");
    // Turn 1: preamble text, closed by a usage event (the observed boundary).
    provider.parseStreamLine(
      JSON.stringify({ type: "text", data: "I'll run it." }),
    );
    provider.parseStreamLine(
      JSON.stringify({
        type: "usage",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    provider.parseStreamLine(
      JSON.stringify({
        type: "tool_call",
        toolName: "run_terminal_command",
        rawInput: { command: "ls" },
      }),
    );
    // Turn 2: the final answer.
    provider.parseStreamLine(
      JSON.stringify({ type: "text", data: "It printed hi." }),
    );
    provider.parseStreamLine(
      JSON.stringify({
        type: "usage",
        usage: { input_tokens: 20, output_tokens: 8 },
      }),
    );
    const events = provider.parseStreamLine(
      JSON.stringify({ type: "end", stopReason: "end_turn" }),
    );
    expect(events).toEqual([{ type: "result", result: "It printed hi." }]);
  });

  it("surfaces error events as result events", () => {
    const provider = grok("grok-4.6");
    const line = JSON.stringify({
      type: "error",
      error: { message: "rate limit exceeded" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "rate limit exceeded" },
    ]);
  });

  it("skips thoughts, unknown types, non-JSON and blank lines", () => {
    const provider = grok("grok-4.6");
    expect(
      provider.parseStreamLine(
        JSON.stringify({ type: "thought", data: "thinking…" }),
      ),
    ).toEqual([]);
    expect(
      provider.parseStreamLine(
        JSON.stringify({ type: "available_commands", tools: [] }),
      ),
    ).toEqual([]);
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
    expect(provider.parseStreamLine("{broken json")).toEqual([]);
  });

  it("parses the captured real streaming-json fixture end to end", async () => {
    const fixture = await readFile(
      join(import.meta.dirname, "fixtures", "grok-streaming-json.ndjson"),
      "utf-8",
    );
    const provider = grok("grok-4.6");
    const events = fixture
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => provider.parseStreamLine(l));

    const texts = events.filter((e) => e.type === "text");
    expect(texts.length).toBeGreaterThan(0);
    expect(events).toContainEqual({
      type: "tool_call",
      name: "run_terminal_command",
      args: "echo hello-world",
    });
    expect(events).toContainEqual({
      type: "session_id",
      sessionId: "01a0b967-b2cc-7233-80c2-172626ddc572",
    });
    // The end event's total usage is the last usage event emitted.
    const usages = events.filter((e) => e.type === "usage");
    expect(usages.at(-1)).toMatchObject({
      usage: { inputTokens: 17043, outputTokens: 95 },
    });
    // The final result is the second response's text only.
    expect(events.at(-1)).toEqual({
      type: "result",
      result: "The command printed `hello-world`.",
    });
  });
});

// ---------------------------------------------------------------------------
// sessionStorage — Grok sessions are directory trees
// ---------------------------------------------------------------------------

describe("grok sessionStorage", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsBindMountHandle = (): BindMountSandboxHandle => ({
    worktreePath: "/workspace",
    exec: async (command) => {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        exec(command, (err, stdout, stderr) => {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err && typeof err.code === "number" ? err.code : 0,
          });
        });
      });
    },
    copyFileIn: async (hostPath, sandboxPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(hostPath, sandboxPath);
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(sandboxPath, hostPath);
    },
    close: async () => {},
  });

  const SESSION_ID = "01a0b967-2d10-77a0-8fab-9a2c0f7a8409";

  /** Stage a minimal Grok session dir mirroring the observed 1.0.30 layout. */
  const stageGrokSession = async (
    root: string,
    cwd: string,
    id: string,
  ): Promise<string> => {
    const dir = join(root, encodeGrokSessionDir(cwd), id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "summary.json"),
      JSON.stringify({
        info: { id, cwd },
        current_model_id: "grok-4.6",
        session_kind: "headless",
      }),
    );
    await writeFile(
      join(dir, "prompt_context.json"),
      JSON.stringify({ working_directory: cwd, version: 1 }),
    );
    await writeFile(
      join(dir, "chat_history.jsonl"),
      JSON.stringify({
        role: "user",
        content: `x\nWorkspace Path: ${cwd}\nrest`,
      }),
    );
    await writeFile(
      join(dir, "updates.jsonl"),
      JSON.stringify({ type: "user_message", text: "hi" }),
    );
    // Advisory lock — present in every real session dir, never transferred.
    await writeFile(join(dir, "updates.jsonl.lock"), "");
    return dir;
  };

  it("encodes cwd with percent-encoding matching ~/.grok/sessions layout", () => {
    expect(encodeGrokSessionDir("/Users/foo")).toBe("%2FUsers%2Ffoo");
    expect(encodeGrokSessionDir("/private/tmp")).toBe("%2Fprivate%2Ftmp");
  });

  it("rewrites cwd carriers in transferred session files", () => {
    const summary = JSON.stringify({
      info: { id: "x", cwd: "/a/b" },
      git_root_dir: "/a/b/",
    });
    const out = JSON.parse(
      transferGrokSessionFile("summary.json", summary, "/a/b", "/c/d"),
    );
    expect(out.info.cwd).toBe("/c/d");
    expect(out.git_root_dir).toBe("/c/d/");

    const ctx = JSON.stringify({ working_directory: "/a/b" });
    expect(
      JSON.parse(
        transferGrokSessionFile("prompt_context.json", ctx, "/a/b", "/c/d"),
      ).working_directory,
    ).toBe("/c/d");

    const history = JSON.stringify({
      content: "Workspace Path: /a/b\\ntail",
    });
    expect(
      transferGrokSessionFile("chat_history.jsonl", history, "/a/b", "/c/d"),
    ).toContain("Workspace Path: /c/d");

    // Other files pass through verbatim.
    const updates = JSON.stringify({ type: "x", cwd: "/a/b" });
    expect(
      transferGrokSessionFile("updates.jsonl", updates, "/a/b", "/c/d"),
    ).toBe(updates);
  });

  it("hostSessionFilePath returns the percent-encoded session dir", () => {
    const provider = grok("grok-4.6", {
      sessionStorage: { hostSessionsDir: "/tmp/sessions" },
    });
    expect(
      provider.sessionStorage!.hostSessionFilePath("/some/cwd", "abc-123"),
    ).toBe(join("/tmp/sessions", "%2Fsome%2Fcwd", "abc-123"));
  });

  it("captureToHost copies the whole session tree with cwd rewritten and skips lock files", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-grok-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-grok-sbx-"));
    try {
      await stageGrokSession(sandboxDir, "/sandbox/repo", SESSION_ID);

      const provider = grok("grok-4.6", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });
      await provider.sessionStorage!.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: SESSION_ID,
        handle: fsBindMountHandle(),
      });

      const targetDir = join(
        hostDir,
        encodeGrokSessionDir("/host/repo"),
        SESSION_ID,
      );
      const summary = JSON.parse(
        await readFile(join(targetDir, "summary.json"), "utf-8"),
      );
      expect(summary.info.cwd).toBe("/host/repo");
      const ctx = JSON.parse(
        await readFile(join(targetDir, "prompt_context.json"), "utf-8"),
      );
      expect(ctx.working_directory).toBe("/host/repo");
      const history = await readFile(
        join(targetDir, "chat_history.jsonl"),
        "utf-8",
      );
      expect(history).toContain("Workspace Path: /host/repo");
      // updates.jsonl lands verbatim.
      const updates = await readFile(join(targetDir, "updates.jsonl"), "utf-8");
      expect(updates).toBe(
        JSON.stringify({ type: "user_message", text: "hi" }),
      );

      // existsOnHost / findByIdOnHost locate the captured session by id.
      expect(
        await provider.sessionStorage!.existsOnHost("/host/repo", SESSION_ID),
      ).toBe(true);
      const found = await provider.sessionStorage!.findByIdOnHost(SESSION_ID);
      expect(found.path).toBe(targetDir);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("resumeIntoSandbox copies the host tree into the sandbox-cwd group with cwd rewritten", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-grok-res-host-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-grok-res-sbx-"),
    );
    try {
      await stageGrokSession(hostDir, "/host/repo", SESSION_ID);

      const provider = grok("grok-4.6", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });
      await provider.sessionStorage!.resumeIntoSandbox({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: SESSION_ID,
        handle: fsBindMountHandle(),
      });

      const targetDir = posix.join(
        sandboxDir,
        encodeGrokSessionDir("/sandbox/repo"),
        SESSION_ID,
      );
      const summary = JSON.parse(
        await readFile(join(targetDir, "summary.json"), "utf-8"),
      );
      expect(summary.info.cwd).toBe("/sandbox/repo");
      // Lock files are never transferred.
      await expect(
        readFile(join(targetDir, "updates.jsonl.lock"), "utf-8"),
      ).rejects.toThrow();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("existsOnHost returns false when no session with the id exists", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-grok-miss-"));
    try {
      const provider = grok("grok-4.6", {
        sessionStorage: { hostSessionsDir: hostDir },
      });
      expect(
        await provider.sessionStorage!.existsOnHost("/some/cwd", "missing"),
      ).toBe(false);
      const found = await provider.sessionStorage!.findByIdOnHost("missing");
      expect(found.path).toBeUndefined();
      expect(found.searchedRoot).toBe(hostDir);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import { antigravity } from "./antigravity.js";
import type { AgentCommandOptions } from "../AgentProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("antigravity factory", () => {
  it("returns a provider with name 'antigravity'", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    expect(provider.name).toBe("antigravity");
  });

  it("is non-resumable: captureSessions false, no sessionStorage", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    expect(provider.captureSessions).toBe(false);
    expect(provider).not.toHaveProperty("sessionStorage");
  });

  it("buildPrintCommand drives headless stream-json mode via stdin, not -p argv", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    // agy rejects `--print` combined with `--input-format stream-json` — the
    // input format alone selects headless mode, and the prompt travels on
    // stdin so it never hits argv size limits.
    expect(command).toBe(
      "agy --input-format stream-json --output-format stream-json --model 'gemini-3.8-flash-high' --dangerously-skip-permissions",
    );
    expect(command).not.toContain("--print");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe(
      JSON.stringify({
        event: "user",
        message: { content: "do something" },
      }) + "\n",
    );
  });

  it("buildPrintCommand JSON-escapes arbitrary prompt content into stdin", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    const prompt = 'fix "quotes" and\nnewlines & symbols';
    const { stdin } = provider.buildPrintCommand(opts(prompt));
    expect(JSON.parse(stdin!)).toEqual({
      event: "user",
      message: { content: prompt },
    });
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    const { command } = provider.buildPrintCommand({
      prompt: "hi",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = antigravity("gemini-3.8-flash-high", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort 'high'");
  });

  it("buildPrintCommand shell-escapes model and effort", () => {
    const provider = antigravity("m'o", { effort: "h'i" });
    const { command } = provider.buildPrintCommand(opts("x"));
    expect(command).toContain("--model 'm'\\''o'");
    expect(command).toContain("--effort 'h'\\''i'");
  });

  it("buildInteractiveArgs seeds the TUI with --prompt-interactive", () => {
    const provider = antigravity("gemini-3.8-flash-high", { effort: "high" });
    const args = provider.buildInteractiveArgs!(opts("hello"));
    expect(args).toEqual([
      "agy",
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "high",
      "--prompt-interactive",
      "hello",
    ]);
  });

  it("buildInteractiveArgs omits the prompt flag when empty", () => {
    const provider = antigravity("gemini-3.8-flash-high");
    const args = provider.buildInteractiveArgs!(opts(""));
    expect(args).toEqual(["agy", "--model", "gemini-3.8-flash-high"]);
  });
});

describe("parseStreamLine", () => {
  const provider = antigravity("gemini-3.8-flash-high");

  it("extracts session_id from the init event", () => {
    const line = JSON.stringify({
      event: "init",
      conversation_id: "c803a17b-28b6-4d62-8d2f-7dc005ccdecf",
      init: { cwd: "/tmp", tools: ["run_command"], permission_mode: "always-proceed" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "c803a17b-28b6-4d62-8d2f-7dc005ccdecf" },
    ]);
  });

  it("ignores an init event with an empty conversation_id", () => {
    const line = JSON.stringify({ event: "init", conversation_id: "", init: {} });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("extracts text from agent_response step_update deltas", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "abc",
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello",
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello" },
    ]);
  });

  it("extracts text from the DONE agent_response frame too", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "abc",
        step_index: 3,
        state: "DONE",
        step_type: "agent_response",
        text_delta: " world\n",
        duration_seconds: 1.2,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: " world\n" },
    ]);
  });

  it("extracts a tool_call from a DONE tool step (run_command → CommandLine)", () => {
    // Real shape from the official headless docs.
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3",
        step_index: 4,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        duration_seconds: 0.07,
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "echo hello_headless_demo" },
          output: "hello_headless_demo\r\n",
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "run_command",
        args: "echo hello_headless_demo",
      },
    ]);
  });

  it("falls back to tool_name and a JSON args dump for unmapped tools", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        state: "DONE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { Path: "/a/b" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "write_to_file", args: '{"Path":"/a/b"}' },
    ]);
  });

  it("skips ACTIVE tool frames (no duplicate tool_call per step)", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 4,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("skips user_input/checkpoint and unknown step types", () => {
    for (const stepType of ["user_input", "checkpoint", "plan", "unknown_thing"]) {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { step_index: 0, state: "DONE", step_type: stepType },
      });
      expect(provider.parseStreamLine(line)).toEqual([]);
    }
  });

  it("extracts result + session_id + usage from a SUCCESS result event", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f",
        status: "SUCCESS",
        response: "apple\n",
        duration_seconds: 1.4,
        num_turns: 1,
        usage: {
          input_tokens: 30384,
          output_tokens: 4,
          thinking_tokens: 2,
          cache_read_tokens: 0,
          total_tokens: 30388,
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f" },
      { type: "result", result: "apple\n" },
      {
        type: "usage",
        usage: {
          inputTokens: 30384,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 6, // output + thinking
        },
      },
    ]);
  });

  it("extracts the error message from an ERROR result event", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: 'invalid model selection: model "nope" is not recognized',
        duration_seconds: 0,
        num_turns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: 'invalid model selection: model "nope" is not recognized',
      },
      {
        type: "usage",
        usage: {
          inputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
        },
      },
    ]);
  });

  it("parses AGY_ERROR lines into result events", () => {
    const line = 'AGY_ERROR: {"error": "quota exhausted", "code": 8}';
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "quota exhausted" },
    ]);
  });

  it("skips command_result and unknown events", () => {
    const line = JSON.stringify({
      event: "command_result",
      command: { name: "help", data: { commands: [] } },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
    expect(
      provider.parseStreamLine(JSON.stringify({ event: "future_thing", x: 1 })),
    ).toEqual([]);
  });

  it("returns empty array for non-JSON lines", () => {
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
    expect(provider.parseStreamLine("Fetching available models...")).toEqual([]);
    expect(provider.parseStreamLine("{malformed")).toEqual([]);
  });
});

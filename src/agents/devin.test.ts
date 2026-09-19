import { describe, expect, it } from "vitest";
import { devin } from "./devin.js";
import type { AgentCommandOptions } from "../AgentProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors the Orchestrator's AFK call). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("devin factory", () => {
  it("returns a provider with name 'devin'", () => {
    expect(devin("claude-opus-5").name).toBe("devin");
  });

  it("does not claim session support (SQLite store is not transferable)", () => {
    const provider = devin("claude-opus-5");
    expect(provider.captureSessions).toBe(false);
    expect(provider.sessionStorage).toBeUndefined();
  });

  it("buildPrintCommand runs print mode with the prompt as a positional arg", () => {
    const { command, stdin } = devin("claude-opus-5").buildPrintCommand(
      opts("fix the bug"),
    );
    expect(command).toContain("devin -p 'fix the bug'");
    expect(stdin).toBeUndefined();
  });

  it("buildPrintCommand selects the family model unchanged", () => {
    const { command } = devin("claude-opus-5").buildPrintCommand(
      opts("do something"),
    );
    expect(command).toContain("--model 'claude-opus-5'");
  });

  it("buildPrintCommand passes the chosen variant model_uid through unchanged", () => {
    // Thinking levels are model variants in Devin's catalog — the exact
    // model_uid must reach --model byte-for-byte, with no --effort flag.
    const { command } = devin("claude-opus-5", {
      variant: "claude-opus-5-xhigh",
    }).buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-5-xhigh'");
    expect(command).not.toContain("claude-opus-5'");
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand passes enum-style variant uids through unchanged", () => {
    const { command } = devin("gpt-5.2", {
      variant: "MODEL_GPT_5_2_XHIGH",
    }).buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'MODEL_GPT_5_2_XHIGH'");
  });

  it("buildPrintCommand uses --permission-mode dangerous for unattended runs", () => {
    const { command } = devin("claude-opus-5").buildPrintCommand(
      opts("do something"),
    );
    expect(command).toContain("--permission-mode dangerous");
  });

  it("buildPrintCommand omits the dangerous mode when not skipping permissions", () => {
    const { command } = devin("claude-opus-5").buildPrintCommand({
      prompt: "do something",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--permission-mode");
  });

  it("DevinOptions.permissionMode replaces the dangerous default", () => {
    const { command } = devin("claude-opus-5", {
      permissionMode: "smart",
    }).buildPrintCommand(opts("do something"));
    expect(command).toContain("--permission-mode smart");
    expect(command).not.toContain("dangerous");
  });

  it("buildPrintCommand always skips the workspace-trust check", () => {
    // Print mode cannot show the trust prompt and would fail in Sandcastle's
    // untrusted worktree without this flag.
    const { command } = devin("claude-opus-5").buildPrintCommand(
      opts("do something"),
    );
    expect(command).toContain("--respect-workspace-trust false");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const { command } = devin("claude-opus-5").buildPrintCommand(
      opts('it\'s a "test" $HOME'),
    );
    expect(command).toContain(`'it'\\''s a "test" $HOME'`);
  });

  it("buildPrintCommand rejects prompts beyond the argv byte limit", () => {
    const provider = devin("claude-opus-5");
    expect(() =>
      provider.buildPrintCommand(opts("x".repeat(121 * 1024))),
    ).toThrow(/print-mode prompt is \d+ bytes/);
  });

  it("buildInteractiveArgs seeds an interactive session behind --", () => {
    const args = devin("claude-opus-5", {
      variant: "claude-opus-5-max",
    }).buildInteractiveArgs!(opts("hello"));
    expect(args).toEqual([
      "devin",
      "--model",
      "claude-opus-5-max",
      "--permission-mode",
      "dangerous",
      "--",
      "hello",
    ]);
  });
});

describe("devin parseStreamLine (plain-text print output)", () => {
  const provider = devin("claude-opus-5");

  it("maps a plain output line to a text event", () => {
    expect(provider.parseStreamLine("Working on the fix…")).toEqual([
      { type: "text", text: "Working on the fix…" },
    ]);
  });

  it("keeps the completion signal visible inside text events", () => {
    // The Orchestrator scans accumulated text for the completion signal —
    // passing lines through verbatim is what makes it detectable.
    const events = provider.parseStreamLine(
      "All done. <promise>COMPLETE</promise>",
    );
    expect(events).toEqual([
      { type: "text", text: "All done. <promise>COMPLETE</promise>" },
    ]);
  });

  it("strips ANSI escape sequences from output lines", () => {
    expect(provider.parseStreamLine("\x1b[32mgreen\x1b[0m text")).toEqual([
      { type: "text", text: "green text" },
    ]);
  });

  it("returns no events for empty or control-only lines", () => {
    expect(provider.parseStreamLine("")).toEqual([]);
    expect(provider.parseStreamLine("\x1b[2K")).toEqual([]);
    expect(provider.parseStreamLine("\r")).toEqual([]);
  });

  it("surfaces error text as ordinary output for the exit-code path", () => {
    // Non-zero exits surface through the Orchestrator's stderr/stdout tail —
    // error-looking lines are passed through, not swallowed or misparsed.
    expect(
      provider.parseStreamLine("Error: model not allowed by team settings"),
    ).toEqual([
      { type: "text", text: "Error: model not allowed by team settings" },
    ]);
  });
});

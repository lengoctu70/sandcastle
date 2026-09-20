import {
  boundToolCallArgs,
  extractErrorMessage,
  shellEscape,
  type AgentCommandOptions,
  type AgentProvider,
  type IterationUsage,
  type ParsedStreamEvent,
  type PrintCommand,
} from "../AgentProvider.js";

/**
 * Google Antigravity (`agy`) agent provider.
 *
 * Headless runs use the CLI's NDJSON stream protocol rather than `-p` argv:
 *
 *     agy --input-format stream-json --output-format stream-json \
 *         --model <model> [--effort <low|medium|high>] \
 *         [--dangerously-skip-permissions]
 *
 *     stdin: {"event":"user","message":{"content":"<prompt>"}}\n
 *
 * Why stdin instead of `-p '<prompt>'`: Linux caps a single argv entry at
 * ~128 KiB and Windows hits ENAMETOOLONG far earlier, so large prompts must not
 * travel in argv. `--input-format stream-json` reads one NDJSON user message
 * per line and runs a turn for each — Sandcastle writes exactly one line and
 * closes stdin, which ends the session after the turn completes. `--print` is
 * deliberately absent: agy consumes the flag's next argument as the prompt
 * string, so `--print --input-format stream-json` mis-parses (verified on
 * agy 1.2.x) — the input format alone selects headless stream mode.
 *
 * Stream events (verified against agy 1.2.x and the official headless docs):
 *   - `init`          → `session_id` (top-level `conversation_id`)
 *   - `step_update`   → `agent_response` frames carry `text_delta` chunks;
 *                       `tool` frames carry `tool_name` + `tool_info`
 *                       `{name, parameters, output, error?}`
 *   - `result`        → terminal `{status, response, error, usage}`;
 *                       `status:"ERROR"` carries the message in `error`
 * `AGY_ERROR: {...}` JSON lines on stderr are also handled defensively here in
 * case they ever reach stdout.
 */

/** Maps agy canonical tool names to the parameters key carrying the display
 *  arg. `tool_info.parameters` uses PascalCase keys (protobuf field names);
 *  fallbacks cover both cases. */
const AGY_TOOL_ARG_FIELDS: Record<string, readonly string[]> = {
  run_command: ["CommandLine", "command"],
  send_command_input: ["Input", "input", "CommandLine", "command"],
  search_web: ["Query", "query"],
  grep_search: ["Query", "query"],
  read_url_content: ["Url", "url"],
  open_browser_url: ["Url", "url"],
  invoke_subagent: ["Task", "task", "Description", "description"],
  define_subagent: ["Name", "name"],
  browser_subagent: ["Task", "task", "Description", "description"],
};

/** Best-effort display arg for a tool call: the mapped parameter when known,
 *  otherwise a compact JSON dump of the parameters object. Every return path
 *  is bounded so a `write_file`-sized payload cannot flood the terminal or
 *  forwarded stream events. */
const antigravityToolArgs = (toolName: string, parameters: unknown): string => {
  if (typeof parameters === "object" && parameters !== null) {
    const params = parameters as Record<string, unknown>;
    for (const field of AGY_TOOL_ARG_FIELDS[toolName] ?? []) {
      const value = params[field];
      if (typeof value === "string" && value.length > 0) {
        return boundToolCallArgs(value);
      }
    }
    try {
      return boundToolCallArgs(JSON.stringify(params));
    } catch {
      return "";
    }
  }
  return "";
};

/** Map an agy usage object to the Claude-shaped IterationUsage.
 *  agy reports {input_tokens, output_tokens, thinking_tokens,
 *  cache_read_tokens, total_tokens}; thinking tokens are billed output tokens,
 *  so they fold into outputTokens. */
const parseAntigravityUsage = (usage: unknown): IterationUsage | undefined => {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  if (
    typeof u.input_tokens !== "number" ||
    typeof u.output_tokens !== "number"
  ) {
    return undefined;
  }
  const thinking =
    typeof u.thinking_tokens === "number" ? u.thinking_tokens : 0;
  const cacheRead =
    typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : 0;
  return {
    inputTokens: u.input_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    outputTokens: u.output_tokens + thinking,
  };
};

/** Parse one line of `agy --output-format stream-json` NDJSON output. */
const parseAntigravityStreamLine = (line: string): ParsedStreamEvent[] => {
  const trimmed = line.trim();
  // `AGY_ERROR: {...}` JSON lines are emitted on stderr for turn failures;
  // parse them here too in case they ever reach stdout.
  if (trimmed.startsWith("AGY_ERROR:")) {
    try {
      const obj = JSON.parse(trimmed.slice("AGY_ERROR:".length));
      const msg =
        extractErrorMessage(obj) ??
        (typeof obj?.short_error === "string" ? obj.short_error : undefined) ??
        (typeof obj?.error === "string" ? obj.error : undefined);
      return msg ? [{ type: "result", result: msg }] : [];
    } catch {
      return [{ type: "result", result: trimmed }];
    }
  }
  if (!trimmed.startsWith("{")) return [];
  try {
    const obj = JSON.parse(trimmed);
    const event = obj.event ?? obj.type; // tolerate either discriminator

    // init carries the conversation id — Sandcastle's session id.
    if (event === "init") {
      const id =
        typeof obj.conversation_id === "string" && obj.conversation_id !== ""
          ? obj.conversation_id
          : typeof obj.init?.conversation_id === "string" &&
              obj.init.conversation_id !== ""
            ? obj.init.conversation_id
            : undefined;
      return id ? [{ type: "session_id", sessionId: id }] : [];
    }

    if (event === "step_update") {
      const step = obj.step_update;
      if (typeof step !== "object" || step === null) return [];
      const stepType = (step as Record<string, unknown>).step_type;
      if (
        stepType === "agent_response" &&
        typeof (step as Record<string, unknown>).text_delta === "string"
      ) {
        return [
          {
            type: "text",
            text: (step as Record<string, unknown>).text_delta as string,
          },
        ];
      }
      // Tool steps: surface one tool_call per completed step. ACTIVE frames
      // repeat as the tool runs; the DONE frame carries the full tool_info.
      if (
        stepType === "tool" &&
        (step as Record<string, unknown>).state === "DONE"
      ) {
        const s = step as Record<string, unknown>;
        const info =
          typeof s.tool_info === "object" && s.tool_info !== null
            ? (s.tool_info as Record<string, unknown>)
            : undefined;
        const name =
          (typeof info?.name === "string" && info.name) ||
          (typeof s.tool_name === "string" && s.tool_name) ||
          undefined;
        if (name === undefined) return [];
        return [
          {
            type: "tool_call",
            name,
            args: antigravityToolArgs(name, info?.parameters),
          },
        ];
      }
      // user_input, checkpoint, ACTIVE tool frames, unknown step types → skip
      return [];
    }

    // Terminal result: response text on SUCCESS, error message on ERROR (or
    // any non-SUCCESS status carrying one — CANCELED, INTERRUPTED, …). The
    // conversation_id is empty on model-validation failures, so it is only
    // trusted when non-empty.
    if (
      event === "result" &&
      typeof obj.result === "object" &&
      obj.result !== null
    ) {
      const r = obj.result as Record<string, unknown>;
      const events: ParsedStreamEvent[] = [];
      if (typeof r.conversation_id === "string" && r.conversation_id !== "") {
        events.push({ type: "session_id", sessionId: r.conversation_id });
      }
      const response = typeof r.response === "string" ? r.response : "";
      // `error` can be a string or a structured object ({message} /
      // {data:{message}}) — extractErrorMessage covers all observed shapes.
      const error = extractErrorMessage(r) ?? "";
      const resultText = response !== "" ? response : error;
      if (resultText !== "") {
        events.push({ type: "result", result: resultText });
      }
      const usage = parseAntigravityUsage(r.usage);
      if (usage !== undefined) {
        events.push({ type: "usage", usage });
      }
      return events;
    }

    // command_result (slash commands) and unknown events → skip
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the antigravity agent provider. */
export interface AntigravityOptions {
  /**
   * Reasoning effort, passed to agy as `--effort <value>` (`low`, `medium`,
   * `high`). Free-form like Codex's: the valid set is model-dependent — agy
   * encodes effort in the model slug (`gemini-3.8-flash-high` requires
   * `--effort high`, non-suffixed models like `claude-sonnet-4-6` reject
   * `--effort` entirely) — and read live from `agy models` at init.
   */
  readonly effort?: string;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const antigravity = (
  model: string,
  options?: AntigravityOptions,
): AgentProvider => ({
  name: "antigravity",
  env: options?.env ?? {},
  // Antigravity stores conversations as per-ID SQLite databases under
  // ~/.gemini/antigravity-cli/conversations/<id>.db PLUS a shared
  // conversation_summaries.db index — like Copilot, a single file cannot be
  // transferred host↔sandbox while preserving the index (ADR 0016). The
  // `--conversation <id>` flag exists and works natively on the host, but
  // Sandcastle-side resume stays off until the storage round-trip is
  // verified end-to-end: captureSessions is false, there is no
  // sessionStorage, and resumeSession/forkSession are ignored — like cursor,
  // opencode, and copilot.
  captureSessions: false,

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): PrintCommand {
    const effortFlag = options?.effort
      ? ` --effort ${shellEscape(options.effort)}`
      : "";
    const permissionsFlag = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    return {
      // No --print: agy takes the flag's next argument as the prompt, so
      // combining it with --input-format is rejected. stream-json input mode
      // is itself headless — write one user message, close stdin, done.
      command: `agy --input-format stream-json --output-format stream-json --model ${shellEscape(model)}${effortFlag}${permissionsFlag}`,
      stdin:
        JSON.stringify({
          event: "user",
          message: { content: prompt },
        }) + "\n",
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["agy", "--model", model];
    if (options?.effort) args.push("--effort", options.effort);
    // `-i`/`--prompt-interactive` requires a value and seeds an interactive
    // session that continues after the first turn — NOT `-p`, which is
    // print-and-exit.
    if (prompt) args.push("--prompt-interactive", prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseAntigravityStreamLine(line);
  },
});

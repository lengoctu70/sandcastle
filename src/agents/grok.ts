/**
 * Grok agent provider (xAI Grok Build CLI).
 *
 * Headless runs invoke `grok --output-format streaming-json` with the prompt
 * delivered on stdin via `--prompt-file /dev/stdin` — Grok's `-p -` does NOT
 * read stdin (`-` is treated as a literal prompt), so the prompt-file indirection
 * is load-bearing for large prompts and shell-safety alike. `/dev/stdin` only
 * exists under POSIX exec shells; when the command will run through cmd.exe
 * (host mode on Windows) the prompt is written to a temporary file instead
 * and that real path is passed to `--prompt-file` (see `execPlatform`).
 *
 * Stream events are ACP-style session updates (`text`, `thought`, `tool_call`,
 * `tool_call_update`, `usage`, `end`). `end` carries the session id and total
 * usage; the parser accumulates streamed text deltas so the final assistant
 * message lands on a `result` event (last-write-wins in the Orchestrator).
 *
 * Sessions are directory trees under `~/.grok/sessions/<encoded-cwd>/<id>/`
 * (percent-encoded cwd, per grok 1.0.30) rather than single JSONL files —
 * capture/resume transfers the whole tree and rewrites the cwd-bearing files
 * (`summary.json`, `prompt_context.json`, `chat_history.jsonl`). Resume by id
 * (`grok --resume <id>`) was verified end-to-end on the host.
 *
 * The executable defaults to `grok`; xAI also installs the same binary as
 * `agent` (a symlink to the same download), so `options.executable` exists for
 * hosts where only that entrypoint is on PATH.
 */

import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  boundToolCallArgs,
  extractErrorMessage,
  readSandboxFile,
  shellEscape,
  writeSandboxFile,
  type AgentCommandOptions,
  type AgentProvider,
  type AgentSessionStorage,
  type IterationUsage,
  type ParsedStreamEvent,
  type PrintCommand,
} from "../AgentProvider.js";
import {
  encodeGrokSessionDir,
  findGrokSessionOnHost,
  grokSessionDirPath,
  listGrokSessionFilesOnHost,
  locateGrokSandboxSession,
  transferGrokSessionFile,
} from "../SessionStore.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// streaming-json event parsing
// ---------------------------------------------------------------------------

/** Maps Grok tool names to the `rawInput` field surfaced as the display arg.
 *  Unlisted tools fall back to a bounded JSON dump of `rawInput`. */
const GROK_TOOL_ARG_FIELDS: Record<string, string> = {
  run_terminal_command: "command",
  read_file: "path",
  search_replace: "path",
  write: "path",
  list_dir: "path",
  grep: "pattern",
  web_search: "query",
  web_fetch: "url",
  spawn_subagent: "description",
  ask_user_question: "question",
};

/** Display args are rendered inline — bound mapped fields and the JSON-dump
 *  fallback alike so a `write`-sized payload cannot flood the log. */
const grokToolCallArgs = (toolName: string, rawInput: unknown): string => {
  if (!isRecord(rawInput)) return "";
  const field = GROK_TOOL_ARG_FIELDS[toolName];
  const value = field !== undefined ? rawInput[field] : undefined;
  if (typeof value === "string") return boundToolCallArgs(value);
  return boundToolCallArgs(JSON.stringify(rawInput));
};

/**
 * Map a Grok usage object to the Claude-shaped IterationUsage.
 *
 * Grok reports `{ input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, reasoning_tokens }` — `input_tokens` here is
 * the non-cached prompt portion (cached tokens are reported separately), so it
 * maps straight across. Reasoning tokens are folded into output like every
 * other provider.
 */
const parseGrokUsage = (usage: unknown): IterationUsage | undefined => {
  if (!isRecord(usage)) return undefined;
  if (
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    cacheCreationInputTokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    cacheReadInputTokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    outputTokens: usage.output_tokens,
  };
};

/**
 * Grok's `streaming-json` format emits incremental `text` deltas — there is no
 * whole-message event. The parser keeps a per-response buffer: a `usage` event
 * marks the end of one model response (observed ordering: text deltas → usage →
 * tool calls → next response), and `end` terminates the turn. The final
 * response's text is emitted as the `result` event on `end`.
 */
const makeGrokStreamParser = (): ((line: string) => ParsedStreamEvent[]) => {
  let responseText = "";
  let lastResponseText = "";

  return (line: string): ParsedStreamEvent[] => {
    if (!line.startsWith("{")) return [];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not valid JSON — skip
      return [];
    }

    // Incremental assistant text.
    if (obj.type === "text" && typeof obj.data === "string") {
      responseText += obj.data;
      return [{ type: "text", text: obj.data }];
    }

    // Tool invocation start. `tool_call_update` events (progress, completion,
    // output) are ignored — re-surfacing them would double-report the call.
    if (obj.type === "tool_call") {
      const toolName =
        typeof obj.toolName === "string"
          ? obj.toolName
          : typeof obj.title === "string"
            ? obj.title
            : undefined;
      if (toolName === undefined) return [];
      return [
        {
          type: "tool_call",
          name: toolName,
          args: grokToolCallArgs(toolName, obj.rawInput),
        },
      ];
    }

    // Per-response token accounting; also the response boundary used to
    // isolate the final message text for the result event.
    if (obj.type === "usage") {
      if (responseText.length > 0) {
        lastResponseText = responseText;
        responseText = "";
      }
      const usage = parseGrokUsage(obj.usage);
      return usage ? [{ type: "usage", usage }] : [];
    }

    // Terminal event: session id + total usage + the final assistant text.
    if (obj.type === "end") {
      const events: ParsedStreamEvent[] = [];
      if (typeof obj.sessionId === "string") {
        events.push({ type: "session_id", sessionId: obj.sessionId });
      }
      const usage = parseGrokUsage(obj.usage);
      if (usage) events.push({ type: "usage", usage });
      const result = responseText.length > 0 ? responseText : lastResponseText;
      responseText = "";
      lastResponseText = "";
      if (result.length > 0) events.push({ type: "result", result });
      return events;
    }

    // Grok emits error events on stdout (not stderr) for auth failures, rate
    // limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error" || obj.type === "agent_error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // thought, tool_call_update, available_commands, unknown types → skip
    return [];
  };
};

// ---------------------------------------------------------------------------
// Session storage — Grok sessions are directory trees
// ---------------------------------------------------------------------------

const GROK_SESSION_FILES_TO_SKIP = /\.lock$/;

const makeGrokSessionStorage = (options?: GrokOptions): AgentSessionStorage => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir =
    options?.sessionStorage?.sandboxSessionsDir ??
    posix.join("/home/agent", ".grok", "sessions");

  return {
    hostSessionFilePath: (cwd, id) =>
      grokSessionDirPath(cwd, id, hostSessionsDir),
    existsOnHost: async (_cwd, id) => {
      const found = await findGrokSessionOnHost(id, hostSessionsDir);
      return found.path !== undefined;
    },
    // `updates.jsonl` is the authoritative conversation log — the closest
    // single-file equivalent of other providers' session JSONL.
    readHostSession: async (_cwd, id) => {
      const found = await findGrokSessionOnHost(id, hostSessionsDir);
      if (!found.path) return undefined;
      try {
        return await readFile(join(found.path, "updates.jsonl"), "utf-8");
      } catch {
        return undefined;
      }
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateGrokSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir,
      );
      // Land under the host cwd's encoded group so `grok sessions list`
      // groups it with the repo it belongs to (id resolution is global, so
      // `grok --resume <id>` would find it under any group).
      const targetDir = grokSessionDirPath(hostCwd, sessionId, hostSessionsDir);
      for (const rel of located.files) {
        if (GROK_SESSION_FILES_TO_SKIP.test(rel)) continue;
        const content = await readSandboxFile(
          handle,
          posix.join(located.path, rel),
          "grok-cap",
        );
        const rewritten = transferGrokSessionFile(
          posix.basename(rel),
          content,
          sandboxCwd,
          hostCwd,
        );
        const dest = join(targetDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, rewritten);
      }
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const found = await findGrokSessionOnHost(sessionId, hostSessionsDir);
      if (!found.path) {
        throw new Error(
          `session ${sessionId} not found in ${found.searchedRoot}`,
        );
      }
      const files = await listGrokSessionFilesOnHost(found.path);
      const targetDir = posix.join(
        sandboxSessionsDir,
        encodeGrokSessionDir(sandboxCwd),
        sessionId,
      );
      for (const rel of files) {
        const content = await readFile(join(found.path, rel), "utf-8");
        const rewritten = transferGrokSessionFile(
          posix.basename(rel),
          content,
          hostCwd,
          sandboxCwd,
        );
        await writeSandboxFile(
          handle,
          posix.join(targetDir, rel),
          rewritten,
          "grok-res",
        );
      }
    },
    findByIdOnHost: (id) => findGrokSessionOnHost(id, hostSessionsDir),
  };
};

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/** Options for the grok agent provider. */
export interface GrokOptions {
  /**
   * Reasoning effort, passed as `--reasoning-effort <value>` (alias
   * `--effort`). Free-form because the CLI help does not enumerate values and
   * the accepted set is version-dependent — the init picker surfaces the
   * discovered choices instead (`low`, `medium`, `high`, `xhigh` on 1.0.30).
   */
  readonly effort?: string;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /**
   * Grok executable name — defaults to `"grok"`. xAI also ships the same
   * binary as `agent`; set this when only that entrypoint is on PATH.
   */
  readonly executable?: string;
  /**
   * Platform of the shell that will interpret the print command — defaults
   * to `process.platform`. Only the `"win32"` vs POSIX distinction matters:
   * a `cmd.exe` exec has no `/dev/stdin`, so the prompt is materialized into
   * a temporary file and `--prompt-file` gets a real path; every POSIX shell
   * (POSIX hosts and Linux containers alike) keeps the stdin device.
   *
   * Container sandboxes always exec through `sh`, even on a Windows host —
   * pass `"linux"` (or any non-`"win32"` value) when this provider will run
   * inside Docker/Podman on Windows, where a host temp path would not exist.
   */
  readonly execPlatform?: string;
  /**
   * Maps directly to Grok's `--permission-mode` flag. When set, replaces the
   * default `--always-approve` Sandcastle passes on AFK runs. Use `"auto"` for
   * AI-mediated per-tool approve/deny on unsandboxed host runs.
   */
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "auto"
    | "dontAsk"
    | "bypassPermissions"
    | "plan";
  /** Override Grok session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
}

export const grok = (
  model: string,
  options?: GrokOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => {
  const executable = options?.executable ?? "grok";
  const parseStreamLine = makeGrokStreamParser();

  return {
    name: "grok",
    env: options?.env ?? {},
    captureSessions: options?.captureSessions ?? true,
    sessionStorage: makeGrokSessionStorage(options),

    buildPrintCommand({
      prompt,
      dangerouslySkipPermissions,
      resumeSession,
      forkSession,
    }: AgentCommandOptions): PrintCommand {
      // permissionMode and --always-approve are mutually exclusive here — an
      // explicit mode on the provider takes precedence over Sandcastle's
      // default auto-approve, same contract as Claude's permissionMode.
      const permissionFlag = options?.permissionMode
        ? ` --permission-mode ${options.permissionMode}`
        : dangerouslySkipPermissions
          ? " --always-approve"
          : "";
      const effortFlag = options?.effort
        ? ` --reasoning-effort ${shellEscape(options.effort)}`
        : "";
      // `--fork-session` is meaningful only alongside `--resume`: the forked
      // continuation is written under a new session id (see ADR 0018).
      const resumeFlag = resumeSession
        ? ` --resume ${shellEscape(resumeSession)}`
        : "";
      const forkFlag = resumeSession && forkSession ? " --fork-session" : "";
      const commandBase = `${executable} --output-format streaming-json --model ${shellEscape(model)}${effortFlag}${permissionFlag}${resumeFlag}${forkFlag}`;
      const execPlatform = options?.execPlatform ?? process.platform;
      if (execPlatform === "win32") {
        // cmd.exe has no /dev/stdin. Write the prompt to a temp file on the
        // host (the command runs on this machine) and hand Grok the real
        // path; `& del` removes it after Grok exits whether it succeeded or
        // failed. cmd.exe quoting uses double quotes — POSIX shellEscape
        // single-quotes do not apply.
        const promptPath = join(
          tmpdir(),
          `sandcastle-grok-prompt-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}.txt`,
        );
        writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
        return {
          command: `${commandBase} --prompt-file "${promptPath}" & del "${promptPath}"`,
        };
      }
      return {
        // `-p -` does not read stdin on Grok — `-` becomes a literal prompt.
        // `--prompt-file /dev/stdin` is the verified stdin delivery path.
        command: `${commandBase} --prompt-file /dev/stdin`,
        stdin: prompt,
      };
    },

    buildInteractiveArgs({
      prompt,
      dangerouslySkipPermissions,
    }: AgentCommandOptions): string[] {
      const args = [executable];
      if (options?.permissionMode) {
        args.push("--permission-mode", options.permissionMode);
      } else if (dangerouslySkipPermissions) {
        args.push("--always-approve");
      }
      args.push("--model", model);
      if (options?.effort) args.push("--reasoning-effort", options.effort);
      // The TUI takes the seed prompt as its positional [PROMPT] argument.
      if (prompt) args.push(prompt);
      return args;
    },

    parseStreamLine,
  };
};

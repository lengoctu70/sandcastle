import type {
  AgentCommandOptions,
  AgentProvider,
  ParsedStreamEvent,
  PrintCommand,
} from "../AgentProvider.js";
import { shellEscape } from "../AgentProvider.js";

/**
 * Devin CLI agent provider (`devin` — Cognition).
 *
 * Print mode is `devin -p [PROMPT]`: the prompt is an optional positional
 * argument, output is plain text on stdout (there is no `--output-format
 * json`/stream-json flag), and the process exits when the answer is done.
 * Two flags matter for unattended runs:
 *
 * - `--permission-mode dangerous` — auto-approves every tool. Sandcastle's
 *   AFK path always asks for the bypass (`dangerouslySkipPermissions: true`),
 *   and host mode only reaches it after the explicit host-access warning has
 *   been accepted (ADR 0021). Callers can substitute a quieter mode via
 *   `DevinOptions.permissionMode`.
 * - `--respect-workspace-trust false` — print mode cannot show the workspace
 *   trust prompt and fails outright in an untrusted directory; Sandcastle's
 *   worktree is always untrusted from the CLI's point of view, so the check
 *   must be skipped for non-interactive runs.
 *
 * Model selection goes through `--model`, which accepts a family slug
 * (`claude-opus-5`), an alias (`opus`), or an exact variant `model_uid`
 * (`claude-opus-5-high`, `MODEL_GPT_5_2_HIGH`). Thinking levels are model
 * VARIANTS in Devin's catalog — `DevinOptions.variant` carries the exact
 * `model_uid` init persisted, and it is passed to `--model` unchanged.
 * There is deliberately no `--effort`-style flag.
 */

/**
 * Devin print mode takes the prompt as a positional argv argument; stdin is
 * not documented for delivering the prompt. Linux enforces a per-argument
 * limit (~128 KiB, ARG_MAX stack). Stay slightly under so users get a clear
 * error instead of spawn E2BIG — same guard as the Cursor and Copilot
 * providers.
 */
const DEVIN_PRINT_PROMPT_MAX_BYTES = 120 * 1024;

function assertDevinPrintPromptFitsArgv(prompt: string): void {
  const n = Buffer.byteLength(prompt, "utf8");
  if (n > DEVIN_PRINT_PROMPT_MAX_BYTES) {
    throw new Error(
      `Devin print-mode prompt is ${n} bytes (max ${DEVIN_PRINT_PROMPT_MAX_BYTES} bytes). The Devin CLI accepts the prompt only as a command-line argument; shorten the prompt or split the work. Other Sandcastle providers use stdin for large prompts.`,
    );
  }
}

/**
 * ANSI escape sequences — CSI (colors, cursor moves, erases) and OSC
 * (hyperlinks, titles). `devin -p` output is plain text, but a prompt or tool
 * output can still smuggle control sequences into stdout; strip them so the
 * `text` events and the completion-signal match stay clean.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-2]|[=>])/g;

const stripAnsi = (line: string): string =>
  line.replace(ANSI_PATTERN, "").replace(/\r$/, "");

/**
 * Parse one line of `devin -p` stdout. Print mode emits plain text — no JSON
 * event stream exists — so every visible line maps to a `text` event. The
 * readline layer strips the line's `\n` before this runs, so the delimiter is
 * restored here: without it `accumulatedOutput` and terminal `textChunk`
 * writes join unrelated lines, and `TextDeltaBuffer` never sees its newline
 * flush trigger. That keeps `accumulatedOutput` aligned with stdout, which is
 * what the Orchestrator's completion-signal scan and stream forwarding
 * consume. There is no terminal `result` event to extract; the run's result
 * falls back to captured stdout (last-write-wins `resultText` stays empty by
 * design). Non-zero exits are surfaced by the Orchestrator from
 * stderr/stdout — nothing is swallowed here.
 */
const parseDevinStreamLine = (line: string): ParsedStreamEvent[] => {
  const text = stripAnsi(line);
  if (text.length === 0) return [];
  return [{ type: "text", text: `${text}\n` }];
};

/** Options for the devin agent provider. */
export interface DevinOptions {
  /**
   * Exact Devin variant `model_uid` to run (e.g. `"claude-opus-5-high"`,
   * `"MODEL_GPT_5_2_XHIGH"`). Devin encodes the thinking level in the model
   * identifier itself rather than a separate effort flag, so when set this
   * replaces the family/alias `model` argument as the `--model` value —
   * passed through unchanged. `sandcastle init` fills this from the chosen
   * catalog variant.
   */
  readonly variant?: string;
  /**
   * Maps directly to Devin's `--permission-mode` flag (`"auto"`,
   * `"accept-edits"`, `"smart"`, `"dangerous"`). When set, replaces the
   * `--permission-mode dangerous` Sandcastle passes on AFK runs.
   */
  readonly permissionMode?: "auto" | "accept-edits" | "smart" | "dangerous";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const devin = (
  model: string,
  options?: DevinOptions,
): AgentProvider => ({
  name: "devin",
  env: options?.env ?? {},
  // Devin keeps sessions in a SQLite store
  // (~/.local/share/devin/cli/sessions.db), not one file per session — the
  // AgentSessionStorage capture/transfer contract cannot be satisfied
  // reliably, so devin is non-resumable per ADR 0012/0016: captureSessions is
  // false, there is no sessionStorage, and resumeSession is ignored here —
  // like cursor, opencode, and copilot.
  captureSessions: false,

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): PrintCommand {
    assertDevinPrintPromptFitsArgv(prompt);
    const permissionFlag = options?.permissionMode
      ? ` --permission-mode ${options.permissionMode}`
      : dangerouslySkipPermissions
        ? " --permission-mode dangerous"
        : "";
    // The variant model_uid — when chosen — IS the model identifier; it
    // reaches --model unchanged (ADR 0021: thinking levels are model
    // variants, never an invented effort flag).
    const selectedModel = options?.variant ?? model;
    return {
      command: `devin -p ${shellEscape(prompt)} --model ${shellEscape(selectedModel)}${permissionFlag} --respect-workspace-trust false`,
    };
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["devin", "--model", options?.variant ?? model];
    if (options?.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    } else if (dangerouslySkipPermissions) {
      args.push("--permission-mode", "dangerous");
    }
    // A positional prompt starts an interactive session; `--` keeps prompt
    // text from being read as a PATH or a flag.
    if (prompt) args.push("--", prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseDevinStreamLine(line);
  },
});

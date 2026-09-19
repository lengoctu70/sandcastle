/**
 * The agent-discovery contract (ADR 0021/0026).
 *
 * Discovery probes an agent's CLI on the host and reports — in one normalized
 * shape — what the executable is, whether the user is signed in, and which
 * models and effort values the account can actually use. Every agent CLI call
 * goes through the injected {@link DiscoveryExec} boundary, so tests never
 * touch real CLIs or subscriptions.
 *
 * This module is deliberately free of runtime dependencies and Effect types so
 * the contract can be re-exported through `index.ts` without leaking Effect
 * into the published `.d.ts` surface (same constraint as `ProjectSettings.ts`).
 * User-facing strings (`guidance`, `detail`) are Vietnamese per ADR 0026;
 * identifiers stay English.
 *
 * Downstream tickets extend discovery by adding ONE adapter file plus ONE line
 * in `registry.ts` — the contract below is the stable seam they build on.
 */

// ---------------------------------------------------------------------------
// Injectable process boundary
// ---------------------------------------------------------------------------

/** Captured outcome of one CLI invocation through the discovery boundary. */
export interface DiscoveryExecResult {
  /** Everything the process wrote to stdout (raw — adapters parse it). */
  readonly stdout: string;
  /** Everything the process wrote to stderr. */
  readonly stderr: string;
  /**
   * Process exit code, or `null` when the process never reached a normal exit
   * (killed on timeout, or never spawned).
   */
  readonly exitCode: number | null;
  /**
   * Set when the process could not be started at all — the OS error code, e.g.
   * `"ENOENT"` (executable not found on PATH → `not-installed`) or `"EACCES"`.
   */
  readonly spawnError?: string;
  /** `true` when the process was terminated for exceeding `timeoutMs`. */
  readonly timedOut?: boolean;
}

/** Options for a single {@link DiscoveryExec} call. */
export interface DiscoveryExecOptions {
  /**
   * Text written to the process's stdin, after which stdin is closed. Used by
   * adapters that talk newline-delimited JSON-RPC to a stdio server (e.g.
   * `codex app-server`): the requests are piped in up front and the captured
   * stdout carries the responses.
   */
  readonly stdin?: string;
  /**
   * Kill the process after this many milliseconds and resolve with the output
   * captured so far (`timedOut: true`). Adapters should always pass a bound so
   * a hung CLI can never wedge discovery.
   */
  readonly timeoutMs?: number;
}

/**
 * The injectable process boundary. Runs `command args` to completion on the
 * host and resolves with the captured output — it never throws for a non-zero
 * exit, a timeout, or a missing executable (those are data on the result). It
 * may only reject on a failure inside the boundary implementation itself.
 *
 * A PATH entry existing is never treated as proof of identity — adapters
 * fingerprint executables by their observed output.
 */
export type DiscoveryExec = (
  command: string,
  args: readonly string[],
  options?: DiscoveryExecOptions,
) => Promise<DiscoveryExecResult>;

// ---------------------------------------------------------------------------
// Discovery report
// ---------------------------------------------------------------------------

/**
 * Readiness of one agent for host-mode use. The states are deliberately
 * distinct so the init picker can render each correctly:
 *
 * - `"ready"` — executable fingerprinted, authenticated, and its model
 *   catalog was read.
 * - `"unauthenticated"` — the right product is installed but not signed in.
 * - `"not-installed"` — the executable does not exist on PATH.
 * - `"wrong-product"` — an executable with the right name answered but is a
 *   different product (e.g. `agent` resolving to Grok, not Cursor).
 * - `"error"` — discovery itself failed (transport failure, malformed catalog
 *   data, an executable that would not run).
 */
export type DiscoveryState =
  | "ready"
  | "unauthenticated"
  | "not-installed"
  | "wrong-product"
  | "error";

/** One reasoning-effort / model-variant value a model supports. */
export interface DiscoveredEffort {
  /** The value persisted to settings and passed back to the agent CLI. */
  readonly id: string;
  /** Optional human-facing description supplied by the catalog. */
  readonly description?: string;
}

/** One model an agent's live catalog reported. */
export interface DiscoveredModel {
  /** Model identifier to persist and pass back to the agent (e.g. `"gpt-5.6-sol"`). */
  readonly id: string;
  /** Human-facing model name (e.g. `"GPT-5.6-Sol"`). */
  readonly displayName: string;
  /** Optional catalog description, shown as a picker hint. */
  readonly description?: string;
  /**
   * The model provider serving this model — only populated for agents that
   * aggregate more than one service (e.g. Pi, OpenCode), where init groups
   * models by provider (ADR 0021). Single-provider agents leave it unset.
   */
  readonly provider?: string;
  /** Effort choices this model supports, in catalog order. Empty when the model exposes none. */
  readonly effortChoices: readonly DiscoveredEffort[];
  /** The catalog's default effort for this model, when it declares one. */
  readonly defaultEffort?: string;
}

/** Normalized result of probing one agent CLI. */
export interface AgentDiscoveryReport {
  /** Registry name of the agent probed (matches `AgentEntry.name`, e.g. `"codex"`). */
  readonly agent: string;
  /** The executable that was probed on PATH (e.g. `"codex"`, `"agent"`). */
  readonly executable: string;
  readonly state: DiscoveryState;
  /** Parsed installed version (e.g. `"0.150.1"`), set once the product is verified. */
  readonly version?: string;
  /**
   * The raw product-identifying line observed while fingerprinting (e.g.
   * `"codex-cli 0.150.1"`). On a `"wrong-product"` report it is the evidence
   * showing which product the executable actually is.
   */
  readonly fingerprint?: string;
  /** The auth status line reported by the CLI (e.g. `"Logged in using ChatGPT"`). */
  readonly authDetail?: string;
  /**
   * The live model catalog. Populated whenever the catalog could be read.
   * Agents whose CLI exposes no model-list command (e.g. Claude Code,
   * Copilot) report `"ready"` with an empty catalog — identity and auth were
   * still verified; the init picker then keeps the `--model` flag or registry
   * default and marks the selection `manual-unverified` rather than
   * `"discovered"`.
   */
  readonly models: readonly DiscoveredModel[];
  /** The model the catalog itself recommends (its default/flagship entry). */
  readonly recommendedModel?: string;
  /** The recommended model's default effort, when declared. */
  readonly recommendedEffort?: string;
  /**
   * Vietnamese next-step guidance for non-`"ready"` states — the install or
   * login action the user can take, or what went wrong.
   */
  readonly guidance?: string;
  /** Extra observed detail (raw output, transport error) for diagnostics. */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base class for discovery failures. Plain `Error` subclass (with a manual
 * `_tag` so it still works with `Effect.catchTag`) rather than
 * `Data.TaggedError` so it can be re-exported without leaking Effect into the
 * public type surface — the `ProjectSettings` errors follow the same pattern.
 *
 * Messages are Vietnamese and actionable (ADR 0026).
 */
export class DiscoveryError extends Error {
  readonly _tag: "DiscoveryError" = "DiscoveryError";
  constructor(
    message: string,
    /** The agent being discovered when the failure happened, when known. */
    readonly agent?: string,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * The CLI answered, but required catalog/identity data was missing or
 * malformed (e.g. a model entry without an `id`). This is terminal — never
 * silently retried or masked by a fallback catalog — so a stale or wrong
 * answer can never be presented as discovered truth.
 *
 * Keeps the inherited `_tag: "DiscoveryError"` (the family tag for
 * `Effect.catchTag`); use `instanceof DiscoveryDataError` to distinguish
 * malformed-data failures from transport-level ones.
 */
export class DiscoveryDataError extends DiscoveryError {
  constructor(
    message: string,
    agent?: string,
    /** Which piece of data was malformed, for diagnostics. */
    readonly field?: string,
  ) {
    super(message, agent);
    this.name = "DiscoveryDataError";
  }
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/**
 * Per-agent discovery implementation. One adapter = one agent CLI. To add an
 * agent, create a new adapter file exporting an `AgentDiscoveryAdapter` and
 * register it in `registry.ts`.
 *
 * Implementations must be read-only (no logins, installs, or config writes)
 * and must never reject from {@link discover} — every outcome, including
 * unexpected failures, is reported via {@link AgentDiscoveryReport.state}.
 */
export interface AgentDiscoveryAdapter {
  /**
   * Registry name this adapter serves — must match an `AgentEntry.name` in
   * `InitService.ts` so the init picker can join discovery state to the agent
   * entry (e.g. `"codex"`).
   */
  readonly agent: string;
  /** The executable probed on PATH (e.g. `"codex"`, `"agent"` for Cursor). */
  readonly executable: string;
  /**
   * Vietnamese install guidance for `not-installed`/`wrong-product` reports —
   * the official install action. Discovery never installs anything itself.
   */
  readonly installGuidance: string;
  /**
   * Vietnamese login guidance for `unauthenticated` reports — the official
   * login action. Discovery never performs the login itself.
   */
  readonly loginGuidance: string;
  /** Probe the agent through the injected boundary and build the report. */
  discover(exec: DiscoveryExec): Promise<AgentDiscoveryReport>;
}

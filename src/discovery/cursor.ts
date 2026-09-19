import { Effect } from "effect";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveredModel,
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";
import { DiscoveryDataError, DiscoveryError } from "./contract.js";

/**
 * Cursor Agent discovery adapter — the command-name-collision case.
 *
 * The `cursor` provider runs the `agent` executable, but `agent` is a
 * collision-prone name: on this design machine it resolves to Grok Build
 * (`grok 1.0.30`, banner `Grok Build TUI`), not Cursor. A PATH hit is
 * therefore never proof of identity.
 *
 * Probes, in order:
 * 1. `agent --version` — real Cursor Agent prints a bare calver
 *    (`2026.07.16-899851b`); that alone cannot identify the product, so…
 * 2. `agent --help` — must carry a Cursor product marker (`Cursor Agent`,
 *    `CURSOR_API_KEY`, `Authenticate with Cursor`). Grok's help contains the
 *    word "Cursor" only in its `cursor-worker` subcommand line and matches
 *    none of these markers, so a Grok binary is rejected `wrong-product`.
 * 3. `agent status` (skipped when `CURSOR_API_KEY` is set — a documented
 *    auth path) — `Logged in` readiness.
 * 4. `agent models` — the account's live catalog, `id - Display Name` rows
 *    with `(default)`/`(current)` markers.
 */

const EXECUTABLE = "agent";
const AGENT = "cursor";

/**
 * Cursor product markers observed in `agent --help` (command descriptions
 * such as "Update Cursor Agent to latest version" and the `CURSOR_API_KEY`
 * env var documented next to `--api-key`). Deliberately narrower than
 * /\bcursor\b/i — Grok's `agent --help` mentions a `cursor-worker`
 * subcommand ("…a Cursor private worker") and must not pass.
 */
const FINGERPRINT_PATTERN =
  /cursor agent|cursor_api_key|authenticate with cursor/i;
/** Cursor prints a bare calver like `2026.07.16-899851b`. */
const VERSION_PATTERN = /\d{4}\.\d{1,2}\.\d{1,2}[-+.\w]*/;

/** `agent status` logged-in marker ("✓ Logged in as user@example.com"). */
const LOGGED_IN_PATTERN = /logged\s*in/i;
/** Explicit logged-out markers checked before the positive one. */
const LOGGED_OUT_PATTERN =
  /not\s+logged\s*in|logged\s*out|not\s+authenticated|authentication\s+required|unauthor/i;

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Cursor Agent CLI (lệnh `agent` không có trên PATH). " +
  "Cài đặt bằng `curl https://cursor.com/install -fsS | bash`, " +
  "rồi chạy `agent login` để đăng nhập, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Cursor Agent đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `agent login` để đăng nhập bằng tài khoản Cursor của bạn " +
  "(hoặc đặt biến môi trường `CURSOR_API_KEY`), rồi chạy lại `sandcastle init`.";

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

const stderrTail = (res: DiscoveryExecResult): string => {
  const tail = (res.stderr || res.stdout)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  return tail.length > 0 ? `: ${tail}` : "";
};

// ---------------------------------------------------------------------------
// `agent models` — `id - Display Name` rows with (default)/(current) markers
// ---------------------------------------------------------------------------

/**
 * One catalog row: `auto - Auto (default)`, `opus-4.6-thinking - Claude 4.6
 * Opus (Thinking)  (current)`. The trailing marker is metadata, not part of
 * the display name; `(default)` elects the recommended model.
 */
const MODEL_ROW_PATTERN = /^(\S+)\s+-\s+(.+)$/;
const ROW_MARKER_PATTERN = /\s+\((default|current)\)\s*$/i;
/** Header/footer lines that are never model rows. */
const NON_ROW_PATTERN = /^(?:#|available models\b|tip[:\s]|no models\b|\.{3})/i;

interface ParsedModels {
  readonly models: DiscoveredModel[];
  readonly recommendedModel?: string;
}

/**
 * Parse `agent models` output. Throws `DiscoveryDataError` when the answer
 * contains no model rows — a verified-authenticated account with an empty
 * or unparseable catalog is a terminal data problem, never masked by a
 * bundled fallback list.
 */
const parseModelsOutput = (stdout: string): ParsedModels => {
  const models: DiscoveredModel[] = [];
  let recommendedModel: string | undefined;
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || NON_ROW_PATTERN.test(line)) continue;
    const match = MODEL_ROW_PATTERN.exec(line);
    if (match === null) continue;
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    let displayName = match[2]!.trim();
    let isDefault = false;
    // Strip one or more trailing (default)/(current) markers.
    for (;;) {
      const marker = ROW_MARKER_PATTERN.exec(displayName);
      if (marker === null) break;
      if (marker[1]!.toLowerCase() === "default") isDefault = true;
      displayName = displayName.slice(0, marker.index).trim();
    }
    models.push({
      id,
      displayName: displayName.length > 0 ? displayName : id,
      effortChoices: [],
    });
    if (isDefault && recommendedModel === undefined) recommendedModel = id;
  }
  if (models.length === 0) {
    throw new DiscoveryDataError(
      "`agent models` không trả về model nào — catalog rỗng hoặc không đọc được. " +
        "Cập nhật Cursor Agent (`agent update`) rồi thử lại.",
      AGENT,
      "models",
    );
  }
  return {
    models,
    recommendedModel: recommendedModel ?? models[0]!.id,
  };
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runAgent = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "agent ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`agent\` trên PATH không phải Cursor Agent` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Cursor Agent bằng " +
  "`curl https://cursor.com/install -fsS | bash`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverCursor = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. `agent --version` — establishes the executable exists and captures
    //    the version line. A bare calver proves nothing by itself.
    const versionRes = yield* runAgent(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`agent\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"agent --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Cursor Agent.`,
          AGENT,
        ),
      );
    }
    const versionOutput =
      `${versionRes.stdout}\n${versionRes.stderr}`.trim();
    const fingerprint = firstNonEmptyLine(versionOutput);

    // 2. `agent --help` — the positive identity check. Cursor's version line
    //    is a bare calver; the help text carries the product markers. Grok's
    //    `agent` prints `grok <ver>` / `Grok Build TUI` and matches none of
    //    them → wrong-product.
    const helpRes = yield* runAgent(exec, ["--help"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (helpRes.spawnError !== undefined || helpRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không xác minh được danh tính của lệnh \`agent\` (` +
            (helpRes.spawnError ?? "hết thời gian chờ") +
            `)${stderrTail(helpRes)}`,
          AGENT,
        ),
      );
    }
    const helpOutput = `${helpRes.stdout}\n${helpRes.stderr}`.trim();
    const identityOutput = `${versionOutput}\n${helpOutput}`;
    if (!FINGERPRINT_PATTERN.test(identityOutput)) {
      return baseReport({
        state: "wrong-product",
        fingerprint: fingerprint ?? firstNonEmptyLine(helpOutput),
        detail: identityOutput,
        guidance: wrongProductGuidance(
          fingerprint ?? firstNonEmptyLine(helpOutput),
        ),
      });
    }
    const version =
      VERSION_PATTERN.exec(versionOutput)?.[0] ?? fingerprint;

    // 3. Auth readiness — `CURSOR_API_KEY` is a documented auth path on its
    //    own; otherwise `agent status` reports the account login.
    const apiKey = process.env["CURSOR_API_KEY"];
    let authDetail: string | undefined;
    if (apiKey !== undefined && apiKey.trim().length > 0) {
      authDetail = "CURSOR_API_KEY (biến môi trường)";
    } else {
      const statusRes = yield* runAgent(exec, ["status"], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const statusOutput =
        `${statusRes.stdout}\n${statusRes.stderr}`.trim();
      authDetail =
        firstNonEmptyLine(statusRes.stdout) ??
        firstNonEmptyLine(statusRes.stderr);
      const authenticated =
        statusRes.exitCode === 0 &&
        LOGGED_IN_PATTERN.test(statusOutput) &&
        !LOGGED_OUT_PATTERN.test(statusOutput);
      if (!authenticated) {
        return baseReport({
          state: "unauthenticated",
          version,
          fingerprint,
          authDetail,
          detail:
            statusRes.spawnError !== undefined || statusRes.timedOut === true
              ? `Không đọc được trạng thái đăng nhập${stderrTail(statusRes)}`
              : statusOutput,
          guidance: LOGIN_GUIDANCE,
        });
      }
    }

    // 4. Live catalog — `agent models` (`id - Display Name` rows). A stale
    //    login can still surface "Authentication required" here; map it back
    //    to unauthenticated rather than erroring.
    const modelsRes = yield* runAgent(exec, ["models"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    const modelsOutput =
      `${modelsRes.stdout}\n${modelsRes.stderr}`.trim();
    if (
      modelsRes.spawnError !== undefined ||
      modelsRes.timedOut === true ||
      modelsRes.exitCode !== 0
    ) {
      if (LOGGED_OUT_PATTERN.test(modelsOutput)) {
        return baseReport({
          state: "unauthenticated",
          version,
          fingerprint,
          detail: modelsOutput,
          guidance: LOGIN_GUIDANCE,
        });
      }
      return yield* Effect.fail(
        new DiscoveryError(
          `"agent models" thất bại` +
            (modelsRes.timedOut === true
              ? " (hết thời gian chờ)"
              : modelsRes.spawnError !== undefined
                ? ` (${modelsRes.spawnError})`
                : ` (mã thoát ${modelsRes.exitCode})`) +
            stderrTail(modelsRes),
          AGENT,
        ),
      );
    }
    // Effect.try routes a DiscoveryDataError throw into the error channel —
    // a bare call inside gen would die as a defect and reject `discover`.
    const catalog = yield* Effect.try({
      try: () => parseModelsOutput(modelsRes.stdout),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "agent models": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });

    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
    });
  });

/**
 * The Cursor discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const cursorDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverCursor(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Cursor: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
        // Defects (a throw that escaped the error channel) must never reject
        // `discover` either — the contract reports every outcome via `state`.
        Effect.catchAllDefect((defect) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail:
                defect instanceof Error ? defect.message : String(defect),
              guidance: `Không khám phá được Cursor (lỗi không mong đợi): ${defect instanceof Error ? defect.message : String(defect)}`,
            }),
          ),
        ),
      ),
    ),
};

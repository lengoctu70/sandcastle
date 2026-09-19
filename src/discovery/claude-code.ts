import { Effect } from "effect";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";
import { DiscoveryError } from "./contract.js";

/**
 * Claude Code discovery adapter.
 *
 * Probes, in order:
 * 1. `claude --version` — product fingerprint (`(Claude Code)`) + version.
 * 2. `claude auth status` — JSON auth state (`loggedIn`, `authMethod`).
 * 3. Catalog — Claude Code has no model-list command (models are passed via
 *    `--model` as aliases or full names), so the report is `ready` with an
 *    empty `models` catalog. The init picker treats an empty catalog as
 *    "no live catalog": the `--model` flag or the registry default is used
 *    and the selection is persisted as `manual-unverified` — a bundled list
 *    is never presented as discovered truth (ADR 0021).
 */

const EXECUTABLE = "claude";
const AGENT = "claude-code";

/** `claude --version` prints `<semver> (Claude Code)` — the product mark. */
const FINGERPRINT_PATTERN = /\(Claude Code\)/;
const VERSION_PATTERN = /(\d[\d.]*[-+.\w]*)\s*\(Claude Code\)/;

const PROBE_TIMEOUT_MS = 10_000;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Claude Code (lệnh `claude` không có trên PATH). " +
  "Cài đặt bằng `curl -fsSL https://claude.ai/install.sh | bash`, " +
  "rồi chạy `claude auth login` để đăng nhập, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Claude Code đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `claude auth login` để đăng nhập bằng tài khoản Claude của bạn, " +
  "rồi chạy lại `sandcastle init`.";

/**
 * Note attached to `ready` reports: the model selection cannot be verified
 * because the CLI exposes no catalog command.
 */
const NO_CATALOG_NOTE =
  "Claude Code không có lệnh liệt kê model — không thể xác minh model nào " +
  "tài khoản đang dùng được. Dùng `--model <id>` để chọn model, hoặc giữ " +
  "model mặc định; lựa chọn sẽ được đánh dấu chưa xác minh.";

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
// `claude auth status` — JSON {loggedIn, authMethod, apiProvider, …}
// ---------------------------------------------------------------------------

interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  /** Short human-readable summary for `authDetail`. */
  readonly detail: string;
}

/**
 * Parse `claude auth status` output. The `--json` shape (the default) carries
 * `loggedIn: boolean` plus `authMethod` (`"none"` when logged out, e.g.
 * `"oauth"` when signed in). A non-JSON or missing `loggedIn` answer means
 * the auth state could not be determined — reported as unauthenticated with
 * the raw output as detail, never silently treated as logged in.
 */
const parseAuthStatus = (
  res: DiscoveryExecResult,
): ClaudeAuthStatus | undefined => {
  const raw = res.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed["loggedIn"] !== "boolean") {
    return undefined;
  }
  const loggedIn = parsed["loggedIn"];
  const authMethod = parsed["authMethod"];
  const detail =
    typeof authMethod === "string" && authMethod.length > 0
      ? `loggedIn: ${loggedIn}, authMethod: ${authMethod}`
      : `loggedIn: ${loggedIn}`;
  return { loggedIn, detail };
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runClaude = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "claude ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`claude\` trên PATH không phải Claude Code` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Claude Code bằng " +
  "`curl -fsSL https://claude.ai/install.sh | bash`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverClaude = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Fingerprint + version — PATH existence alone proves nothing.
    const versionRes = yield* runClaude(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`claude\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"claude --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Claude Code.`,
          AGENT,
        ),
      );
    }
    const versionOutput =
      `${versionRes.stdout}\n${versionRes.stderr}`.trim();
    const fingerprint = firstNonEmptyLine(versionOutput);
    if (!FINGERPRINT_PATTERN.test(versionOutput)) {
      return baseReport({
        state: "wrong-product",
        fingerprint,
        detail: versionOutput,
        guidance: wrongProductGuidance(fingerprint),
      });
    }
    const version = VERSION_PATTERN.exec(versionOutput)?.[1] ?? fingerprint;

    // 2. Auth readiness — `claude auth status` (JSON, `loggedIn` field).
    const authRes = yield* runClaude(exec, ["auth", "status"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const authOutput = `${authRes.stdout}\n${authRes.stderr}`.trim();
    const status = parseAuthStatus(authRes);
    if (status?.loggedIn !== true) {
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        authDetail: status?.detail,
        detail:
          authRes.spawnError !== undefined || authRes.timedOut === true
            ? `Không đọc được trạng thái đăng nhập${stderrTail(authRes)}`
            : authOutput,
        guidance: LOGIN_GUIDANCE,
      });
    }

    // 3. Catalog — Claude Code exposes no model-list command, so the agent
    // reports ready with an empty catalog. The picker keeps the --model flag
    // or registry default and marks the choice unverified.
    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail: status.detail,
      models: [],
      guidance: NO_CATALOG_NOTE,
    });
  });

/**
 * The Claude Code discovery adapter. `discover` never rejects — every
 * outcome is expressed in the report's `state` (unexpected failures become
 * `"error"`).
 */
export const claudeCodeDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverClaude(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Claude Code: ${e instanceof Error ? e.message : String(e)}`,
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
              guidance: `Không khám phá được Claude Code (lỗi không mong đợi): ${defect instanceof Error ? defect.message : String(defect)}`,
            }),
          ),
        ),
      ),
    ),
};

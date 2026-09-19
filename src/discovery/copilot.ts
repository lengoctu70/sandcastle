import { Effect } from "effect";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";
import { DiscoveryError } from "./contract.js";

/**
 * GitHub Copilot CLI discovery adapter.
 *
 * Probes, in order:
 * 1. `copilot --version` — product fingerprint. Newer builds print
 *    `GitHub Copilot CLI <ver>.`; older/lo-res builds print a bare version
 *    plus a `Commit:` line with no product string, so…
 * 2. `copilot --help` — only consulted when `--version` lacks the
 *    `GitHub Copilot` product mark (the help banner/description carries it).
 * 3. Auth — the CLI exposes no login-status command. Its documented
 *    credential order is `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` →
 *    `GITHUB_TOKEN` → OAuth token in the OS credential store → `gh` CLI
 *    fallback. Discovery can verify the env vars directly and the `gh`
 *    fallback via `gh auth status`; a token stored only in the OS keychain
 *    cannot be probed read-only, so that shape reports `unauthenticated`
 *    with `copilot login` guidance (a false negative the user resolves by
 *    logging in — never a false "ready").
 * 4. Catalog — Copilot CLI has no model-list command (the model list is
 *    hydrated per-account inside the session UI), so the report is `ready`
 *    with an empty `models` catalog: init keeps the `--model` flag or
 *    registry default, persisted as `manual-unverified` (ADR 0021).
 */

const EXECUTABLE = "copilot";
const AGENT = "copilot";

/** `GitHub Copilot CLI <ver>.` / help banner — the product mark. */
const FINGERPRINT_PATTERN = /github\s+copilot/i;
const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/;

/** `gh auth status` logged-in marker ("Logged in to github.com account …"). */
const GH_LOGGED_IN_PATTERN = /logged\s+in\s+to/i;

/** Env vars Copilot CLI accepts as credentials, in documented precedence order. */
const TOKEN_ENV_VARS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

const PROBE_TIMEOUT_MS = 10_000;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy GitHub Copilot CLI (lệnh `copilot` không có trên PATH). " +
  "Cài đặt bằng `npm install -g @github/copilot`, " +
  "rồi chạy `copilot login` để đăng nhập, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "GitHub Copilot CLI đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `copilot login` để đăng nhập bằng tài khoản GitHub của bạn " +
  "(hoặc đặt `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`, " +
  "hoặc đăng nhập `gh auth login` để Copilot dùng token của GitHub CLI), " +
  "rồi chạy lại `sandcastle init`.";

/**
 * Note attached to `ready` reports: the model selection cannot be verified
 * because the CLI exposes no catalog command.
 */
const NO_CATALOG_NOTE =
  "GitHub Copilot CLI không có lệnh liệt kê model — không thể xác minh " +
  "model nào tài khoản đang dùng được. Dùng `--model <id>` để chọn model, " +
  "hoặc giữ model mặc định; lựa chọn sẽ được đánh dấu chưa xác minh.";

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
// Probe pipeline
// ---------------------------------------------------------------------------

const runProbe = (
  exec: DiscoveryExec,
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(command, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "${command} ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`copilot\` trên PATH không phải GitHub Copilot CLI` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Copilot CLI bằng " +
  "`npm install -g @github/copilot`, rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

/**
 * Auth probe. Returns the env var name when a token is configured; otherwise
 * runs `gh auth status` — Copilot's documented lowest-priority credential
 * source — and reports whether a GitHub login is usable.
 */
const probeAuth = (
  exec: DiscoveryExec,
): Effect.Effect<
  | { readonly authenticated: true; readonly authDetail: string }
  | {
      readonly authenticated: false;
      readonly detail: string;
    },
  DiscoveryError
> =>
  Effect.gen(function* () {
    const envVar = TOKEN_ENV_VARS.find(
      (name) => (process.env[name] ?? "").trim().length > 0,
    );
    if (envVar !== undefined) {
      return {
        authenticated: true as const,
        authDetail: `${envVar} (biến môi trường)`,
      };
    }
    const ghRes = yield* runProbe(exec, "gh", ["auth", "status"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const ghOutput = `${ghRes.stdout}\n${ghRes.stderr}`.trim();
    // `gh auth status` prints a hostname line first ("github.com") — surface
    // the "✓ Logged in to …" line when present, else the first output line.
    const loggedInLine = ghOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => GH_LOGGED_IN_PATTERN.test(line));
    const ghDetail =
      ghRes.spawnError !== undefined
        ? `không chạy được (${ghRes.spawnError})`
        : (loggedInLine ?? firstNonEmptyLine(ghOutput) ?? "không có kết quả");
    if (ghRes.exitCode === 0 && GH_LOGGED_IN_PATTERN.test(ghOutput)) {
      return {
        authenticated: true as const,
        authDetail: `gh: ${ghDetail}`,
      };
    }
    return {
      authenticated: false as const,
      detail:
        "Không có token trong `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`; " +
        `\`gh auth status\`: ${ghDetail}.`,
    };
  });

const discoverCopilot = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Fingerprint + version — PATH existence alone proves nothing.
    const versionRes = yield* runProbe(exec, EXECUTABLE, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`copilot\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"copilot --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Copilot CLI.`,
          AGENT,
        ),
      );
    }
    const versionOutput = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
    const fingerprint = firstNonEmptyLine(versionOutput);

    // 2. Positive identity — `GitHub Copilot` must appear in the version
    //    output, or (for builds whose version is a bare number + `Commit:`
    //    line) in `copilot --help`.
    let identityOutput = versionOutput;
    if (!FINGERPRINT_PATTERN.test(identityOutput)) {
      const helpRes = yield* runProbe(exec, EXECUTABLE, ["--help"], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (helpRes.spawnError !== undefined || helpRes.timedOut === true) {
        return yield* Effect.fail(
          new DiscoveryError(
            `Không xác minh được danh tính của lệnh \`copilot\` (` +
              (helpRes.spawnError ?? "hết thời gian chờ") +
              `)${stderrTail(helpRes)}`,
            AGENT,
          ),
        );
      }
      identityOutput =
        `${versionOutput}\n${helpRes.stdout}\n${helpRes.stderr}`.trim();
    }
    if (!FINGERPRINT_PATTERN.test(identityOutput)) {
      return baseReport({
        state: "wrong-product",
        fingerprint,
        detail: identityOutput,
        guidance: wrongProductGuidance(fingerprint),
      });
    }
    const version = VERSION_PATTERN.exec(versionOutput)?.[0] ?? fingerprint;

    // 3. Auth readiness — env token, else the documented `gh` fallback.
    const auth = yield* probeAuth(exec);
    if (!auth.authenticated) {
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        detail: auth.detail,
        guidance: LOGIN_GUIDANCE,
      });
    }

    // 4. Catalog — Copilot CLI exposes no model-list command; report ready
    //    with an empty catalog so the selection stays marked unverified.
    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail: auth.authDetail,
      models: [],
      guidance: NO_CATALOG_NOTE,
    });
  });

/**
 * The Copilot discovery adapter. `discover` never rejects — every outcome
 * is expressed in the report's `state` (unexpected failures become
 * `"error"`).
 */
export const copilotDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverCopilot(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Copilot: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
        // Defects (a throw that escaped the error channel) must never reject
        // `discover` either — the contract reports every outcome via `state`.
        Effect.catchAllDefect((defect) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: defect instanceof Error ? defect.message : String(defect),
              guidance: `Không khám phá được Copilot (lỗi không mong đợi): ${defect instanceof Error ? defect.message : String(defect)}`,
            }),
          ),
        ),
      ),
    ),
};

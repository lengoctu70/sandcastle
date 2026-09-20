import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
 *    `GITHUB_TOKEN` → OAuth token written by `copilot login` → `gh` CLI
 *    fallback. Discovery verifies the env vars directly, then the native
 *    login by reading `<COPILOT_HOME|~/.copilot>/config.json`'s documented
 *    `loggedInUsers` application-state field — it records `copilot login`
 *    accounts (`{host, login}`) whether the token went to the OS keychain
 *    or the plaintext fallback, and contains no secret material itself.
 *    The `gh` fallback is probed via `gh auth status`.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * Read the CLI's own login record. `copilot login` writes the OAuth token to
 * the OS credential store (service `copilot-cli`) — or to `config.json` when
 * the user opted into plaintext storage — and records the account in
 * `config.json`'s `loggedInUsers` field (documented shape:
 * `[{ host, login }]`; `lastLoggedInUser` marks the active entry). Only the
 * non-secret `host`/`login` fields are read — token material is never
 * surfaced, printed, or persisted.
 */
const probeNativeLogin = async (): Promise<
  { readonly login?: string; readonly host?: string } | undefined
> => {
  const copilotHome = process.env.COPILOT_HOME?.trim();
  const configDir =
    copilotHome !== undefined && copilotHome.length > 0
      ? copilotHome
      : join(homedir(), ".copilot");
  try {
    const raw = await readFile(join(configDir, "config.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const users = parsed["loggedInUsers"];
    if (!Array.isArray(users) || users.length === 0) return undefined;
    const active = isRecord(parsed["lastLoggedInUser"])
      ? parsed["lastLoggedInUser"]
      : users.find(isRecord);
    if (!isRecord(active)) return {};
    return {
      ...(typeof active["login"] === "string" && active["login"].length > 0
        ? { login: active["login"] }
        : {}),
      ...(typeof active["host"] === "string" && active["host"].length > 0
        ? { host: active["host"] }
        : {}),
    };
  } catch {
    // Missing/malformed config.json is data — no native login recorded.
    return undefined;
  }
};

/**
 * Auth probe, in the CLI's documented credential precedence: token env vars,
 * then the account `copilot login` recorded in `config.json`, then the `gh`
 * CLI fallback via `gh auth status`.
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
    const native = yield* Effect.promise(probeNativeLogin);
    if (native !== undefined) {
      const account =
        native.login !== undefined
          ? ` (${native.login}${native.host !== undefined ? ` @ ${native.host}` : ""})`
          : "";
      return {
        authenticated: true as const,
        authDetail: `copilot login${account} (token trong credential store của hệ điều hành)`,
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

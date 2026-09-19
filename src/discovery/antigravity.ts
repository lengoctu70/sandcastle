import { Effect } from "effect";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveredEffort,
  DiscoveredModel,
  DiscoveryExec,
  DiscoveryExecResult,
} from "./contract.js";
import { DiscoveryDataError, DiscoveryError } from "./contract.js";

/**
 * Antigravity (`agy`) discovery adapter.
 *
 * Probes, in order:
 * 1. `agy --version` — existence + version (a bare numeric string; NOT a
 *    product fingerprint).
 * 2. `agy --help` — product fingerprint: the Go-flag `Usage of agy:` header
 *    plus agy-specific flags (`--input-format`, `--prompt-interactive`,
 *    `mic-serve`). A same-named executable answering differently reports
 *    `wrong-product`.
 * 3. `agy models` — auth readiness AND the live model catalog in one call:
 *    an unauthenticated CLI prints "Please sign in to view available
 *    models…"; a signed-in one prints tab-separated `id<TAB>name` rows.
 *    Effort support is inferred from the model slug: ids ending in
 *    `-low`/`-medium`/`-high` accept exactly that `--effort` value (mismatch
 *    is rejected by the CLI); ids without a suffix reject `--effort`
 *    entirely (verified against agy 1.2.x).
 */

const EXECUTABLE = "agy";
const AGENT = "antigravity";

/** `agy --help` header — required, but not sufficient on its own. */
const HELP_HEADER_PATTERN = /Usage of agy\b/;
/** Flags/subcommands distinctive to the Antigravity CLI. */
const AGY_MARKER_PATTERN = /--input-format|--prompt-interactive|mic-serve|antigravity/i;
/** `agy --version` output is a bare version like `1.2.7`. */
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)*/;
/** `agy models` output when the CLI is not signed in. */
const SIGN_IN_PATTERN = /please sign in|not authenticated|authentication required/i;

const PROBE_TIMEOUT_MS = 10_000;
/** `agy models` fetches the account-scoped catalog over the network —
 *  observed ~25–30s cold; bound generously so a slow fetch isn't a timeout. */
const CATALOG_TIMEOUT_MS = 45_000;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Antigravity CLI (lệnh `agy` không có trên PATH). " +
  "Cài đặt bằng `curl -fsSL https://antigravity.google/cli/install.sh | bash` " +
  "(xem https://antigravity.google/docs/cli/overview), rồi chạy `agy` để đăng nhập, " +
  "sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Antigravity CLI đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `agy` (không tham số) để đăng nhập bằng tài khoản Google của bạn, " +
  "rồi chạy lại `sandcastle init`.";

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
// `agy models` TSV catalog
// ---------------------------------------------------------------------------

const EFFORT_SUFFIX_PATTERN = /-(low|medium|high)$/;

/**
 * Parse one `agy models` TSV row into a DiscoveredModel. agy encodes the
 * reasoning effort in the model slug: `gemini-3.8-flash-high` accepts only
 * `--effort high`, `claude-sonnet-4-6` rejects `--effort` outright
 * (verified). A `-low|medium|high` suffix therefore maps to a single-choice
 * effort list; other ids expose none.
 */
const parseModelRow = (line: string, index: number): DiscoveredModel => {
  const where = `models[${index}]`;
  const tab = line.indexOf("\t");
  const id = line.slice(0, tab).trim();
  const displayName = line.slice(tab + 1).trim();
  if (id === "" || displayName === "") {
    throw new DiscoveryDataError(
      `Catalog của Antigravity có dữ liệu không hợp lệ: ${where} không phải dòng "id<TAB>tên" hợp lệ. ` +
        "Phiên bản agy có thể quá cũ hoặc quá mới — hãy cập nhật agy rồi thử lại.",
      AGENT,
      where,
    );
  }
  const suffix = EFFORT_SUFFIX_PATTERN.exec(id)?.[1];
  const effortChoices: DiscoveredEffort[] =
    suffix !== undefined ? [{ id: suffix }] : [];
  return {
    id,
    displayName,
    effortChoices,
    ...(suffix !== undefined ? { defaultEffort: suffix } : {}),
  };
};

/**
 * Parse captured `agy models` output — a progress/banner line followed by
 * `id<TAB>name` rows. Lines without a tab are ignored (progress noise); a row
 * with a tab but a missing field is a `DiscoveryDataError`. Zero rows is a
 * data failure — never masked by a fallback catalog.
 */
const parseModelsStdout = (
  res: DiscoveryExecResult,
): { models: DiscoveredModel[]; recommendedModel: string; recommendedEffort?: string } => {
  if (res.spawnError !== undefined) {
    throw new DiscoveryError(
      `Không chạy được "agy models" (${res.spawnError})`,
      AGENT,
    );
  }
  if (res.timedOut === true) {
    throw new DiscoveryError(
      `"agy models" không phản hồi trong ${CATALOG_TIMEOUT_MS / 1000}s — kiểm tra kết nối mạng rồi thử lại.`,
      AGENT,
    );
  }
  // Rows carry a literal TAB between id and display name. Test the raw line —
  // trimming first would silently erase a missing-field row (`id\t` → `id`)
  // instead of flagging it as malformed data.
  const models = res.stdout
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map(parseModelRow);
  if (models.length === 0) {
    if (res.exitCode !== 0) {
      throw new DiscoveryError(
        `"agy models" thất bại (mã thoát ${res.exitCode})${stderrTail(res)}`,
        AGENT,
      );
    }
    throw new DiscoveryDataError(
      "Antigravity trả về catalog rỗng — `agy models` không có model nào để chọn. " +
        "Cập nhật agy rồi thử lại.",
      AGENT,
      "models",
    );
  }
  const recommended = models[0]!;
  return {
    models,
    recommendedModel: recommended.id,
    ...(recommended.defaultEffort !== undefined
      ? { recommendedEffort: recommended.defaultEffort }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runAgy = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "agy ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  "Lệnh `agy` trên PATH không phải Antigravity CLI" +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Antigravity bằng " +
  "`curl -fsSL https://antigravity.google/cli/install.sh | bash`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverAntigravity = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Existence + version. `agy --version` prints a bare numeric string —
    // it is NOT a fingerprint; identity is established via --help below.
    const versionRes = yield* runAgy(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`agy\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"agy --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Antigravity.`,
          AGENT,
        ),
      );
    }
    const versionOutput = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
    const version = VERSION_PATTERN.exec(versionOutput)?.[0];

    // 2. Fingerprint — `agy --help` prints the Go-flag `Usage of agy:` header
    // plus agy-specific flags. PATH existence or a numeric version alone
    // proves nothing.
    const helpRes = yield* runAgy(exec, ["--help"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (helpRes.spawnError !== undefined || helpRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"agy --help" thất bại${helpRes.timedOut === true ? " (hết thời gian chờ)" : ` (${helpRes.spawnError})`}${stderrTail(helpRes)}`,
          AGENT,
        ),
      );
    }
    const helpOutput = `${helpRes.stdout}\n${helpRes.stderr}`;
    const helpFirstLine = firstNonEmptyLine(helpOutput);
    const isAntigravity =
      HELP_HEADER_PATTERN.test(helpOutput) && AGY_MARKER_PATTERN.test(helpOutput);
    if (!isAntigravity) {
      if (helpFirstLine === undefined && helpRes.exitCode !== 0) {
        return yield* Effect.fail(
          new DiscoveryError(
            `"agy --help" thất bại (mã thoát ${helpRes.exitCode})${stderrTail(helpRes)}`,
            AGENT,
          ),
        );
      }
      return baseReport({
        state: "wrong-product",
        fingerprint: helpFirstLine,
        detail: helpOutput.trim(),
        guidance: wrongProductGuidance(helpFirstLine),
      });
    }

    // 3. Auth readiness + live catalog — `agy models` does both: it prints a
    // sign-in notice when unauthenticated, or the TSV catalog when signed in.
    const modelsRes = yield* runAgy(exec, ["models"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    const modelsOutput = `${modelsRes.stdout}\n${modelsRes.stderr}`;
    const signInLine = modelsOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => SIGN_IN_PATTERN.test(line));
    if (signInLine !== undefined) {
      return baseReport({
        state: "unauthenticated",
        ...(version !== undefined ? { version } : {}),
        fingerprint: helpFirstLine,
        authDetail: signInLine,
        detail: modelsOutput.trim(),
        guidance: LOGIN_GUIDANCE,
      });
    }

    const catalog = yield* Effect.try({
      try: () => parseModelsStdout(modelsRes),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "agy models": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });

    return baseReport({
      state: "ready",
      ...(version !== undefined ? { version } : {}),
      fingerprint: helpFirstLine,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
      ...(catalog.recommendedEffort !== undefined
        ? { recommendedEffort: catalog.recommendedEffort }
        : {}),
    });
  });

/**
 * The Antigravity discovery adapter. `discover` never rejects — every
 * outcome is expressed in the report's `state` (unexpected failures become
 * `"error"`).
 */
export const antigravityDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverAntigravity(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Antigravity: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

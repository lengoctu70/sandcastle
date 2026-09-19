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
 * Pi discovery adapter (`@earendil-works/pi-coding-agent`) — follows the
 * contract Codex established.
 *
 * Probes, in order:
 * 1. `pi --version` — a bare semver (`0.84.4`), no product string. Detects
 *    the executable and reads the version; identity needs step 2.
 * 2. `pi --help` — the product fingerprint:
 *    `pi - AI coding assistant with read, bash, edit, write tools`.
 * 3. `pi --list-models` — auth readiness AND catalog in one call: pi lists
 *    only models whose model provider has working credentials, and prints
 *    `No models available. Use /login …` when none do — that message is the
 *    unauthenticated signal.
 * 4. `pi auth check --provider <p> --json --no-refresh` — once per provider
 *    seen in the catalog, purely for `authDetail` evidence. `--no-refresh`
 *    keeps the probe read-only (pi would otherwise write refreshed OAuth
 *    tokens); a check that fails or disagrees never overrides the catalog —
 *    `pi --list-models` already filtered to usable providers.
 *
 * Pi emits extension noise (e.g. a `[paseo-team] …` line) on stderr for every
 * invocation — parsers read stdout and never treat stderr lines as data.
 */

const EXECUTABLE = "pi";
const AGENT = "pi";

/**
 * `pi --help` prints `pi - AI coding assistant with read, bash, edit, write
 * tools` as its first content line — the product fingerprint, since
 * `pi --version` is a bare number with no identifying string.
 */
const FINGERPRINT_PATTERN = /^pi - AI coding assistant\b/;
const VERSION_PATTERN = /(\d+\.\d+\.\d+\S*)/;
/** Printed by `pi --list-models` when no provider has credentials. */
const NO_MODELS_PATTERN = /^No models available\b/im;

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Pi's CLI-level thinking levels (`VALID_THINKING_LEVELS` in pi's arg parser —
 * `--thinking` rejects anything outside this set). The catalog only reports
 * whether a model reasons (`thinking: yes/no`), so a reasoning-capable model
 * is offered the full level list.
 */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
/** Pi's built-in default thinking level (`DEFAULT_THINKING_LEVEL`). */
const DEFAULT_THINKING_LEVEL = "medium";
/**
 * Pi's built-in default provider (`--provider` defaults to `google`); its
 * first listed model is the recommendation when google is configured.
 */
const DEFAULT_PROVIDER = "google";

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Pi (lệnh `pi` không có trên PATH). " +
  "Cài đặt bằng `npm install -g @earendil-works/pi-coding-agent`, rồi chạy `pi` " +
  "và dùng lệnh `/login` để đăng nhập một model provider, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Pi đã được cài đặt nhưng chưa có model provider nào khả dụng. " +
  "Chạy `pi` rồi dùng lệnh `/login` để đăng nhập một provider qua OAuth hoặc API key, " +
  "sau đó chạy lại `sandcastle init`.";

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
// `pi --list-models` table parsing
// ---------------------------------------------------------------------------

/**
 * `pi --list-models` prints a padded table sorted by provider then model id:
 *
 *   provider   model                  context  max-out  thinking  images
 *   anthropic  claude-sonnet-4-5      200K     64K      yes       yes
 *
 * Columns are joined by runs of 2+ spaces; no cell contains spaces. The
 * header row fixes the column order, so reordering or extra columns are
 * tolerated. Noise lines (extension output, footers) are skipped; a header
 * with zero parseable rows, or no recognizable shape at all, is malformed
 * catalog data — a `DiscoveryDataError`, never silently masked.
 */
const parseModelsTable = (stdout: string): DiscoveredModel[] => {
  const lines = stdout.split("\n");

  let headerIndex = -1;
  let headerCellCount = 0;
  let providerCol = -1;
  let modelCol = -1;
  let thinkingCol = -1;
  let contextCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i]!.trim().split(/\s{2,}/);
    if (cells[0] === "provider" && cells[1] === "model") {
      headerIndex = i;
      headerCellCount = cells.length;
      providerCol = cells.indexOf("provider");
      modelCol = cells.indexOf("model");
      thinkingCol = cells.indexOf("thinking");
      contextCol = cells.indexOf("context");
      break;
    }
  }
  if (headerIndex === -1) {
    throw new DiscoveryDataError(
      'Kết quả "pi --list-models" không hợp lệ: không tìm thấy dòng tiêu đề ' +
        '"provider  model  …". Phiên bản Pi có thể quá cũ hoặc quá mới — hãy cập nhật rồi thử lại.',
      AGENT,
      "models",
    );
  }

  const models: DiscoveredModel[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0) continue;
    const cells = trimmed.split(/\s{2,}/);
    // Every real row populates all columns (thinking/images are always
    // yes/no) — a shorter line is extension noise or a footer, not a
    // truncated model row, so it is skipped rather than misparsed.
    if (cells.length < headerCellCount) continue;
    const provider = cells[providerCol]!;
    const modelId = cells[modelCol]!;
    if (provider.length === 0 || modelId.length === 0) continue;
    const thinking = thinkingCol !== -1 && cells[thinkingCol] === "yes";
    const context = contextCol !== -1 ? cells[contextCol] : undefined;
    const effortChoices: readonly DiscoveredEffort[] = thinking
      ? THINKING_LEVELS.map((id) => ({ id }))
      : [];
    models.push({
      // `provider/model` is the canonical `--model` form pi accepts back
      // ("supports provider/id") and stays unique when two providers list
      // the same model id.
      id: `${provider}/${modelId}`,
      displayName: modelId,
      ...(context !== undefined
        ? { description: `${provider} · ${context} context` }
        : { description: provider }),
      provider,
      effortChoices,
      ...(thinking ? { defaultEffort: DEFAULT_THINKING_LEVEL } : {}),
    });
  }
  if (models.length === 0) {
    throw new DiscoveryDataError(
      'Kết quả "pi --list-models" không hợp lệ: có dòng tiêu đề nhưng không ' +
        "parse được hàng model nào. Phiên bản Pi có thể quá cũ hoặc quá mới — " +
        "hãy cập nhật rồi thử lại.",
      AGENT,
      "models",
    );
  }
  return models;
};

// ---------------------------------------------------------------------------
// `pi auth check` — per-provider readiness evidence
// ---------------------------------------------------------------------------

/**
 * One `pi auth check --provider <p> --json --no-refresh` probe. Returns the
 * parsed `{status, reason?, authType?}` payload, or `undefined` when the
 * check itself could not produce a verdict (transport failure, non-JSON
 * output) — evidence-only, so failures degrade rather than fail discovery.
 */
const checkProviderAuth = (
  exec: DiscoveryExec,
  provider: string,
): Effect.Effect<Record<string, unknown> | undefined, DiscoveryError> =>
  Effect.gen(function* () {
    const res = yield* runPi(
      exec,
      ["auth", "check", "--provider", provider, "--json", "--no-refresh"],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (
      res.spawnError !== undefined ||
      res.timedOut === true ||
      res.exitCode !== 0
    ) {
      return undefined;
    }
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed) && typeof parsed["status"] === "string") {
          return parsed;
        }
      } catch {
        // Not JSON — try the next line.
      }
    }
    return undefined;
  });

const formatAuthCheck = (parsed: Record<string, unknown>): string => {
  const provider =
    typeof parsed["provider"] === "string" ? parsed["provider"] : "?";
  const status = parsed["status"] as string;
  const extra =
    typeof parsed["authType"] === "string"
      ? ` (${parsed["authType"]})`
      : typeof parsed["reason"] === "string"
        ? ` (${parsed["reason"]})`
        : "";
  return `${provider}: ${status}${extra}`;
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runPi = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "pi ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`pi\` trên PATH không phải Pi coding agent` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Pi bằng `npm install -g @earendil-works/pi-coding-agent`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverPi = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. `pi --version` — existence + bare version. PATH existence alone
    // proves nothing; a bare number is not a fingerprint (that's step 2).
    const versionRes = yield* runPi(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`pi\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"pi --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Pi.`,
          AGENT,
        ),
      );
    }
    const version = VERSION_PATTERN.exec(
      `${versionRes.stdout}\n${versionRes.stderr}`,
    )?.[1];

    // 2. `pi --help` — the product fingerprint line.
    const helpRes = yield* runPi(exec, ["--help"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (helpRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được "pi --help" (${helpRes.spawnError})${stderrTail(helpRes)}`,
          AGENT,
        ),
      );
    }
    if (helpRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"pi --help" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Pi.`,
          AGENT,
        ),
      );
    }
    const helpOutput = `${helpRes.stdout}\n${helpRes.stderr}`.trim();
    const fingerprint = helpOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => FINGERPRINT_PATTERN.test(line));
    if (fingerprint === undefined) {
      if (helpOutput.length === 0) {
        return yield* Effect.fail(
          new DiscoveryError(
            `"pi --help" không trả về nội dung nào — không xác minh được đây là Pi.`,
            AGENT,
          ),
        );
      }
      const observed = firstNonEmptyLine(helpOutput);
      return baseReport({
        state: "wrong-product",
        fingerprint: observed,
        detail: helpOutput,
        guidance: wrongProductGuidance(observed),
      });
    }

    // 3. `pi --list-models` — auth signal + live catalog. Pi lists only
    // models from providers with working credentials; an empty catalog means
    // "installed but not signed in", which stays distinct from not-installed.
    const listRes = yield* runPi(exec, ["--list-models"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    if (listRes.spawnError !== undefined || listRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"pi --list-models" thất bại${listRes.timedOut === true ? " (hết thời gian chờ)" : ` (${listRes.spawnError})`}${stderrTail(listRes)}`,
          AGENT,
        ),
      );
    }
    if (NO_MODELS_PATTERN.test(listRes.stdout)) {
      const noModelsLine = listRes.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^No models available\b/.test(line));
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        authDetail: noModelsLine ?? firstNonEmptyLine(listRes.stdout),
        detail: listRes.stdout.trim(),
        guidance: LOGIN_GUIDANCE,
      });
    }
    if (listRes.exitCode !== 0) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"pi --list-models" thất bại (mã thoát ${listRes.exitCode})${stderrTail(listRes)}`,
          AGENT,
        ),
      );
    }
    const models = yield* Effect.try({
      try: () => parseModelsTable(listRes.stdout),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "pi --list-models": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });

    // 4. Evidence for `authDetail`: one read-only auth check per provider in
    // the catalog. `--no-refresh` keeps the probe from writing refreshed
    // OAuth tokens; inconclusive checks never override the catalog — pi
    // already filtered it to providers that can actually serve a model.
    const providers = [
      ...new Set(
        models
          .map((m) => m.provider)
          .filter((p): p is string => p !== undefined),
      ),
    ];
    const authSummaries: string[] = [];
    for (const provider of providers) {
      const parsed = yield* checkProviderAuth(exec, provider);
      if (parsed !== undefined) authSummaries.push(formatAuthCheck(parsed));
    }
    const authDetail =
      authSummaries.length > 0
        ? authSummaries.join("; ")
        : `model providers: ${providers.join(", ")}`;

    // Recommendation: pi defaults `--provider` to google, so its first
    // catalog entry is the pick when present — otherwise the catalog's
    // first row (pi sorts by provider, then model id).
    const recommended =
      models.find((m) => m.provider === DEFAULT_PROVIDER) ?? models[0]!;

    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail,
      models,
      recommendedModel: recommended.id,
      ...(recommended.defaultEffort !== undefined
        ? { recommendedEffort: recommended.defaultEffort }
        : {}),
    });
  });

/**
 * The Pi discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const piDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverPi(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Pi: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

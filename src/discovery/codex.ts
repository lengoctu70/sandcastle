import { Effect } from "effect";
import { VERSION } from "../version.js";
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
 * Codex discovery adapter — establishes the contract every other adapter
 * follows.
 *
 * Probes, in order:
 * 1. `codex --version` — product fingerprint (`codex-cli`) + version.
 * 2. `codex login status` — subscription readiness ("Logged in using ChatGPT").
 * 3. `codex app-server` — the JSON-RPC `model/list` protocol over stdio
 *    (initialize → initialized → model/list, paginated). When the app-server
 *    transport itself is unavailable (older CLIs, protocol errors, timeouts),
 *    `codex debug models` is the documented fallback — it exposes equivalent
 *    catalog data (slug, display_name, default_reasoning_level,
 *    supported_reasoning_levels). Malformed *data* in either path is a
 *    `DiscoveryDataError` and never falls back.
 */

const EXECUTABLE = "codex";
const AGENT = "codex";

/** `codex --version` prints `codex-cli <version>` — the product fingerprint. */
const FINGERPRINT_PATTERN = /\bcodex-cli\b/;
const VERSION_PATTERN = /codex-cli\s+(\S+)/;
/** `codex login status` line-anchored login marker ("Logged in using ChatGPT"). */
const LOGGED_IN_PATTERN = /^[^\S\r\n]*logged in\b/im;
/** Explicit logged-out markers checked before the positive one. */
const LOGGED_OUT_PATTERN = /not logged in|no credentials|unauthor/i;

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;
/** Page size for `model/list`; a 200-cap bounds pagination loops. */
const MODEL_LIST_PAGE_LIMIT = 200;
const MAX_CATALOG_PAGES = 10;

/** JSON-RPC request id for `model/list` — unique within one session. */
const MODEL_LIST_REQUEST_ID = "sandcastle-model-list";

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Codex CLI (lệnh `codex` không có trên PATH). " +
  "Cài đặt bằng `npm install -g @openai/codex`, rồi chạy `codex login` để đăng nhập, " +
  "sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Codex đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `codex login` để đăng nhập bằng tài khoản ChatGPT của bạn, rồi chạy lại `sandcastle init`.";

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

const requiredString = (
  value: unknown,
  field: string,
  where: string,
): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiscoveryDataError(
      `Catalog của Codex có dữ liệu không hợp lệ: ${where} thiếu trường "${field}". ` +
        "Phiên bản Codex có thể quá cũ hoặc quá mới — hãy cập nhật Codex rồi thử lại.",
      AGENT,
      field,
    );
  }
  return value;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const stderrTail = (res: DiscoveryExecResult): string => {
  const tail = (res.stderr || res.stdout)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  return tail.length > 0 ? `: ${tail}` : "";
};

// ---------------------------------------------------------------------------
// Catalog entry normalization (shared by both catalog protocols)
// ---------------------------------------------------------------------------

/**
 * Internal catalog row: the normalized model plus recommendation metadata.
 * `recommendedScore` orders candidates for the "recommended" pick — lowest
 * wins; app-server's `isDefault` maps to 0, debug-models' `priority` is used
 * as-is (0 is Codex's flagship in the observed catalog), and everything else
 * falls behind at a large constant.
 */
interface CatalogEntry {
  readonly model: DiscoveredModel;
  readonly hidden: boolean;
  readonly recommendedScore: number;
}

const assembleCatalog = (
  entries: readonly CatalogEntry[],
): {
  models: DiscoveredModel[];
  recommendedModel: string;
  recommendedEffort?: string;
} => {
  const visible = entries.filter((entry) => !entry.hidden);
  if (visible.length === 0) {
    throw new DiscoveryDataError(
      "Codex trả về catalog rỗng — không có model nào để chọn. " +
        "Cập nhật Codex CLI rồi thử lại.",
      AGENT,
      "models",
    );
  }
  const recommended = visible.reduce((best, entry) =>
    entry.recommendedScore < best.recommendedScore ? entry : best,
  );
  return {
    models: visible.map((entry) => entry.model),
    recommendedModel: recommended.model.id,
    recommendedEffort: recommended.model.defaultEffort,
  };
};

// ---------------------------------------------------------------------------
// App-server `model/list` (JSON-RPC over stdio) — primary catalog protocol
// ---------------------------------------------------------------------------

interface ModelListPage {
  readonly entries: CatalogEntry[];
  readonly nextCursor: string | null;
}

const parseReasoningEfforts = (
  raw: unknown,
  where: string,
): DiscoveredEffort[] => {
  if (!Array.isArray(raw)) {
    throw new DiscoveryDataError(
      `Catalog của Codex có dữ liệu không hợp lệ: ${where} thiếu danh sách effort.`,
      AGENT,
      where,
    );
  }
  return raw.map((entry, i) => ({
    id: requiredString(
      isRecord(entry) ? entry["reasoningEffort"] : undefined,
      `reasoningEffort`,
      `${where}.supportedReasoningEfforts[${i}]`,
    ),
    ...(isRecord(entry) && optionalString(entry["description"]) !== undefined
      ? { description: entry["description"] as string }
      : {}),
  }));
};

const parseAppServerModel = (raw: unknown, index: number): CatalogEntry => {
  const where = `models[${index}]`;
  if (!isRecord(raw)) {
    throw new DiscoveryDataError(
      `Catalog của Codex có dữ liệu không hợp lệ: ${where} không phải một đối tượng.`,
      AGENT,
      where,
    );
  }
  const model: DiscoveredModel = {
    // `id` is the catalog identifier Codex accepts back via `-m`.
    id: requiredString(raw["id"], "id", where),
    displayName: requiredString(raw["displayName"], "displayName", where),
    ...(optionalString(raw["description"]) !== undefined
      ? { description: raw["description"] as string }
      : {}),
    effortChoices: parseReasoningEfforts(
      raw["supportedReasoningEfforts"],
      where,
    ),
    defaultEffort: requiredString(
      raw["defaultReasoningEffort"],
      "defaultReasoningEffort",
      where,
    ),
  };
  return {
    model,
    hidden: raw["hidden"] === true,
    recommendedScore: raw["isDefault"] === true ? 0 : index + 1,
  };
};

const parseModelListResult = (result: unknown): ModelListPage => {
  if (!isRecord(result) || !Array.isArray(result["data"])) {
    throw new DiscoveryDataError(
      'Phản hồi `model/list` của Codex không hợp lệ: thiếu mảng "data".',
      AGENT,
      "data",
    );
  }
  const rawCursor = result["nextCursor"];
  if (
    rawCursor !== undefined &&
    rawCursor !== null &&
    typeof rawCursor !== "string"
  ) {
    throw new DiscoveryDataError(
      'Phản hồi `model/list` của Codex không hợp lệ: "nextCursor" phải là chuỗi hoặc null.',
      AGENT,
      "nextCursor",
    );
  }
  return {
    entries: result["data"].map(parseAppServerModel),
    nextCursor: rawCursor ?? null,
  };
};

const extractJsonRpcError = (error: unknown): string => {
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  return JSON.stringify(error);
};

/**
 * One app-server session: spawn `codex app-server` (stdio transport), pipe
 * `initialize` + `initialized` + `model/list` in as newline-delimited JSON-RPC,
 * and capture the responses from stdout. Pagination needs the previous page's
 * cursor, so each page runs its own short-lived session.
 */
const modelListPage = (
  exec: DiscoveryExec,
  cursor: string | null,
): Effect.Effect<ModelListPage, DiscoveryError> =>
  Effect.gen(function* () {
    const requests = [
      {
        id: "sandcastle-init",
        method: "initialize",
        params: {
          clientInfo: { name: "sandcastle", version: VERSION },
        },
      },
      // MCP-style handshake notification — no id, no response expected.
      { method: "initialized" },
      {
        id: MODEL_LIST_REQUEST_ID,
        method: "model/list",
        params: {
          ...(cursor !== null ? { cursor } : {}),
          includeHidden: false,
          limit: MODEL_LIST_PAGE_LIMIT,
        },
      },
    ];
    const stdin = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const res = yield* runCodex(exec, ["app-server"], {
      stdin,
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    return yield* Effect.try({
      try: () => parseModelListStdout(res),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được phản hồi của "codex app-server": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });
  });

/**
 * Extract the `model/list` response from captured app-server stdout and parse
 * its catalog. Throws `DiscoveryError` for transport-level failures (spawn
 * error, timeout, JSON-RPC error, missing response) and `DiscoveryDataError`
 * for malformed catalog data.
 */
const parseModelListStdout = (res: DiscoveryExecResult): ModelListPage => {
  if (res.spawnError !== undefined) {
    throw new DiscoveryError(
      `Không khởi động được "codex app-server" (${res.spawnError})${stderrTail(res)}`,
      AGENT,
    );
  }

  // Scan stdout for the JSON-RPC response carrying our request id — the
  // server may interleave notifications, log lines, or its own requests.
  let response: Record<string, unknown> | undefined;
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(msg) && msg["id"] === MODEL_LIST_REQUEST_ID) {
      response = msg;
    }
  }
  if (response === undefined) {
    throw new DiscoveryError(
      `"codex app-server" không trả về kết quả model/list` +
        `${res.timedOut ? " (hết thời gian chờ)" : ""}${stderrTail(res)}`,
      AGENT,
    );
  }
  if (response["error"] !== undefined) {
    throw new DiscoveryError(
      `Codex app-server từ chối model/list: ${extractJsonRpcError(response["error"])}`,
      AGENT,
    );
  }
  return parseModelListResult(response["result"]);
};

const fetchCatalogViaAppServer = (
  exec: DiscoveryExec,
): Effect.Effect<
  {
    models: DiscoveredModel[];
    recommendedModel: string;
    recommendedEffort?: string;
  },
  DiscoveryError
> =>
  Effect.gen(function* () {
    const entries: CatalogEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const parsed: ModelListPage = yield* modelListPage(exec, cursor);
      entries.push(...parsed.entries);
      cursor = parsed.nextCursor;
      if (cursor === null) {
        return assembleCatalog(entries);
      }
    }
    return yield* Effect.fail(
      new DiscoveryError(
        `Catalog của Codex phân trang quá ${MAX_CATALOG_PAGES} lần — dừng lại để tránh vòng lặp vô hạn.`,
        AGENT,
      ),
    );
  });

// ---------------------------------------------------------------------------
// `codex debug models` — documented fallback catalog
// ---------------------------------------------------------------------------

const parseDebugModel = (raw: unknown, index: number): CatalogEntry => {
  const where = `models[${index}]`;
  if (!isRecord(raw)) {
    throw new DiscoveryDataError(
      `Catalog "codex debug models" không hợp lệ: ${where} không phải một đối tượng.`,
      AGENT,
      where,
    );
  }
  const effortsRaw = raw["supported_reasoning_levels"];
  if (!Array.isArray(effortsRaw)) {
    throw new DiscoveryDataError(
      `Catalog "codex debug models" không hợp lệ: ${where} thiếu "supported_reasoning_levels".`,
      AGENT,
      "supported_reasoning_levels",
    );
  }
  const effortChoices: DiscoveredEffort[] = effortsRaw.map((entry, i) => ({
    id: requiredString(
      isRecord(entry) ? entry["effort"] : undefined,
      "effort",
      `${where}.supported_reasoning_levels[${i}]`,
    ),
    ...(isRecord(entry) && optionalString(entry["description"]) !== undefined
      ? { description: entry["description"] as string }
      : {}),
  }));
  const model: DiscoveredModel = {
    id: requiredString(raw["slug"], "slug", where),
    displayName: requiredString(raw["display_name"], "display_name", where),
    ...(optionalString(raw["description"]) !== undefined
      ? { description: raw["description"] as string }
      : {}),
    effortChoices,
    defaultEffort: requiredString(
      raw["default_reasoning_level"],
      "default_reasoning_level",
      where,
    ),
  };
  const priority = raw["priority"];
  return {
    model,
    hidden: raw["visibility"] === "hide",
    // `priority: 0` is Codex's flagship/recommended slot in the raw catalog.
    recommendedScore:
      typeof priority === "number" && Number.isFinite(priority)
        ? priority
        : index + 1000,
  };
};

/**
 * Parse captured `codex debug models` output — a single-line `{"models":[…]}`
 * document (possibly behind banner/log lines). Throws `DiscoveryError` for
 * transport-level failures and `DiscoveryDataError` for malformed data.
 */
const parseDebugCatalogStdout = (
  res: DiscoveryExecResult,
): ReturnType<typeof assembleCatalog> => {
  if (res.spawnError !== undefined) {
    throw new DiscoveryError(
      `Không chạy được "codex debug models" (${res.spawnError})`,
      AGENT,
    );
  }
  if (res.exitCode !== 0 || res.timedOut) {
    throw new DiscoveryError(
      `"codex debug models" thất bại${res.timedOut ? " (hết thời gian chờ)" : ` (mã thoát ${res.exitCode})`}${stderrTail(res)}`,
      AGENT,
    );
  }
  // The catalog is one {"models":[…]} JSON document — observed output is a
  // single line, but tolerate pretty-printed output and surrounding banner
  // lines: try the whole tail from the first `{`, then individual lines.
  const candidates: string[] = [];
  const firstBrace = res.stdout.indexOf("{");
  if (firstBrace !== -1) {
    candidates.push(res.stdout.slice(firstBrace).trim());
  }
  for (const line of res.stdout.split("\n")) {
    if (line.trimStart().startsWith("{")) candidates.push(line.trim());
  }
  let parsed: unknown;
  let parsedOk = false;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parsedOk = true;
      break;
    } catch {
      // Not this candidate — try the next.
    }
  }
  if (!parsedOk) {
    throw new DiscoveryError(
      `"codex debug models" không trả về JSON hợp lệ${stderrTail(res)}`,
      AGENT,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["models"])) {
    throw new DiscoveryDataError(
      `Catalog "codex debug models" không hợp lệ: thiếu mảng "models".`,
      AGENT,
      "models",
    );
  }
  return assembleCatalog(parsed["models"].map(parseDebugModel));
};

const fetchCatalogViaDebugModels = (
  exec: DiscoveryExec,
): Effect.Effect<
  {
    models: DiscoveredModel[];
    recommendedModel: string;
    recommendedEffort?: string;
  },
  DiscoveryError
> =>
  Effect.gen(function* () {
    const res = yield* runCodex(exec, ["debug", "models"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    return yield* Effect.try({
      try: () => parseDebugCatalogStdout(res),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "codex debug models": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });
  });

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runCodex = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { stdin?: string; timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "codex ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`codex\` trên PATH không phải Codex CLI` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Codex bằng `npm install -g @openai/codex`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverCodex = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Fingerprint + version — PATH existence alone proves nothing.
    const versionRes = yield* runCodex(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`codex\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"codex --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Codex.`,
          AGENT,
        ),
      );
    }
    const versionOutput = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
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

    // 2. Auth readiness — `codex login status`.
    const loginRes = yield* runCodex(exec, ["login", "status"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const loginOutput = `${loginRes.stdout}\n${loginRes.stderr}`.trim();
    const authDetail =
      firstNonEmptyLine(loginRes.stdout) ?? firstNonEmptyLine(loginRes.stderr);
    const authenticated =
      loginRes.exitCode === 0 &&
      LOGGED_IN_PATTERN.test(loginOutput) &&
      !LOGGED_OUT_PATTERN.test(loginOutput);
    if (!authenticated) {
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        authDetail,
        detail:
          loginRes.spawnError !== undefined || loginRes.timedOut === true
            ? `Không đọc được trạng thái đăng nhập${stderrTail(loginRes)}`
            : loginOutput,
        guidance: LOGIN_GUIDANCE,
      });
    }

    // 3. Live catalog — app-server `model/list`, `debug models` as the
    // documented equivalent-data fallback for transport-level failures only.
    const catalog = yield* fetchCatalogViaAppServer(exec).pipe(
      Effect.catchIf(
        (e) => !(e instanceof DiscoveryDataError),
        () => fetchCatalogViaDebugModels(exec),
      ),
    );

    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
      ...(catalog.recommendedEffort !== undefined
        ? { recommendedEffort: catalog.recommendedEffort }
        : {}),
    });
  });

/**
 * The Codex discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const codexDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverCodex(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Codex: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

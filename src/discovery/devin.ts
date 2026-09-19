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
 * Devin discovery adapter — follows the contract `codex.ts` established.
 *
 * Probes, in order:
 * 1. `devin --version` — product fingerprint (the `devin ` line prefix, e.g.
 *    `devin 3000.10.31 (b98cc431)`) + version.
 * 2. `devin auth status` — account readiness ("Logged in (via Devin).").
 * 3. `devin models list --format json` — the account-scoped model catalog:
 *    `{ families: [{ family_label, family_uid, slug, aliases, variants:
 *    [{ model_uid, label, cost_tier, cost_summary, … }] }] }`.
 *
 * Devin encodes thinking levels as model VARIANTS selected through `--model`
 * (a family slug, an alias, or an exact `model_uid`) — never a separate
 * effort flag (ADR 0021). Families therefore map to `DiscoveredModel`s and
 * their variants to `effortChoices` whose ids are the exact `model_uid`s the
 * provider passes back unchanged. There is no fallback catalog: a malformed
 * or unreachable catalog is a discovery error, not a stale answer.
 */

const EXECUTABLE = "devin";
const AGENT = "devin";

/** `devin --version` prints `devin <version> (<hash>)` — the line-anchored `devin ` prefix is the fingerprint. */
const FINGERPRINT_PATTERN = /^devin\s+\S+/m;
const VERSION_PATTERN = /^devin\s+(\S+)/m;
/** `devin auth status` line-anchored login marker ("Logged in (via Devin)."). */
const LOGGED_IN_PATTERN = /^[^\S\r\n]*logged in\b/im;
/** Explicit logged-out markers checked before the positive one. */
const LOGGED_OUT_PATTERN = /not logged in|logged out|no credentials|unauthor/i;

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Devin CLI (lệnh `devin` không có trên PATH). " +
  "Cài đặt bằng `curl -fsSL https://cli.devin.ai/install.sh | bash`, " +
  "rồi chạy `devin auth login` để đăng nhập, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Devin đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `devin auth login` để đăng nhập bằng tài khoản Devin của bạn, rồi chạy lại `sandcastle init`.";

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
      `Catalog của Devin có dữ liệu không hợp lệ: ${where} thiếu trường "${field}". ` +
        "Phiên bản Devin có thể quá cũ hoặc quá mới — hãy cập nhật Devin rồi thử lại.",
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
// Catalog parsing — `devin models list --format json`
// ---------------------------------------------------------------------------

/**
 * One catalog variant → one effort choice. The choice's `id` is the exact
 * `model_uid` — the value `--model` accepts back unchanged. `label` (e.g.
 * "Claude Opus 5 High") plus the short `cost_tier` make up the picker hint;
 * both are optional catalog data, never required.
 */
const parseVariant = (raw: unknown, where: string): DiscoveredEffort => {
  if (!isRecord(raw)) {
    throw new DiscoveryDataError(
      `Catalog của Devin có dữ liệu không hợp lệ: ${where} không phải một đối tượng.`,
      AGENT,
      where,
    );
  }
  const uid = requiredString(raw["model_uid"], "model_uid", where);
  const parts = [
    optionalString(raw["label"]),
    optionalString(raw["cost_tier"]),
  ].filter((part): part is string => part !== undefined);
  return {
    id: uid,
    ...(parts.length > 0 ? { description: parts.join(" · ") } : {}),
  };
};

/**
 * One catalog family → one discovered model. `slug` is the `--model`
 * selector and `family_label` the display name — both required. `aliases`
 * are informational (they also work as `--model` selectors) and `variants`
 * become the effort choices; unknown fields are tolerated.
 */
const parseFamily = (raw: unknown, index: number): DiscoveredModel => {
  const where = `families[${index}]`;
  if (!isRecord(raw)) {
    throw new DiscoveryDataError(
      `Catalog của Devin có dữ liệu không hợp lệ: ${where} không phải một đối tượng.`,
      AGENT,
      where,
    );
  }
  const aliasesRaw = raw["aliases"];
  const aliases = Array.isArray(aliasesRaw)
    ? aliasesRaw.filter(
        (alias): alias is string =>
          typeof alias === "string" && alias.length > 0,
      )
    : [];
  const variantsRaw = raw["variants"];
  if (variantsRaw !== undefined && !Array.isArray(variantsRaw)) {
    throw new DiscoveryDataError(
      `Catalog của Devin có dữ liệu không hợp lệ: ${where}.variants không phải một mảng.`,
      AGENT,
      "variants",
    );
  }
  const effortChoices: DiscoveredEffort[] = (variantsRaw ?? []).map(
    (variant, i) => parseVariant(variant, `${where}.variants[${i}]`),
  );
  return {
    id: requiredString(raw["slug"], "slug", where),
    displayName: requiredString(raw["family_label"], "family_label", where),
    ...(aliases.length > 0
      ? { description: `Alias: ${aliases.join(", ")}` }
      : {}),
    effortChoices,
    // No defaultEffort: the catalog does not declare one, and inventing a
    // default would pick a variant the account may not want. Devin resolves
    // the family slug to its own default variant at launch.
  };
};

/**
 * Parse captured `devin models list --format json` output — a single
 * `{"families":[…]}` document. Tolerates banner/log lines around the JSON
 * (same candidate strategy as the Codex debug catalog). Throws
 * `DiscoveryError` for transport-level failures (spawn error, timeout,
 * non-zero exit, unparseable output) and `DiscoveryDataError` for malformed
 * catalog data — there is no fallback path for either.
 */
const parseCatalogResult = (
  res: DiscoveryExecResult,
): { models: DiscoveredModel[]; recommendedModel: string } => {
  if (res.spawnError !== undefined) {
    throw new DiscoveryError(
      `Không chạy được "devin models list" (${res.spawnError})${stderrTail(res)}`,
      AGENT,
    );
  }
  if (res.timedOut === true || res.exitCode !== 0) {
    throw new DiscoveryError(
      `"devin models list" thất bại${res.timedOut === true ? " (hết thời gian chờ)" : ` (mã thoát ${res.exitCode})`}${stderrTail(res)}`,
      AGENT,
    );
  }
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
      `"devin models list --format json" không trả về JSON hợp lệ${stderrTail(res)}`,
      AGENT,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["families"])) {
    throw new DiscoveryDataError(
      'Catalog của Devin không hợp lệ: thiếu mảng "families".',
      AGENT,
      "families",
    );
  }
  const models = parsed["families"].map(parseFamily);
  if (models.length === 0) {
    throw new DiscoveryDataError(
      "Devin trả về catalog rỗng — không có model nào để chọn. " +
        "Kiểm tra quyền truy cập model của tài khoản rồi thử lại.",
      AGENT,
      "families",
    );
  }
  // The catalog's first family is the flagship slot (observed catalogs lead
  // with Claude Opus) — surfaced as the recommended pick.
  return { models, recommendedModel: models[0]!.id };
};

const fetchCatalog = (
  exec: DiscoveryExec,
): Effect.Effect<
  { models: DiscoveredModel[]; recommendedModel: string },
  DiscoveryError
> =>
  Effect.gen(function* () {
    const res = yield* runDevin(exec, ["models", "list", "--format", "json"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    return yield* Effect.try({
      try: () => parseCatalogResult(res),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "devin models list": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });
  });

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runDevin = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "devin ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`devin\` trên PATH không phải Devin CLI` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Devin bằng `curl -fsSL https://cli.devin.ai/install.sh | bash`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverDevin = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Fingerprint + version — PATH existence alone proves nothing.
    const versionRes = yield* runDevin(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`devin\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"devin --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Devin.`,
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

    // 2. Auth readiness — `devin auth status`.
    const authRes = yield* runDevin(exec, ["auth", "status"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const authOutput = `${authRes.stdout}\n${authRes.stderr}`.trim();
    const authDetail =
      firstNonEmptyLine(authRes.stdout) ?? firstNonEmptyLine(authRes.stderr);
    const authenticated =
      authRes.exitCode === 0 &&
      LOGGED_IN_PATTERN.test(authOutput) &&
      !LOGGED_OUT_PATTERN.test(authOutput);
    if (!authenticated) {
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        authDetail,
        detail:
          authRes.spawnError !== undefined || authRes.timedOut === true
            ? `Không đọc được trạng thái đăng nhập${stderrTail(authRes)}`
            : authOutput,
        guidance: LOGIN_GUIDANCE,
      });
    }

    // 3. Live account-scoped catalog — no fallback: a failed or malformed
    // catalog is an honest discovery error, never a bundled stale list.
    const catalog = yield* fetchCatalog(exec);

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
 * The Devin discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const devinDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverDevin(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Devin: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

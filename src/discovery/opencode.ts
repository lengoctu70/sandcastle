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
 * OpenCode discovery adapter — follows the Codex contract (ADR 0021/0026).
 *
 * Probes, in order:
 * 1. `opencode --version` — existence + version. Output is a **bare** version
 *    number (`1.18.31`), so it cannot fingerprint the product on its own.
 * 2. `opencode --help` — product fingerprint: the block-art `opencode` logo
 *    and/or the `opencode <cmd>` command list. A same-named executable that
 *    answers but isn't OpenCode reports `wrong-product` here.
 * 3. `opencode auth list` (alias of `providers list`) — credential readiness.
 *    Ready = at least one stored credential/provider; an empty list, a
 *    non-zero exit, or an unreadable probe all report `unauthenticated`.
 * 4. `opencode models --verbose` — the live catalog: repeated
 *    `provider/model` header lines each followed by a pretty-printed JSON
 *    object (`id`, `providerID`, `name`, `status`, `variants{…}`, …). The
 *    CLI itself only lists models for enabled providers, so the parsed set is
 *    already what the signed-in user can use; models are grouped by
 *    `providerID` via `DiscoveredModel.provider`. A model's `variants` keys
 *    are its effort choices (`opencode run --variant <name>`) — a model with
 *    no variants gets none. Malformed *required* data is a terminal
 *    `DiscoveryDataError`; unknown fields are tolerated so catalog changes
 *    stay compatible.
 */

const EXECUTABLE = "opencode";
const AGENT = "opencode";

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * `opencode --help` fingerprint. The banner is block-art spelling "opencode"
 * (long runs of █/▀/▄); the command list prints one `  opencode <cmd>` line
 * per subcommand. Either signal identifies the product — the command list is
 * required to show several entries so stray prose mentioning "opencode"
 * cannot pass.
 */
const BANNER_PATTERN = /[█▀▄]{4,}/;
const COMMAND_LIST_LINE = /^\s+opencode\s+\S/gm;
const MIN_COMMAND_LIST_LINES = 3;
/** `opencode --version` prints a bare semver (`1.18.31`). */
const VERSION_PATTERN = /(\d+\.\d+\.\d+[\w.-]*)/;

/** Bound on one model's JSON block in `models --verbose` output. */
const MAX_MODEL_BLOCK_LINES = 400;

const INSTALL_GUIDANCE =
  "Chưa tìm thấy OpenCode (lệnh `opencode` không có trên PATH). " +
  "Cài đặt bằng `npm install -g opencode-ai` (hoặc `curl -fsSL https://opencode.ai/install | bash`), " +
  "rồi chạy `opencode auth login` để đăng nhập một provider, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "OpenCode đã được cài đặt nhưng chưa có credential nào. " +
  "Chạy `opencode auth login` để đăng nhập một provider, rồi chạy lại `sandcastle init`.";

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
      `Catalog của OpenCode có dữ liệu không hợp lệ: ${where} thiếu trường "${field}". ` +
        "Phiên bản OpenCode có thể quá cũ hoặc quá mới — hãy cập nhật OpenCode rồi thử lại.",
      AGENT,
      field,
    );
  }
  return value;
};

const stderrTail = (res: DiscoveryExecResult): string => {
  const tail = (res.stderr || res.stdout)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  return tail.length > 0 ? `: ${tail}` : "";
};

/** Strip ANSI SGR/control sequences so styled CLI output parses as text. */
const stripAnsi = (text: string): string =>
  text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");

// ---------------------------------------------------------------------------
// Fingerprint (`opencode --help`)
// ---------------------------------------------------------------------------

const looksLikeOpenCode = (helpOutput: string): boolean =>
  BANNER_PATTERN.test(helpOutput) ||
  (helpOutput.match(COMMAND_LIST_LINE)?.length ?? 0) >= MIN_COMMAND_LIST_LINES;

/**
 * The raw product-identifying evidence for the report: the first
 * `opencode <cmd>` command-list line (whitespace-collapsed), falling back to
 * the banner's first block-art line.
 */
const helpFingerprint = (helpOutput: string): string | undefined => {
  const commandLine = helpOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^opencode\s+\S/.test(line));
  if (commandLine !== undefined) return commandLine.replace(/\s+/g, " ");
  return helpOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => BANNER_PATTERN.test(line));
};

// ---------------------------------------------------------------------------
// Auth readiness (`opencode auth list`)
// ---------------------------------------------------------------------------

interface AuthSummary {
  /** Stored credential count — bullet rows, or the `N credentials` footer. */
  readonly count: number;
  /** Credential display names (e.g. "OpenAI", "OpenCode Go"), in list order. */
  readonly names: string[];
}

/**
 * Parse `opencode auth list` output: clack-styled bullet rows
 * (`●  OpenAI oauth`) plus a `└  N credentials` footer over the auth.json
 * path. Either signal counts — both derive from the same credential list.
 */
const parseAuthList = (output: string): AuthSummary => {
  const clean = stripAnsi(output);
  const names: string[] = [];
  let footerCount: number | undefined;
  for (const line of clean.split("\n")) {
    const bullet = /●\s+(.+?)\s*$/.exec(line);
    if (bullet !== null) {
      // Row shape is `<name> <kind>` where kind is a single trailing token
      // (oauth, api, …); multi-word names keep their internal spaces.
      const row = bullet[1]!.trim().replace(/\s+\S+$/, "");
      names.push(row.length > 0 ? row : bullet[1]!.trim());
      continue;
    }
    const footer = /(\d+)\s+credentials?\b/i.exec(line);
    if (footer !== null) footerCount = Number(footer[1]);
  }
  return { count: Math.max(names.length, footerCount ?? 0), names };
};

// ---------------------------------------------------------------------------
// Catalog (`opencode models --verbose`)
// ---------------------------------------------------------------------------

interface CatalogEntry {
  readonly model: DiscoveredModel;
  readonly hidden: boolean;
}

const parseModel = (raw: unknown, index: number): CatalogEntry => {
  const where = `models[${index}]`;
  if (!isRecord(raw)) {
    throw new DiscoveryDataError(
      `Catalog của OpenCode có dữ liệu không hợp lệ: ${where} không phải một đối tượng.`,
      AGENT,
      where,
    );
  }
  const bareId = requiredString(raw["id"], "id", where);
  const providerID = requiredString(raw["providerID"], "providerID", where);
  const name = requiredString(raw["name"], "name", where);

  // Variants are the model's valid `--variant` values — a provider-specific
  // reasoning-effort knob. A model with no variants gets NO effort choices;
  // nothing is invented.
  const variantsRaw = raw["variants"];
  let effortChoices: DiscoveredEffort[] = [];
  if (variantsRaw !== undefined && variantsRaw !== null) {
    if (!isRecord(variantsRaw)) {
      throw new DiscoveryDataError(
        `Catalog của OpenCode có dữ liệu không hợp lệ: ${where}.variants không phải một đối tượng.`,
        AGENT,
        "variants",
      );
    }
    effortChoices = Object.keys(variantsRaw).map((key) => {
      if (key.length === 0) {
        throw new DiscoveryDataError(
          `Catalog của OpenCode có dữ liệu không hợp lệ: ${where}.variants chứa variant rỗng.`,
          AGENT,
          "variants",
        );
      }
      return { id: key };
    });
  }

  return {
    model: {
      // `--model` takes `provider/model` — the same form the non-verbose
      // `opencode models` list prints. Tolerate an id that already carries
      // the prefix so catalog changes don't double it.
      id: bareId.startsWith(`${providerID}/`)
        ? bareId
        : `${providerID}/${bareId}`,
      displayName: name,
      provider: providerID,
      effortChoices,
    },
    // `status` is the models.dev lifecycle marker; "deprecated" models are no
    // longer selectable, other values (active/beta/…) stay listed.
    hidden: raw["status"] === "deprecated",
  };
};

/**
 * Parse `opencode models --verbose` output — repeated `provider/model` header
 * lines each followed by one JSON object (pretty-printed in observed output,
 * but single-line objects parse the same way). Non-JSON noise between blocks
 * is skipped; an unterminated or unparseable block is `DiscoveryDataError`.
 */
const parseVerboseCatalog = (stdout: string): DiscoveredModel[] => {
  const raws: unknown[] = [];
  let buf: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (buf.length === 0 && !trimmed.startsWith("{")) {
      continue; // `provider/model` header line or other noise.
    }
    buf.push(line);
    if (!trimmed.endsWith("}")) continue;
    try {
      raws.push(JSON.parse(buf.join("\n")));
      buf = [];
    } catch {
      if (buf.length > MAX_MODEL_BLOCK_LINES) {
        throw new DiscoveryDataError(
          `Catalog của OpenCode có dữ liệu không hợp lệ: một khối JSON model vượt quá ${MAX_MODEL_BLOCK_LINES} dòng mà không đọc được.`,
          AGENT,
          "models",
        );
      }
      // Incomplete object — keep accumulating.
    }
  }
  if (buf.length > 0) {
    throw new DiscoveryDataError(
      "Catalog của OpenCode có dữ liệu không hợp lệ: khối JSON cuối cùng không khép kín.",
      AGENT,
      "models",
    );
  }

  const entries = raws.map(parseModel);
  const visible = entries.filter((entry) => !entry.hidden);
  if (visible.length === 0) {
    throw new DiscoveryDataError(
      "OpenCode trả về catalog rỗng — không có model nào để chọn. " +
        "Kiểm tra `opencode auth list` rồi chạy lại `sandcastle init`.",
      AGENT,
      "models",
    );
  }
  return visible.map((entry) => entry.model);
};

const parseCatalogStdout = (res: DiscoveryExecResult): DiscoveredModel[] => {
  if (res.spawnError !== undefined) {
    throw new DiscoveryError(
      `Không chạy được "opencode models --verbose" (${res.spawnError})`,
      AGENT,
    );
  }
  if (res.exitCode !== 0 || res.timedOut === true) {
    throw new DiscoveryError(
      `"opencode models --verbose" thất bại${res.timedOut === true ? " (hết thời gian chờ)" : ` (mã thoát ${res.exitCode})`}${stderrTail(res)}`,
      AGENT,
    );
  }
  return parseVerboseCatalog(res.stdout);
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const runOpencode = (
  exec: DiscoveryExec,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(EXECUTABLE, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "opencode ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  `Lệnh \`opencode\` trên PATH không phải OpenCode CLI` +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài OpenCode bằng `npm install -g opencode-ai`, " +
  "rồi chạy lại `sandcastle init`.";

const baseReport = (
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable: EXECUTABLE,
  models: [],
  ...fields,
});

const discoverOpenCode = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Existence + version — `opencode --version` prints a bare number, so
    // PATH existence plus a semver is necessary but NOT sufficient proof.
    const versionRes = yield* runOpencode(exec, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return baseReport({ state: "not-installed", guidance: INSTALL_GUIDANCE });
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`opencode\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"opencode --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt OpenCode.`,
          AGENT,
        ),
      );
    }
    const version = VERSION_PATTERN.exec(versionRes.stdout)?.[1];

    // 2. Product fingerprint — `opencode --help` carries the block-art logo
    // and the `opencode <cmd>` command list; a same-named foreign binary
    // cannot produce either.
    const helpRes = yield* runOpencode(exec, ["--help"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const helpOutput = `${helpRes.stdout}\n${helpRes.stderr}`.trim();
    if (!looksLikeOpenCode(helpOutput)) {
      const observed = firstNonEmptyLine(helpOutput);
      if (helpRes.timedOut === true || helpRes.spawnError !== undefined) {
        return yield* Effect.fail(
          new DiscoveryError(
            `"opencode --help" không phản hồi được` +
              `${helpRes.timedOut === true ? ` (hết ${PROBE_TIMEOUT_MS / 1000}s)` : ` (${helpRes.spawnError})`} — kiểm tra lại cài đặt OpenCode.`,
            AGENT,
          ),
        );
      }
      if (observed === undefined) {
        return yield* Effect.fail(
          new DiscoveryError(
            `"opencode --help" không trả về nội dung nào (mã thoát ${helpRes.exitCode}) — kiểm tra lại cài đặt OpenCode.`,
            AGENT,
          ),
        );
      }
      return baseReport({
        state: "wrong-product",
        fingerprint: observed,
        detail: helpOutput.split("\n").slice(0, 10).join("\n"),
        guidance: wrongProductGuidance(observed),
      });
    }
    const fingerprint = helpFingerprint(helpOutput);

    // 3. Auth readiness — `opencode auth list` (alias of `providers list`).
    // Ready = at least one stored credential/provider; anything else —
    // zero credentials, a non-zero exit, an unreadable probe — is
    // unauthenticated, never error (the product is verified at this point).
    const authRes = yield* runOpencode(exec, ["auth", "list"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const authOutput = `${authRes.stdout}\n${authRes.stderr}`;
    const auth = parseAuthList(authOutput);
    const authDetail =
      auth.count > 0
        ? `${auth.count} credential${auth.count === 1 ? "" : "s"}` +
          (auth.names.length > 0 ? `: ${auth.names.join(", ")}` : "")
        : firstNonEmptyLine(stripAnsi(authOutput));
    const authenticated = authRes.exitCode === 0 && auth.count > 0;
    if (!authenticated) {
      return baseReport({
        state: "unauthenticated",
        version,
        fingerprint,
        authDetail,
        detail:
          authRes.spawnError !== undefined || authRes.timedOut === true
            ? `Không đọc được trạng thái đăng nhập${stderrTail(authRes)}`
            : stripAnsi(authOutput).trim(),
        guidance: LOGIN_GUIDANCE,
      });
    }

    // 4. Live catalog — `opencode models --verbose`. The CLI lists only
    // models of enabled (i.e. signed-in) providers, so the parsed set is
    // already provider-scoped; `provider` carries the grouping.
    const modelsRes = yield* runOpencode(exec, ["models", "--verbose"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    const models = yield* Effect.try({
      try: () => parseCatalogStdout(modelsRes),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "opencode models --verbose": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });

    return baseReport({
      state: "ready",
      version,
      fingerprint,
      authDetail,
      // The catalog marks no default/flagship model — no recommendation is
      // invented; init falls back to the catalog's first entry.
      models,
    });
  });

/**
 * The OpenCode discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const opencodeDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE,
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverOpenCode(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport({
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được OpenCode: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

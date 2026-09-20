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
 * Grok discovery adapter (xAI Grok Build CLI).
 *
 * Probes, in order:
 * 1. `<exe> --version` — product fingerprint (`grok <semver>`) + version.
 * 2. `<exe> --help` — fallback fingerprint (`Grok Build TUI` banner) and the
 *    `--reasoning-effort` capability check that gates the effort catalog.
 * 3. `<exe> models` — doubles as the auth probe (`You are not authenticated.`)
 *    and the live model catalog (`Default model:` + `Available models:`).
 *
 * Two executable names are probed — `grok` first, then `agent`. xAI installs
 * the same binary under both names, and on the design machine `agent`
 * identifies Grok even though Cursor's integration assumes the same command
 * (ADR 0021). Identity is always established by observed output, never by the
 * executable name — so a Cursor `agent` can never be reported as Grok, and a
 * Grok `agent` is correctly claimed by this adapter, not Cursor's.
 */

const AGENT = "grok";
/** `grok` is canonical; `agent` is the same binary under its alias. */
const EXECUTABLE_CANDIDATES = ["grok", "agent"] as const;

/** `grok --version` prints `grok <semver> (<hash>)` — the product fingerprint. */
const VERSION_FINGERPRINT_PATTERN = /\bgrok\b/i;
const VERSION_PATTERN = /\bgrok\s+(\S+)/i;
/** `grok --help` opens with the `Grok Build TUI` banner — the second fingerprint. */
const HELP_FINGERPRINT_PATTERN = /Grok Build TUI/;
/** Presence of this flag in `--help` proves the binary accepts an effort value. */
const EFFORT_FLAG_PATTERN = /--reasoning-effort/;
/** `grok models` prints this marker when the subscription login is absent/expired. */
const NOT_AUTHENTICATED_PATTERN = /not authenticated/i;

const PROBE_TIMEOUT_MS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Effort values Grok accepts via `--reasoning-effort`, as observed on
 * grok 1.0.30 (`xhigh, high, medium, low`, from the binary's own
 * invalid-value error), sorted ascending. The CLI help never enumerates the
 * valid set, so this list is a suggestion set, not an authoritative catalog —
 * every emitted model carries `effortChoicesExhaustive: false`, and the init
 * picker accepts unlisted values as unverified rather than rejecting a newer
 * CLI's legitimate effort names.
 */
const GROK_EFFORT_CHOICES: readonly DiscoveredEffort[] = [
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh" },
];

const INSTALL_GUIDANCE =
  "Chưa tìm thấy Grok CLI (lệnh `grok` không có trên PATH). " +
  "Cài đặt bằng `curl -fsSL https://x.ai/cli/install.sh | bash`, rồi chạy `grok login` " +
  "để đăng nhập, sau đó chạy lại `sandcastle init`.";

const LOGIN_GUIDANCE =
  "Grok đã được cài đặt nhưng chưa đăng nhập. " +
  "Chạy `grok login` để đăng nhập bằng tài khoản Grok của bạn, rồi chạy lại `sandcastle init`.";

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
// Identity probe — one executable
// ---------------------------------------------------------------------------

type ProbeOutcome =
  | {
      readonly kind: "grok";
      readonly executable: string;
      readonly version?: string;
      readonly fingerprint?: string;
      readonly effortCapable: boolean;
    }
  | { readonly kind: "missing" }
  | {
      readonly kind: "wrong-product";
      readonly executable: string;
      readonly fingerprint?: string;
      readonly detail: string;
    };

const runGrok = (
  exec: DiscoveryExec,
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Effect.Effect<DiscoveryExecResult, DiscoveryError> =>
  Effect.tryPromise({
    try: () => exec(executable, args, options),
    catch: (e) =>
      new DiscoveryError(
        `Không chạy được "${executable} ${args.join(" ")}": ${e instanceof Error ? e.message : String(e)}`,
        AGENT,
      ),
  });

/**
 * Fingerprint one executable by observed output. `--version` is tried first;
 * when its output does not mention Grok, `--help` gets a second chance via the
 * `Grok Build TUI` banner (covers binaries whose version line deviates). The
 * help output also carries the `--reasoning-effort` capability check.
 *
 * Fails (→ `state: "error"`) only when the executable exists but cannot be run
 * or hangs; a non-Grok executable is data (`wrong-product`), not an error.
 */
const probeExecutable = (
  exec: DiscoveryExec,
  executable: string,
): Effect.Effect<ProbeOutcome, DiscoveryError> =>
  Effect.gen(function* () {
    const versionRes = yield* runGrok(exec, executable, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionRes.spawnError === "ENOENT") {
      return { kind: "missing" as const };
    }
    if (versionRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được lệnh \`${executable}\` (${versionRes.spawnError}) — tệp tồn tại nhưng không thực thi được.`,
          AGENT,
        ),
      );
    }
    if (versionRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"${executable} --version" không phản hồi trong ${PROBE_TIMEOUT_MS / 1000}s — kiểm tra lại cài đặt Grok.`,
          AGENT,
        ),
      );
    }
    const versionOutput = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
    const versionFingerprint = firstNonEmptyLine(versionOutput);

    const readHelp = (): Effect.Effect<
      { effortCapable: boolean; output: string } | undefined,
      DiscoveryError
    > =>
      runGrok(exec, executable, ["--help"], {
        timeoutMs: PROBE_TIMEOUT_MS,
      }).pipe(
        Effect.map((res) => {
          if (res.spawnError !== undefined || res.timedOut === true) {
            return undefined;
          }
          const output = `${res.stdout}\n${res.stderr}`.trim();
          return {
            effortCapable: EFFORT_FLAG_PATTERN.test(output),
            output,
          };
        }),
      );

    if (VERSION_FINGERPRINT_PATTERN.test(versionOutput)) {
      // Identity confirmed by the version line; --help is now only the
      // effort-capability probe — a failed help must not sink a verified CLI.
      const help = yield* readHelp();
      return {
        kind: "grok" as const,
        executable,
        version: VERSION_PATTERN.exec(versionOutput)?.[1] ?? versionFingerprint,
        fingerprint: versionFingerprint,
        effortCapable: help?.effortCapable ?? false,
      };
    }

    // Second-chance fingerprint: `Grok Build TUI` in --help.
    const helpRes = yield* runGrok(exec, executable, ["--help"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const helpOutput = `${helpRes.stdout}\n${helpRes.stderr}`.trim();
    if (HELP_FINGERPRINT_PATTERN.test(helpOutput)) {
      return {
        kind: "grok" as const,
        executable,
        version: VERSION_PATTERN.exec(versionOutput)?.[1],
        fingerprint: versionFingerprint ?? firstNonEmptyLine(helpOutput),
        effortCapable: EFFORT_FLAG_PATTERN.test(helpOutput),
      };
    }
    return {
      kind: "wrong-product" as const,
      executable,
      fingerprint: versionFingerprint ?? firstNonEmptyLine(helpOutput),
      detail: versionOutput.length > 0 ? versionOutput : helpOutput,
    };
  });

// ---------------------------------------------------------------------------
// `grok models` — auth probe + live catalog in one call
// ---------------------------------------------------------------------------

/**
 * Parse captured `grok models` output:
 *
 * ```
 * Default model: grok-4.6
 *
 * Available models:
 *   * grok-4.6 (default)
 *   - grok-4.5
 * ```
 *
 * `*` marks the active/default entry, `-` an available one. Throws
 * `DiscoveryDataError` when no catalog can be read — a stale or malformed
 * answer is never presented as discovered truth.
 */
const parseGrokModelsCatalog = (
  output: string,
  effortCapable: boolean,
): { models: DiscoveredModel[]; recommendedModel: string } => {
  const effortChoices = effortCapable ? GROK_EFFORT_CHOICES : [];
  const models: DiscoveredModel[] = [];
  let defaultModel: string | undefined;
  let inModelsSection = false;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const defaultMatch = /^Default model:\s*(\S+)/.exec(line);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }
    if (/^Available models:/i.test(line)) {
      inModelsSection = true;
      continue;
    }
    if (!inModelsSection) continue;
    const bullet = /^[*-]\s+(\S+)/.exec(line);
    if (bullet) {
      const id = bullet[1]!;
      models.push({
        id,
        displayName: id,
        effortChoices,
        // Suggestions only — the CLI never enumerates its valid effort set,
        // so unlisted values are accepted as unverified, not rejected.
        effortChoicesExhaustive: false,
      });
      if (/\(default\)/.test(line) && defaultModel === undefined) {
        defaultModel = id;
      }
      continue;
    }
    // A non-bullet content line ends the section; blank lines are tolerated.
    if (line.length > 0) inModelsSection = false;
  }

  if (models.length === 0) {
    throw new DiscoveryDataError(
      "`grok models` trả về catalog rỗng — không có model nào để chọn. " +
        "Cập nhật Grok CLI rồi thử lại.",
      AGENT,
      "models",
    );
  }
  // `Default model:` may print an alias that is not listed under
  // `Available models:` — recommend it only when it is a catalog member,
  // else the picker would resolve an id that has no catalog entry (F018).
  const recommendedModel =
    defaultModel !== undefined && models.some((m) => m.id === defaultModel)
      ? defaultModel
      : models[0]!.id;
  return { models, recommendedModel };
};

// ---------------------------------------------------------------------------
// Probe pipeline
// ---------------------------------------------------------------------------

const wrongProductGuidance = (fingerprint: string | undefined): string =>
  "Lệnh `grok` trên PATH không phải Grok CLI" +
  (fingerprint !== undefined ? ` (phát hiện: "${fingerprint}")` : "") +
  ". Gỡ hoặc đổi tên chương trình đó, cài Grok bằng " +
  "`curl -fsSL https://x.ai/cli/install.sh | bash`, rồi chạy lại `sandcastle init`.";

const baseReport = (
  executable: string,
  fields: Partial<AgentDiscoveryReport> & Pick<AgentDiscoveryReport, "state">,
): AgentDiscoveryReport => ({
  agent: AGENT,
  executable,
  models: [],
  ...fields,
});

const discoverGrok = (
  exec: DiscoveryExec,
): Effect.Effect<AgentDiscoveryReport, DiscoveryError> =>
  Effect.gen(function* () {
    // 1. Identity — `grok` first, then the `agent` alias of the same binary.
    let identified: Extract<ProbeOutcome, { kind: "grok" }> | undefined;
    let wrongProduct:
      | Extract<ProbeOutcome, { kind: "wrong-product" }>
      | undefined;
    let agentEvidence: string | undefined;
    for (const candidate of EXECUTABLE_CANDIDATES) {
      const outcome = yield* probeExecutable(exec, candidate);
      if (outcome.kind === "grok") {
        identified = outcome;
        break;
      }
      if (outcome.kind === "wrong-product") {
        if (candidate === "grok") {
          wrongProduct = outcome;
        } else {
          agentEvidence = outcome.fingerprint;
        }
      }
      // "missing" → try the next candidate.
    }

    if (identified === undefined) {
      if (wrongProduct !== undefined) {
        return baseReport(wrongProduct.executable, {
          state: "wrong-product",
          fingerprint: wrongProduct.fingerprint,
          detail: wrongProduct.detail,
          guidance: wrongProductGuidance(wrongProduct.fingerprint),
        });
      }
      return baseReport(EXECUTABLE_CANDIDATES[0], {
        state: "not-installed",
        guidance: INSTALL_GUIDANCE,
        ...(agentEvidence !== undefined
          ? {
              detail: `Lệnh \`agent\` trên PATH là một chương trình khác (phát hiện: "${agentEvidence}"), không phải Grok.`,
            }
          : {}),
      });
    }

    const executable = identified.executable;
    const impostorNote =
      wrongProduct !== undefined
        ? ` Lệnh \`grok\` trên PATH là một chương trình khác (phát hiện: "${wrongProduct.fingerprint ?? "không rõ"}"); đang dùng entrypoint \`${executable}\`.`
        : "";

    // 2. Auth + live catalog — `grok models` serves both.
    const modelsRes = yield* runGrok(exec, executable, ["models"], {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    if (modelsRes.spawnError !== undefined) {
      return yield* Effect.fail(
        new DiscoveryError(
          `Không chạy được "${executable} models" (${modelsRes.spawnError})${stderrTail(modelsRes)}`,
          AGENT,
        ),
      );
    }
    const modelsOutput = `${modelsRes.stdout}\n${modelsRes.stderr}`.trim();
    const authDetail = firstNonEmptyLine(modelsRes.stdout);

    if (NOT_AUTHENTICATED_PATTERN.test(modelsOutput)) {
      return baseReport(executable, {
        state: "unauthenticated",
        version: identified.version,
        fingerprint: identified.fingerprint,
        authDetail,
        detail: `${modelsOutput}${impostorNote}`.trim(),
        guidance: LOGIN_GUIDANCE,
      });
    }
    if (modelsRes.exitCode !== 0 || modelsRes.timedOut === true) {
      return yield* Effect.fail(
        new DiscoveryError(
          `"${executable} models" thất bại${modelsRes.timedOut === true ? " (hết thời gian chờ)" : ` (mã thoát ${modelsRes.exitCode})`}${stderrTail(modelsRes)}`,
          AGENT,
        ),
      );
    }

    const catalog = yield* Effect.try({
      try: () => parseGrokModelsCatalog(modelsOutput, identified.effortCapable),
      catch: (e) =>
        e instanceof DiscoveryError
          ? e
          : new DiscoveryError(
              `Không đọc được catalog của "${executable} models": ${e instanceof Error ? e.message : String(e)}`,
              AGENT,
            ),
    });

    return baseReport(executable, {
      state: "ready",
      version: identified.version,
      fingerprint: identified.fingerprint,
      authDetail,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
      ...(impostorNote.length > 0 ? { detail: impostorNote.trim() } : {}),
    });
  });

/**
 * The Grok discovery adapter. `discover` never rejects — every outcome is
 * expressed in the report's `state` (unexpected failures become `"error"`).
 */
export const grokDiscoveryAdapter: AgentDiscoveryAdapter = {
  agent: AGENT,
  executable: EXECUTABLE_CANDIDATES[0],
  installGuidance: INSTALL_GUIDANCE,
  loginGuidance: LOGIN_GUIDANCE,
  discover: (exec) =>
    Effect.runPromise(
      discoverGrok(exec).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            baseReport(EXECUTABLE_CANDIDATES[0], {
              state: "error",
              detail: e instanceof Error ? e.message : String(e),
              guidance: `Không khám phá được Grok: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ),
        ),
      ),
    ),
};

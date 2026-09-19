import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { join } from "node:path";

/**
 * Durable, versioned project settings persisted at
 * `.sandcastle/settings.json` (ADR 0025/0026).
 *
 * `sandcastle init` writes the initial file during {@link scaffold};
 * `sandcastle configure` updates it without touching generated prompts or
 * workflow code; `sandcastle run` reads it to reload the user's choices.
 *
 * Diagnostics are Vietnamese-facing per ADR 0026 — field names and commands
 * stay English.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Current settings schema version. Bump for any non-additive change. */
export const PROJECT_SETTINGS_VERSION = 1;

/** Directory (relative to the repo root) that holds Sandcastle state. */
export const PROJECT_SETTINGS_DIR = ".sandcastle";

/** Settings filename inside {@link PROJECT_SETTINGS_DIR}. */
export const PROJECT_SETTINGS_FILENAME = "settings.json";

/**
 * Sandbox provider choice. `"host"` is the user-facing name for host mode
 * (backed by the no-sandbox provider, ADR 0021); `"docker"`/`"podman"` match
 * the init sandbox registry names.
 */
export type SandboxProviderChoice = "host" | "docker" | "podman";

/**
 * How the configured model was obtained. `"discovered"` means the agent's live
 * catalog reported it at init time; `"manual-unverified"` means it was typed in
 * by hand (or came from a bundled default) and has never been verified against
 * the agent. Persisted so later `configure` screens never mislabel a manual
 * entry as discovered truth.
 */
export type ModelSource = "discovered" | "manual-unverified";

/** Workflow roles that may override the shared agent/model/effort config. */
export type WorkflowRole = "planner" | "implementer" | "reviewer" | "merger";

/** Per-role override of the shared agent/model/effort defaults (ADR 0025). */
export interface RoleOverride {
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
}

export type RoleOverrides = Partial<Record<WorkflowRole, RoleOverride>>;

/**
 * Verification outcome states (ADR 0024). `"passed"`/`"failed"` are written
 * by the run command after it executes `verificationCommands`; init only ever
 * writes `"skipped"` (the user explicitly declined verification) or
 * `"unavailable"` (no candidate commands could be detected). An absent field
 * means commands are configured but have not run yet — so a skipped or
 * missing setup can never be misread as passed.
 */
export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "unavailable";

/**
 * The `.sandcastle/settings.json` document (version 1).
 *
 * Optional keys (`effort`, `roleOverrides`) are omitted from the file entirely
 * when unset rather than serialized as `null`.
 */
export interface ProjectSettings {
  readonly version: typeof PROJECT_SETTINGS_VERSION;
  /** Selected agent name (matches the init agent registry, e.g. `"claude-code"`). */
  readonly agent: string;
  /** Selected model identifier, e.g. `"claude-opus-4-8"`. */
  readonly model: string;
  /** Optional reasoning effort / model variant the agent supports. */
  readonly effort?: string;
  readonly modelSource: ModelSource;
  /** Workflow/template identifier chosen at init, e.g. `"simple-loop"`. */
  readonly workflow: string;
  readonly sandbox: SandboxProviderChoice;
  /** Ordered verification commands run after implementation (may be empty). */
  readonly verificationCommands: readonly string[];
  /**
   * Latest verification state (additive, version 1). Omitted when commands
   * are configured but have not run — `"passed"` is only ever written after a
   * command actually exited 0.
   */
  readonly verificationStatus?: VerificationStatus;
  /** Bounded parallelism for parallel workflows; an integer from 1 to 4. */
  readonly parallelism: number;
  readonly roleOverrides?: RoleOverrides;
  /** Issue tracker choice (matches the init tracker registry, e.g. `"github-issues"`). */
  readonly issueTracker: string;
}

/** Bounded-parallelism limits from ADR 0025 (inclusive). */
export const MIN_PARALLELISM = 1;
export const MAX_PARALLELISM = 4;

const SANDBOX_PROVIDER_CHOICES: readonly SandboxProviderChoice[] = [
  "host",
  "docker",
  "podman",
];
const MODEL_SOURCES: readonly ModelSource[] = [
  "discovered",
  "manual-unverified",
];
/**
 * All workflow roles that may carry a {@link RoleOverride}, in canonical
 * order — `configure` iterates this for the role submenu and `--set-role`
 * validation.
 */
export const WORKFLOW_ROLES: readonly WorkflowRole[] = [
  "planner",
  "implementer",
  "reviewer",
  "merger",
];
const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "passed",
  "failed",
  "skipped",
  "unavailable",
];

/** Absolute path to a repo's `.sandcastle/settings.json`. */
export const projectSettingsPath = (repoDir: string): string =>
  join(repoDir, PROJECT_SETTINGS_DIR, PROJECT_SETTINGS_FILENAME);

// ---------------------------------------------------------------------------
// Errors (plain `Error` subclasses — Effect-free so they can be re-exported
// through index.ts without leaking Effect into the published .d.ts surface).
// ---------------------------------------------------------------------------

/** `.sandcastle/settings.json` does not exist (e.g. pre-settings scaffold). */
export class ProjectSettingsNotFoundError extends Error {
  readonly _tag: "ProjectSettingsNotFoundError" =
    "ProjectSettingsNotFoundError";
  constructor(readonly settingsPath: string) {
    super(
      `Không tìm thấy tệp cấu hình Sandcastle tại "${settingsPath}". ` +
        "Chạy `sandcastle init` để khởi tạo dự án, hoặc `sandcastle configure` " +
        "để tạo tệp cấu hình mà không ghi đè các tệp hiện có.",
    );
    this.name = "ProjectSettingsNotFoundError";
  }
}

/** Settings file exists but is not valid JSON or fails schema validation. */
export class ProjectSettingsMalformedError extends Error {
  readonly _tag: "ProjectSettingsMalformedError" =
    "ProjectSettingsMalformedError";
  constructor(
    readonly settingsPath: string,
    readonly detail: string,
  ) {
    super(
      `Tệp cấu hình Sandcastle tại "${settingsPath}" không hợp lệ: ${detail}. ` +
        "Chạy `sandcastle init` để khởi tạo lại dự án, hoặc `sandcastle configure` " +
        "để tạo lại tệp cấu hình.",
    );
    this.name = "ProjectSettingsMalformedError";
  }
}

/** Settings file was written by a different schema version than this CLI reads. */
export class ProjectSettingsUnsupportedVersionError extends Error {
  readonly _tag: "ProjectSettingsUnsupportedVersionError" =
    "ProjectSettingsUnsupportedVersionError";
  constructor(
    readonly settingsPath: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Tệp cấu hình Sandcastle tại "${settingsPath}" có phiên bản ` +
        `${JSON.stringify(foundVersion)} không được hỗ trợ (phiên bản hiện tại: ` +
        `${PROJECT_SETTINGS_VERSION}). Hãy cập nhật Sandcastle rồi chạy ` +
        "`sandcastle configure`, hoặc chạy `sandcastle init` để khởi tạo lại.",
    );
    this.name = "ProjectSettingsUnsupportedVersionError";
  }
}

/** A settings value supplied by the caller failed validation before writing. */
export class ProjectSettingsValidationError extends Error {
  readonly _tag: "ProjectSettingsValidationError" =
    "ProjectSettingsValidationError";
  constructor(readonly detail: string) {
    super(`Cấu hình Sandcastle không hợp lệ: ${detail}.`);
    this.name = "ProjectSettingsValidationError";
  }
}

/** Filesystem failure while reading or writing the settings file. */
export class ProjectSettingsIoError extends Error {
  readonly _tag: "ProjectSettingsIoError" = "ProjectSettingsIoError";
  constructor(
    readonly settingsPath: string,
    readonly operation: "read" | "write",
    readonly detail: string,
  ) {
    super(
      `Không thể ${operation === "read" ? "đọc" : "ghi"} tệp cấu hình ` +
        `Sandcastle tại "${settingsPath}": ${detail}.`,
    );
    this.name = "ProjectSettingsIoError";
  }
}

/** Failures {@link loadProjectSettings} can produce. */
export type ProjectSettingsLoadError =
  | ProjectSettingsNotFoundError
  | ProjectSettingsMalformedError
  | ProjectSettingsUnsupportedVersionError
  | ProjectSettingsIoError;

/** Failures {@link saveProjectSettings} can produce. */
export type ProjectSettingsSaveError =
  | ProjectSettingsValidationError
  | ProjectSettingsIoError;

/** Any settings-seam failure. */
export type ProjectSettingsError =
  | ProjectSettingsLoadError
  | ProjectSettingsSaveError;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Inputs for the initial settings document written by `scaffold()`. Required
 * fields mirror the choices init already makes; optional fields default to the
 * conservative values documented on {@link ProjectSettings}.
 */
export interface InitialProjectSettings {
  readonly agent: string;
  readonly model: string;
  readonly workflow: string;
  readonly sandbox: SandboxProviderChoice;
  readonly issueTracker: string;
  readonly effort?: string;
  /** Defaults to `"manual-unverified"` — init must opt in to `"discovered"` only when it actually queried the agent's live catalog. */
  readonly modelSource?: ModelSource;
  /** Defaults to `[]`. */
  readonly verificationCommands?: readonly string[];
  /**
   * Defaults to omitted (configured, not yet run). Init writes `"skipped"` or
   * `"unavailable"` when no usable command list was produced.
   */
  readonly verificationStatus?: VerificationStatus;
  /** Defaults to `1` (sequential). Must stay within {@link MIN_PARALLELISM}–{@link MAX_PARALLELISM}. */
  readonly parallelism?: number;
  readonly roleOverrides?: RoleOverrides;
}

/**
 * Optional extras {@link ScaffoldOptions.settings} carries into the initial
 * settings document. Everything omitted falls back to the other scaffold
 * options or the defaults on {@link InitialProjectSettings}.
 */
export interface ProjectSettingsInitOverrides {
  readonly effort?: string;
  readonly modelSource?: ModelSource;
  readonly sandbox?: SandboxProviderChoice;
  readonly verificationCommands?: readonly string[];
  readonly verificationStatus?: VerificationStatus;
  readonly parallelism?: number;
  readonly roleOverrides?: RoleOverrides;
}

/**
 * Assemble a version-1 {@link ProjectSettings} from init choices, applying
 * defaults for omitted fields. Pure — validation happens on save/load.
 */
export const makeProjectSettings = (
  init: InitialProjectSettings,
): ProjectSettings => ({
  version: PROJECT_SETTINGS_VERSION,
  agent: init.agent,
  model: init.model,
  ...(init.effort !== undefined ? { effort: init.effort } : {}),
  modelSource: init.modelSource ?? "manual-unverified",
  workflow: init.workflow,
  sandbox: init.sandbox,
  verificationCommands: init.verificationCommands ?? [],
  ...(init.verificationStatus !== undefined
    ? { verificationStatus: init.verificationStatus }
    : {}),
  parallelism: init.parallelism ?? MIN_PARALLELISM,
  ...(init.roleOverrides !== undefined
    ? { roleOverrides: init.roleOverrides }
    : {}),
  issueTracker: init.issueTracker,
});

// ---------------------------------------------------------------------------
// Update patch
// ---------------------------------------------------------------------------

/**
 * Patch for one role's override. `null` clears that key from the role's
 * override; `undefined` leaves it unchanged.
 */
export interface RoleOverrideUpdate {
  readonly agent?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

/**
 * Partial update applied by {@link updateProjectSettings}.
 *
 * - `undefined` leaves a field unchanged.
 * - `null` clears an optional field (`effort`) or removes a role's override
 *   entry inside `roleOverrides`.
 * - `verificationCommands` and each role-override entry replace wholesale
 *   (per-key `null` clears inside a role entry).
 * - `version` is never updatable.
 */
export interface ProjectSettingsUpdate {
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string | null;
  readonly modelSource?: ModelSource;
  readonly workflow?: string;
  readonly sandbox?: SandboxProviderChoice;
  readonly verificationCommands?: readonly string[];
  /** `null` clears the stored status back to "configured, not yet run". */
  readonly verificationStatus?: VerificationStatus | null;
  readonly parallelism?: number;
  readonly roleOverrides?: Partial<
    Record<WorkflowRole, RoleOverrideUpdate | null>
  >;
  readonly issueTracker?: string;
}

// ---------------------------------------------------------------------------
// Validation / (de)serialization
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const malformed = (path: string, detail: string): never => {
  throw new ProjectSettingsMalformedError(path, detail);
};

const invalid = (detail: string): never => {
  throw new ProjectSettingsValidationError(detail);
};

type FailFn = (detail: string) => never;

const requireString = (value: unknown, field: string, fail: FailFn): string => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`trường "${field}" phải là chuỗi không rỗng`);
  }
  return value;
};

const checkNoUnknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  fail: FailFn,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${where} chứa trường không được hỗ trợ "${key}"`);
    }
  }
};

const parseRoleOverride = (
  value: unknown,
  role: string,
  fail: FailFn,
): RoleOverride => {
  if (!isRecord(value)) {
    fail(`trường "roleOverrides.${role}" phải là một đối tượng`);
  }
  checkNoUnknownKeys(
    value,
    ["agent", "model", "effort"],
    `"roleOverrides.${role}"`,
    fail,
  );
  const out: { agent?: string; model?: string; effort?: string } = {};
  for (const key of ["agent", "model", "effort"] as const) {
    if (value[key] !== undefined) {
      out[key] = requireString(
        value[key],
        `roleOverrides.${role}.${key}`,
        fail,
      );
    }
  }
  return out;
};

const SETTINGS_FIELDS = [
  "version",
  "agent",
  "model",
  "effort",
  "modelSource",
  "workflow",
  "sandbox",
  "verificationCommands",
  "verificationStatus",
  "parallelism",
  "roleOverrides",
  "issueTracker",
] as const;

/**
 * Validate an unknown value as a settings document. Throws
 * {@link ProjectSettingsMalformedError} (when `path` is given) or
 * {@link ProjectSettingsValidationError} (when it is not) on any violation.
 * Unknown keys are rejected so a typo'd edit cannot be silently dropped on the
 * next save.
 */
const validateSettings = (
  raw: unknown,
  path: string | undefined,
): ProjectSettings => {
  const fail: FailFn =
    path === undefined ? invalid : (d: string) => malformed(path, d);
  if (!isRecord(raw)) {
    fail("nội dung không phải là một đối tượng JSON");
  }
  checkNoUnknownKeys(raw, SETTINGS_FIELDS, "tệp cấu hình", fail);

  const agent = requireString(raw["agent"], "agent", fail);
  const model = requireString(raw["model"], "model", fail);
  const workflow = requireString(raw["workflow"], "workflow", fail);
  const issueTracker = requireString(raw["issueTracker"], "issueTracker", fail);

  let effort: string | undefined;
  if (raw["effort"] !== undefined) {
    effort = requireString(raw["effort"], "effort", fail);
  }

  const modelSource = raw["modelSource"];
  if (
    typeof modelSource !== "string" ||
    !MODEL_SOURCES.includes(modelSource as ModelSource)
  ) {
    fail(`trường "modelSource" phải là một trong: ${MODEL_SOURCES.join(", ")}`);
  }

  const sandbox = raw["sandbox"];
  if (
    typeof sandbox !== "string" ||
    !SANDBOX_PROVIDER_CHOICES.includes(sandbox as SandboxProviderChoice)
  ) {
    fail(
      `trường "sandbox" phải là một trong: ${SANDBOX_PROVIDER_CHOICES.join(", ")}`,
    );
  }

  const verificationCommands = raw["verificationCommands"];
  if (!Array.isArray(verificationCommands)) {
    fail(`trường "verificationCommands" phải là một mảng chuỗi`);
  }
  const commands: string[] = [];
  for (const command of verificationCommands as unknown[]) {
    if (typeof command !== "string" || command.length === 0) {
      fail(`trường "verificationCommands" chỉ được chứa chuỗi không rỗng`);
    }
    commands.push(command);
  }

  let verificationStatus: VerificationStatus | undefined;
  const rawStatus = raw["verificationStatus"];
  if (rawStatus !== undefined) {
    if (
      typeof rawStatus !== "string" ||
      !VERIFICATION_STATUSES.includes(rawStatus as VerificationStatus)
    ) {
      fail(
        `trường "verificationStatus" phải là một trong: ${VERIFICATION_STATUSES.join(", ")}`,
      );
    }
    verificationStatus = rawStatus as VerificationStatus;
  }

  const parallelism = raw["parallelism"];
  if (
    typeof parallelism !== "number" ||
    !Number.isInteger(parallelism) ||
    parallelism < MIN_PARALLELISM ||
    parallelism > MAX_PARALLELISM
  ) {
    fail(
      `trường "parallelism" phải là số nguyên từ ${MIN_PARALLELISM} đến ${MAX_PARALLELISM}`,
    );
  }

  let roleOverrides: RoleOverrides | undefined;
  if (raw["roleOverrides"] !== undefined) {
    if (!isRecord(raw["roleOverrides"])) {
      fail(`trường "roleOverrides" phải là một đối tượng`);
    }
    const parsed: Record<string, RoleOverride> = {};
    for (const [role, override] of Object.entries(raw["roleOverrides"])) {
      if (!WORKFLOW_ROLES.includes(role as WorkflowRole)) {
        fail(
          `trường "roleOverrides" chứa vai trò không được hỗ trợ "${role}" ` +
            `(hỗ trợ: ${WORKFLOW_ROLES.join(", ")})`,
        );
      }
      parsed[role] = parseRoleOverride(override, role, fail);
    }
    if (Object.keys(parsed).length > 0) {
      roleOverrides = parsed;
    }
  }

  return {
    version: PROJECT_SETTINGS_VERSION,
    agent,
    model,
    ...(effort !== undefined ? { effort } : {}),
    modelSource: modelSource as ModelSource,
    workflow,
    sandbox: sandbox as SandboxProviderChoice,
    verificationCommands: commands,
    ...(verificationStatus !== undefined ? { verificationStatus } : {}),
    parallelism,
    ...(roleOverrides !== undefined ? { roleOverrides } : {}),
    issueTracker,
  };
};

/**
 * Parse raw settings-file content. Throws {@link ProjectSettingsMalformedError}
 * for invalid JSON/shape and {@link ProjectSettingsUnsupportedVersionError}
 * when `version` differs from {@link PROJECT_SETTINGS_VERSION}.
 */
export const parseProjectSettings = (
  content: string,
  settingsPath: string,
): ProjectSettings => {
  const raw: unknown = (() => {
    try {
      return JSON.parse(content);
    } catch (e) {
      throw new ProjectSettingsMalformedError(
        settingsPath,
        `JSON không hợp lệ (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  })();
  const obj = isRecord(raw)
    ? raw
    : malformed(settingsPath, "nội dung không phải là một đối tượng JSON");
  const version = obj["version"];
  if (version === undefined) {
    malformed(settingsPath, `thiếu trường "version"`);
  }
  if (version !== PROJECT_SETTINGS_VERSION) {
    throw new ProjectSettingsUnsupportedVersionError(settingsPath, version);
  }
  return validateSettings(obj, settingsPath);
};

/**
 * Serialize settings for writing. Throws {@link ProjectSettingsValidationError}
 * if the value would not load back — so a bad document never reaches disk.
 */
export const serializeProjectSettings = (settings: ProjectSettings): string => {
  const validated = validateSettings(
    JSON.parse(JSON.stringify(settings)),
    undefined,
  );
  return JSON.stringify(validated, null, 2) + "\n";
};

// ---------------------------------------------------------------------------
// Effect API (canonical — used by cli.ts, InitService.ts, and tests)
// ---------------------------------------------------------------------------

/**
 * Read and validate `.sandcastle/settings.json`.
 *
 * Fails with a distinct Vietnamese, actionable diagnostic per case:
 * - {@link ProjectSettingsNotFoundError} — file missing (e.g. a project
 *   scaffolded before settings existed); the message points at
 *   `sandcastle init`/`sandcastle configure` as the migration path.
 * - {@link ProjectSettingsMalformedError} — invalid JSON or schema.
 * - {@link ProjectSettingsUnsupportedVersionError} — schema version mismatch.
 * - {@link ProjectSettingsIoError} — other filesystem failures.
 */
export const loadProjectSettings = (
  repoDir: string,
): Effect.Effect<
  ProjectSettings,
  ProjectSettingsLoadError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = projectSettingsPath(repoDir);

    const exists = yield* fs
      .exists(path)
      .pipe(
        Effect.mapError(
          (e) => new ProjectSettingsIoError(path, "read", e.message),
        ),
      );
    if (!exists) {
      return yield* Effect.fail(new ProjectSettingsNotFoundError(path));
    }

    const content = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError((e) =>
          e._tag === "SystemError" && e.reason === "NotFound"
            ? new ProjectSettingsNotFoundError(path)
            : new ProjectSettingsIoError(path, "read", e.message),
        ),
      );

    return yield* Effect.try({
      try: () => parseProjectSettings(content, path),
      catch: (e) =>
        e as
          | ProjectSettingsMalformedError
          | ProjectSettingsUnsupportedVersionError,
    });
  });

/**
 * Write `.sandcastle/settings.json` (creating `.sandcastle/` if needed).
 *
 * Only ever touches the settings file — generated prompts, workflow code, and
 * `.env*` are never rewritten here.
 */
export const saveProjectSettings = (
  repoDir: string,
  settings: ProjectSettings,
): Effect.Effect<void, ProjectSettingsSaveError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = projectSettingsPath(repoDir);
    const serialized = yield* Effect.try({
      try: () => serializeProjectSettings(settings),
      catch: (e) =>
        e instanceof ProjectSettingsValidationError
          ? e
          : new ProjectSettingsValidationError(
              e instanceof Error ? e.message : String(e),
            ),
    });
    yield* fs
      .makeDirectory(join(repoDir, PROJECT_SETTINGS_DIR), { recursive: true })
      .pipe(
        Effect.mapError(
          (e) => new ProjectSettingsIoError(path, "write", e.message),
        ),
      );
    yield* fs
      .writeFileString(path, serialized)
      .pipe(
        Effect.mapError(
          (e) => new ProjectSettingsIoError(path, "write", e.message),
        ),
      );
  });

const mergeRoleOverride = (
  current: RoleOverride | undefined,
  patch: RoleOverrideUpdate,
): RoleOverride | undefined => {
  const merged: { agent?: string; model?: string; effort?: string } = {
    ...current,
  };
  for (const key of ["agent", "model", "effort"] as const) {
    const value = patch[key];
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

type MutableProjectSettings = {
  -readonly [K in keyof ProjectSettings]: ProjectSettings[K];
};

const applyUpdate = (
  settings: ProjectSettings,
  update: ProjectSettingsUpdate,
): ProjectSettings => {
  const next: MutableProjectSettings = { ...settings };

  if (update.agent !== undefined) next.agent = update.agent;
  if (update.model !== undefined) next.model = update.model;
  if (update.modelSource !== undefined) next.modelSource = update.modelSource;
  if (update.workflow !== undefined) next.workflow = update.workflow;
  if (update.sandbox !== undefined) next.sandbox = update.sandbox;
  if (update.issueTracker !== undefined)
    next.issueTracker = update.issueTracker;
  if (update.parallelism !== undefined) next.parallelism = update.parallelism;
  if (update.verificationCommands !== undefined) {
    next.verificationCommands = [...update.verificationCommands];
  }
  if (update.verificationStatus === null) {
    delete next.verificationStatus;
  } else if (update.verificationStatus !== undefined) {
    next.verificationStatus = update.verificationStatus;
  }

  if (update.effort === null) {
    delete next.effort;
  } else if (update.effort !== undefined) {
    next.effort = update.effort;
  }

  if (update.roleOverrides !== undefined) {
    const merged: Record<string, RoleOverride> = {
      ...(settings.roleOverrides ?? {}),
    };
    for (const [role, patch] of Object.entries(update.roleOverrides)) {
      if (patch === null) {
        delete merged[role];
      } else if (patch !== undefined) {
        const result = mergeRoleOverride(merged[role], patch);
        if (result === undefined) delete merged[role];
        else merged[role] = result;
      }
    }
    if (Object.keys(merged).length > 0) {
      next.roleOverrides = merged;
    } else {
      delete next.roleOverrides;
    }
  }

  return next;
};

/**
 * Load, patch, and re-save `.sandcastle/settings.json`, returning the updated
 * settings. See {@link ProjectSettingsUpdate} for patch semantics.
 */
export const updateProjectSettings = (
  repoDir: string,
  update: ProjectSettingsUpdate,
): Effect.Effect<
  ProjectSettings,
  ProjectSettingsError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const current = yield* loadProjectSettings(repoDir);
    const next = applyUpdate(current, update);
    yield* saveProjectSettings(repoDir, next);
    return next;
  });

// ---------------------------------------------------------------------------
// Promise API (public seam re-exported through index.ts)
//
// `effect` must never appear in the published .d.ts surface
// (scripts/check-public-types-effect-free.mjs), so index.ts re-exports these
// Promise wrappers under the canonical names instead of the Effect functions
// above — the same way run()/interactive() wrap their Effect internals.
// ---------------------------------------------------------------------------

const runSettingsEffect = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeFileSystem.layer))).then(
    (exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      // Rethrow the underlying settings error (not a FiberFailure) so callers can
      // use instanceof against the exported error classes.
      throw Cause.squash(exit.cause);
    },
  );

/** Promise variant of {@link loadProjectSettings}, backed by the Node filesystem. */
export const loadProjectSettingsAsync = (
  repoDir: string,
): Promise<ProjectSettings> => runSettingsEffect(loadProjectSettings(repoDir));

/** Promise variant of {@link saveProjectSettings}, backed by the Node filesystem. */
export const saveProjectSettingsAsync = (
  repoDir: string,
  settings: ProjectSettings,
): Promise<void> => runSettingsEffect(saveProjectSettings(repoDir, settings));

/** Promise variant of {@link updateProjectSettings}, backed by the Node filesystem. */
export const updateProjectSettingsAsync = (
  repoDir: string,
  update: ProjectSettingsUpdate,
): Promise<ProjectSettings> =>
  runSettingsEffect(updateProjectSettings(repoDir, update));

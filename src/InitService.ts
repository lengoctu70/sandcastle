import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProjectSettings, saveProjectSettings } from "./ProjectSettings.js";
import type {
  ProjectSettingsInitOverrides,
  SandboxProviderChoice,
} from "./ProjectSettings.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

const GITIGNORE = `.env
logs/
worktrees/
recovery/
`;

/**
 * `.env.example` header emitted instead of the agent API-key block for host
 * mode — the agent reuses its existing host CLI login (ADR 0021). Generated
 * file content stays English; only interactive surfaces are Vietnamese.
 */
const HOST_ENV_NOTE = `# Host mode — the agent reuses its existing CLI login on this machine.
# No agent API key is required.`;

/**
 * Filename of the setup prompt scaffolded for the `custom` issue tracker.
 * Both the per-agent `setupCommand` and the in-scaffold sentinels point at it,
 * so it is defined once here.
 */
const SETUP_ISSUE_TRACKER_DOC = "SETUP_ISSUE_TRACKER.md";
const SETUP_ISSUE_TRACKER_PATH = `.sandcastle/${SETUP_ISSUE_TRACKER_DOC}`;

/**
 * The parallel templates bracket their container-oriented setup block with
 * `// sandcastle:sandbox-setup:start` / `// sandcastle:sandbox-setup:end`
 * markers and tag every `hooks,` option referencing it with a
 * `sandcastle:sandbox-hooks` block comment. At scaffold time the marked
 * block is substituted wholesale: container providers restore the original
 * text (so Docker/Podman output is unchanged), while host mode drops the
 * sandbox-side `npm install` hook and keeps only host dependency reuse via
 * `copyToWorktree` (ADR 0021).
 */
const CONTAINER_PARALLEL_SETUP = `// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];`;

const HOST_PARALLEL_SETUP = `// Reuse host dependencies in each implementer's branch worktree.
const copyToWorktree = ["node_modules"];`;

export interface TemplateMetadata {
  name: string;
  description: string;
  /**
   * Host-side npm packages the template's `main` file imports directly (e.g.
   * the planner templates import `zod` for their `<plan>` output schema). Init
   * offers to install these with the detected package manager so that
   * `npx tsx .sandcastle/main.ts` doesn't crash with ERR_MODULE_NOT_FOUND.
   */
  dependencies?: readonly string[];
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
    dependencies: ["zod"],
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
    dependencies: ["zod"],
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

// ---------------------------------------------------------------------------
// Workflow picker presentation (ADR 0025/0026)
// ---------------------------------------------------------------------------

/**
 * One row in the interactive workflow picker: a Vietnamese, outcome-oriented
 * label bound to a stable internal template id (ADR 0026). The ids are what
 * `--template`, `settings.json#workflow`, and the scaffold directories use —
 * they are never renamed. `recommended` marks the reviewed sequential
 * workflow (quality-first default per ADR 0025's quality/speed trade-off).
 */
export interface WorkflowOption {
  /** Stable internal template identifier, e.g. `"sequential-reviewer"`. */
  readonly template: string;
  /** Vietnamese outcome label shown in the picker. */
  readonly label: string;
  /** Vietnamese hint describing the trade-off, including the template id. */
  readonly hint: string;
  /** The picker's preselected, recommended choice. */
  readonly recommended?: boolean;
}

/**
 * Outcome-ordered workflow choices. Presentation order is deliberate: the
 * reviewed sequential workflow first (recommended), then the fast sequential
 * trade-off, then the two parallel workflows, then custom/blank for advanced
 * users who want the programmable API.
 */
const WORKFLOW_OPTIONS: readonly WorkflowOption[] = [
  {
    template: "sequential-reviewer",
    recommended: true,
    label: "Làm từng issue một, có bước review code (khuyến nghị)",
    hint: "sequential-reviewer — một issue tại một thời điểm, chất lượng được kiểm tra sau mỗi issue",
  },
  {
    template: "simple-loop",
    label: "Làm từng issue một, không có bước review riêng",
    hint: "simple-loop — nhanh hơn, đánh đổi không có review tự động",
  },
  {
    template: "parallel-planner",
    label: "Nhiều issue cùng lúc, do planner chia việc",
    hint: "parallel-planner — tối đa 2 issue song song (cấu hình 1–4 trong configure)",
  },
  {
    template: "parallel-planner-with-review",
    label: "Nhiều issue cùng lúc, có review cho từng nhánh",
    hint: "parallel-planner-with-review — song song và vẫn review mỗi implementation",
  },
  {
    template: "blank",
    label: "Tùy chỉnh — tự viết workflow bằng JS API",
    hint: "blank — scaffold trống cho người dùng nâng cao",
  },
];

export const listWorkflowOptions = (): readonly WorkflowOption[] =>
  WORKFLOW_OPTIONS;

/**
 * Host-side npm packages the given template imports directly. Empty when the
 * template name is unknown or the template declares no extra dependencies.
 */
export const getTemplateDependencies = (
  templateName: string,
): readonly string[] =>
  TEMPLATES.find((t) => t.name === templateName)?.dependencies ?? [];

// ---------------------------------------------------------------------------
// Package manager detection (internal — not part of public API)
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

/** A package manager Sandcastle can detect on the host and build install commands for. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Lockfiles checked in priority order. bun.lock / bun.lockb are both valid bun
// lockfiles (text vs binary), so both map to bun.
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Strip a leading UTF-8 byte-order mark so `JSON.parse` accepts package.json
 * files written by editors that emit one (common on Windows). Only the BOM at
 * position 0 is removed — the rest of the content is left untouched.
 */
const stripBom = (content: string): string =>
  content.startsWith("\uFEFF") ? content.slice(1) : content;

/**
 * Detect the host project's package manager. An explicit corepack-style
 * `packageManager` field in package.json wins; otherwise the first matching
 * lockfile decides. Defaults to npm when nothing matches.
 */
export const detectPackageManager = (
  repoDir: string,
): Effect.Effect<PackageManager, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const pkgPath = join(repoDir, "package.json");
    const pkgExists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (pkgExists) {
      const content = yield* fs
        .readFileString(pkgPath)
        .pipe(Effect.orElseSucceed(() => ""));
      try {
        const pkg = JSON.parse(stripBom(content)) as Record<string, unknown>;
        const field = pkg["packageManager"];
        if (typeof field === "string") {
          const name = field.split("@")[0];
          const match = PACKAGE_MANAGERS.find((pm) => pm === name);
          if (match) return match;
        }
      } catch {
        // Malformed package.json — fall through to lockfile detection.
      }
    }

    for (const [file, pm] of LOCKFILES) {
      const exists = yield* fs
        .exists(join(repoDir, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) return pm;
    }

    return "npm";
  });

/** Build the command that adds a runtime dependency for the given package manager. */
export const addDependencyCommand = (
  packageManager: PackageManager,
  pkg: string,
): string => {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
    case "npm":
      return `npm install ${pkg}`;
  }
};

/**
 * Whether the host package.json already declares `pkg` in any of its dependency
 * maps. Used so init doesn't offer to install something already present.
 */
export const hostHasDependency = (
  repoDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return false;
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const parsed = JSON.parse(stripBom(content)) as Record<string, unknown>;
      const depMaps = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ];
      return depMaps.some((key) => {
        const deps = parsed[key];
        return (
          typeof deps === "object" && deps !== null && pkg in (deps as object)
        );
      });
    } catch {
      return false;
    }
  });

// ---------------------------------------------------------------------------
// Verification-command detection (ADR 0024)
// ---------------------------------------------------------------------------

/**
 * package.json scripts probed as verification candidates, in the order they
 * should run: cheap static checks first, then tests, then the full build.
 */
const NPM_VERIFICATION_SCRIPTS = [
  "typecheck",
  "lint",
  "test",
  "build",
] as const;

/**
 * The script body `npm init` scaffolds for `test` — a placeholder that always
 * fails. It is never a real verification command, so detection skips it.
 */
const NPM_TEST_PLACEHOLDER = /no test specified/i;

/** Render a detected package script as a runnable verification command. */
const scriptCommand = (
  packageManager: PackageManager,
  script: string,
): string =>
  // `npm test` is the idiomatic form for npm's special test alias; every other
  // manager/script pair goes through the uniform `run` subcommand.
  packageManager === "npm" && script === "test"
    ? "npm test"
    : `${packageManager} run ${script}`;

/**
 * Non-npm verification candidates keyed on a config file's presence. These
 * run only when their marker exists, so a Node project never sees `cargo
 * test` suggested. `Makefile` is handled separately — a bare `make test` is
 * only a candidate when the makefile actually declares a `test:` target.
 */
const NON_NPM_VERIFICATION_MARKERS: ReadonlyArray<{
  readonly file: string;
  readonly command: string;
}> = [
  { file: "Cargo.toml", command: "cargo test" },
  { file: "go.mod", command: "go test ./..." },
  { file: "pytest.ini", command: "pytest" },
  { file: "tox.ini", command: "pytest" },
  { file: "pyproject.toml", command: "pytest" },
];

/**
 * Detect candidate verification commands for the project (ADR 0024).
 *
 * Reads `package.json` scripts (`typecheck`, `lint`, `test`, `build` — in
 * that run order) through the detected package manager, then appends
 * non-npm candidates whose config markers exist (`cargo test` for
 * `Cargo.toml`, `pytest` for pytest/tox/pyproject configs, `make test` for a
 * Makefile that declares a `test:` target, …). Returns the ordered,
 * de-duplicated list — confirmation, editing, and skipping all happen in the
 * CLI, which persists the result to `settings.json`.
 */
export const detectVerificationCandidates = (
  repoDir: string,
  packageManager: PackageManager,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const commands: string[] = [];

    const pkgPath = join(repoDir, "package.json");
    const pkgExists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (pkgExists) {
      const content = yield* fs
        .readFileString(pkgPath)
        .pipe(Effect.orElseSucceed(() => ""));
      try {
        const pkg = JSON.parse(stripBom(content)) as Record<string, unknown>;
        const scripts = pkg["scripts"];
        if (typeof scripts === "object" && scripts !== null) {
          for (const name of NPM_VERIFICATION_SCRIPTS) {
            const body = (scripts as Record<string, unknown>)[name];
            if (typeof body !== "string" || body.trim().length === 0) continue;
            // Skip the failing `npm init` test placeholder — suggesting it
            // would configure verification that can never pass.
            if (name === "test" && NPM_TEST_PLACEHOLDER.test(body)) continue;
            commands.push(scriptCommand(packageManager, name));
          }
        }
      } catch {
        // Malformed package.json — no npm-derived candidates.
      }
    }

    for (const marker of NON_NPM_VERIFICATION_MARKERS) {
      const exists = yield* fs
        .exists(join(repoDir, marker.file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) commands.push(marker.command);
    }

    const makefilePath = join(repoDir, "Makefile");
    const makefileExists = yield* fs
      .exists(makefilePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (makefileExists) {
      const content = yield* fs
        .readFileString(makefilePath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (/^test\s*:/m.test(content)) commands.push("make test");
    }

    return [...new Set(commands)];
  });

// ---------------------------------------------------------------------------
// package.json `sandcastle` script (ADR 0026)
// ---------------------------------------------------------------------------

/** The package.json script key init manages. */
export const SANDCASTLE_SCRIPT_NAME = "sandcastle";

/**
 * The fixed script target — `sandcastle run` is the CLI-owned workflow
 * command (ADR 0026), so the normal launch is `npm run sandcastle`.
 */
export const SANDCASTLE_SCRIPT_COMMAND = "sandcastle run";

/**
 * How a conflicting existing `sandcastle` script is resolved. `"ask"` leaves
 * the file untouched and reports the conflict so the caller can prompt;
 * `"overwrite"`/`"keep"` resolve it without asking.
 */
export type ScriptConflictResolution = "ask" | "overwrite" | "keep";

export type PackageScriptOutcome =
  | { readonly kind: "added" }
  | { readonly kind: "already-correct" }
  | { readonly kind: "overwritten" }
  | { readonly kind: "kept-existing" }
  /** package.json exists but is not parseable — nothing was written. */
  | { readonly kind: "skipped-malformed" }
  /**
   * package.json parses, but its `scripts` field is not a string map
   * (array, `null`, or a primitive) — reported and preserved rather than
   * coerced into an object.
   */
  | { readonly kind: "malformed-scripts" }
  /** No package.json at all — a minimal one was created for the script. */
  | { readonly kind: "created-package-json" }
  /**
   * An existing `sandcastle` script differs and resolution was `"ask"`.
   * `existing` is the current script body, for the caller's prompt/error.
   */
  | { readonly kind: "conflict"; readonly existing: string };

/** Indentation used when creating a new package.json or scripts block. */
const detectJsonIndent = (content: string): string => {
  const match = content.match(/\n([ \t]+)"/);
  return match?.[1] ?? "  ";
};

/**
 * Ensure the project has a `"sandcastle": "sandcastle run"` package script
 * (ADR 0026). Unrelated scripts and all other package.json keys are preserved
 * (parsed and re-serialized with the file's detected indentation). A
 * conflicting existing script is never silently overwritten — `resolution`
 * decides, and `"ask"` reports the conflict to the caller instead.
 *
 * When no package.json exists, a minimal `{ "private": true, "scripts": … }`
 * is created so `npm run sandcastle` still works. A malformed package.json
 * yields `skipped-malformed` rather than a destructive rewrite, and a
 * `scripts` field that is not a string map yields `malformed-scripts` —
 * both leave the file byte-identical. Rewrites preserve a leading UTF-8
 * BOM and the file's existing LF or CRLF line-ending convention.
 */
export const ensureSandcastleScript = (
  repoDir: string,
  options?: { readonly resolution?: ScriptConflictResolution },
): Effect.Effect<PackageScriptOutcome, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolution = options?.resolution ?? "ask";
    const pkgPath = join(repoDir, "package.json");

    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) {
      const content =
        JSON.stringify(
          {
            private: true,
            scripts: { [SANDCASTLE_SCRIPT_NAME]: SANDCASTLE_SCRIPT_COMMAND },
          },
          null,
          2,
        ) + "\n";
      yield* fs
        .writeFileString(pkgPath, content)
        .pipe(Effect.mapError((e) => new Error(e.message)));
      return { kind: "created-package-json" };
    }

    // Read raw bytes so a leading UTF-8 BOM stays detectable —
    // `readFileString` decodes it away before `JSON.parse` ever sees it.
    const bytes = yield* fs
      .readFile(pkgPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const hasBom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf;
    const content = new TextDecoder().decode(bytes);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(stripBom(content)) as Record<string, unknown>;
    } catch {
      return { kind: "skipped-malformed" };
    }
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
      return { kind: "skipped-malformed" };
    }

    // A `scripts` field that isn't a string map (array, `null`, primitive)
    // can't be merged safely — report it and leave the file untouched rather
    // than coercing it into an object.
    const rawScripts = pkg["scripts"];
    if (
      rawScripts !== undefined &&
      (typeof rawScripts !== "object" ||
        rawScripts === null ||
        Array.isArray(rawScripts))
    ) {
      return { kind: "malformed-scripts" };
    }
    const scripts = rawScripts as Record<string, unknown> | undefined;

    // Any defined `sandcastle` entry — including a non-string one, which a
    // string check would silently overwrite — goes through the explicit
    // resolution path.
    const existing = scripts?.[SANDCASTLE_SCRIPT_NAME];
    if (existing !== undefined) {
      if (existing === SANDCASTLE_SCRIPT_COMMAND) {
        return { kind: "already-correct" };
      }
      if (resolution === "ask") {
        return {
          kind: "conflict",
          existing:
            typeof existing === "string" ? existing : JSON.stringify(existing),
        };
      }
      if (resolution === "keep") {
        return { kind: "kept-existing" };
      }
    }

    const nextScripts: Record<string, unknown> = { ...(scripts ?? {}) };
    nextScripts[SANDCASTLE_SCRIPT_NAME] = SANDCASTLE_SCRIPT_COMMAND;
    pkg["scripts"] = nextScripts;

    // Re-serialize in the file's own convention: detected indentation, its
    // CRLF line endings if it uses them, and its BOM if it had one.
    let serialized =
      JSON.stringify(pkg, null, detectJsonIndent(content)) + "\n";
    if (content.includes("\r\n")) {
      serialized = serialized.replaceAll("\n", "\r\n");
    }
    if (hasBom) {
      serialized = "\uFEFF" + serialized;
    }
    yield* fs
      .writeFileString(pkgPath, serialized)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    return existing !== undefined ? { kind: "overwritten" } : { kind: "added" };
  });

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
  /** Lines to include in the generated `.env.example` for this agent's API key. */
  readonly envExample: string;
  /**
   * Copy-pasteable interactive command that feeds the custom-issue-tracker
   * setup prompt to this agent's CLI on the host. Printed in init's next steps
   * when the `custom` issue tracker is selected. Runs on the host (the
   * sandbox image isn't built yet), so the user must have the CLI installed.
   */
  readonly setupCommand: string;
  /**
   * Name of the factory-options field that receives the reasoning-effort
   * value — `"effort"` for `codex("gpt-5.6-sol", { effort: "xhigh" })`,
   * `"variant"` for `opencode("openai/gpt-5.6-sol", { variant: "high" })`.
   * When set and init resolved an effort (flag or discovery), the generated
   * `main` passes it to the factory so the persisted `settings.json` value
   * actually reaches the agent CLI. Agents without an effort option leave it
   * unset — their generated call keeps the single-argument form.
   */
  readonly effortOption?: string;
  /**
   * Name of the factory-options field that receives the discovered executable
   * name — `"executable"` for `grok("grok-4.6", { executable: "agent" })`.
   * Host-mode discovery can fingerprint a binary under an alias (xAI ships
   * Grok as both `grok` and `agent`); persisting it means `run` and the
   * generated `main` invoke the exact probed entrypoint. Agents whose
   * factories take no executable option leave this unset — the alias is
   * never emitted for them.
   */
  readonly executableOption?: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CURSOR_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash

# Add Cursor CLI to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const COPILOT_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install GitHub Copilot CLI (run as root before USER agent)
RUN npm install -g @github/copilot

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const DEVIN_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

USER \${AGENT_UID}:\${AGENT_GID}

# Install Devin CLI (installs under the agent user's ~/.local)
RUN curl -fsSL https://cli.devin.ai/install.sh | bash

# Add Devin to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const GROK_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Grok CLI (installs to ~/.grok/bin)
RUN curl -fsSL https://x.ai/cli/install.sh | bash

# Add Grok to PATH
ENV PATH="/home/agent/.grok/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const ANTIGRAVITY_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Antigravity CLI via the official install script (runs as agent →
# ~/.local/bin). In the container, authenticate with GEMINI_API_KEY plus
# modelProvider "gemini" in ~/.gemini/antigravity-cli/settings.json — the
# browser OAuth flow is host-mode territory.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Add agy to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-8",
    factoryImport: "claudeCode",
    effortOption: "effort",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Claude Code OAuth token — get one by running \`claude setup-token\` on your host.
# Lets the agent use your Claude subscription instead of an API key.
CLAUDE_CODE_OAUTH_TOKEN=
# Or use an Anthropic API key instead — uncomment and fill in:
# ANTHROPIC_API_KEY=`,
    setupCommand: `claude "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    // Pi's factory option is named `thinking` — `pi("model", { thinking:
    // "high" })` emits the CLI's `--thinking` flag.
    effortOption: "thinking",
    dockerfileTemplate: PI_DOCKERFILE,
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
    setupCommand: `pi "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4",
    factoryImport: "codex",
    effortOption: "effort",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_KEY=`,
    setupCommand: `codex "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "cursor",
    label: "Cursor",
    defaultModel: "composer-2",
    factoryImport: "cursor",
    dockerfileTemplate: CURSOR_DOCKERFILE,
    envExample: `# Cursor API key (recommended)
# You can also pass --api-key directly to the agent CLI.
CURSOR_API_KEY=`,
    setupCommand: `agent "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    // OpenCode's reasoning effort is the model *variant* — the generated call
    // is `opencode("provider/model", { variant: "high" })` → `--variant high`.
    effortOption: "variant",
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
    setupCommand: `opencode --prompt "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "copilot",
    label: "GitHub Copilot CLI",
    defaultModel: "claude-sonnet-4.5",
    factoryImport: "copilot",
    effortOption: "effort",
    dockerfileTemplate: COPILOT_DOCKERFILE,
    envExample: `# GitHub token with the "Copilot Requests" permission
# (a fine-grained PAT, or any token from \`gh auth login\`).
# COPILOT_GITHUB_TOKEN takes precedence over GH_TOKEN and GITHUB_TOKEN.
GITHUB_TOKEN=`,
    setupCommand: `copilot -i "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "devin",
    label: "Devin",
    defaultModel: "claude-opus-5",
    factoryImport: "devin",
    // Devin encodes thinking levels as model variants — the persisted effort
    // value is the exact catalog `model_uid`, emitted into generated mains as
    // `devin("<family>", { variant: "<model_uid>" })` and passed to
    // `--model` unchanged (ADR 0021).
    effortOption: "variant",
    dockerfileTemplate: DEVIN_DOCKERFILE,
    // Devin has no API-key env var — it authenticates via `devin auth login`
    // (credentials in ~/.local/share/devin/credentials.toml). Host mode never
    // scaffolds an agent env block anyway; in container mode the credentials
    // must be mounted or the user must log in inside the sandbox.
    envExample: `# Devin CLI uses your Devin account login, not an API key.
# Run \`devin auth login\` on the host (credentials live in
# ~/.local/share/devin/credentials.toml) — host mode reuses them directly.`,
    setupCommand: `devin -- "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "grok",
    label: "Grok",
    defaultModel: "grok-4.6",
    factoryImport: "grok",
    effortOption: "effort",
    // Grok's factory accepts `executable` — xAI installs the same binary as
    // both `grok` and `agent`, and discovery reports which one answered.
    executableOption: "executable",
    dockerfileTemplate: GROK_DOCKERFILE,
    // Host mode reuses the machine's `grok login` subscription session — the
    // .env.example block only applies to container sandboxes.
    envExample: `# xAI API key — not needed in host mode (your \`grok login\` session is reused).
XAI_API_KEY=`,
    setupCommand: `grok "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
  {
    name: "antigravity",
    label: "Google Antigravity",
    defaultModel: "gemini-3.8-flash-high",
    factoryImport: "antigravity",
    effortOption: "effort",
    dockerfileTemplate: ANTIGRAVITY_DOCKERFILE,
    envExample: `# Gemini API key — optional alternative to Antigravity's Google sign-in.
# Set "modelProvider": "gemini" in ~/.gemini/antigravity-cli/settings.json and
# export this key to run without the browser OAuth flow (useful in containers).
GEMINI_API_KEY=`,
    // -i runs the setup prompt then keeps an interactive session open — the
    // agy equivalent of Copilot's `-i` seed (not `-p`, which is print-and-exit).
    setupCommand: `agy -i "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`,
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

// ---------------------------------------------------------------------------
// Issue tracker registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface IssueTrackerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    /**
     * The workflow step that finishes a completed issue in simple-loop and
     * sequential-reviewer prompts — a close command for self-managed trackers
     * (beads, custom), a do-not-close instruction for GitHub Issues (ADR 0023:
     * `sandcastle run` reports and closes only after verified landing).
     */
    readonly CLOSE_TASK_INSTRUCTION: string;
    /**
     * Bullet-point rules about mutating issue state in the two sequential
     * prompts (what the agent may close/comment and when).
     */
    readonly ISSUE_MUTATION_RULES: string;
    /**
     * The "# THE ISSUE" guidance in the parallel implementer prompts — what
     * to do with the issue when the task is left incomplete, and who closes it.
     */
    readonly INCOMPLETE_TASK_INSTRUCTION: string;
    /**
     * The issue-handling step in the parallel merge prompts — a close command
     * for self-managed trackers, a do-not-mutate instruction for GitHub Issues.
     */
    readonly MERGE_CLOSE_INSTRUCTION: string;
    readonly ISSUE_TRACKER_TOOLS: string;
  };
  /** Lines to append to `.env.example` for this issue tracker, or empty string if none needed. */
  readonly envExample: string;
  /**
   * `.env.example` block used instead of `envExample` when the sandbox
   * provider runs on the host (ADR 0021). Host mode reuses the machine's
   * existing CLI logins, so a tracker that would need a token inside a
   * container (e.g. GitHub Issues' `GH_TOKEN`, replaced on the host by the
   * `gh` CLI's own `gh auth login` session) emits nothing there.
   */
  readonly hostEnvExample?: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;

// Sentinels baked into the scaffold for the `custom` issue tracker. The
// project ships deliberately broken-until-configured; the setup agent finds
// and replaces these markers in place (see SETUP_ISSUE_TRACKER.md). Defined as
// shared constants so the registry entry and the setup doc stay in sync.
const CUSTOM_LIST_TASKS_SENTINEL = `echo 'No issue tracker configured — run ${SETUP_ISSUE_TRACKER_PATH} through your coding agent.' >&2; exit 1`;
const CUSTOM_VIEW_TASK_MARKER = `<view command — see ${SETUP_ISSUE_TRACKER_PATH}>`;
const CUSTOM_CLOSE_TASK_MARKER = `<close command — see ${SETUP_ISSUE_TRACKER_PATH}>`;
const CUSTOM_TRACKER_TOOLS = `# TODO: install your issue tracker's CLI here. See ${SETUP_ISSUE_TRACKER_PATH}`;
const CUSTOM_ENV_EXAMPLE = `# TODO: add any env vars your issue tracker needs (e.g. an API token).
# See ${SETUP_ISSUE_TRACKER_PATH}`;

const ISSUE_TRACKER_REGISTRY: IssueTrackerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      // ADR 0023: the agent never mutates a GitHub Issue — `sandcastle run`
      // owns the completion report and the close, and only after the work is
      // verified and landed. The generated prompts therefore carry explicit
      // do-not-close/do-not-comment instructions instead of a close command.
      CLOSE_TASK_INSTRUCTION:
        "**Done** — do NOT close or comment on the issue. Sandcastle verifies, merges, reports, and closes it after your work lands.",
      ISSUE_MUTATION_RULES:
        "- Never mutate the issue — no close, comment, edit, or label commands. Sandcastle reports and closes it after your work lands.\n" +
        "- An issue whose work is already committed counts as done — check the recent commits list before picking.\n" +
        "- If you are blocked (missing context, failing tests you cannot fix, external dependency), describe the blocker in your final output and move on.",
      INCOMPLETE_TASK_INSTRUCTION:
        "Do NOT close or comment on the issue — Sandcastle verifies, merges, reports, and closes it after your work lands. If the task is not complete, describe what was done and what remains in your final output.",
      MERGE_CLOSE_INSTRUCTION:
        "Do not close or comment on any issue — Sandcastle reports and closes each one after its merged work is verified and landed.",
      ISSUE_TRACKER_TOOLS: GITHUB_CLI_TOOLS,
    },
    envExample: `# GitHub personal access token — the agent uses it to read and manage GitHub Issues
# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
# Required repository permissions: Issues (Read and write) and Metadata (Read)
GH_TOKEN=`,
    // Host mode talks to GitHub through the `gh` CLI on this machine, which
    // reuses the existing `gh auth login` session — no token is scaffolded.
    hostEnvExample: "",
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_INSTRUCTION:
        '**Close** — close the issue with `bd close <ID> --reason="<what was done>"` explaining what was done.',
      ISSUE_MUTATION_RULES:
        "- Do not close an issue until you have committed the fix and verified tests pass.\n" +
        "- If you are blocked (missing context, failing tests you cannot fix, external dependency), leave a comment on the issue and move on — do not close it.",
      INCOMPLETE_TASK_INSTRUCTION:
        "If the task is not complete, leave a comment on the issue with what was done. Do not close the issue — it is closed after its branch is merged.",
      MERGE_CLOSE_INSTRUCTION:
        'For each branch that was merged, close its issue with `bd close <ID> --reason="<what was done>"`.',
      ISSUE_TRACKER_TOOLS: BEADS_TOOLS,
    },
    envExample: "",
  },
  {
    name: "custom",
    label: "Custom",
    templateArgs: {
      // The only real shell expression: PromptPreprocessor fails the run on a
      // non-zero exit and surfaces stderr, so this is the single enforcement
      // point that keeps the scaffold broken until the user configures it.
      LIST_TASKS_COMMAND: CUSTOM_LIST_TASKS_SENTINEL,
      // Inline text markers — replaced by the setup agent, never executed.
      VIEW_TASK_COMMAND: CUSTOM_VIEW_TASK_MARKER,
      CLOSE_TASK_INSTRUCTION: `**Close** — close the issue with \`${CUSTOM_CLOSE_TASK_MARKER}\` explaining what was done.`,
      ISSUE_MUTATION_RULES:
        "- Do not close an issue until you have committed the fix and verified tests pass.\n" +
        "- If you are blocked (missing context, failing tests you cannot fix, external dependency), leave a comment on the issue and move on — do not close it.",
      INCOMPLETE_TASK_INSTRUCTION:
        "If the task is not complete, leave a comment on the issue with what was done. Do not close the issue — it is closed after its branch is merged.",
      MERGE_CLOSE_INSTRUCTION: `For each branch that was merged, close its issue with \`${CUSTOM_CLOSE_TASK_MARKER}\`.`,
      ISSUE_TRACKER_TOOLS: CUSTOM_TRACKER_TOOLS,
    },
    envExample: CUSTOM_ENV_EXAMPLE,
  },
];

export const listIssueTrackers = (): IssueTrackerEntry[] =>
  ISSUE_TRACKER_REGISTRY;

export const getIssueTracker = (name: string): IssueTrackerEntry | undefined =>
  ISSUE_TRACKER_REGISTRY.find((b) => b.name === name);

/**
 * The `.env.example` block a tracker contributes for the chosen provider.
 * Host mode reuses the machine's existing CLI logins (ADR 0021), so a tracker
 * that only needed a token for in-sandbox use — GitHub Issues' `GH_TOKEN`,
 * which host mode replaces with the `gh` CLI's own login — can substitute a
 * different block (or none) via `hostEnvExample`.
 */
const trackerEnvExample = (
  issueTracker: IssueTrackerEntry,
  runsOnHost: boolean,
): string =>
  runsOnHost
    ? (issueTracker.hostEnvExample ?? issueTracker.envExample)
    : issueTracker.envExample;

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  /**
   * Registry name — the `--sandbox <name>` flag value, the interactive picker
   * value, and the `sandbox` choice persisted to `settings.json`. Host mode's
   * name is the user-facing `"host"` (ADR 0021), not the backing provider's
   * internal `"no-sandbox"` name.
   */
  readonly name: string;
  /** Human-facing picker label. */
  readonly label: string;
  /**
   * Optional picker hint shown next to the label. New user-facing strings are
   * Vietnamese per ADR 0026; identifiers stay English.
   */
  readonly selectHint?: string;
  /**
   * `true` on the entry the interactive picker marks "(khuyến nghị)" and
   * preselects — host mode, the subscription path ADR 0021 recommends. This
   * only steers the interactive default; the scaffold's own default stays
   * docker so library consumers keep the containerized baseline.
   */
  readonly recommended?: boolean;
  /**
   * Image file written to `.sandcastle/` (e.g. "Dockerfile" or
   * "Containerfile"). Absent for providers that never build an image — host
   * mode writes no Dockerfile/Containerfile at all.
   */
  readonly containerfileName?: string;
  /**
   * CLI namespace for `build-image`/`remove-image` (e.g. "docker" or
   * "podman"). Absent for providers with no image commands — host mode skips
   * every image prompt, build operation, and image-oriented next step.
   */
  readonly cliNamespace?: string;
  /**
   * `true` when the provider runs the agent on the host itself — ADR 0021
   * host mode, backed by `noSandbox()`. Host providers reuse the agent's
   * existing host CLI login, so the scaffold omits the agent API-key env
   * block; the CLI shows the host-access warning before saving the choice.
   * Deliberately separate from `cliNamespace`/`containerfileName` presence —
   * a future remote provider could also lack image commands without sharing
   * host mode's trust model.
   */
  readonly runsOnHost?: boolean;
  /**
   * How the provider renders into generated `main` files. Templates always
   * write `docker()` as the placeholder: `importSubpath` replaces `docker`
   * inside the `sandboxes/<subpath>` import path, then `factoryImport`
   * replaces every remaining `docker` identifier (the named import and all
   * call sites).
   */
  readonly codegen: {
    readonly factoryImport: string;
    readonly importSubpath: string;
    /**
     * When set, `branchStrategy: <literal>` is generated into every
     * `run({…})` call that selects this provider via `sandbox:` but pins no
     * `branchStrategy` of its own. Host mode uses it to force
     * `merge-to-head` — the no-sandbox runtime default is `head`, which would
     * run the agent directly in the user's checkout instead of a worktree
     * (ADR 0021 requires a worktree for unattended host runs).
     */
    readonly runBranchStrategy?: string;
  };
}

const SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] = [
  // Host first: the subscription-reusing path ADR 0021 recommends for
  // interactive init, so it leads the picker and carries the marker.
  {
    name: "host",
    label: "Host",
    recommended: true,
    selectHint:
      "Chạy agent trực tiếp trên máy này — dùng lại đăng nhập CLI sẵn có, không cô lập hệ điều hành",
    runsOnHost: true,
    codegen: {
      factoryImport: "noSandbox",
      importSubpath: "no-sandbox",
      runBranchStrategy: '{ type: "merge-to-head" }',
    },
  },
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
    codegen: { factoryImport: "docker", importSubpath: "docker" },
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman",
    codegen: { factoryImport: "podman", importSubpath: "podman" },
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  mainFilename: string,
  issueTracker: IssueTrackerEntry,
  agent: AgentEntry,
  packageManager: PackageManager,
  sandboxProvider: SandboxProviderEntry,
  options?: {
    /**
     * `false` when an existing `sandcastle` package script was kept after a
     * conflict — the launch step then warns that `npm run sandcastle` does
     * not start Sandcastle until the script is fixed. Defaults to `true`
     * (init added the script, or it already pointed at `sandcastle run`).
     */
    readonly packageScriptReady?: boolean;
  },
): string[] {
  // The custom issue tracker scaffolds a broken-until-configured project, so
  // its next steps are about running the setup prompt — not the template's
  // normal "set env vars and go" flow. This branch wins over template-specific
  // steps regardless of the chosen template. Stays English — the custom flow
  // is agent-facing setup work, and the setup doc itself is English.
  if (issueTracker.name === "custom") {
    const hasImage = sandboxProvider.cliNamespace !== undefined;
    return [
      "Next steps:",
      "1. Your custom issue tracker isn't wired up yet — runs hard-fail until you configure it.",
      `2. Feed the setup prompt to ${agent.label} on your host to finish wiring it up:`,
      `   ${agent.setupCommand}`,
      `   (Runs on the host — you need the ${agent.label} CLI installed locally${hasImage ? ", since the sandbox image isn't built yet" : ""}.)`,
      `3. Follow .sandcastle/${SETUP_ISSUE_TRACKER_DOC} to edit the scaffolded files in place${hasImage ? ", build the image," : ""} and verify.`,
    ];
  }

  // The launch step names the auto-added package script (ADR 0026). When a
  // conflicting pre-existing script was kept, say so honestly instead of
  // telling the user `npm run sandcastle` will work.
  const packageScriptReady = options?.packageScriptReady !== false;
  const runStep = packageScriptReady
    ? `Chạy \`npm run sandcastle\` để khởi động — init đã thêm script "sandcastle": "sandcastle run" vào package.json`
    : `Script "sandcastle" trong package.json đã tồn tại với nội dung khác nên được giữ nguyên — \`npm run sandcastle\` sẽ KHÔNG khởi động Sandcastle cho đến khi bạn chỉnh script đó thành "sandcastle run"`;

  // Host mode (ADR 0021): the agent runs on this machine with its existing
  // CLI login — no image to build, no API key to set. Vietnamese per ADR 0026;
  // commands, filenames, and identifiers stay English.
  if (sandboxProvider.runsOnHost) {
    return hostNextStepsLines(
      template,
      mainFilename,
      issueTracker,
      agent,
      packageManager,
      runStep,
    );
  }
  if (template === "blank") {
    const lines = [
      "Các bước tiếp theo:",
      `1. Đặt các biến môi trường cần thiết trong .sandcastle/.env (xem .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   Để dùng Claude subscription thay cho API key, chạy `claude setup-token` trên máy host rồi dán kết quả vào CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      "2. Đọc và chỉnh sửa .sandcastle/prompt.md để mô tả việc bạn muốn agent làm",
      `3. Tùy chỉnh .sandcastle/${mainFilename} — file này dùng JS API (\`run()\`) để điều khiển cách agent chạy`,
      `4. ${runStep}`,
    );
    return lines;
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines: string[] = [
      "Các bước tiếp theo:",
      `${step++}. Đặt các biến môi trường cần thiết trong .sandcastle/.env (xem .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   Để dùng Claude subscription thay cho API key, chạy `claude setup-token` trên máy host rồi dán kết quả vào CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      `${step++}. Template dùng \`copyToWorktree: ["node_modules"]\` để sao chép node_modules của host vào sandbox cho khởi động nhanh — \`npm install\` trong hook onSandboxReady là phần dự phòng cho binary theo nền tảng. Điều chỉnh cả hai nếu bạn dùng package manager khác`,
    );
    if (usesPlanSchema) {
      lines.push(
        `${step++}. Cài đặt schema validator cho output \`<plan>\` của planner — template dùng Zod (\`${addDependencyCommand(packageManager, "zod")}\`), nhưng Valibot, ArkType, hoặc một thư viện Standard Schema bất kỳ đều được (https://standardschema.dev)`,
      );
    }
    lines.push(
      `${step++}. Đọc và chỉnh sửa các tệp prompt trong .sandcastle/ — chúng quyết định việc agent làm`,
    );
    if (hasReviewer) {
      lines.push(
        `${step++}. Tùy chỉnh .sandcastle/CODING_STANDARDS.md theo chuẩn của dự án — reviewer agent đọc tệp này khi review`,
      );
    }
    lines.push(`${step++}. ${runStep}`);
    return lines;
  }
}

/**
 * Next steps for host mode (ADR 0021) — Vietnamese per ADR 0026. There is no
 * image to build and no agent API key to set; the agent reuses its existing
 * host CLI login. Only env the project itself needs (e.g. the issue
 * tracker's) is mentioned. `runStep` carries the shared launch/conflict line.
 */
const hostNextStepsLines = (
  template: string,
  mainFilename: string,
  issueTracker: IssueTrackerEntry,
  agent: AgentEntry,
  packageManager: PackageManager,
  runStep: string,
): string[] => {
  const hasReviewer = template.includes("review");
  const usesPlanSchema = getTemplateDependencies(template).includes("zod");
  const isParallel = template.startsWith("parallel-");
  const lines = [
    "Các bước tiếp theo:",
    `1. Đảm bảo ${agent.label} đã được cài đặt và đăng nhập trên máy này — host mode dùng lại phiên đăng nhập CLI hiện có, không cần API key.`,
  ];
  let step = 2;
  // The env step only appears when the tracker actually needs configuration
  // on the host — GitHub Issues needs none because `gh` reuses the existing
  // login, so host + github-issues scaffolds get no env-var step at all.
  if (trackerEnvExample(issueTracker, true)) {
    lines.push(
      `${step++}. Đặt các biến môi trường cần thiết trong .sandcastle/.env (xem .sandcastle/.env.example)`,
    );
  }
  if (isParallel) {
    // Parallel workflows keep host dependency reuse (copyToWorktree) but
    // carry no container install hook — point that out so the user knows
    // what to adjust for a different dependency layout.
    lines.push(
      `${step++}. Template dùng \`copyToWorktree: ["node_modules"]\` để tái sử dụng dependencies của host trong worktree nhánh riêng của mỗi implementer — điều chỉnh nếu dự án dùng cách quản lý dependencies khác`,
    );
  }
  if (usesPlanSchema) {
    lines.push(
      `${step++}. Cài đặt schema validator cho output \`<plan>\` của planner — template dùng Zod (\`${addDependencyCommand(packageManager, "zod")}\`), nhưng Valibot, ArkType, hoặc một thư viện Standard Schema bất kỳ đều được (https://standardschema.dev)`,
    );
  }
  if (template === "blank") {
    lines.push(
      `${step++}. Đọc và chỉnh sửa .sandcastle/prompt.md để mô tả việc bạn muốn agent làm`,
      `${step++}. Tùy chỉnh .sandcastle/${mainFilename} — file này dùng JS API (\`run()\`) để điều khiển cách agent chạy`,
    );
  } else {
    lines.push(
      `${step++}. Đọc và chỉnh sửa các tệp prompt trong .sandcastle/ — chúng quyết định việc agent làm`,
    );
    if (hasReviewer) {
      lines.push(
        `${step++}. Tùy chỉnh .sandcastle/CODING_STANDARDS.md theo chuẩn của dự án — reviewer agent đọc tệp này khi review`,
      );
    }
    // The sequential templates reuse host dependencies in each worktree via
    // copyToWorktree — there is no image and no in-sandbox install step.
    lines.push(
      `${step++}. Host mode chạy agent trong một git worktree riêng và tái sử dụng dependencies của host qua \`copyToWorktree\` (ví dụ node_modules) — không cần bước cài đặt nào trong worktree`,
    );
  }
  lines.push(`${step++}. ${runStep}`);
  return lines;
};

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map",
];

/**
 * Provider-specific main variants — `main.<provider>.mts` (e.g.
 * `main.host.mts`). A template ships one when the shared `main.mts` cannot
 * produce good output for that provider through rewriting alone: host mode's
 * sequential workflows, for example, drop the container-only `npm install`
 * sandbox hook and describe worktrees rather than containers. Variants are
 * authored provider-native (they call `noSandbox()` directly instead of the
 * `docker()` placeholder) and are never emitted under their own filename.
 */
const PROVIDER_MAIN_VARIANT_RE = /^main\.[^.]+\.mts$/;

/**
 * Copy a template directory into the scaffold. Returns the name of the file
 * used as the main source — `main.<provider>.mts` when the template ships a
 * variant for the selected sandbox provider, else `main.mts` — so
 * {@link rewriteMainTs} knows whether the provider placeholder rewrite
 * applies.
 */
const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
  mainFilename: string,
  sandboxProviderName: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const providerVariant = `main.${sandboxProviderName}.mts`;
    const mainSource = files.includes(providerVariant)
      ? providerVariant
      : "main.mts";
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            f !== ".env.example" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)) &&
            // Provider variants are codegen inputs, not scaffold output:
            // only the selected provider's variant ships, always renamed to
            // the canonical main filename. The shared main.mts is skipped
            // whenever a variant won.
            (PROVIDER_MAIN_VARIANT_RE.test(f)
              ? f === mainSource
              : f !== "main.mts" || mainSource === "main.mts"),
        )
        .map((f) => {
          const destName = f === mainSource ? mainFilename : f;
          return fs
            .copyFile(join(templateDir, f), join(destDir, destName))
            .pipe(Effect.mapError((e) => new Error(e.message)));
        }),
      { concurrency: "unbounded" },
    );
    return mainSource;
  });

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find the offset of the `}` matching the `{` at `openIdx` via naive brace
 * counting — sufficient for generated template mains, where strings inside
 * option literals only ever contain balanced `${…}` interpolations.
 */
const findMatchingBrace = (text: string, openIdx: number): number => {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * Insert `branchStrategy: <literal>` into every `run({…})` call that selects
 * `sandbox: <factory>()` but declares no `branchStrategy` of its own.
 *
 * `x.run({…})` member calls (e.g. `sandbox.run(…)` on a reusable handle) match
 * the `run(` scan but carry no `sandbox:` option, so they're skipped — as are
 * `createSandbox({…})` calls, which never match `run(` and always take an
 * explicit `branch`. Calls that already pin a strategy are left untouched.
 */
const injectRunBranchStrategy = (
  content: string,
  factoryImport: string,
  branchStrategyLiteral: string,
): string => {
  const escapedFactory = escapeRegExp(factoryImport);
  const callRe = /\brun\s*\(\s*\{/g;
  const sandboxRe = new RegExp(`\\bsandbox\\s*:\\s*${escapedFactory}\\(\\)`);
  const sandboxLineRe = new RegExp(
    `^([ \\t]*)sandbox:\\s*${escapedFactory}\\(\\),`,
    "m",
  );
  let result = "";
  let cursor = 0;
  for (
    let match = callRe.exec(content);
    match !== null;
    match = callRe.exec(content)
  ) {
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = findMatchingBrace(content, openBrace);
    if (closeBrace === -1) break;
    let callText = content.slice(match.index, closeBrace + 1);
    if (sandboxRe.test(callText) && !/\bbranchStrategy\b/.test(callText)) {
      callText = callText.replace(
        sandboxLineRe,
        (line, indent: string) =>
          `${line}\n${indent}// Work in a separate worktree and merge back on success —\n${indent}// the agent never edits your checkout directly.\n${indent}branchStrategy: ${branchStrategyLiteral},`,
      );
    }
    result += content.slice(cursor, match.index) + callText;
    cursor = closeBrace + 1;
    // Skip any `run({` matches nested inside the call just processed.
    callRe.lastIndex = closeBrace + 1;
  }
  return result + content.slice(cursor);
};

/**
 * Replace the agent factory and sandbox provider in a scaffolded main.ts.
 *
 * Templates use `claudeCode` as the default agent factory and `docker` as the
 * default sandbox provider. When a different agent, model, or sandbox provider
 * is selected, this function rewrites the imports and factory calls.
 *
 * `providerVariant` is true when the file came from a `main.<provider>.mts`
 * variant rather than the shared `main.mts`. Variants are authored
 * provider-native, so the `docker` placeholder rewrite is skipped for them —
 * running it would also corrupt variant comments that legitimately mention
 * Docker (word-boundary replace cannot tell code from prose).
 */
const rewriteMainTs = (
  configDir: string,
  agent: AgentEntry,
  model: string,
  effort: string | undefined,
  agentExecutable: string | undefined,
  sandboxProvider: SandboxProviderEntry,
  mainFilename: string,
  providerVariant: boolean,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replace(/main\.mts/g, "main.ts");
    }

    // Replace factory function name in imports (e.g. claudeCode → pi)
    // and all factory calls with the correct model.
    // Templates always use claudeCode as the placeholder factory.
    content = content.replace(/\bclaudeCode\b/g, agent.factoryImport);
    // Replace model strings in factory calls: factoryImport("any-model").
    // When init resolved a reasoning effort and the agent's factory accepts
    // one, it is emitted as the options argument — `codex("gpt-5.6-sol",
    // { effort: "xhigh" })` — so the persisted settings.json value reaches
    // the agent CLI without the user editing generated code. The discovered
    // executable alias rides in the same options object for agents whose
    // factory takes one (`grok("…", { executable: "agent" })`).
    const optionEntries: string[] = [];
    if (effort !== undefined && agent.effortOption !== undefined) {
      optionEntries.push(`${agent.effortOption}: ${JSON.stringify(effort)}`);
    }
    if (agentExecutable !== undefined && agent.executableOption !== undefined) {
      optionEntries.push(
        `${agent.executableOption}: ${JSON.stringify(agentExecutable)}`,
      );
    }
    const optionsSuffix =
      optionEntries.length > 0 ? `, { ${optionEntries.join(", ")} }` : "";
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
      "g",
    );
    content = content.replace(
      factoryCallRe,
      () => `${agent.factoryImport}("${model}"${optionsSuffix})`,
    );

    // Replace the sandbox provider. Templates always use `docker` as the
    // placeholder — both the factory identifier and the `sandboxes/docker`
    // import subpath segment. The subpath is rewritten first so the
    // identifier pass never sees it: host mode's factory (`noSandbox`) differs
    // from its subpath (`no-sandbox`), and a single word-boundary replace
    // would wrongly produce `sandboxes/noSandbox`. For docker/podman this is
    // equivalent to the old one-pass replace (both fields equal the name).
    // Provider-variant mains (main.<provider>.mts) are already provider-native
    // and skip this rewrite entirely.
    if (!providerVariant) {
      content = content.replace(
        /sandboxes\/docker\b/g,
        `sandboxes/${sandboxProvider.codegen.importSubpath}`,
      );
      content = content.replace(
        /\bdocker\b/g,
        sandboxProvider.codegen.factoryImport,
      );
    }

    // Resolve the parallel templates' sandbox-setup markers (see
    // CONTAINER_PARALLEL_SETUP above). Container providers get the original
    // block back verbatim; host mode keeps only host dependency reuse via
    // copyToWorktree — the sandbox-side `npm install` hook and its
    // container-oriented comments are container-only artifacts.
    content = content.replace(
      /\/\/ sandcastle:sandbox-setup:start[\s\S]*?\/\/ sandcastle:sandbox-setup:end/,
      sandboxProvider.runsOnHost
        ? HOST_PARALLEL_SETUP
        : CONTAINER_PARALLEL_SETUP,
    );
    content = sandboxProvider.runsOnHost
      ? // Host mode: drop each tagged `hooks,` line entirely — nothing
        // references `hooks` once its declaration is gone.
        content.replace(
          /^[ \t]*\/\* sandcastle:sandbox-hooks \*\/ hooks,\r?\n/gm,
          "",
        )
      : // Container providers: strip the tag, restoring the plain `hooks,`
        // argument so generated output is unchanged.
        content.replace(/\/\* sandcastle:sandbox-hooks \*\/ hooks,/g, "hooks,");

    // Host mode pins an explicit branch strategy into every generated `run()`
    // call that doesn't declare one — the no-sandbox runtime default is
    // `head`, which would run the agent directly in the user's checkout
    // instead of a worktree (ADR 0021).
    const runBranchStrategy = sandboxProvider.codegen.runBranchStrategy;
    if (runBranchStrategy !== undefined) {
      content = injectRunBranchStrategy(
        content,
        sandboxProvider.codegen.factoryImport,
        runBranchStrategy,
      );
    }

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * When the user opted out of the Sandcastle label, strip ` --label Sandcastle`
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = content.replace(/ --label Sandcastle/g, "");
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/** Text file extensions eligible for `{{KEY}}` template argument substitution. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".env",
  ".example",
  // Dockerfile / Containerfile have no extension — handled by name check below
]);

const isTextFile = (filename: string): boolean => {
  if (
    filename === "Dockerfile" ||
    filename === "Containerfile" ||
    filename === ".gitignore"
  )
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments from the issue tracker's
 * `templateArgs` map in all text files in the scaffolded config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  issueTracker: IssueTrackerEntry,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const textFiles = files.filter(isTextFile);
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const original = content;
          for (const [key, value] of Object.entries(
            issueTracker.templateArgs,
          )) {
            content = content.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/**
 * Build the `SETUP_ISSUE_TRACKER.md` prompt scaffolded for the `custom` issue
 * tracker. It addresses the user's coding agent and walks it through wiring up
 * the tracker by editing the scaffolded files in place. The build command is
 * provider-parameterized so it names the actual CLI namespace (docker/podman);
 * host mode has no image, so its variant installs and verifies on the host.
 */
const buildSetupIssueTrackerDoc = (
  sandboxProvider: SandboxProviderEntry,
): string => {
  const hasImage = sandboxProvider.cliNamespace !== undefined;
  const trackerToolsEdit = hasImage
    ? `- **Dockerfile / Containerfile** — replace the line

  \`\`\`
  ${CUSTOM_TRACKER_TOOLS}
  \`\`\`

  with the install steps for your tracker's CLI (if it needs one).`
    : `- **Host machine** — host mode writes no Dockerfile/Containerfile. If your tracker needs a CLI, install and authenticate it on this machine instead (e.g. \`brew install gh\` then \`gh auth login\`).`;
  const buildStep = hasImage
    ? `Once the files are wired up, build the sandbox image:

\`\`\`
sandcastle ${sandboxProvider.cliNamespace} build-image
\`\`\``
    : `Nothing to build — host mode runs the agent directly on your machine, so there is no sandbox image.`;
  const verify = hasImage
    ? "Run your **list** command inside the built image and confirm it returns the open tasks as JSON. If it errors, fix the command or the auth and rebuild."
    : "Run your **list** command on the host and confirm it returns the open tasks as JSON. If it errors, fix the command or the host CLI login.";
  return `# Set up your custom issue tracker

You are a coding agent. Finish wiring up the **custom issue tracker** for this Sandcastle project. It was scaffolded in a deliberately broken-until-configured state: until you complete the steps below, every Sandcastle run hard-fails with a pointer back to this file.

## Goal

Wire up the issue tracker so the scaffolded prompts can **list**, **view**, and **close** tasks. There is no runtime abstraction to implement — the tracker commands are baked into the scaffolded files, so you edit those files **in place**.

## 1. Interview the user

Ask the user:

- Which issue tracker do they use (e.g. Jira, Linear, a GitHub repo other than this one, an internal API)?
- How should the sandbox authenticate — a CLI that is already logged in, or an API token? If a token, what is the environment variable name?

## 2. Produce three commands

Work out, together with the user, the shell commands for:

- **list** — print all open tasks **as JSON** (match the shape the built-in trackers emit: an array of objects, each with at least an id/number, title, and body). This is what the agent reads at the start of every iteration.
- **view** \`<ID>\` — show a single task by id.
- **close** \`<ID>\` — close a single task by id.

## 3. Edit the scaffolded files in place

${trackerToolsEdit}

- **Prompt files (\`.sandcastle/*.md\`)** — replace the sentinel

  \`\`\`
  ${CUSTOM_LIST_TASKS_SENTINEL}
  \`\`\`

  with your **list** command. In the prompt file the sentinel sits inside a Sandcastle **shell expression** — a leading \`!\` followed by the command in backticks — whose output is injected into the prompt before each run. Keep that \`!\` and the surrounding backticks; replace only the command between them, and **remove the \`exit 1\`** (leaving it keeps every run hard-failing). Then replace the \`${CUSTOM_VIEW_TASK_MARKER}\` and \`${CUSTOM_CLOSE_TASK_MARKER}\` markers with your **view** and **close** commands.

- **\`.env.example\`** — replace the \`# TODO\` block with the real env var(s) your tracker needs, then tell the user to set them in \`.sandcastle/.env\`.

## 4. Build the image

${buildStep}

## 5. Verify

${verify}
`;
};

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  templateName?: string;
  createLabel?: boolean;
  issueTracker?: IssueTrackerEntry;
  sandboxProvider?: SandboxProviderEntry;
  /**
   * Optional extras folded into the initial `.sandcastle/settings.json`
   * (effort, model discovery state, verification commands, parallelism,
   * per-role overrides, and a sandbox choice — `"host"` — for when host mode
   * has no `SandboxProviderEntry` yet). Anything omitted falls back to the
   * other scaffold options.
   */
  settings?: ProjectSettingsInitOverrides;
}

export interface ScaffoldResult {
  mainFilename: string;
}

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "main.mts";
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(stripBom(content)) as Record<string, unknown>;
      return pkg["type"] === "module" ? "main.ts" : "main.mts";
    } catch {
      return "main.mts";
    }
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      createLabel = true,
      issueTracker = ISSUE_TRACKER_REGISTRY[0]!, // default: github-issues
      // default: docker — pinned explicitly because the registry's first entry
      // is now host mode (picker order/recommendation), not the default
      // sandbox for library callers.
      sandboxProvider = getSandboxProvider("docker")!,
      settings: settingsOverrides,
    } = options;
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (exists) {
      yield* Effect.fail(
        new Error(
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
        ),
      );
    }

    const mainFilename = yield* detectMainFilename(repoDir);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from agent + issue tracker env blocks. Host mode
    // reuses the agent's existing host CLI login (ADR 0021), so no agent
    // API-key block is scaffolded — only env the project itself needs (e.g.
    // the issue tracker's) is emitted. The tracker's host variant applies
    // too: GitHub Issues needs no GH_TOKEN on the host because the `gh` CLI
    // already carries the user's login.
    const envExampleParts = [
      sandboxProvider.runsOnHost === true ? HOST_ENV_NOTE : agent.envExample,
    ];
    const trackerEnv = trackerEnvExample(
      issueTracker,
      sandboxProvider.runsOnHost === true,
    );
    if (trackerEnv) {
      envExampleParts.push(trackerEnv);
    }
    const envExampleContent = envExampleParts.join("\n") + "\n";

    const { mainSource } = yield* Effect.all(
      {
        // Providers without an image (host mode) have no containerfileName —
        // no Dockerfile/Containerfile is written at all.
        ...(sandboxProvider.containerfileName !== undefined
          ? {
              containerfile: fs
                .writeFileString(
                  join(configDir, sandboxProvider.containerfileName),
                  agent.dockerfileTemplate,
                )
                .pipe(Effect.mapError((e) => new Error(e.message))),
            }
          : {}),
        gitignore: fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        envExample: fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        // Returns which template file backed the scaffolded main — needed
        // below to decide whether the docker() placeholder rewrite applies.
        mainSource: copyTemplateFiles(
          templateDir,
          configDir,
          mainFilename,
          sandboxProvider.name,
        ),
      },
      { concurrency: "unbounded" },
    );

    // Persist the reloadable project-settings seam so later `run`/`configure`
    // commands can reload the init choices without re-prompting. Writes only
    // settings.json — generated prompts and workflow code are untouched.
    // Parallel workflows default to two active issues, everything else to one
    // (ADR 0025's bounded parallelism).
    yield* saveProjectSettings(
      repoDir,
      makeProjectSettings({
        agent: agent.name,
        model,
        effort: settingsOverrides?.effort,
        agentExecutable: settingsOverrides?.agentExecutable,
        modelSource: settingsOverrides?.modelSource,
        workflow: templateName,
        sandbox:
          settingsOverrides?.sandbox ??
          (sandboxProvider.name as SandboxProviderChoice),
        verificationCommands: settingsOverrides?.verificationCommands,
        verificationStatus: settingsOverrides?.verificationStatus,
        parallelism:
          settingsOverrides?.parallelism ??
          (templateName.startsWith("parallel-") ? 2 : 1),
        roleOverrides: settingsOverrides?.roleOverrides,
        issueTracker: issueTracker.name,
      }),
    );

    // Rewrite main file with the selected agent factory, model, effort,
    // executable alias, and sandbox provider. A `main.<provider>.mts` variant
    // is already provider-native, so it skips the docker() placeholder
    // rewrite.
    yield* rewriteMainTs(
      configDir,
      agent,
      model,
      settingsOverrides?.effort,
      settingsOverrides?.agentExecutable,
      sandboxProvider,
      mainFilename,
      mainSource !== "main.mts",
    );

    // Replace issue tracker template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, issueTracker);

    // Strip --label Sandcastle from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    // For the custom issue tracker, drop the setup prompt the user feeds to
    // their coding agent. Written after substituteTemplateArgs so it isn't
    // clobbered and references the resolved sentinel markers the agent finds
    // (not the {{KEY}} names, which are gone by now).
    if (issueTracker.name === "custom") {
      yield* fs
        .writeFileString(
          join(configDir, SETUP_ISSUE_TRACKER_DOC),
          buildSetupIssueTrackerDoc(sandboxProvider),
        )
        .pipe(Effect.mapError((e) => new Error(e.message)));
    }

    return { mainFilename };
  });

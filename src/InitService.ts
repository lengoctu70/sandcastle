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
        const pkg = JSON.parse(content) as Record<string, unknown>;
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
      const parsed = JSON.parse(content) as Record<string, unknown>;
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
    readonly CLOSE_TASK_COMMAND: string;
    readonly ISSUE_TRACKER_TOOLS: string;
  };
  /** Lines to append to `.env.example` for this issue tracker, or empty string if none needed. */
  readonly envExample: string;
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
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by Sandcastle"`,
      ISSUE_TRACKER_TOOLS: GITHUB_CLI_TOOLS,
    },
    envExample: `# GitHub personal access token — the agent uses it to read and manage GitHub Issues
# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
# Required repository permissions: Issues (Read and write) and Metadata (Read)
GH_TOKEN=`,
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_COMMAND: `bd close <ID> --reason="Completed by Sandcastle"`,
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
      CLOSE_TASK_COMMAND: CUSTOM_CLOSE_TASK_MARKER,
      ISSUE_TRACKER_TOOLS: CUSTOM_TRACKER_TOOLS,
    },
    envExample: CUSTOM_ENV_EXAMPLE,
  },
];

export const listIssueTrackers = (): IssueTrackerEntry[] =>
  ISSUE_TRACKER_REGISTRY;

export const getIssueTracker = (name: string): IssueTrackerEntry | undefined =>
  ISSUE_TRACKER_REGISTRY.find((b) => b.name === name);

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
  {
    name: "host",
    label: "Host",
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
    );
  }
  if (template === "blank") {
    const lines = [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "5. Run `npm run sandcastle` to start the agent",
    );
    return lines;
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines: string[] = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`,
    ];
    if (agent.name === "claude-code") {
      lines.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN.",
      );
    }
    lines.push(
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
    );
    if (usesPlanSchema) {
      lines.push(
        `${step++}. Install a schema validator for the planner's \`<plan>\` output — the template uses Zod (\`${addDependencyCommand(packageManager, "zod")}\`), but Valibot, ArkType, or any Standard Schema library works (https://standardschema.dev)`,
      );
    }
    lines.push(
      `${step++}. Read and customize the prompt files in .sandcastle/ — they shape what the agent does`,
    );
    if (hasReviewer) {
      lines.push(
        `${step++}. Customize .sandcastle/CODING_STANDARDS.md with your project's standards — the reviewer agent loads it during review`,
      );
    }
    lines.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines;
  }
}

/**
 * Next steps for host mode (ADR 0021) — Vietnamese per ADR 0026. There is no
 * image to build and no agent API key to set; the agent reuses its existing
 * host CLI login. Only env the project itself needs (e.g. the issue
 * tracker's) is mentioned.
 */
const hostNextStepsLines = (
  template: string,
  mainFilename: string,
  issueTracker: IssueTrackerEntry,
  agent: AgentEntry,
  packageManager: PackageManager,
): string[] => {
  const hasReviewer = template.includes("review");
  const usesPlanSchema = getTemplateDependencies(template).includes("zod");
  const isParallel = template.startsWith("parallel-");
  const lines = [
    "Các bước tiếp theo:",
    `1. Đảm bảo ${agent.label} đã được cài đặt và đăng nhập trên máy này — host mode dùng lại phiên đăng nhập CLI hiện có, không cần API key.`,
  ];
  let step = 2;
  if (issueTracker.envExample) {
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
  lines.push(
    `${step++}. Thêm "sandcastle": "npx tsx .sandcastle/${mainFilename}" vào package.json scripts`,
    `${step++}. Chạy \`npm run sandcastle\` để khởi động agent`,
  );
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
    // the agent CLI without the user editing generated code.
    const optionsSuffix =
      effort !== undefined && agent.effortOption !== undefined
        ? `, { ${agent.effortOption}: ${JSON.stringify(effort)} }`
        : "";
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
      const pkg = JSON.parse(content) as Record<string, unknown>;
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
    // the issue tracker's) is emitted.
    const envExampleParts = [
      sandboxProvider.runsOnHost ? HOST_ENV_NOTE : agent.envExample,
    ];
    if (issueTracker.envExample) {
      envExampleParts.push(issueTracker.envExample);
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
        modelSource: settingsOverrides?.modelSource,
        workflow: templateName,
        sandbox:
          settingsOverrides?.sandbox ??
          (sandboxProvider.name as SandboxProviderChoice),
        verificationCommands: settingsOverrides?.verificationCommands,
        parallelism:
          settingsOverrides?.parallelism ??
          (templateName.startsWith("parallel-") ? 2 : 1),
        roleOverrides: settingsOverrides?.roleOverrides,
        issueTracker: issueTracker.name,
      }),
    );

    // Rewrite main file with the selected agent factory, model, effort, and
    // sandbox provider. A `main.<provider>.mts` variant is already
    // provider-native, so it skips the docker() placeholder rewrite.
    yield* rewriteMainTs(
      configDir,
      agent,
      model,
      settingsOverrides?.effort,
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

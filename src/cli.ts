import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display, type DisplayService } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listWorkflowOptions,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
  detectVerificationCandidates,
  ensureSandcastleScript,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { getDiscoveryAdapter } from "./discovery/registry.js";
import {
  pickHostAgent,
  resolveDiscoveredSelection,
  INIT_STOPPED_MESSAGE,
} from "./discoveryPicker.js";
import { probeGhReadiness, createSandcastleLabel } from "./githubSetup.js";
import { configureCommand } from "./configure.js";
import {
  MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS,
  MAX_TARGET_REBUILD_ATTEMPTS,
  MAX_VERIFICATION_REPAIR_ATTEMPTS,
  PHASE_LABEL,
  runIssueQueueWorkflow,
  runIssueWorkflow,
  type RunIssueWorkflowOptions,
} from "./WorkflowRun.js";
import {
  acquireRetryLock,
  discardRecoveryWork,
  listRecoveryStates,
  probeRecoveryArtifacts,
  readRecoveryState,
  recoveryStatePath,
  RetryLockHeldError,
  type RecoveryReadResult,
  type RecoveryState,
} from "./recovery.js";
import type { GithubIssue } from "./githubIssues.js";
import {
  MAX_PARALLELISM,
  MIN_PARALLELISM,
  type ModelSource,
  type VerificationStatus,
} from "./ProjectSettings.js";
import { ConfigDirError, InitError } from "./errors.js";
import { VERSION } from "./version.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

/**
 * Early repository gate for `init` (F060): the github-issues path probes and
 * mutates GitHub state, which only works inside a usable checkout — `gh`'s
 * "not a git repository" (or an unborn HEAD) otherwise surfaces mislabeled
 * as a GitHub permission failure. Checked before any `gh` invocation so the
 * first error is the actionable repository one.
 */
const requireUsableGitRepo = (cwd: string): Effect.Effect<void, InitError> =>
  Effect.gen(function* () {
    const inWorkTree = yield* Effect.sync(() => {
      try {
        return (
          execSync("git rev-parse --is-inside-work-tree", {
            cwd,
            stdio: ["ignore", "pipe", "ignore"],
          })
            .toString()
            .trim() === "true"
        );
      } catch {
        return false;
      }
    });
    if (!inWorkTree) {
      yield* Effect.fail(
        new InitError({
          message:
            "Thư mục hiện tại không nằm trong một Git repository — " +
            "`sandcastle init` với issue tracker GitHub cần chạy bên trong working tree của dự án. " +
            "cd vào repo, hoặc chạy `git init` rồi tạo commit đầu tiên trước.",
        }),
      );
    }
    const headResolves = yield* Effect.sync(() => {
      try {
        execSync("git rev-parse --verify HEAD", {
          cwd,
          stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!headResolves) {
      yield* Effect.fail(
        new InitError({
          message:
            "Repository chưa có commit nào — HEAD chưa resolve được. " +
            "Hãy tạo commit đầu tiên trước khi chạy `sandcastle init` với GitHub Issues.",
        }),
      );
    }
  });

// --- Init command ---

/**
 * Host-access warning shown whenever host mode is selected, before the choice
 * is persisted to settings.json (ADR 0021). Vietnamese per ADR 0026 — it must
 * never describe a worktree as operating-system isolation.
 */
const HOST_MODE_WARNING =
  "Cảnh báo chế độ host: agent sẽ chạy trực tiếp trên máy của bạn trong một git worktree. " +
  "Worktree KHÔNG phải là sự cô lập ở cấp hệ điều hành — agent vẫn giữ toàn bộ " +
  "quyền truy cập tệp và tiến trình của tài khoản bạn. " +
  "Nếu cần ranh giới bảo mật thực sự, hãy chọn Docker hoặc Podman.";

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const initEffortOption = Options.text("effort").pipe(
  Options.withDescription(
    "Reasoning effort for the model (e.g. low, medium, high). In host mode it is validated against the model's discovered effort choices",
  ),
  Options.optional,
);

// Non-interactive parity for the interactive "manual entry (unverified)"
// recovery choice: with this flag, a --model/--effort pair that discovery
// could not verify (agent unavailable, or values outside the live catalog)
// is accepted and persisted as modelSource "manual-unverified" instead of
// failing. Without it, unverifiable selections fail fast with guidance.
const allowUnverifiedOption = Options.boolean("allow-unverified").pipe(
  Options.withDescription(
    "Host mode: accept --model/--effort without live-catalog verification (marked unverified). Without it, discovery failures exit non-zero",
  ),
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription(
    "Sandbox provider to use (e.g. host, docker, podman)",
  ),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

// Verification setup (ADR 0024): an explicit comma-separated list, or an
// explicit skip. Without either, interactive init asks to
// confirm/edit/skip the detected candidates and non-interactive init adopts
// whatever was detected (empty detection records status "unavailable").
const verificationCommandsOption = Options.text("verification-commands").pipe(
  Options.withDescription(
    'Comma-separated verification commands to persist (e.g. "npm run typecheck,npm test"). Overrides detection',
  ),
  Options.optional,
);

const skipVerificationOption = Options.boolean("skip-verification").pipe(
  Options.withDescription(
    'Skip verification-command setup — settings record verificationStatus "skipped"',
  ),
);

// package.json script conflict resolution (ADR 0026): an existing
// "sandcastle" script with different content is never silently overwritten.
// Interactive init asks; non-interactive init fails unless this flag decides.
const overwriteScriptOption = Options.choice("overwrite-script", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Resolve a conflicting existing "sandcastle" package script: true overwrites it with "sandcastle run", false keeps it',
  ),
  Options.optional,
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    effort: initEffortOption,
    allowUnverified: allowUnverifiedOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
    verificationCommands: verificationCommandsOption,
    skipVerification: skipVerificationOption,
    overwriteScript: overwriteScriptOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    effort: effortFlag,
    allowUnverified,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
    verificationCommands: verificationCommandsFlag,
    skipVerification,
    overwriteScript: overwriteScriptFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      // --agent validates up front too — an unknown agent name must error
      // before any prompt, even though the agent itself is resolved after the
      // sandbox choice below (host mode's picker needs it first).
      const agents = listAgents();
      if (agentFlag._tag === "Some") {
        const valid = getAgent(agentFlag.value);
        if (!valid) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );
      const overwriteScriptChoice = choiceToTriBool(overwriteScriptFlag);

      // The two verification flags answer the same question — combining them
      // is a caller error, not a precedence rule.
      if (verificationCommandsFlag._tag === "Some" && skipVerification) {
        yield* Effect.fail(
          new InitError({
            message:
              "--verification-commands and --skip-verification cannot be combined.",
          }),
        );
      }

      const isInteractive = process.stdin.isTTY === true;
      const failIfNonInteractive = (flag: string) =>
        Effect.fail(
          new InitError({
            message: `${flag} is required in non-interactive mode (no TTY detected).`,
          }),
        );

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts above.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") return params.choice.value;
          if (!isInteractive) {
            yield* failIfNonInteractive(params.flag);
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            yield* Effect.fail(
              new InitError({ message: params.cancelMessage }),
            );
          }
          return confirmed === true;
        });

      // Resolve sandbox provider first: CLI flag > interactive select (no
      // default — user must choose). It runs before the agent picker because
      // host mode's agent list is built from live discovery results.
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        // Host is the recommended entry (ADR 0021): it leads the registry,
        // gets the "(khuyến nghị)" marker, and is the picker's initial value —
        // mirroring the workflow picker's recommended-option handling.
        const recommended =
          sandboxProviders.find((p) => p.recommended === true) ??
          sandboxProviders[0]!;
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn nơi chạy agent:",
            initialValue: recommended.name,
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label:
                p.recommended === true ? `${p.label} (khuyến nghị)` : p.label,
              ...(p.selectHint !== undefined ? { hint: p.selectHint } : {}),
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(new InitError({ message: INIT_STOPPED_MESSAGE }));
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Host mode runs the agent directly on this machine — surface the
      // trust warning before the choice is saved to settings.json (ADR 0021).
      // Shown for both flag and picker selection, interactive or not.
      if (selectedSandboxProvider.runsOnHost) {
        yield* d.status(HOST_MODE_WARNING, "warn");
      }

      // Resolve agent + model + effort. In host mode the agent's live
      // discovery state drives the picker: `--agent` still wins when passed
      // (single-adapter probe), and without it every registered adapter is
      // probed in parallel so verified-ready agents list first while
      // missing/unauthenticated ones sit behind an "other agents" choice
      // with guidance + recheck. Container sandboxes keep the static picker —
      // probing host CLIs says nothing about what the image installs.
      // Definite-assignment assertions: every branch below assigns through
      // applySelection (or fails), which control-flow analysis can't see.
      let selectedAgent!: AgentEntry;
      let selectedModel!: string;
      let selectedEffort: string | undefined;
      // The executable name the host-mode probe actually fingerprinted
      // (e.g. Grok answering only under its `agent` alias) — persisted as
      // `agentExecutable` so `run` invokes the same entrypoint.
      let selectedExecutable: string | undefined;
      let modelSource: ModelSource = "manual-unverified";

      const applySelection = (
        agent: AgentEntry,
        selection: {
          model: string;
          effort?: string;
          executable?: string;
          modelSource: ModelSource;
        },
      ) => {
        selectedAgent = agent;
        selectedModel = selection.model;
        selectedEffort = selection.effort;
        selectedExecutable = selection.executable;
        modelSource = selection.modelSource;
      };

      const staticSelection = (agent: AgentEntry) => ({
        model: modelFlag._tag === "Some" ? modelFlag.value : agent.defaultModel,
        effort:
          effortFlag._tag === "Some" && effortFlag.value.trim().length > 0
            ? effortFlag.value.trim()
            : undefined,
        modelSource: "manual-unverified" as const,
      });

      if (agentFlag._tag === "Some") {
        // Already validated above.
        selectedAgent = getAgent(agentFlag.value)!;
        const adapter = selectedSandboxProvider.runsOnHost
          ? getDiscoveryAdapter(selectedAgent.name)
          : undefined;
        if (adapter !== undefined) {
          const outcome = yield* resolveDiscoveredSelection({
            adapter,
            agentLabel: selectedAgent.label,
            defaultModel: selectedAgent.defaultModel,
            modelFlag,
            effortFlag,
            isInteractive,
            allowUnverified,
            // Interactive flag users can fall back to the live picker when
            // their chosen agent isn't usable on this machine.
            offerBack: isInteractive,
          });
          if (outcome.kind === "back") {
            const picked = yield* pickHostAgent({
              agents,
              modelFlag,
              effortFlag,
              allowUnverified,
            });
            applySelection(picked.agent, picked.selection);
          } else {
            applySelection(selectedAgent, outcome.selection);
          }
        } else {
          applySelection(selectedAgent, staticSelection(selectedAgent));
        }
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        if (selectedSandboxProvider.runsOnHost) {
          const picked = yield* pickHostAgent({
            agents,
            modelFlag,
            effortFlag,
            allowUnverified,
          });
          applySelection(picked.agent, picked.selection);
        } else {
          const selected = yield* Effect.promise(() =>
            clack.select({
              message: "Chọn agent:",
              initialValue: "claude-code",
              options: agents.map((a) => ({
                value: a.name,
                label: a.label,
                hint: `Default model: ${a.defaultModel}`,
              })),
            }),
          );
          if (clack.isCancel(selected)) {
            yield* Effect.fail(
              new InitError({ message: INIT_STOPPED_MESSAGE }),
            );
          }
          const entry = getAgent(selected as string)!;
          applySelection(entry, staticSelection(entry));
        }
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(new InitError({ message: INIT_STOPPED_MESSAGE }));
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve workflow: --template (stable internal id) > interactive
      // outcome picker. The picker presents Vietnamese outcome labels bound
      // to unchanged template ids (ADR 0026) — the reviewed sequential
      // workflow is the recommended preselection (ADR 0025).
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const workflowOptions = listWorkflowOptions();
        const recommended =
          workflowOptions.find((o) => o.recommended) ?? workflowOptions[0]!;
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn workflow theo kết quả bạn muốn:",
            initialValue: recommended.template,
            options: workflowOptions.map((o) => ({
              value: o.template,
              label: o.label,
              hint: o.hint,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(new InitError({ message: INIT_STOPPED_MESSAGE }));
        }
        selectedTemplate = selected as string;
      }

      // Detect the host package manager — verification candidates are built
      // with it below, and the zod offer / next steps reuse it.
      const packageManager = yield* detectPackageManager(cwd);

      // Verification commands (ADR 0024): detect project candidates, then
      // confirm/edit/skip. Flags win (--verification-commands an explicit
      // list, --skip-verification an explicit decline); non-interactive runs
      // without a flag adopt the detected list. The saved
      // verificationStatus distinguishes skipped/unavailable from a
      // configured-but-not-yet-run list so nothing is ever reported passed
      // that did not run.
      let verificationCommands: readonly string[] = [];
      let verificationStatus: VerificationStatus | undefined;
      const parseCommandList = (raw: string): string[] =>
        raw
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);

      if (verificationCommandsFlag._tag === "Some") {
        verificationCommands = parseCommandList(verificationCommandsFlag.value);
        if (verificationCommands.length === 0) {
          yield* Effect.fail(
            new InitError({
              message:
                "--verification-commands must list at least one command (or pass --skip-verification).",
            }),
          );
        }
      } else if (skipVerification) {
        verificationStatus = "skipped";
      } else {
        const candidates = yield* detectVerificationCandidates(
          cwd,
          packageManager,
        );
        if (!isInteractive) {
          // Deterministic headless behavior: adopt detection as-is. An
          // explicit flag is the only way to override or decline it.
          verificationCommands = candidates;
          if (candidates.length === 0) {
            verificationStatus = "unavailable";
          } else {
            yield* d.status(
              `Dùng các lệnh xác minh phát hiện được: ${candidates.join(", ")}`,
              "info",
            );
          }
        } else if (candidates.length > 0) {
          yield* d.text(
            "Phát hiện các lệnh xác minh trong dự án:\n" +
              candidates.map((c) => `  • ${c}`).join("\n"),
          );
          const action = yield* Effect.promise(() =>
            clack.select({
              message: "Bạn muốn thiết lập lệnh xác minh thế nào?",
              options: [
                {
                  value: "confirm" as const,
                  label: `Dùng ${candidates.length} lệnh trên`,
                },
                { value: "edit" as const, label: "Chỉnh sửa danh sách" },
                {
                  value: "skip" as const,
                  label: "Bỏ qua — không dùng lệnh xác minh",
                },
              ],
            }),
          );
          if (clack.isCancel(action)) {
            yield* Effect.fail(
              new InitError({ message: INIT_STOPPED_MESSAGE }),
            );
          }
          if (action === "confirm") {
            verificationCommands = candidates;
          } else if (action === "edit") {
            const entered = yield* Effect.promise(() =>
              clack.text({
                message:
                  "Nhập các lệnh xác minh, cách nhau bởi dấu phẩy (để trống = bỏ qua):",
                initialValue: candidates.join(", "),
              }),
            );
            if (clack.isCancel(entered)) {
              return yield* Effect.fail(
                new InitError({ message: INIT_STOPPED_MESSAGE }),
              );
            }
            verificationCommands = parseCommandList(entered);
            if (verificationCommands.length === 0) {
              verificationStatus = "skipped";
            }
          } else {
            verificationStatus = "skipped";
          }
        } else {
          yield* d.status(
            "Không phát hiện lệnh xác minh nào trong dự án (xem package.json scripts, Cargo.toml, go.mod, Makefile…).",
            "info",
          );
          const action = yield* Effect.promise(() =>
            clack.select({
              message: "Bạn có muốn nhập lệnh xác minh thủ công không?",
              options: [
                { value: "manual" as const, label: "Nhập lệnh thủ công" },
                {
                  value: "none" as const,
                  label: "Tiếp tục không có lệnh xác minh",
                },
              ],
            }),
          );
          if (clack.isCancel(action)) {
            yield* Effect.fail(
              new InitError({ message: INIT_STOPPED_MESSAGE }),
            );
          }
          if (action === "manual") {
            const entered = yield* Effect.promise(() =>
              clack.text({
                message:
                  "Nhập các lệnh xác minh, cách nhau bởi dấu phẩy (để trống = bỏ qua):",
              }),
            );
            if (clack.isCancel(entered)) {
              return yield* Effect.fail(
                new InitError({ message: INIT_STOPPED_MESSAGE }),
              );
            }
            verificationCommands = parseCommandList(entered);
          }
          verificationStatus =
            verificationCommands.length > 0 ? undefined : "unavailable";
        }
      }
      if (verificationStatus === "skipped") {
        yield* d.status(
          'Đã bỏ qua lệnh xác minh — settings ghi nhận trạng thái "skipped", không bao giờ báo cáo là đã pass.',
          "warn",
        );
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        // A usable checkout with a resolvable HEAD is required before any
        // `gh` probe or label mutation (F060) — otherwise "not a git
        // repository" (or an unborn HEAD) surfaces mislabeled as a GitHub
        // permission failure.
        yield* requireUsableGitRepo(cwd);

        // Verify gh is installed AND authenticated before any label work or
        // scaffolding (ADR 0026) — GitHub failures must surface during setup,
        // not after agent work. Interactive runs may recheck after the user
        // installs/logs in; non-interactive runs fail with the guidance.
        for (;;) {
          const readiness = yield* d.spinner(
            "Đang kiểm tra GitHub CLI (gh)…",
            Effect.promise(() => probeGhReadiness()),
          );
          if (readiness.kind === "ready") {
            yield* d.status(
              `gh ${readiness.version ?? ""} — đã đăng nhập${
                readiness.authDetail ? ` (${readiness.authDetail})` : ""
              }`,
              "success",
            );
            break;
          }
          const reason =
            readiness.kind === "not-installed"
              ? "Chưa tìm thấy GitHub CLI (`gh`). Cài đặt từ https://cli.github.com/ (ví dụ `brew install gh`), sau đó chạy `gh auth login`."
              : readiness.kind === "unauthenticated"
                ? "`gh` đã được cài đặt nhưng chưa đăng nhập GitHub. Chạy `gh auth login` để đăng nhập."
                : `Không kiểm tra được gh: ${readiness.detail ?? "lỗi không xác định"}.`;
          if (!isInteractive) {
            yield* Effect.fail(new InitError({ message: reason }));
          }
          yield* d.status(reason, "warn");
          const action = yield* Effect.promise(() =>
            clack.select({
              message: "GitHub CLI chưa sẵn sàng — bạn muốn tiếp tục thế nào?",
              options: [
                { value: "retry", label: "Kiểm tra lại" },
                { value: "stop", label: "Dừng lại" },
              ],
            }),
          );
          if (clack.isCancel(action) || action === "stop") {
            yield* Effect.fail(
              new InitError({ message: INIT_STOPPED_MESSAGE }),
            );
          }
          // "retry" — loop back and probe again.
        }

        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Tạo label "Sandcastle" trên GitHub? (Các template lọc issue theo label này)',
          cancelMessage: INIT_STOPPED_MESSAGE,
        });

        if (shouldCreateLabel) {
          const labelResult = yield* Effect.promise(() =>
            createSandcastleLabel(),
          );
          if (labelResult.kind === "created") {
            yield* d.status(
              'Đã tạo label "Sandcastle" trên GitHub.',
              "success",
            );
          } else if (labelResult.kind === "already-exists") {
            yield* d.status(
              'Label "Sandcastle" đã tồn tại trên repository.',
              "info",
            );
          } else {
            yield* Effect.fail(
              new InitError({
                message:
                  labelResult.kind === "forbidden"
                    ? `Không tạo được label "Sandcastle": ${labelResult.detail}. ` +
                      "Kiểm tra quyền ghi của tài khoản `gh` trên repository này " +
                      "(label cần quyền Issues: write), hoặc chạy lại init với --create-label false."
                    : `Không tạo được label "Sandcastle": ${labelResult.detail}. ` +
                      "Chạy lại init với --create-label false để bỏ qua bước này.",
              }),
            );
          }
        }
      }

      // Add the "sandcastle": "sandcastle run" package script (ADR 0026) so
      // the normal launch is `npm run sandcastle`. This runs *before*
      // scaffolding: a conflicting existing script is never silently
      // overwritten — --overwrite-script decides non-interactively;
      // interactive init asks, defaulting to keep — so a refused conflict
      // fails without leaving a partial .sandcastle/ behind.
      let packageScriptReady = true;
      {
        let outcome = yield* ensureSandcastleScript(cwd, {
          resolution:
            overwriteScriptChoice._tag === "Some"
              ? overwriteScriptChoice.value
                ? "overwrite"
                : "keep"
              : "ask",
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        );
        if (outcome.kind === "conflict") {
          const existing = outcome.existing;
          if (!isInteractive) {
            yield* Effect.fail(
              new InitError({
                message:
                  `package.json already has a "sandcastle" script ("${existing}") that differs from "sandcastle run". ` +
                  "--overwrite-script is required in non-interactive mode (no TTY detected): " +
                  "true to replace it, false to keep it.",
              }),
            );
          }
          const overwrite = yield* Effect.promise(() =>
            clack.confirm({
              message: `Script "sandcastle" trong package.json đang là "${existing}". Ghi đè thành "sandcastle run"?`,
              initialValue: false,
            }),
          );
          if (clack.isCancel(overwrite)) {
            yield* Effect.fail(
              new InitError({ message: INIT_STOPPED_MESSAGE }),
            );
          }
          outcome = yield* ensureSandcastleScript(cwd, {
            resolution: overwrite ? "overwrite" : "keep",
          }).pipe(
            Effect.mapError(
              (e) =>
                new InitError({
                  message: `${e instanceof Error ? e.message : e}`,
                }),
            ),
          );
        }
        switch (outcome.kind) {
          case "added":
            yield* d.status(
              'Đã thêm script "sandcastle": "sandcastle run" vào package.json.',
              "success",
            );
            break;
          case "created-package-json":
            yield* d.status(
              'Đã tạo package.json với script "sandcastle": "sandcastle run".',
              "success",
            );
            break;
          case "overwritten":
            yield* d.status(
              'Đã ghi đè script "sandcastle" trong package.json thành "sandcastle run".',
              "success",
            );
            break;
          case "kept-existing":
            packageScriptReady = false;
            yield* d.status(
              'Giữ nguyên script "sandcastle" hiện có — `npm run sandcastle` sẽ không khởi động Sandcastle.',
              "warn",
            );
            break;
          case "skipped-malformed":
            packageScriptReady = false;
            yield* d.status(
              `package.json không phải là JSON hợp lệ — bỏ qua bước thêm script "sandcastle". Tự thêm "sandcastle": "sandcastle run" vào scripts để dùng \`npm run sandcastle\`.`,
              "warn",
            );
            break;
          case "malformed-scripts":
            packageScriptReady = false;
            yield* d.status(
              `"scripts" trong package.json không phải là object — giữ nguyên và bỏ qua bước thêm script "sandcastle". Sửa "scripts" thành object rồi thêm "sandcastle": "sandcastle run" để dùng \`npm run sandcastle\`.`,
              "warn",
            );
            break;
          case "already-correct":
            break;
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Đang tạo thư mục cấu hình .sandcastle/…",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          settings: {
            modelSource,
            ...(selectedEffort !== undefined ? { effort: selectedEffort } : {}),
            ...(selectedExecutable !== undefined
              ? { agentExecutable: selectedExecutable }
              : {}),
            verificationCommands,
            ...(verificationStatus !== undefined ? { verificationStatus } : {}),
          },
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      // If the chosen template imports zod on the host (the planner templates
      // build their <plan> output schema with it) and the host doesn't already
      // declare it, offer to install it. Without this, the very first
      // `npx tsx .sandcastle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (!alreadyInstalled) {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `Template ${selectedTemplate} cần một schema validator. Cài zod ngay (\`${installCmd}\`)?`,
            cancelMessage: INIT_STOPPED_MESSAGE,
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Đã cài zod bằng ${packageManager}.`, "success")
              : d.status(
                  `Không cài được zod tự động. Chạy \`${installCmd}\` trước khi chạy agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc.
      const providerLabel = selectedSandboxProvider.label;
      const cliNamespace = selectedSandboxProvider.cliNamespace;
      if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          cliNamespace === undefined
            ? "Khởi tạo xong! Issue tracker tùy chỉnh của bạn chưa được cấu hình — xem các bước bên dưới."
            : "Khởi tạo xong! Issue tracker tùy chỉnh của bạn chưa được cấu hình — xem các bước bên dưới trước khi build.",
          "success",
        );
      } else if (cliNamespace === undefined) {
        // Host mode: there is no image, so no build prompt, no build, and no
        // build-image next step — --build-image is ignored entirely.
        yield* d.status(
          "Khởi tạo xong! Chế độ host chạy agent trực tiếp trên máy của bạn — không có image nào để build.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build image ${providerLabel} mặc định ngay bây giờ?`,
          cancelMessage: INIT_STOPPED_MESSAGE,
        });

        if (shouldBuild) {
          const containerfileDir = join(cwd, CONFIG_DIR);
          if (selectedSandboxProvider.name === "podman") {
            yield* d.spinner(
              `Đang build image ${providerLabel} '${imageName}'…`,
              podmanBuildImage(imageName, containerfileDir),
            );
          } else {
            yield* d.spinner(
              `Đang build image ${providerLabel} '${imageName}'…`,
              buildImage(imageName, containerfileDir, {
                buildArgs: defaultUidBuildArgs(),
              }),
            );
          }
          yield* d.status("Khởi tạo xong! Image đã được build.", "success");
        } else {
          yield* d.status(
            `Khởi tạo xong! Chạy \`sandcastle ${cliNamespace} build-image\` để build image ${providerLabel} sau.`,
            "success",
          );
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
        selectedSandboxProvider,
        { packageScriptReady },
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Run command ---

/**
 * `sandcastle run` — implement GitHub Issues end to end (ADR 0023/0024/0026,
 * #20). Scope: `--issue <number>` runs one issue deterministically
 * (non-interactive/CI), `--all` runs every open `Sandcastle`-labeled issue —
 * sequentially by default, or bounded-parallel via `--parallelism`/configured
 * `parallelism`. Without flags, a TTY picker first asks for the run scope
 * (one issue / all sequential / all parallel), then the issue when needed.
 * The workflow itself lives in `WorkflowRun.ts`; this handler only bridges
 * the clack pickers and Display service into the service's callbacks, then
 * maps the structured result onto exit status.
 */
const runIssueOption = Options.integer("issue").pipe(
  Options.withDescription(
    "GitHub issue number to implement — skips the run-scope picker",
  ),
  Options.optional,
);

const runAllOption = Options.boolean("all").pipe(
  Options.withDescription(
    "Run every open Sandcastle-labeled issue — sequential by default, bounded parallel with --parallelism > 1",
  ),
);

const runParallelismOption = Options.integer("parallelism").pipe(
  Options.withDescription(
    `Cap how many --all issues run at once (integer ${MIN_PARALLELISM}-${MAX_PARALLELISM}; default: configured parallelism)`,
  ),
  Options.optional,
);

type RunScope =
  | { readonly kind: "issue"; readonly issueNumber?: number }
  | { readonly kind: "all"; readonly parallelism?: number };

const runCommand = Command.make(
  "run",
  {
    issue: runIssueOption,
    all: runAllOption,
    parallelism: runParallelismOption,
  },
  ({ issue, all, parallelism }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const isInteractive = process.stdin.isTTY === true;

      // #20: --all and --issue name different scopes — never combine them.
      if (all && issue._tag === "Some") {
        return yield* Effect.fail(
          new InitError({
            message:
              "`--all` không dùng chung với `--issue` — chọn một issue " +
              "(`sandcastle run --issue <n>`) hoặc tất cả issue đủ điều kiện " +
              "(`sandcastle run --all`).",
          }),
        );
      }
      if (parallelism._tag === "Some") {
        const p = parallelism.value;
        if (
          !Number.isInteger(p) ||
          p < MIN_PARALLELISM ||
          p > MAX_PARALLELISM
        ) {
          return yield* Effect.fail(
            new InitError({
              message:
                `--parallelism phải là số nguyên từ ${MIN_PARALLELISM} đến ` +
                `${MAX_PARALLELISM} (nhận: ${p}).`,
            }),
          );
        }
        if (!all) {
          // The bound only shapes multi-issue runs — a lone --issue run (or a
          // non-interactive run without --all) has nothing to parallelize.
          return yield* Effect.fail(
            new InitError({
              message:
                "`--parallelism` chỉ áp dụng khi chạy nhiều issue — " +
                "dùng cùng `--all` (hoặc chọn chế độ song song trong picker tương tác).",
            }),
          );
        }
      }

      // Resolve the run scope: flags win; an interactive TTY gets the
      // scope picker; non-interactive without flags falls through to the
      // single-issue path, which reports the missing selection itself.
      let scope: RunScope;
      if (issue._tag === "Some") {
        scope = { kind: "issue", issueNumber: issue.value };
      } else if (all) {
        scope = {
          kind: "all",
          parallelism:
            parallelism._tag === "Some" ? parallelism.value : undefined,
        };
      } else if (isInteractive) {
        const pickedScope = yield* Effect.promise(() =>
          clack.select<"one" | "seq" | "par">({
            message: "Sandcastle chạy phạm vi nào?",
            options: [
              {
                value: "one" as const,
                label: "Một issue",
                hint: "chọn một issue đang mở",
              },
              {
                value: "seq" as const,
                label: "Tất cả issue đủ điều kiện — tuần tự",
                hint: "mỗi lần một issue, theo số issue tăng dần",
              },
              {
                value: "par" as const,
                label: "Tất cả issue đủ điều kiện — song song",
                hint: `tối đa theo parallelism đã cấu hình (${MIN_PARALLELISM}-${MAX_PARALLELISM})`,
              },
            ],
          }),
        );
        if (clack.isCancel(pickedScope)) {
          return yield* Effect.fail(
            new InitError({ message: "Đã hủy — chưa chọn phạm vi nào." }),
          );
        }
        scope =
          pickedScope === "one"
            ? { kind: "issue" }
            : pickedScope === "seq"
              ? { kind: "all", parallelism: MIN_PARALLELISM }
              : {
                  kind: "all",
                  parallelism:
                    parallelism._tag === "Some" ? parallelism.value : undefined,
                };
      } else {
        scope = { kind: "issue" };
      }

      if (scope.kind === "all") {
        const result = yield* Effect.tryPromise({
          try: () =>
            runIssueQueueWorkflow({
              cwd,
              parallelism: scope.parallelism,
              onStatus: (message, severity) => {
                Effect.runSync(d.status(message, severity));
              },
            }),
          catch: (e) =>
            new InitError({
              message: e instanceof Error ? e.message : String(e),
            }),
        });
        switch (result.outcome) {
          case "landed":
            yield* d.status(result.message, "success");
            break;
          case "no-issues":
            yield* d.status(result.message, "info");
            break;
          case "skipped":
            // Nothing failed, but ≥1 issue was left for `sandcastle retry`
            // because it already has a recovery record — surface the summary
            // as a warning so the pending preserved work isn't missed.
            yield* d.status(result.message, "warn");
            break;
          case "failed":
            // Per-issue failure reports were already posted; landed issues
            // stay landed. Exit non-zero so scripts/CI observe the failures.
            return yield* Effect.fail(
              new InitError({ message: result.message }),
            );
        }
        return;
      }

      yield* runWorkflowAndReport(d, {
        cwd,
        issueNumber: scope.issueNumber,
        // The picker seam is only wired when a TTY exists — without it the
        // service requires --issue (or reports no eligible issues).
        ...(isInteractive
          ? {
              selectIssue: async (issues: readonly GithubIssue[]) => {
                const picked = await clack.select<number>({
                  message: "Chọn issue để Sandcastle thực hiện:",
                  options: issues.map((i) => ({
                    value: i.number,
                    label: `#${i.number} ${i.title}`,
                  })),
                });
                return clack.isCancel(picked) ? undefined : picked;
              },
            }
          : {}),
        onStatus: (message, severity) => {
          Effect.runSync(d.status(message, severity));
        },
      });
    }),
);

/**
 * Shared bridge for `run`/`retry`: invoke the workflow and map its
 * structured outcome onto the Display service and exit status.
 */
const runWorkflowAndReport = (
  d: DisplayService,
  options: RunIssueWorkflowOptions,
): Effect.Effect<void, InitError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => runIssueWorkflow(options),
      catch: (e) =>
        new InitError({
          message: e instanceof Error ? e.message : String(e),
        }),
    });

    switch (result.outcome) {
      case "landed":
        yield* d.status(result.message, "success");
        break;
      case "no-issues":
        yield* d.status(result.message, "info");
        break;
      case "skipped":
        // Only queue runs produce "skipped" — a standalone run never does;
        // handled for completeness so the union stays exhaustive.
        yield* d.status(result.message, "warn");
        break;
      case "failed":
        // The failure report was already posted to the issue; the process
        // exits non-zero so scripts/CI observe the failed run.
        return yield* Effect.fail(new InitError({ message: result.message }));
    }
  });

// --- Recovery commands: status / retry / discard (ADR 0024) ---

const issueNumberArg = Args.integer({ name: "issue-number" }).pipe(
  Args.withDescription("GitHub issue number of the preserved failed task"),
);

const firstLineOf = (text: string): string => text.split("\n", 1)[0] ?? text;

/**
 * `sandcastle status` — list every preserved failed task with the phase it
 * stopped in, spent repair attempts, and the live state of its branch and
 * worktree. Corrupt records are surfaced, never hidden.
 */
const formatRecoveryEntry = async (
  cwd: string,
  entry:
    | { readonly kind: "ok"; readonly state: RecoveryState }
    | {
        readonly kind: "corrupt";
        readonly path: string;
        readonly detail: string;
      },
): Promise<string> => {
  if (entry.kind === "corrupt") {
    return (
      `• ${entry.path} — BẢN GHI BỊ HỎNG: ${entry.detail}. ` +
      "Sandcastle không tự xóa bản ghi hỏng; sửa hoặc xóa tệp thủ công."
    );
  }
  const s = entry.state;
  const probe = await probeRecoveryArtifacts(cwd, s);
  const retrySuffix = s.retryCount > 0 ? ` — đã retry ${s.retryCount} lần` : "";
  const lines = [
    `• Issue #${s.issue.number} — ${s.issue.title}`,
    s.landingState === undefined
      ? `  Dừng ở bước "${PHASE_LABEL[s.failurePhase]}" lúc ${s.failedAt}${retrySuffix}`
      : // Post-landing record (#37): the work is already on the target
        // branch — what remains is a GitHub step, not a failure phase.
        `  Đã merge vào \`${s.targetBranch}\`` +
        (s.landedSha !== undefined ? ` (${s.landedSha.slice(0, 8)})` : "") +
        ` — ${
          s.landingState === "landed-awaiting-report"
            ? "chờ đăng báo cáo hoàn thành rồi đóng issue"
            : "báo cáo đã đăng — chờ đóng issue"
        } lúc ${s.failedAt}${retrySuffix}`,
    `  Nhánh \`${s.sourceBranch}\`${probe.branchExists ? "" : " (đã mất)"}` +
      ` · Worktree \`${s.worktreePath ?? "—"}\`` +
      (s.worktreePath !== undefined && !probe.worktreeExists
        ? " (đã mất)"
        : ""),
    `  Sửa tự động đã dùng: xác minh ${s.attempts.verificationRepair}/${MAX_VERIFICATION_REPAIR_ATTEMPTS}` +
      ` · xung đột merge ${s.attempts.mergeConflictRepair}/${MAX_MERGE_CONFLICT_REPAIR_ATTEMPTS}` +
      ` · dựng lại tích hợp ${s.attempts.integrationRebuild}/${MAX_TARGET_REBUILD_ATTEMPTS}`,
    `  ${s.landingState === undefined ? "Lỗi" : "Chi tiết"}: ${firstLineOf(s.error)}`,
  ];
  if (s.landingState !== undefined) {
    lines.push(
      "  Retry chỉ hoàn tất các bước GitHub (đăng báo cáo/đóng issue) — không chạy lại agent hay merge lại.",
    );
  } else {
    const stale: string[] = [];
    if (!probe.branchExists) stale.push("nhánh nguồn đã mất");
    if (probe.landedOrEmpty) {
      stale.push(
        "nhánh không còn commit chưa merge (có thể đã merge ở nơi khác)",
      );
    }
    if (
      s.worktreePath !== undefined &&
      !probe.worktreeExists &&
      probe.branchExists
    ) {
      stale.push("worktree đã mất — retry sẽ dựng lại từ nhánh");
    }
    if (stale.length > 0) lines.push(`  ⚠ Lỗi thời: ${stale.join("; ")}.`);
    // A comparison that could not run is UNKNOWN, never "0 unmerged commits"
    // (F030) — and an empty range on a run that never committed is
    // INCOMPLETE work, not landed or stale (F072).
    if (probe.comparison === "target-missing") {
      lines.push(
        "  ⚠ Không xác định được số commit chưa merge — nhánh đích " +
          `\`${s.targetBranch}\` không còn; kiểm tra thủ công trước khi discard.`,
      );
    } else if (probe.comparison === "unknown") {
      lines.push(
        "  ⚠ Không xác định được số commit chưa merge — không so sánh được " +
          `với nhánh đích \`${s.targetBranch}\`; kiểm tra thủ công trước khi discard.`,
      );
    } else if (
      probe.comparison === "ok" &&
      probe.branchExists &&
      probe.preservedCommits.length === 0 &&
      s.commits.length === 0
    ) {
      lines.push(
        "  Chưa hoàn thành: lần chạy chưa tạo commit nào trên nhánh " +
          "— không phải đã merge hay lỗi thời.",
      );
    }
  }
  return lines.join("\n");
};

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const entries = yield* Effect.promise(() => listRecoveryStates(cwd));
    if (entries.length === 0) {
      yield* d.status("Không có tác vụ thất bại nào được giữ lại.", "info");
      return;
    }
    yield* d.text(`Tác vụ thất bại được giữ lại (${entries.length}):`);
    for (const entry of entries) {
      yield* d.text(
        yield* Effect.promise(() => formatRecoveryEntry(cwd, entry)),
      );
    }
    // Name only commands that can actually handle each entry kind (F071):
    // `retry`/`discard` work on parseable records; a corrupt record can
    // neither resume nor be probed for safe deletion, so its exit path is
    // manual file cleanup — never a discard loop that always refuses.
    if (entries.some((e) => e.kind === "ok")) {
      yield* d.text(
        "Dùng `sandcastle retry <số-issue>` để tiếp tục, hoặc `sandcastle discard <số-issue>` để xóa công việc được giữ lại.",
      );
    }
    if (entries.some((e) => e.kind === "corrupt")) {
      yield* d.text(
        "Bản ghi BỊ HỎNG không dùng được với `retry`/`discard` — " +
          "sửa hoặc xóa tệp thủ công theo đường dẫn in ở trên.",
      );
    }
  }),
);

/**
 * `sandcastle retry <issue>` — continue a preserved failed task. The record
 * pins the issue/branch/worktree so the run NEVER re-selects an issue or
 * creates a new implementation branch; it re-enters the workflow at the
 * recorded failure phase.
 *
 * A per-issue lock file (`.sandcastle/recovery/issue-<N>.lock`, F065) is
 * acquired after the record checks out and BEFORE the workflow can mutate
 * the worktree or the Git index, so two processes can never retry the same
 * issue at once; it is released when the run ends for any reason.
 */
const retryCommand = Command.make(
  "retry",
  { issueNumber: issueNumberArg },
  ({ issueNumber }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const record: RecoveryReadResult = yield* Effect.promise(() =>
        readRecoveryState(cwd, issueNumber),
      );
      if (record.kind === "missing") {
        return yield* Effect.fail(
          new InitError({
            message:
              `Không tìm thấy bản ghi phục hồi cho issue #${issueNumber}. ` +
              "Chạy `sandcastle status` để xem các tác vụ thất bại được giữ lại.",
          }),
        );
      }
      if (record.kind === "corrupt") {
        return yield* Effect.fail(
          new InitError({
            message:
              `Bản ghi phục hồi cho issue #${issueNumber} bị hỏng: ${record.detail} ` +
              `(${record.path}). Sandcastle không tự xóa — sửa hoặc xóa tệp thủ công.`,
          }),
        );
      }
      const lock = yield* Effect.tryPromise({
        try: () => acquireRetryLock(cwd, issueNumber),
        catch: (e) =>
          new InitError({
            message:
              e instanceof RetryLockHeldError
                ? e.message
                : `Không tạo được khóa retry cho issue #${issueNumber}: ` +
                  (e instanceof Error ? e.message : String(e)),
          }),
      });
      yield* runWorkflowAndReport(d, {
        cwd,
        resume: record.state,
        onStatus: (message, severity) => {
          Effect.runSync(d.status(message, severity));
        },
      }).pipe(Effect.ensuring(Effect.promise(() => lock.release())));
    }),
);

const discardYesOption = Options.boolean("yes").pipe(
  Options.withAlias("y"),
  Options.withDescription(
    "Confirm the discard — required when stdin is not a TTY",
  ),
);

/**
 * `sandcastle discard <issue>` — permanently delete a preserved failed task:
 * worktree, source branch, and recovery record. Interactive runs ask for
 * confirmation first; non-interactive runs require `--yes`. A declined
 * confirmation leaves EVERYTHING untouched.
 */
const discardCommand = Command.make(
  "discard",
  { issueNumber: issueNumberArg, yes: discardYesOption },
  ({ issueNumber, yes }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const record: RecoveryReadResult = yield* Effect.promise(() =>
        readRecoveryState(cwd, issueNumber),
      );
      if (record.kind === "missing") {
        return yield* Effect.fail(
          new InitError({
            message:
              `Không tìm thấy bản ghi phục hồi cho issue #${issueNumber}. ` +
              "Chạy `sandcastle status` để xem các tác vụ thất bại được giữ lại.",
          }),
        );
      }
      if (record.kind === "corrupt") {
        return yield* Effect.fail(
          new InitError({
            message:
              `Bản ghi phục hồi cho issue #${issueNumber} bị hỏng: ${record.detail} ` +
              `(${record.path}). Sandcastle không tự xóa — sửa hoặc xóa tệp thủ công.`,
          }),
        );
      }
      const state = record.state;

      // `retry` holds the per-issue lock for its whole run (F065) — a
      // discard that slipped in mid-retry would delete the worktree/branch
      // out from under the running workflow, so the same lock gates this
      // mutation too. It is taken BEFORE the probe+prompt so the state the
      // user confirms cannot be changed by a retry starting in between; a
      // live holder means a retry is in progress and discard must refuse.
      // Corrupt records never reach here — they are refused above — so a
      // missing lock file is the normal case, not an error.
      const lock = yield* Effect.tryPromise({
        try: () => acquireRetryLock(cwd, issueNumber),
        catch: (e) =>
          new InitError({
            message:
              e instanceof RetryLockHeldError
                ? `Một tiến trình retry đang giữ khóa cho issue #${issueNumber} ` +
                  `(${e.holderDetail}) — không thể xóa công việc đang được ` +
                  "chạy lại. Đợi retry kết thúc rồi chạy lại " +
                  `\`sandcastle discard ${issueNumber}\`; nếu retry đã dừng ` +
                  `đột ngột, xóa tệp khóa \`${e.lockPath}\` rồi thử lại.`
                : `Không tạo được khóa discard cho issue #${issueNumber}: ` +
                  (e instanceof Error ? e.message : String(e)),
          }),
      });
      yield* Effect.gen(function* () {
        // Show exactly what would be destroyed BEFORE asking.
        const probe = yield* Effect.promise(() =>
          probeRecoveryArtifacts(cwd, state),
        );
        yield* d.text(
          `Sẽ xóa vĩnh viễn công việc được giữ lại của issue #${issueNumber}:`,
        );
        yield* d.text(
          `  • Nhánh \`${state.sourceBranch}\`` +
            (probe.branchExists
              ? probe.comparison === "ok"
                ? ` (${probe.preservedCommits.length} commit chưa merge)`
                : // A failed comparison is UNKNOWN — never "0 commits" (F030):
                  // the branch may hold real unmerged work the user is about
                  // to delete, so the prompt must say so explicitly.
                  ` (số commit chưa merge không xác định — ` +
                  (probe.comparison === "target-missing"
                    ? `nhánh đích \`${state.targetBranch}\` không còn`
                    : `không so sánh được với nhánh đích \`${state.targetBranch}\``) +
                  `)`
              : " (đã mất)"),
        );
        if (state.worktreePath !== undefined) {
          yield* d.text(
            `  • Worktree \`${state.worktreePath}\`` +
              (probe.worktreeExists ? "" : " (đã mất)"),
          );
        }
        yield* d.text(`  • Bản ghi ${recoveryStatePath(cwd, issueNumber)}`);
        if (state.landingState !== undefined) {
          yield* d.text(
            `  ⚠ Công việc đã merge vào \`${state.targetBranch}\` — xóa bản ghi sẽ ` +
              `bỏ qua bước GitHub còn lại (${state.landingState === "landed-awaiting-report" ? "đăng báo cáo + đóng issue" : "đóng issue"}); ` +
              "issue sẽ cần xử lý thủ công trên GitHub.",
          );
        }

        let confirmed = yes;
        if (!confirmed) {
          if (process.stdin.isTTY !== true) {
            return yield* Effect.fail(
              new InitError({
                message:
                  "Lệnh `discard` cần xác nhận. Chạy lại với `--yes` để xóa, " +
                  "hoặc chạy trong terminal tương tác để được hỏi xác nhận.",
              }),
            );
          }
          const answer = yield* Effect.promise(() =>
            clack.confirm({
              message: `Xóa vĩnh viễn công việc được giữ lại của issue #${issueNumber}?`,
              initialValue: false,
            }),
          );
          confirmed = answer === true;
        }
        if (!confirmed) {
          yield* d.status(
            "Đã hủy — worktree, nhánh và bản ghi phục hồi được giữ nguyên.",
            "info",
          );
          return;
        }

        const outcome = yield* Effect.promise(() =>
          discardRecoveryWork(cwd, state),
        );
        if (!outcome.ok) {
          return yield* Effect.fail(
            new InitError({
              message:
                "Không xóa được toàn bộ công việc được giữ lại — bản ghi phục hồi vẫn còn:\n" +
                outcome.failures.map((f) => `  • ${f}`).join("\n"),
            }),
          );
        }
        yield* d.status(
          `Đã xóa công việc được giữ lại của issue #${issueNumber}` +
            ` (worktree: ${outcome.worktreeRemoved ? "đã xóa" : "không có"}` +
            `, nhánh: ${outcome.branchRemoved ? "đã xóa" : "không có"}).`,
          "success",
        );
      }).pipe(
        // Released on every exit — declined confirmation, failure, success —
        // so a discard never wedges a later retry behind a dead lock file.
        Effect.ensuring(Effect.promise(() => lock.release())),
      );
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    configureCommand,
    runCommand,
    statusCommand,
    retryCommand,
    discardCommand,
    dockerCommand,
    podmanCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});

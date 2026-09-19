import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
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
import type { ModelSource } from "./ProjectSettings.js";
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
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn nơi chạy agent:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
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
      let modelSource: ModelSource = "manual-unverified";

      const applySelection = (
        agent: AgentEntry,
        selection: {
          model: string;
          effort?: string;
          modelSource: ModelSource;
        },
      ) => {
        selectedAgent = agent;
        selectedModel = selection.model;
        selectedEffort = selection.effort;
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

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Chọn template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(new InitError({ message: INIT_STOPPED_MESSAGE }));
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Tạo label "Sandcastle" trên GitHub? (Các template lọc issue theo label này)',
          cancelMessage: INIT_STOPPED_MESSAGE,
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
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

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

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

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([initCommand, dockerCommand, podmanCommand]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});

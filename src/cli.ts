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
import { discoverAgent, getDiscoveryAdapter } from "./discovery/registry.js";
import { nodeDiscoveryExec } from "./discovery/nodeExec.js";
import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
} from "./discovery/contract.js";
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

/** The model/effort selection init resolved through agent discovery. */
interface DiscoveredSelection {
  readonly model: string;
  readonly effort?: string;
  readonly modelSource: ModelSource;
}

const discoveryCancelledMessage =
  "Đã dừng khởi tạo — chưa có tệp nào được tạo.";

/**
 * Run one adapter's discovery through the real process boundary, showing a
 * spinner while the CLI probes run. Never fails — adapters report every
 * outcome via `report.state`.
 */
const runDiscovery = (
  adapter: AgentDiscoveryAdapter,
  agentLabel: string,
): Effect.Effect<AgentDiscoveryReport, never, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    return yield* d.spinner(
      `Đang kiểm tra ${agentLabel} trên máy này…`,
      Effect.promise(() => discoverAgent(adapter.agent, nodeDiscoveryExec)),
    );
  }).pipe(
    Effect.map(
      (report) =>
        report ??
        ({
          agent: adapter.agent,
          executable: adapter.executable,
          state: "error",
          models: [],
          detail: "Không có adapter nào đăng ký cho agent này.",
        } satisfies AgentDiscoveryReport),
    ),
  );

/**
 * Resolve the model and effort for a host-mode agent through live discovery
 * (ADR 0021). Non-interactive runs fail with the report's Vietnamese guidance
 * on any non-ready state; interactive runs offer retry / manual-unverified
 * entry / safe stop before anything is scaffolded.
 */
const resolveDiscoveredSelection = (params: {
  readonly adapter: AgentDiscoveryAdapter;
  readonly agentLabel: string;
  readonly modelFlag: Option.Option<string>;
  readonly effortFlag: Option.Option<string>;
  readonly isInteractive: boolean;
}): Effect.Effect<DiscoveredSelection, InitError, Display> =>
  Effect.gen(function* () {
    const d = yield* Display;
    const { adapter, agentLabel, modelFlag, effortFlag, isInteractive } =
      params;

    let report = yield* runDiscovery(adapter, agentLabel);

    // Every state except "ready" needs either a flag answer or an
    // interactive choice before init may continue.
    while (report.state !== "ready") {
      const reason =
        report.guidance ??
        report.detail ??
        `Không khám phá được ${agentLabel}.`;
      if (!isInteractive) {
        return yield* Effect.fail(new InitError({ message: reason }));
      }
      yield* d.status(reason, "warn");
      const action = yield* Effect.promise(() =>
        clack.select({
          message: "Bạn muốn tiếp tục thế nào?",
          options: [
            { value: "retry", label: "Thử lại" },
            {
              value: "manual",
              label: "Nhập model thủ công (chưa xác minh)",
            },
            { value: "stop", label: "Dừng lại" },
          ],
        }),
      );
      if (clack.isCancel(action) || action === "stop") {
        return yield* Effect.fail(
          new InitError({ message: discoveryCancelledMessage }),
        );
      }
      if (action === "retry") {
        report = yield* runDiscovery(adapter, agentLabel);
        continue;
      }

      // "manual" — an explicitly unverified entry (ADR 0021). A passed --model
      // flag counts as the manual entry; otherwise prompt for it.
      let model =
        modelFlag._tag === "Some" ? modelFlag.value.trim() : undefined;
      if (model === undefined || model.length === 0) {
        const entered = yield* Effect.promise(() =>
          clack.text({
            message: `Nhập model cho ${agentLabel} (sẽ được đánh dấu chưa xác minh):`,
            validate: (value) =>
              value === undefined || value.trim().length === 0
                ? "Model không được để trống."
                : undefined,
          }),
        );
        if (clack.isCancel(entered)) {
          return yield* Effect.fail(
            new InitError({ message: discoveryCancelledMessage }),
          );
        }
        model = entered.trim();
      }
      let effort =
        effortFlag._tag === "Some" ? effortFlag.value.trim() : undefined;
      // An explicitly-empty --effort (" ") counts as absent — prompt for it.
      if (effort === undefined || effort.length === 0) {
        const entered = yield* Effect.promise(() =>
          clack.text({
            message: `Nhập effort cho ${model} (để trống nếu không dùng):`,
          }),
        );
        if (clack.isCancel(entered)) {
          return yield* Effect.fail(
            new InitError({ message: discoveryCancelledMessage }),
          );
        }
        effort = entered.trim().length > 0 ? entered.trim() : undefined;
      }
      return { model, effort, modelSource: "manual-unverified" };
    }

    // --- state === "ready": pick from the live catalog ---
    const catalog = report.models;
    yield* d.status(
      `${agentLabel} ${report.version ?? ""} — đã xác minh và đăng nhập`.trim(),
      "success",
    );

    let model: string;
    if (modelFlag._tag === "Some") {
      const requested = modelFlag.value.trim();
      const found = catalog.some((m) => m.id === requested);
      if (!found) {
        const names = catalog.map((m) => m.id).join(", ");
        return yield* Effect.fail(
          new InitError({
            message: `Model "${requested}" không có trong catalog của ${agentLabel}. Có sẵn: ${names}`,
          }),
        );
      }
      model = requested;
    } else if (isInteractive) {
      const selected = yield* Effect.promise(() =>
        clack.select({
          message: `Chọn model cho ${agentLabel}:`,
          initialValue: report.recommendedModel,
          options: catalog.map((m) => {
            // Multi-provider agents (e.g. OpenCode) surface the model
            // provider in the hint so the picker reads grouped by provider —
            // the catalog already arrives in provider order.
            const hint = [m.provider, m.description]
              .filter((s): s is string => s !== undefined)
              .join(" — ");
            return {
              value: m.id,
              label: m.displayName,
              ...(hint.length > 0 ? { hint } : {}),
            };
          }),
        }),
      );
      if (clack.isCancel(selected)) {
        return yield* Effect.fail(
          new InitError({ message: discoveryCancelledMessage }),
        );
      }
      model = selected as string;
    } else {
      model = report.recommendedModel ?? catalog[0]!.id;
    }
    const chosenModel = catalog.find((m) => m.id === model)!;

    let effort: string | undefined;
    if (effortFlag._tag === "Some" && effortFlag.value.trim().length > 0) {
      const requested = effortFlag.value.trim();
      const supported = chosenModel.effortChoices.some(
        (e) => e.id === requested,
      );
      if (!supported) {
        const values = chosenModel.effortChoices.map((e) => e.id).join(", ");
        return yield* Effect.fail(
          new InitError({
            message:
              `Effort "${requested}" không được model "${model}" hỗ trợ.` +
              (values.length > 0 ? ` Có sẵn: ${values}` : ""),
          }),
        );
      }
      effort = requested;
    } else if (chosenModel.effortChoices.length > 0) {
      if (isInteractive) {
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: `Chọn effort cho ${model}:`,
            initialValue: chosenModel.defaultEffort,
            options: chosenModel.effortChoices.map((e) => ({
              value: e.id,
              label: e.id,
              ...(e.description !== undefined ? { hint: e.description } : {}),
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          return yield* Effect.fail(
            new InitError({ message: discoveryCancelledMessage }),
          );
        }
        effort = selected as string;
      } else {
        effort = chosenModel.defaultEffort;
      }
    }

    return { model, effort, modelSource: "discovered" };
  });

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    effort: initEffortOption,
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

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
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
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
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
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
              ...(p.selectHint !== undefined ? { hint: p.selectHint } : {}),
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Host mode runs the agent directly on this machine — surface the
      // trust warning before the choice is saved to settings.json (ADR 0021).
      // Shown for both flag and picker selection, interactive or not.
      if (selectedSandboxProvider.runsOnHost) {
        yield* d.status(HOST_MODE_WARNING, "warn");
      }

      // Resolve model + effort. In host mode with a discovery adapter, the
      // agent's live catalog is the source of truth (ADR 0021) — the agent's
      // executable is fingerprinted, its login verified, and the chosen
      // model/effort persisted as `modelSource: "discovered"`. Everything
      // else keeps the static registry default, marked "manual-unverified"
      // since it was never checked against the agent.
      let selectedModel: string;
      let selectedEffort: string | undefined;
      let modelSource: ModelSource = "manual-unverified";
      const discoveryAdapter = selectedSandboxProvider.runsOnHost
        ? getDiscoveryAdapter(selectedAgent.name)
        : undefined;
      if (discoveryAdapter !== undefined) {
        const selection = yield* resolveDiscoveredSelection({
          adapter: discoveryAdapter,
          agentLabel: selectedAgent.label,
          modelFlag,
          effortFlag,
          isInteractive,
        });
        selectedModel = selection.model;
        selectedEffort = selection.effort;
        modelSource = selection.modelSource;
      } else {
        selectedModel =
          modelFlag._tag === "Some"
            ? modelFlag.value
            : selectedAgent.defaultModel;
        selectedEffort =
          effortFlag._tag === "Some" && effortFlag.value.trim().length > 0
            ? effortFlag.value.trim()
            : undefined;
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
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
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
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
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
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
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
        "Scaffolding .sandcastle/ config directory...",
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
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
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
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
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
            ? "Init complete! Your custom issue tracker isn't configured yet — see the steps below."
            : "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building.",
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
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const containerfileDir = join(cwd, CONFIG_DIR);
          if (selectedSandboxProvider.name === "podman") {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              podmanBuildImage(imageName, containerfileDir),
            );
          } else {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              buildImage(imageName, containerfileDir, {
                buildArgs: defaultUidBuildArgs(),
              }),
            );
          }
          yield* d.status(
            "Init complete! Image built successfully.",
            "success",
          );
        } else {
          yield* d.status(
            `Init complete! Run \`sandcastle ${cliNamespace} build-image\` to build the ${providerLabel} image later.`,
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

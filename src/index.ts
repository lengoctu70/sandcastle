export { run } from "./run.js";
export type {
  RunOptions,
  RunResult,
  LoggingOption,
  IterationResult,
  IterationUsage,
  Timeouts,
} from "./run.js";
export { interactive } from "./interactive.js";
export type { InteractiveOptions, InteractiveResult } from "./interactive.js";
export { createSandbox } from "./createSandbox.js";
export type {
  CreateSandboxOptions,
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
  ResumeSandboxRunResultOptions,
  SandboxInteractiveOptions,
  SandboxInteractiveResult,
  SandboxExecOptions,
  CloseResult,
} from "./createSandbox.js";
export { createWorktree } from "./createWorktree.js";
export type {
  CreateWorktreeOptions,
  Worktree,
  WorktreeBranchStrategy,
  WorktreeInteractiveOptions,
  WorktreeRunOptions,
  WorktreeRunResult,
  WorktreeCreateSandboxOptions,
} from "./createWorktree.js";
export type { PromptArgs } from "./PromptArgumentSubstitution.js";
export type { AgentStreamEvent } from "./AgentStreamEmitter.js";
export {
  transferClaudeSession,
  transferCodexSession,
  encodeProjectPath,
  claudeHostSessionPath,
  claudeSandboxSessionPath,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
} from "./SessionStore.js";
export type { HostSessionLookup } from "./SessionStore.js";
export type { SandboxHooks } from "./SandboxLifecycle.js";
export type { MountConfig } from "./MountConfig.js";
export { Output, StructuredOutputError } from "./Output.js";
export type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";
export { CwdError } from "./CwdError.js";
export {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
export { devin } from "./agents/devin.js";
export type { DevinOptions } from "./agents/devin.js";
export type {
  AgentProvider,
  AgentCommandOptions,
  PrintCommand,
  ClaudeCodeOptions,
  CodexOptions,
  CopilotOptions,
  CursorOptions,
  OpenCodeOptions,
  PiOptions,
} from "./AgentProvider.js";
export {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "./SandboxProvider.js";
export type {
  SandboxProvider,
  AnySandboxProvider,
  BindMountSandboxProvider,
  IsolatedSandboxProvider,
  NoSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
  InteractiveExecOptions,
  ExecResult,
  BindMountCreateOptions,
  BindMountSandboxProviderConfig,
  IsolatedCreateOptions,
  IsolatedSandboxProviderConfig,
  BranchStrategy,
  BindMountBranchStrategy,
  IsolatedBranchStrategy,
  NoSandboxBranchStrategy,
  HeadBranchStrategy,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
} from "./SandboxProvider.js";
// The project-settings seam (`.sandcastle/settings.json`) is Effect-based
// internally; index.ts re-exports Promise wrappers under the canonical names
// because Effect types must never reach the published .d.ts surface.
export {
  PROJECT_SETTINGS_VERSION,
  PROJECT_SETTINGS_DIR,
  PROJECT_SETTINGS_FILENAME,
  projectSettingsPath,
  ProjectSettingsNotFoundError,
  ProjectSettingsMalformedError,
  ProjectSettingsUnsupportedVersionError,
  ProjectSettingsValidationError,
  ProjectSettingsIoError,
  loadProjectSettingsAsync as loadProjectSettings,
  saveProjectSettingsAsync as saveProjectSettings,
  updateProjectSettingsAsync as updateProjectSettings,
} from "./ProjectSettings.js";
export type {
  InitialProjectSettings,
  ModelSource,
  ProjectSettings,
  ProjectSettingsError,
  ProjectSettingsInitOverrides,
  ProjectSettingsLoadError,
  ProjectSettingsSaveError,
  ProjectSettingsUpdate,
  RoleOverride,
  RoleOverrideUpdate,
  RoleOverrides,
  SandboxProviderChoice,
  WorkflowRole,
} from "./ProjectSettings.js";
// The agent-discovery contract (identity fingerprint, auth readiness, live
// model/effort catalog) — Promise-based and Effect-free like the settings
// seam above. `sandcastle init` uses it to verify host-mode agents.
export { DiscoveryError, DiscoveryDataError } from "./discovery/contract.js";
export { codexDiscoveryAdapter } from "./discovery/codex.js";
export { devinDiscoveryAdapter } from "./discovery/devin.js";
export {
  listDiscoveryAdapters,
  getDiscoveryAdapter,
  discoverAgent,
  discoverAgents,
} from "./discovery/registry.js";
export { nodeDiscoveryExec } from "./discovery/nodeExec.js";
export type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveredEffort,
  DiscoveredModel,
  DiscoveryExec,
  DiscoveryExecOptions,
  DiscoveryExecResult,
  DiscoveryState,
} from "./discovery/contract.js";

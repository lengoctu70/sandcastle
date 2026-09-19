# Host mode reuses local agent logins with a worktree safety default

## Context

`noSandbox()` already lets Sandcastle execute an agent on the host, but `sandcastle init` only offers Docker and Podman. Container setup also makes subscription users install and authenticate their agent again inside the container. The intended non-code workflow is to select an already-installed agent, reuse its host subscription login, and run GitHub Issues unattended.

Running an unattended agent on the host is materially different from container isolation. A git worktree can protect the user's active checkout from direct edits, but it cannot stop the agent from reading or changing other host files that the user's account can access.

## Decision

Add **host mode** as an explicit `init` choice with these defaults:

- Detect and verify the identity of installed agent CLIs instead of trusting the executable name alone. Host mode supports Codex, Pi, OpenCode, Grok, Antigravity (`agy`), Devin, Claude Code, Cursor, and Copilot. Init lists verified ready agents first and keeps missing agents behind an "other agents" choice.
- Reuse each agent's existing host subscription login. Host mode does not ask for an API key or copy credentials into `.sandcastle/.env`.
- Discover models from the selected agent at init time. Where an agent exposes multiple model providers, group the models by model provider. Discover model-specific effort choices when the agent exposes them.
- For Devin, reuse its existing account authentication, discover models from its machine-readable account catalog, and treat thinking levels as model variants because Devin selects them through the model identifier rather than a separate effort option.
- If model discovery fails, offer retry, explicit manual entry marked as unverified, or a safe stop before scaffolding. Do not silently present a bundled or cached list as current.
- If an agent is missing or not authenticated, show the official install or login action and offer to check again. Do not automatically install global software or modify a host account.
- Use the `merge-to-head` branch strategy so unattended work happens in a separate host worktree and merges back only through Sandcastle's normal successful-run path.
- Allow unattended execution by enabling the selected agent's non-interactive approval mode after showing a one-time, explicit warning that host mode is not operating-system isolation.
- Provide a `configure` command that changes the agent, model, or effort later without deleting the config directory or overwriting its prompts and workflow customizations.

The warning must not describe the worktree as a security sandbox. It must state that the agent still has the host user's filesystem and process privileges.

## Consequences

- A subscription user can run Sandcastle without installing a container runtime, reinstalling an agent, or logging in again inside a container.
- The active checkout is less exposed to accidental edits than the existing `noSandbox()` head-strategy default.
- Malicious prompts, dependencies, or agent mistakes can still affect files and processes outside the worktree. Users who need an operating-system security boundary must choose Docker or Podman instead.
- Agent detection needs a provider-specific fingerprint because executable names can collide. On the design machine, `agent` identifies Grok even though the existing Cursor integration also assumes the `agent` command.
- Model and effort defaults cannot remain a single hard-coded registry. Discovery failures need an honest fallback flow rather than silently presenting stale values as current.
- Installation and authentication remain visible user actions. Init guides and verifies them but does not take ownership of global CLI installations or subscription accounts.

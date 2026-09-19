---
"@lengoctu70/sandcastle": minor
---

Add a `host` sandbox choice to `sandcastle init` (interactive picker and `--sandbox host`) that scaffolds a host-mode project backed by the existing `noSandbox()` provider: generated mains import `sandboxes/no-sandbox` and pin `branchStrategy: { type: "merge-to-head" }` so agent work happens in a separate git worktree, no Dockerfile/Containerfile or image build is produced, and `.env.example` carries only project-required variables (e.g. the issue tracker's) since the agent reuses its existing host CLI login. Selecting host mode shows a Vietnamese warning that a worktree is not OS isolation before the choice is saved, persists `sandbox: "host"` to `.sandcastle/settings.json`, and prints Vietnamese next steps. Docker and Podman behavior is unchanged.

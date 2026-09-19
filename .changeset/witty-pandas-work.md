---
"@ai-hero/sandcastle": minor
---

`sandcastle init --sandbox host` now scaffolds runnable host-mode mains for the `simple-loop` and `sequential-reviewer` templates. When a template ships a `main.<provider>.mts` variant it is emitted instead of the shared `main.mts` (provider variants are authored provider-native and skip the `docker()` placeholder rewrite). The host variants run the agent via `noSandbox()` in a git worktree — `simple-loop` pins `branchStrategy: { type: "merge-to-head" }`, while `sequential-reviewer` keeps implement and review on one explicit branch in the shared task worktree — reuse host dependencies via `copyToWorktree`, and drop the container-only `npm install` sandbox hook and container-oriented comments. Docker and Podman output for these templates is unchanged.

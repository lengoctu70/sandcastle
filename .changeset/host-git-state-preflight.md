---
"@lengoctu70/sandcastle": patch
---

Protect host Git state before workflow execution. `sandcastle init` (github-issues) and `sandcastle run` now validate that the working directory is a usable Git repository with a resolvable HEAD before any `gh` probe, label creation, or agent invocation — a non-git directory or an unborn repository surfaces an actionable repository error instead of a raw plumbing crash or a mislabeled GitHub permission failure. A dirty active checkout is reported before the agent starts when the checkout is the target branch (tracked modifications would block the landing's fast-forward merge), so agent quota is never spent on work that cannot land. Host mode (`noSandbox`) no longer writes `git config --global` identity or `safe.directory` entries — those writes stay inside container sandbox boundaries. The built-in `TARGET_BRANCH` prompt argument in `createWorktree` flows now names the host's target branch rather than the worktree's source branch.

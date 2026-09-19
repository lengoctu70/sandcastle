---
"@lengoctu70/sandcastle": minor
---

Generate runnable host-mode workflows for both parallel planner templates. With `--sandbox host`, `parallel-planner` and `parallel-planner-with-review` now drop the container-only `npm install` sandbox hook and its container-oriented comments while keeping host dependency reuse via `copyToWorktree`; every concurrent implementer runs on its own explicit branch and host worktree, review stays in the same branch/worktree as the implementation it evaluates, and planner and merger runs pin `merge-to-head` so their results land on the target branch through Sandcastle's normal merge path. Docker and Podman output is unchanged.

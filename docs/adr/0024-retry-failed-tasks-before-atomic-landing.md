# Retry failed tasks before atomic landing

## Context

Sandcastle currently retries malformed structured output, but it does not retry failed project verification or merge conflicts. A failed merge preserves the temporary branch and tells the user to run `git merge` manually. Re-running the whole issue workflow can select the issue again, duplicate work, lose useful failure context, and consume more subscription quota.

Merging directly into the target checkout before post-merge verification can also leave the user's active branch conflicted or broken. A non-code workflow needs a bounded repair path and must not claim success while the target branch is in an unverified state.

## Decision

Use bounded, state-preserving recovery:

- Init detects candidate project verification commands, including `typecheck` and `test` package scripts, and asks the user to confirm them. Missing or skipped verification is shown explicitly and is never reported as passed.
- When verification fails after implementation, feed the exact failure back to the agent in the same worktree for at most two automatic repair attempts. Resume the same agent session when supported; otherwise start a new session against the preserved worktree and failure output.
- Perform the merge in a separate integration worktree based on the current target branch. On a merge conflict, allow one automatic agent repair attempt, then run all verification commands again in that integrated state.
- When verification fails only in the integrated state, allow up to two automatic agent repair attempts inside the integration worktree — the agent repairs the committed merged tree with the integrated failure's command and output. Each committed repair is folded back onto the source branch (a fast-forward, since the integration tip always descends from the source tip) so it survives the disposable worktree, a target-drift rebuild, and a later `retry`.
- Update the target branch only after the integrated result passes verification. Then post the completion report and close the GitHub Issue as specified by ADR 0023.
- If the bounded attempts are exhausted, preserve the recovery branch/worktree, post a Vietnamese failure report, and keep the issue open.
- Provide `sandcastle retry <issue-number>` to continue the preserved failed task. Retry does not reselect the issue or repeat completed implementation from scratch.
- Provide `sandcastle status` to list preserved recovery states and `sandcastle discard <issue-number>` to remove one. Discard asks for confirmation because it deletes unmerged work.
- Remove successful worktrees and recovery metadata automatically. Keep failed recovery state until retry succeeds or the user explicitly discards it.
- On cancellation, idle timeout, or completion timeout in host mode, terminate the agent process tree before returning. Host-mode cleanup cannot be the existing no-op because abandoned child processes retain host access.

## Consequences

- Normal transient or agent-fixable failures recover without asking a non-code user to diagnose commands or reconstruct context.
- Retry is bounded: two verification repairs, one merge-conflict repair, two integrated-verification repairs, and one integration rebuild. A repeated deterministic failure cannot consume subscription quota forever.
- Agents without resumable session storage can still retry because the code, branch, failure output, and task identity are preserved independently of the conversation.
- Sandcastle needs durable recovery metadata that maps a GitHub Issue to its branch, worktree, verification results, and optional agent session.
- Target-branch movement must be checked before landing. If the integration base becomes stale, Sandcastle must rebuild the integrated state rather than force-update or overwrite the user's branch.
- Destructive recovery cleanup is always explicit after failure; normal successful cleanup remains automatic.

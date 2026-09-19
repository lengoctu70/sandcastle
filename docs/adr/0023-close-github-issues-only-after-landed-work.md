# Sandcastle closes GitHub Issues only after work lands

## Context

The existing sequential prompts tell the agent to run `gh issue close` inside its worktree before Sandcastle merges the temporary branch into the target branch. A later merge conflict can therefore leave an issue closed even though its code never reached the project. The generic `Completed by Sandcastle` closing message also does not explain the result to a non-code user.

## Decision

Sandcastle, not the implementation agent, owns the final GitHub Issue transition. A successful task follows this order:

1. The agent implements and commits the task without closing the issue.
2. The configured verification commands pass.
3. Sandcastle merges the work into the target branch successfully.
4. Sandcastle posts the Vietnamese completion report.
5. Sandcastle closes the GitHub Issue.

If verification or merge fails, Sandcastle posts a Vietnamese failure report, keeps the issue open, and preserves the recovery branch or worktree. The completion and failure reports use concise outcome language and a small diagram or diff only where it materially improves understanding.

This behavior initially applies only to GitHub Issues. Other issue trackers keep their existing behavior until they receive an explicit reporting design.

## Consequences

- A closed issue means its code passed the configured checks and reached the target branch, rather than merely existing in an agent worktree.
- Templates must return enough structured task identity and report data for the orchestrator to comment and close after the run.
- GitHub mutations move out of implementation prompts and into orchestration code, so reporting failures can be surfaced separately from coding failures.
- Parallel templates close each issue only after the branch containing that issue has been successfully integrated and verified.

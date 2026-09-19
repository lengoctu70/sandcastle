# Make Sandcastle easy to use with host subscription agents and GitHub Issues

## Problem Statement

Sandcastle exposes a powerful TypeScript orchestration API, but its current setup still expects users to understand sandbox providers, generated TypeScript, static model identifiers, package scripts, and agent-specific authentication. A non-code user who already pays for and has signed into coding-agent CLIs on the host should not need to install the same tools in a container, copy API keys, manually edit generated code, or guess which model and reasoning effort names are valid.

The current fork also has gaps that make unattended GitHub Issue work difficult to trust. Init does not provide one coherent host-subscription setup across supported agents. Model and effort defaults are static even though CLI catalogs change. The executable name `agent` can identify different products on the same machine, so name-only detection can invoke the wrong agent. Implementation prompts can close an issue before Sandcastle has successfully merged and verified its work. Verification and merge failures have no bounded, non-code recovery workflow. A no-sandbox timeout can leave an agent process tree running on the host.

The desired product is a Vietnamese, outcome-oriented CLI that keeps technical details available but does not require the user to edit TypeScript for normal setup, execution, configuration, or recovery.

## Solution

Publish the fork as `@lengoctu70/sandcastle` and make its normal workflow:

1. Install the package as a development dependency.
2. Run `npx @lengoctu70/sandcastle init`.
3. Let init detect and verify installed agent CLIs, their subscription-login readiness, available models, model providers, and supported effort choices.
4. Choose host mode, Docker, or Podman. Host mode is the recommended subscription path, uses a separate git worktree, and clearly warns that it is not operating-system isolation.
5. Choose an understandable workflow outcome, confirm project verification commands, and let init add the package script needed to launch Sandcastle.
6. Run `npm run sandcastle`, choose one labeled GitHub Issue or a set of issues, and let Sandcastle own execution, bounded retries, integration, reporting, and issue closure.

Host mode reuses the selected CLI's existing host login and does not request API keys. It verifies executable identity instead of trusting a command name. Models and effort choices come from the selected CLI when possible. If discovery fails, the user may retry, enter an explicitly unverified model, or stop safely.

Every task runs in an isolated git worktree. Verification failures receive at most two automatic repair attempts. Merge conflicts receive at most one automatic repair attempt in a separate integration worktree. The target branch is updated only after the integrated result passes verification. Sandcastle then posts a concise Vietnamese completion report and closes the GitHub Issue. Failed tasks remain open with a failure report and durable recovery state that can be inspected, retried, or explicitly discarded.

## User Stories

1. As a non-code user, I want to install the fork with one npm command, so that I do not need to build Sandcastle from source.
2. As the fork owner, I want the package published under `@lengoctu70/sandcastle`, so that ownership is clear and independent of the upstream npm scope.
3. As a new user, I want init to guide me in Vietnamese, so that I can make setup choices without translating technical English.
4. As a user, I want commands, flags, filenames, and code identifiers to remain in English, so that generated projects remain compatible with developer tooling.
5. As a subscription user, I want Sandcastle to reuse my existing host CLI login, so that I do not need to create or copy an API key.
6. As a subscription user, I want host mode to avoid reinstalling and signing into an agent inside a container, so that setup is fast and familiar.
7. As a security-conscious user, I want host mode to state that a worktree is not an operating-system sandbox, so that I understand the agent can access files and processes available to my account.
8. As a cautious user, I want Docker and Podman to remain available, so that I can choose a stronger isolation boundary.
9. As an unattended-run user, I want host mode to use a separate worktree, so that the agent does not edit my active checkout directly.
10. As a user, I want Sandcastle to verify an executable's product identity and version, so that a command-name collision cannot launch the wrong agent.
11. As a user whose `agent` command points to Grok, I want Sandcastle not to misidentify it as Cursor, so that my selected provider matches the process that runs.
12. As a Codex user, I want Codex detected as ready when my subscription login is usable, so that init does not ask for an API key.
13. As a Pi user, I want Pi detected as ready and its accessible model providers grouped clearly, so that I can choose from models my account can actually use.
14. As an OpenCode user, I want available models and variants discovered from OpenCode, so that provider-specific effort values are not guessed.
15. As a Grok user, I want Grok subscription authentication, models, reasoning effort, headless output, and permission mode supported, so that it is a first-class host agent.
16. As an Antigravity user, I want the `agy` CLI detected and supported, so that Antigravity subscription workflows do not require a custom adapter.
17. As a Claude Code user, I want existing support preserved, so that simplifying onboarding does not remove a supported agent.
18. As a Cursor user, I want existing support preserved and identity-checked, so that executable collisions are handled safely.
19. As a Copilot user, I want existing support preserved, so that the fork does not regress upstream capabilities.
20. As a user, I want ready agents listed before missing agents, so that the easiest valid choices are visible first.
21. As a user, I want missing agents grouped under an additional choice, so that the main setup screen is not cluttered.
22. As a user with a missing CLI, I want init to show the official installation action without installing global software automatically, so that host changes remain under my control.
23. As a user with an unauthenticated CLI, I want init to show the login action and let me check again, so that account changes remain explicit.
24. As a user, I want model names fetched from the selected CLI, so that retired or newly introduced model IDs do not depend on a Sandcastle release.
25. As a Codex user, I want model-specific supported effort values and defaults read from Codex's model catalog, so that values such as `max` or `ultra` appear only when supported.
26. As an OpenCode user, I want model variants used as effort choices, so that the generated command matches OpenCode's actual catalog.
27. As a user of an agent with multiple model providers, I want models grouped by model provider, so that identically named models remain understandable.
28. As a user, I want the agent-recommended model and effort identified, so that I have a safe default without researching every option.
29. As a user, I want to retry model discovery when it fails, so that a transient CLI or network problem does not force manual configuration.
30. As an advanced user, I want to enter a model manually when discovery fails, so that custom or newly released models remain usable.
31. As a user entering a model manually, I want it labeled unverified, so that the UI never presents an unchecked value as discovered truth.
32. As a user, I want discovery failure to stop before invalid files are scaffolded, so that setup does not leave a misleading configuration.
33. As a first-time user, I want to select a workflow by outcome rather than template codename, so that I understand what Sandcastle will do.
34. As a careful user, I want “work one issue and review it” recommended, so that quality is the default.
35. As a speed-focused user, I want a sequential workflow without a separate review phase, so that I can choose the trade-off explicitly.
36. As a user with several independent issues, I want a parallel workflow, so that I can reduce total completion time.
37. As an advanced user, I want a custom workflow option, so that simplified onboarding does not remove the programmable API.
38. As a first-time user, I want one shared agent, model, and effort choice applied to all roles, so that I do not configure planner, implementer, reviewer, and merger separately.
39. As an advanced user, I want role-specific overrides in configure, so that I can use different models for planning, implementation, review, and merging.
40. As a sequential-workflow user, I want only one issue active at a time, so that behavior and subscription usage remain predictable.
41. As a parallel-workflow user, I want two active issues by default, so that I gain concurrency without immediately maximizing conflicts and quota pressure.
42. As an advanced user, I want to configure parallelism from one through four, so that I can tune it to my machine and subscription.
43. As a user, I do not want an unbounded parallelism option, so that a configuration mistake cannot launch unlimited agents.
44. As a user, I want init to detect candidate verification commands from my project, so that generated workflows do not assume every repository uses npm test scripts.
45. As a user, I want to confirm or change verification commands, so that Sandcastle applies the checks that define success for my project.
46. As a user, I want skipped or missing verification reported honestly, so that “passed” always means a command actually ran successfully.
47. As a user, I want init to add a `sandcastle` package script, so that normal execution is simply `npm run sandcastle`.
48. As a user, I want normal execution to hide generated TypeScript entrypoint details, so that I do not need to know about `tsx` or module extensions.
49. As a GitHub user, I want init to verify GitHub CLI installation and authentication, so that issue operations do not fail after agent work completes.
50. As a repository owner, I want label creation to require confirmation, so that init does not silently mutate repository metadata.
51. As a user, I want the run command to list open issues labeled `Sandcastle`, so that only intentionally queued work appears.
52. As a user, I want to choose one issue interactively, so that an agent never selects an unexpected task on my behalf.
53. As a user, I want to choose all labeled issues sequentially, so that I can leave a queue running unattended.
54. As a user, I want to choose all labeled issues with configured parallelism, so that independent tasks can run concurrently.
55. As an automation user, I want `--issue` and `--all` flags, so that scripts and CI do not require an interactive picker.
56. As a user, I want each task implemented and committed without letting the implementation agent close its issue, so that issue state reflects landed work rather than worktree state.
57. As a user, I want project verification run after implementation, so that obvious breakage is caught before integration.
58. As a user, I want a failed verification sent back to the agent with exact output, so that it can repair the real failure rather than guess.
59. As a subscription user, I want verification repair limited to two attempts, so that a deterministic failure cannot consume quota forever.
60. As a user of a resumable agent, I want retries to continue the same agent session, so that prior reasoning and context are retained.
61. As a user of a non-resumable agent, I want retries to keep the same code and failure context, so that lack of session storage does not force a complete restart.
62. As a user, I want merges attempted in a separate integration worktree, so that a conflict does not dirty my active checkout.
63. As a user, I want one automatic merge-conflict repair attempt, so that straightforward conflicts recover without manual Git work.
64. As a subscription user, I want merge-conflict repair bounded to one attempt, so that repeated conflict loops stop predictably.
65. As a user, I want all verification commands rerun against the integrated result, so that conflict resolution and target-branch changes are tested together.
66. As a user, I want target-branch movement detected before landing, so that Sandcastle never force-overwrites newer work.
67. As a user, I want the target branch updated only after integrated verification passes, so that a failed task cannot leave broken merged code.
68. As a GitHub user, I want a Vietnamese completion report after work lands, so that I can understand what changed and how the project is affected.
69. As a non-code user, I want completion reports to describe outcomes, visible changes, verification, and cautions rather than dump technical logs.
70. As a visual learner, I want a small diagram or diff included only when it materially clarifies the result, so that reports stay concise.
71. As a GitHub user, I want an issue closed only after its code passes verification and lands, so that closed means completed in the real project.
72. As a user, I want failed tasks to receive a Vietnamese failure report and remain open, so that unresolved work is visible and honest.
73. As a user, I want failed worktrees, branches, error output, verification results, issue identity, and optional session identity preserved, so that recovery does not depend on memory.
74. As a user, I want `sandcastle status` to list recoverable tasks, so that I can see what needs attention.
75. As a user, I want `sandcastle retry <issue-number>` to continue preserved work, so that retry does not reselect or reimplement the issue from scratch.
76. As a user, I want `sandcastle discard <issue-number>` to remove abandoned work only after confirmation, so that unmerged changes are not deleted accidentally.
77. As a user, I want successful worktrees and recovery metadata removed automatically, so that routine runs do not accumulate stale state.
78. As a user, I want failed recovery state retained until success or explicit discard, so that cleanup cannot destroy my only copy of work.
79. As a host-mode user, I want cancellation and timeouts to terminate the entire agent process tree, so that abandoned children do not retain access to my machine.
80. As a user, I want `sandcastle configure` to change agent, model, effort, role overrides, verification commands, and parallelism without deleting customized prompts, so that configuration changes are safe.
81. As an existing Sandcastle API user, I want Docker, Podman, existing agents, and programmatic APIs retained, so that the simplified CLI does not remove advanced capabilities.
82. As a maintainer, I want public behavior represented by a pre-1.0 minor changeset, so that consumers can identify the expanded onboarding and workflow contract.
83. As a Vietnamese reader, I want a Vietnamese quickstart in the README, so that installation and first use are immediately understandable.
84. As a technical contributor, I want detailed reference material allowed to remain in English, so that the fork can continue using upstream terminology and documentation efficiently.
85. As a Devin CLI user, I want Sandcastle to reuse my Devin account login and discover the models available to that account, so that Devin is a first-class host agent without requiring an API key.

## Implementation Decisions

- Change the package identity and generated imports to `@lengoctu70/sandcastle`, while retaining the `sandcastle` executable name.
- Keep agent provider and sandbox provider as separate concepts. Host mode is a user-facing init choice backed by the no-sandbox provider, not a new agent type.
- Reuse the upstream host-first no-sandbox scaffolding work where possible. The fork predates closed upstream issues that added explicit no-sandbox scaffolds, branch-isolated parallel templates, host-ready sequential templates, and host-first onboarding; sync or port that work before building fork-specific behavior.
- Introduce an agent discovery contract that reports executable identity, installed version, authentication readiness, available model providers, available models, default model, supported effort choices, default effort, and install/login guidance.
- Agent discovery executes read-only CLI capabilities through an injectable process boundary. A command existing on PATH is insufficient proof of identity.
- Use each agent's native catalog when available. Codex uses its app-server model-list protocol, OpenCode uses verbose model metadata including variants, Pi uses its model listing, Grok uses its model listing, Antigravity uses the `agy` model listing, and Devin uses its account-scoped JSON model listing.
- Treat catalog and auth output as provider-owned, versioned data. Parsers must tolerate unknown fields and return actionable discovery errors rather than silently falling back to hard-coded “latest” models.
- Keep manual model entry as an explicit unverified state. Persist that state so later configure screens do not mislabel it as discovered.
- Add first-class Grok, Antigravity, and Devin agent providers with non-interactive execution, output parsing, model selection, effort or model-variant selection, permission handling, error surfacing, and session support where their documented storage permits it.
- For Devin, verify the installed product and existing account login before offering it. Discover models from the signed-in account, preserve provider model IDs unchanged, and derive displayed thinking choices from the returned model variants instead of inventing a separate effort flag.
- Preserve Claude Code, Codex, Pi, Cursor, OpenCode, and Copilot integrations. Add product fingerprinting before an executable is considered a valid match.
- In host mode, use existing subscription login state and omit agent API-key scaffolding. Continue preserving environment configuration required by GitHub or other project tools.
- Host mode defaults to merge-to-head for sequential work and explicit branches for parallel implementers. It never describes a worktree as a security sandbox.
- Use the safest provider-native unattended permission mode that can complete non-interactively. Always show the host-access warning before saving host mode.
- Terminate the complete host process tree on cancellation, idle timeout, completion timeout, and teardown. Account for platform differences rather than killing only the direct shell child.
- Replace template codenames in the interactive UI with outcome-oriented Vietnamese labels while retaining stable internal template identifiers.
- Apply one shared agent/model/effort configuration to all roles by default. Store optional planner, implementer, reviewer, and merger overrides through configure.
- Bound parallel issue execution to one through four, defaulting to two only for the parallel workflow and one for sequential workflows.
- Detect project verification candidates and ask the user to confirm the ordered command list. Verification status distinguishes passed, failed, skipped, and unavailable.
- Add a CLI-owned workflow-run service. Generated TypeScript remains an advanced implementation surface, but normal users launch through `sandcastle run` and the package script inserted by init.
- Preserve unrelated package scripts. If a conflicting `sandcastle` script already exists, ask before replacing it or require an explicit non-interactive choice.
- Make GitHub Issues the simplified workflow's initial task source. Verify GitHub CLI and authentication during init, and create the `Sandcastle` label only after confirmation.
- Move issue selection from the implementation prompt to the CLI. The selected issue identity is immutable for that task run.
- Move GitHub completion and closure mutations out of implementation prompts. The orchestrator posts and closes only after atomic landing succeeds.
- Require task runs to return structured task identity and report material sufficient to construct completion and failure reports without scraping prose.
- Store durable recovery state independently of agent session storage. Recovery includes issue number, source branch, worktree, target base, failure phase, failure output, verification results, attempt counts, and optional session identity.
- Retry verification repair at most twice. Prefer native session resume; otherwise start a fresh agent invocation in the preserved worktree with task and failure context.
- Build merge results in an integration worktree based on the current target branch. Permit one agent conflict-repair attempt and rerun all verification before landing.
- Recheck the target branch immediately before landing. Rebuild stale integration state instead of force-updating the target.
- Clean successful state automatically. Preserve failed state until retry succeeds or a confirmed discard removes it.
- Keep Vietnamese at the presentation boundary: prompts, warnings, statuses, pickers, completion reports, failure reports, and quickstart. Keep shell/API identifiers and generated code in English.
- Keep other issue trackers and advanced APIs available but exclude them from the initial simplified reporting and closure guarantee.
- Record public-facing additions in a pre-1.0 minor changeset and update README behavior and package metadata.

## Testing Decisions

- Test externally observable behavior rather than internal string replacement, parser call ordering, or private storage layout.
- Use the built CLI process in a temporary git repository as the primary test seam. This is the highest seam that observes help text, non-interactive flags, prompts through controlled input, generated files, package-script edits, branch behavior, status output, and exit status as a user experiences them.
- Replace external agent CLIs and GitHub CLI at the process boundary with deterministic fake executables placed first on PATH. Fixtures represent installed, missing, wrong-product, unauthenticated, discovery-success, discovery-failure, malformed-output, and changing-catalog cases without using real accounts or spending subscription quota.
- Reuse existing CLI integration-test patterns that execute the built binary in temporary repositories.
- Reuse existing initialization tests for generated artifacts, package-manager behavior, provider-aware scaffolds, environment examples, and next-step output.
- Add contract tests for each agent discovery adapter using captured, sanitized CLI output. Verify identity fingerprints, model grouping, default choices, effort capabilities, unknown fields, and actionable failures.
- Add agent-provider fixture tests for Grok, Antigravity, and Devin command construction and output parsing, following existing Claude Code, Codex, Pi, Cursor, OpenCode, and Copilot tests.
- Test the command-name collision case where `agent` identifies Grok rather than Cursor.
- Test that host mode never scaffolds agent API-key requirements and never claims operating-system isolation.
- Test that Docker and Podman paths remain available and retain their expected artifacts.
- Test interactive ready-first agent ordering and the separate missing-agent path. Test equivalent non-interactive flags without requiring a TTY.
- Test retry, manual unverified model entry, and safe-stop behavior when discovery fails.
- Test configure against a customized config directory and verify that prompts and workflow customizations survive agent/model/effort changes.
- Test package-script insertion, preservation of unrelated scripts, and explicit handling of an existing conflicting script.
- Test verification-command detection across npm and non-npm fixtures, including no detected commands and an explicit skip.
- Test workflow runs through a fake GitHub CLI: one issue, all sequential, all parallel, unauthenticated GitHub, missing label, and no eligible issues.
- Test that implementation prompts cannot close issues and that no completion mutation occurs before integrated verification and landing.
- Test two repair attempts after verification failure, then assert a failure report, open issue, and preserved recovery state.
- Test one merge-conflict repair attempt, integrated verification, target-branch movement, safe abort, and recovery preservation.
- Test successful atomic landing followed by completion report and issue closure in that order.
- Test completion and failure report content in Vietnamese, including honest skipped-verification language and optional concise visual blocks.
- Test `status`, successful retry, exhausted retry, unknown issue number, confirmed discard, and rejected discard.
- Test that successful runs remove temporary state while failed runs retain it.
- Add focused process-lifecycle integration tests proving host cancellation and timeout terminate descendants, with platform-specific coverage where process-group behavior differs.
- Never call live subscription APIs, mutate live GitHub repositories, or rely on the developer's real agent configuration in automated tests.
- Run focused tests, `npm run typecheck`, and the full test suite before completion.

## Out of Scope

- Removing Docker, Podman, Vercel, Daytona, custom sandbox providers, existing agent providers, or the programmatic TypeScript API.
- Providing operating-system isolation in host mode or claiming that a worktree limits host filesystem access.
- Automatically installing global agent CLIs or completing subscription login on the user's behalf.
- Guaranteeing that every third-party CLI exposes a complete or stable model catalog forever.
- Treating a cached or bundled model list as current after live discovery fails.
- Unlimited automatic retries, unlimited parallelism, or force-updating a moved target branch.
- Closing GitHub Issues before integrated code passes verification and lands.
- Full completion-report and closure support for Beads, custom trackers, or other issue trackers in the first release.
- Translating every technical reference document into Vietnamese.
- Migrating or rewriting existing user configurations automatically on package upgrade.
- Publishing the npm package, deploying a release, or changing repository secrets as part of implementing the feature itself.
- Solving unrelated container dependency, Windows mount, or remote sandbox issues.

## Further Notes

- The accepted design is recorded in the fork's domain glossary and ADRs covering host-mode trust, package identity, landed-work issue closure, bounded retry with atomic landing, shared model defaults with bounded parallelism, and the CLI-owned GitHub workflow.
- A throwaway HTML prototype demonstrates normal discovery, failed model discovery, and blocked missing/authentication states. It is illustrative and is not production UI code.
- The fork's current commit predates upstream's completed host-first onboarding work in issues #971 through #975. Those upstream issues are prior art to port or sync, not justification to duplicate the same implementation from scratch.
- Upstream issue #766 tracks no-sandbox process-tree cleanup and remains relevant to the host lifecycle requirement.
- Upstream issue #786 tracks hard-coded npm verification commands and reinforces the decision to detect and confirm project verification commands.
- The local design machine verified dynamic model discovery from Codex, OpenCode, Pi, Grok, and the installed Devin CLI. Devin exposes account login status, machine-readable model discovery, non-interactive execution, model selection, and unattended permission modes. Antigravity was not installed locally, so its adapter must be validated against the official `agy` CLI and captured output during implementation.
- The primary test seam has been selected to match existing repository practice: the built CLI in temporary repositories, with fake external executables at the process boundary. This keeps tests user-visible while avoiding live account and GitHub mutations.

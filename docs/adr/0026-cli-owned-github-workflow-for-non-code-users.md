# The CLI owns the GitHub workflow for non-code users

## Context

The existing init flow asks users to add a package script manually and then execute a generated TypeScript file with `tsx`. Issue selection is delegated to an agent prompt that chooses from labeled issues. Those steps expose implementation details and make it harder for a non-code user to choose exactly what will run.

The fork initially targets a Vietnamese user working only with GitHub Issues. Technical identifiers still need to remain compatible with npm, shells, TypeScript, GitHub CLI, and upstream code.

## Decision

- Init adds `"sandcastle": "sandcastle run"` to the host project's `package.json` scripts. The normal launch command is `npm run sandcastle`.
- `sandcastle run` lists open GitHub Issues carrying the `Sandcastle` label and lets the user choose one issue, all issues sequentially, or all issues with configured parallelism.
- Non-interactive selection supports `sandcastle run --issue <number>` and `sandcastle run --all`; the npm equivalents pass these flags after `--`.
- Init verifies that GitHub CLI is installed and authenticated. It offers to create the `Sandcastle` label after explicit confirmation rather than silently mutating the repository.
- The initial user-facing issue tracker is GitHub Issues. Existing internal support for other trackers is not deleted, but it is not part of the simplified default workflow or completion-report guarantee.
- Interactive prompts, warnings, status messages, and GitHub completion/failure reports are in Vietnamese.
- Commands, flags, filenames, package names, code identifiers, and generated TypeScript remain in English.
- README starts with a Vietnamese quickstart. Detailed technical reference may remain in English.

## Consequences

- A normal user does not need to know about `tsx` or edit `package.json` after init.
- The human, rather than the implementation agent, controls which issue or issue set enters a workflow run.
- Script insertion must preserve unrelated scripts and handle an existing conflicting `sandcastle` script explicitly.
- Headless and CI usage remains deterministic through flags and must not open an interactive picker.
- GitHub authentication and label permissions fail early during setup instead of after agent work has already completed.

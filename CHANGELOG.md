# @lengoctu70/sandcastle

## 0.13.0

### Minor Changes

- b608615: Add a first-class Google Antigravity (`agy`) agent provider and host-mode discovery. The new `antigravity(model, options?)` factory runs the CLI in its headless stream-json mode — `agy --input-format stream-json --output-format stream-json` with the prompt delivered as one NDJSON `user` message on stdin, so large prompts never hit argv size limits — with `--model`, `--effort`, and `--dangerously-skip-permissions` wired through. Its parser understands the real `init`/`step_update`/`result` event vocabulary (session id, `text_delta` streaming, `tool_info`/`tool_name` tool calls, terminal `status`/`error`/`usage`) plus `AGY_ERROR:` lines. `sandcastle init --agent antigravity --sandbox host` probes the executable through the injected discovery boundary — fingerprinting `agy --help` output (a bare numeric `--version` is not identity proof), checking auth readiness and reading the live model catalog via `agy models`, and inferring per-model effort choices from the slug suffix — then persists the selection as `modelSource: "discovered"` and generates `antigravity("<model>", { effort: "<effort>" })`. Distinct Vietnamese guidance covers not-installed, wrong-product, and unauthenticated states. Resume is deferred per ADR 0016: agy stores conversations as SQLite files indexed by a shared `conversation_summaries.db`, so `captureSessions` is false and there is no `sessionStorage` until the storage round-trip is verified end-to-end — `agy --conversation <id>` still works natively on the host.
- 3d9b0a0: `sandcastle run` now repairs deterministic failures automatically within strict bounds (ADR 0024) instead of stopping at the first error. A failed source-stage verification sends the exact failed command, its exit code, and captured output back to the agent in the same worktree — resuming the captured agent session natively for providers with session storage (Claude Code, Codex, Pi, Grok), or launching a fresh invocation against the preserved worktree with the task and failure context inlined for non-resumable providers (Cursor, OpenCode, Copilot, Devin, Antigravity) — for at most two repair attempts, each re-running all configured verification commands. A merge conflict in the integration worktree triggers at most one repair inside that worktree: the agent resolves the conflicted files and commits the in-progress merge, Sandcastle verifies the merge actually completed (no unmerged paths, source branch is an ancestor of HEAD), then re-runs every verification command on the integrated tree before landing. When the target branch moved during integration, the run discards the integration state and rebuilds it on the new tip at most once — a second movement stops safely, and the target branch is never force-updated. Exhausted budgets post a Vietnamese failure report naming the phase and the attempts spent, keep the issue open, preserve the source branch and worktree, and persist a machine-local `.sandcastle/recovery/issue-<N>.json` record that now carries the failure phase, structured attempt counters (`implementation`, `verificationRepair`, `mergeConflictRepair`, `integrationRebuild`), verification results, and the last agent session id; the completion report likewise surfaces how much automatic repair the landing needed.
- 43ad90a: Add `sandcastle run` — the first complete single-issue workflow command (ADR 0023/0024/0026). With the `github-issues` issue tracker configured, `run` verifies `gh` is installed and authenticated and that the `Sandcastle` label exists, then either lists open labeled issues for an interactive one-issue pick or takes `--issue <number>` deterministically. The selected issue's identity is fixed for the run and injected into a Sandcastle-owned implementation prompt that never carries issue-closing instructions — the agent works on a dedicated `sandcastle/issue-<number>` branch in its own worktree using the persisted agent/model/effort and sandbox choice. After implementation, the configured `verificationCommands` run in the worktree with per-command pass/fail/skip results recorded to `settings.json`; the result is then merged in a separate integration worktree based on the target branch's current tip and verification runs again on the integrated tree. The target branch lands only after a freshness recheck — `merge --ff-only` when it's the active checkout, an atomic compare-and-swap `update-ref` otherwise — and only then is a Vietnamese completion report (outcome, landed commits, change stat, executed verification, cautions) posted and the issue closed, in that order. Every pre-landing failure posts a Vietnamese failure report instead, keeps the issue open, preserves the source branch and worktree plus a durable `.sandcastle/recovery/issue-<N>.json` record for later retry tooling, and never leaves the active checkout conflicted.
- 0e2f95f: Fingerprint Claude Code, Cursor, and Copilot before offering them in host mode. `sandcastle init --sandbox host` now discovers all four supported agents through the shared discovery contract, each adapter probing its real executable without touching subscriptions:
  - **Claude Code** (`claude`) — fingerprinted by the `(Claude Code)` product mark in `claude --version`; `claude auth status` JSON (`loggedIn`) verifies the login. Claude Code exposes no model-list command, so a verified report carries an empty catalog.
  - **Cursor** (`agent`) — the command-name-collision case: `agent` can resolve to a different product entirely, so the adapter requires Cursor markers in `agent --help` (`Cursor Agent`, `CURSOR_API_KEY`, `Authenticate with Cursor`) — Grok's `agent` answers `grok 1.0.30`/`Grok Build TUI` and reports `wrong-product`. Auth comes from `CURSOR_API_KEY` or `agent status`; the live catalog is read from `agent models`.
  - **Copilot** (`copilot`) — fingerprinted by `GitHub Copilot` in `copilot --version` or `--help` (older builds print a bare version). Auth follows the documented credential chain: `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`, then `gh auth status`. Copilot has no model-list command either, so it reports `ready` with an empty catalog.

  Agents with no catalog command keep the `--model` flag or registry default and persist `modelSource: "manual-unverified"` instead of pretending a verified pick; distinct Vietnamese guidance covers `not-installed`, `wrong-product`, and `unauthenticated`, and a non-ready report stops non-interactive init before anything is scaffolded. Runtime provider behavior is unchanged — discovery only inspects, never installs or logs in.

- b29d735: Ship the Vietnamese quickstart and prove the complete non-code workflow end to end (#21). `README.md` now opens with a Vietnamese `Bắt đầu nhanh` section covering the full release surface: `npm i -D @lengoctu70/sandcastle` (or `npx @lengoctu70/sandcastle init`), `npx sandcastle init`, the `"sandcastle": "sandcastle run"` package script init adds, and `npm run sandcastle` — plus honest explanations of host-mode trust (subscription-login reuse in a git worktree that is **not** OS isolation), the Docker/Podman alternatives, live model/effort discovery with the explicit `manual-unverified` fallback, verification commands, the bounded repair limits (2 verification / 1 merge-conflict / 1 integration rebuild), the `status`/`retry`/`discard` recovery commands, and the guarantee that GitHub Issues close only after verified landing. The detailed English reference is reorganized but kept intact below. New `src/e2e.test.ts` end-to-end tests drive the real built CLI with fake `gh`/`claude` executables on PATH: one covers `init` (non-interactive flags, host mode, github-issues, label creation) through `npm run sandcastle -- --issue N` to an ordered implement → verify → land → report → close with the issue actually closed, and the other covers a verification failure beyond repair through the persisted recovery record, `sandcastle status`, `sandcastle retry` with the agent fixed, successful landing/report/closure, and complete branch/worktree bookkeeping cleanup.
- 8db3401: Add a shared agent-discovery contract (`src/discovery/`, re-exported from the package root) and a complete Codex implementation. `sandcastle init --agent codex --sandbox host` now probes the `codex` executable through an injectable process boundary — fingerprinting `codex --version` output, checking `codex login status`, and reading the live model catalog via the app-server JSON-RPC `model/list` protocol (with `codex debug models` as the documented fallback) — then lets you pick a model and reasoning effort that actually exist. The selection is persisted to `settings.json` as `modelSource: "discovered"` and generated into `main.mts` as `codex("<model>", { effort: "<effort>" })`. Distinct Vietnamese guidance covers not-installed, wrong-product, and unauthenticated states; non-interactive init fails fast with actionable output, while interactive init offers retry, explicit manual-unverified entry, or a safe stop before scaffolding. `CodexOptions.effort` widens to `string` so catalog values beyond the historical set (`max`, `ultra`, …) pass through. Other agents keep the static picker for now — later tickets add their adapters (one file plus one registry line each).
- 7588738: Add Devin CLI as a first-class agent provider and host-mode discovery target. The new `devin()` factory (exported from the package root) runs `devin -p` non-interactively with `--model <id>`, `--respect-workspace-trust false` (print mode cannot show the trust prompt and would fail in Sandcastle's worktree), and `--permission-mode dangerous` on AFK runs — reachable only after host mode's explicit host-access warning. Devin encodes thinking levels as model variants rather than a separate effort flag, so `DevinOptions.variant` carries the exact catalog `model_uid` and passes it to `--model` unchanged; output is plain text, surfaced line-by-line as `text` events so the completion signal and stream forwarding keep working, and non-zero exits surface through the standard stderr/stdout-tail error path. `sandcastle init --agent devin --sandbox host` fingerprints `devin --version`, verifies the account via `devin auth status`, and reads the account-scoped catalog from `devin models list --format json` — families become models and variants become effort choices — persisting the pick to `settings.json` and generating `devin("<family>", { variant: "<model_uid>" })`. Missing CLI, wrong product, unauthenticated, malformed, timed-out, and non-zero catalog outcomes all produce actionable Vietnamese guidance with no stale fallback. Devin sessions live in a SQLite store, so the provider is non-resumable (no `sessionStorage`, `captureSessions: false`) like `cursor`/`opencode`/`copilot`.
- b968ced: Generate runnable host-mode workflows for both parallel planner templates. With `--sandbox host`, `parallel-planner` and `parallel-planner-with-review` now drop the container-only `npm install` sandbox hook and its container-oriented comments while keeping host dependency reuse via `copyToWorktree`; every concurrent implementer runs on its own explicit branch and host worktree, review stays in the same branch/worktree as the implementation it evaluates, and planner and merger runs pin `merge-to-head` so their results land on the target branch through Sandcastle's normal merge path. Docker and Podman output is unchanged.
- d06ac45: Add first-class Grok (xAI Grok Build CLI) support. The new `grok()` provider runs headless turns via `grok --output-format streaming-json` with the prompt piped through `--prompt-file /dev/stdin` (Grok's `-p -` does not read stdin), `--always-approve` for unattended runs, `--reasoning-effort` for effort, and `--resume`/`--fork-session` for session resume and forks. The stream parser maps Grok's ACP-style events (`text`, `tool_call`, `usage`, `end`, `error`) to Sandcastle's structured events, including session id and token usage. Sessions are stored as directory trees under `~/.grok/sessions/<percent-encoded-cwd>/<id>/`; capture/resume transfers the whole tree and rewrites the cwd-bearing files (`summary.json`, `prompt_context.json`, `chat_history.jsonl`) — verified against `grok --resume <id>` round-trip. `sandcastle init --agent grok --sandbox host` fingerprints `grok --version` / `Grok Build TUI` help output — also through the `agent` entrypoint alias, which resolves to the same Grok binary — probes auth and the live model catalog via `grok models`, and detects `--reasoning-effort` capability for the effort picker. A same-named foreign executable is reported as `wrong-product`, and a non-Grok `agent` (e.g. Cursor's CLI) is never claimed as Grok.
- 55cfa93: Fix false idle-timeout kills for agents whose print mode streams text without newlines (`devin -p`). The sandbox `exec` contract gains `onData(chunk)` — raw stdout bytes as they arrive — and the idle timer now resets on any stdout byte instead of only complete lines, so a working agent that stays line-silent no longer fails at 600s. Providers with unframed output can define `parseStreamChunk`, which Devin implements so its narration surfaces live in the run log instead of in one block at exit. `sandcastle run`/`retry` accept `--idle-timeout <seconds>`, and `.sandcastle/settings.json` accepts `idleTimeoutSeconds`; both flow to every agent invocation in the issue workflow (ADR 0027).
- 13a4043: Rename the distributable package from `@ai-hero/sandcastle` to `@lengoctu70/sandcastle` so the fork publishes under the owner's npm scope (ADR 0022). The executable stays `sandcastle`; install with `npm install --save-dev @lengoctu70/sandcastle` and scaffold with `npx @lengoctu70/sandcastle init`. All generated `main.mts`/host-variant imports and the repo's own `.sandcastle/` orchestration files now resolve `@lengoctu70/sandcastle` and its `./sandboxes/*` subpaths, and repository metadata points at `lengoctu70/sandcastle`.
- 8a85ddf: Complete the non-code `sandcastle init` experience around the workflow picker (ADR 0024/0025/0026). The interactive workflow step now presents Vietnamese outcome labels bound to the unchanged internal template ids — reviewed sequential (`sequential-reviewer`) is the recommended preselection, with fast sequential (`simple-loop`), both parallel planners, and a custom/blank option alongside. Init detects verification commands from `package.json` scripts (`typecheck`, `lint`, `test`, `build`, in run order and via the detected package manager) and non-npm markers (`Cargo.toml`, `go.mod`, `pytest`/`tox`/`pyproject.toml`, a `Makefile` `test:` target), then offers confirm/edit/skip; non-interactive runs adopt the detection deterministically or take the new `--verification-commands` list / `--skip-verification` flags. The persisted settings carry `verificationCommands` plus an honest `verificationStatus` (`passed`/`failed`/`skipped`/`unavailable`, schema version 1) so a skipped or undetected setup is never reported as passed. For `--issue-tracker github-issues`, init now verifies `gh` is installed and `gh auth status`-authenticated before anything is scaffolded — interactive runs can recheck after `gh auth login`, headless runs fail with Vietnamese guidance — creates the `Sandcastle` label only after explicit confirmation (`--create-label`), and reports permission failures with gh's own error line. Init also inserts `"sandcastle": "sandcastle run"` into the project `package.json` (creating a minimal one if absent, preserving unrelated scripts), and never silently overwrites a conflicting existing script — interactive init asks, non-interactive init fails unless `--overwrite-script true|false` decides. Docker and Podman flows are unchanged, and host mode still reuses the host CLI login without asking for API keys.
- 22b4781: Add an OpenCode discovery adapter to the shared discovery flow. `sandcastle init --agent opencode --sandbox host` now verifies the `opencode` executable by its `--help` fingerprint (block-art logo / `opencode <cmd>` command list, since `--version` prints only a bare number), checks credential readiness via `opencode auth list`, and reads the live `opencode models --verbose` catalog — models are grouped by provider (`opencode`, `opencode-go`, `openai`, …) and each model's `variants` become its valid effort choices, so a model without variants offers none. The picked model and variant persist to `settings.json` as `modelSource: "discovered"` and generate `opencode("<provider/model>", { variant: "<effort>" })`, which the factory passes through as `--variant`. Vietnamese guidance covers not-installed, wrong-product, and unauthenticated states; malformed catalog data is a terminal discovery error while unknown fields stay tolerated.
- 387341d: Add Pi to host-mode agent discovery. `sandcastle init --agent pi --sandbox host` now probes the `pi` executable through the same injectable process boundary as Codex — fingerprinting `pi --help` for the `pi - AI coding assistant` line (the bare `pi --version` carries no product string), treating `pi --list-models`' "No models available" message as the unauthenticated signal, and parsing its live provider/model table so you pick from models your configured providers can actually serve, grouped by model provider. Pi's thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) surface as effort choices with `medium` as the default, and `pi auth check --provider <p> --json --no-refresh` supplies read-only auth evidence per discovered provider. The selection persists to `settings.json` as `modelSource: "discovered"` and generates `pi("<provider>/<model>", { thinking: "<level>" })` in `main.mts`. `PiOptions.thinking` now accepts `"max"`, matching the CLI's level set.
- c0ceca7: Persist a versioned `.sandcastle/settings.json` during `init` and expose a shared load/save/update seam (`ProjectSettings`, `loadProjectSettings`, `saveProjectSettings`, `updateProjectSettings`) so future `run` and `configure` commands can reload the selected agent, model, effort, workflow, sandbox, verification commands, parallelism, per-role overrides, and issue tracker without re-prompting. Settings diagnostics are Vietnamese and actionable; saves never rewrite generated prompts or workflow files.
- c5ca4ed: `sandcastle run` can now work through every eligible issue in one invocation (sequential or bounded-parallel, #20). The interactive picker first asks for the run scope — one issue, all eligible issues sequentially, or all eligible issues in parallel bounded by the configured `parallelism` — and non-interactive runs get `--all` (every open `Sandcastle`-labeled issue, ascending issue-number order) plus `--parallelism <1-4>` as a per-run bound override; `--all` and `--issue` are mutually exclusive, and there is no unbounded option. Each queued issue gets the identical single-issue pipeline — its own `sandcastle/issue-<number>` branch, worktree, integration worktree, verification, atomic landing, Vietnamese report, and issue close — while a shared FIFO lock serializes worktree creation and the whole integrate → re-verify → land section across concurrent issues, so parallel runs can never prune a sibling's half-created worktree or race the target branch. A failing issue never aborts the queue: it keeps its failure report, preserved branch/worktree, and `.sandcastle/recovery/issue-<N>.json` record, and the run ends with a Vietnamese summary naming landed vs failed issues (non-zero exit when any failed, so landed work stays landed). Host-mode sandbox setup also retries `~/.gitconfig` lock collisions between parallel runs.
- a51564a: Add `sandcastle configure` — a settings-only update command that loads `.sandcastle/settings.json`, displays the current values, and applies changes through the shared `updateProjectSettings` seam without ever rewriting generated prompts, workflow code, or `package.json`, so user customizations stay byte-for-byte intact. On a `host` sandbox the shared agent/model/effort section reuses init's live discovery: switching agents re-probes the executable for its real catalog, changed model/effort values are validated against it, and `--allow-unverified` accepts an explicitly unverifiable pair (persisted as `modelSource: "manual-unverified"`); container projects keep the static picker. Verification commands can be replaced (`--verification-commands`), cleared (`--skip-verification`, recorded as `"skipped"` so a skipped setup never reports as passed), or edited interactively, and parallelism stays bounded to 1–4 (`--parallelism`). Per-role overrides for `planner`/`implementer`/`reviewer`/`merger` are managed with repeatable `--set-role role.field=value` / `--clear-role role` flags — clearing the last field restores inheritance from the shared defaults. A cancelled or failed run writes nothing (the single save happens after every choice resolves), a bare non-interactive `configure` prints the current settings without prompting, and missing/invalid flag values fail with clear English diagnostics while prompts and statuses stay Vietnamese.
- c4f712a: Add a `host` sandbox choice to `sandcastle init` (interactive picker and `--sandbox host`) that scaffolds a host-mode project backed by the existing `noSandbox()` provider: generated mains import `sandboxes/no-sandbox` and pin `branchStrategy: { type: "merge-to-head" }` so agent work happens in a separate git worktree, no Dockerfile/Containerfile or image build is produced, and `.env.example` carries only project-required variables (e.g. the issue tracker's) since the agent reuses its existing host CLI login. Selecting host mode shows a Vietnamese warning that a worktree is not OS isolation before the choice is saved, persists `sandbox: "host"` to `.sandcastle/settings.json`, and prints Vietnamese next steps. Docker and Podman behavior is unchanged.
- c879ad2: Complete the host-mode agent picker and discovery recovery in `sandcastle init`. With `--sandbox host` and no `--agent`, init now probes every registered discovery adapter in one parallel pass and lists verified-ready agents first — each hint shows the installed version and live model count — while unavailable agents sit behind an "other agents" choice that reports whether each is missing, unauthenticated, the wrong executable, or errored, with actionable Vietnamese guidance and a recheck option. Every failure path offers retry, an explicit manual entry persisted as `modelSource: "manual-unverified"`, or a safe stop — all before anything is scaffolded, and no cached or bundled list is ever presented as a live result. The model picker groups entries by model provider where catalogs carry one (Pi, OpenCode, Devin) and marks the recommended model and effort `(khuyến nghị)`. Non-interactive parity comes from the new `--allow-unverified` flag: a `--model`/`--effort` pair that live discovery could not verify is accepted and honestly marked unverified; without it those runs exit non-zero with the same guidance. All init prompts and statuses are now Vietnamese (identifiers stay English), and Docker/Podman flows are unchanged.
- 9c92b18: `sandcastle run` now executes the persisted `settings.workflow` end-to-end and honors per-role agent choices (#27). The run dispatches optional phases from the configured workflow id — `parallel-planner` adds a read-only planning pass whose plan text is injected into the implementation prompt, `sequential-reviewer` adds a review pass over the committed branch diff, and `parallel-planner-with-review` runs both; `simple-loop`/`blank` keep the base pipeline and an unknown workflow id falls back to it with a warning. Each workflow role — planner, implementer, reviewer, and merger — resolves its effective agent/model/effort independently by layering `roleOverrides` over the shared `settings.agent`/`model`/`effort`, so a planner override never leaks into implementation and a merger override can give conflict repair a different agent entirely (a non-resumable one falls back to a fresh invocation carrying the failure context, per ADR 0024). Planning and review are first-class recovery phases: a run that stops in either records it in `.sandcastle/recovery/issue-<N>.json` and `sandcastle retry` re-enters at the right stage while planner/reviewer sessions never displace the implementer session that retries resume. Host-mode discovery now persists which executable actually fingerprinted — `agentExecutable` in settings.json — so Grok installs that only answer under their `agent` alias work end-to-end: `init --agent grok --sandbox host` writes `grok("<model>", { executable: "agent" })` into the generated provider call and `run` invokes the same entrypoint. The alias is cleared when `configure` switches agents and is never applied to a role override that resolves to a different provider. Interactive `configure` pre-selects the current effective agent/model/effort (F015), and changing the model drops an inherited effort unless it is re-supplied or still valid for the new model (F037).
- f926363: `sandcastle init --sandbox host` now scaffolds runnable host-mode mains for the `simple-loop` and `sequential-reviewer` templates. When a template ships a `main.<provider>.mts` variant it is emitted instead of the shared `main.mts` (provider variants are authored provider-native and skip the `docker()` placeholder rewrite). The host variants run the agent via `noSandbox()` in a git worktree — `simple-loop` pins `branchStrategy: { type: "merge-to-head" }`, while `sequential-reviewer` keeps implement and review on one explicit branch in the shared task worktree — reuse host dependencies via `copyToWorktree`, and drop the container-only `npm install` sandbox hook and container-oriented comments. Docker and Podman output for these templates is unchanged.
- a65ff1c: Failed `sandcastle run` tasks are now durable and manageable across process exits (#19). The recovery record at `.sandcastle/recovery/issue-<N>.json` is extended with a schema version, the target branch's base SHA, and a retry counter, and a tolerant reader distinguishes missing, valid, and corrupt records — a file Sandcastle cannot parse is surfaced as corrupt, never silently deleted or used. Three new commands manage the preserved work, all with Vietnamese output: `sandcastle status` lists every preserved task with the phase it stopped in, failure time, retry count, live branch/worktree state, spent bounded-repair attempts, and explicit stale markers; `sandcastle retry <issue-number>` continues the preserved task without ever re-selecting an issue or creating a new implementation branch — it re-enters the workflow at the recorded failure phase inside the preserved worktree and source branch (rebuilding the worktree from the branch's commits when only the branch survived), resumes the recorded agent session when the provider supports session storage and the session still exists, and otherwise invokes the agent freshly against the preserved code with the issue identity and failure context inlined — then lands through the normal verify → integrate → freshness-check → report → close path and cleans up record, worktree, and branch; `sandcastle discard <issue-number>` permanently deletes the preserved worktree, source branch, and record, listing what it will remove first — interactive runs confirm first, non-interactive runs require `--yes`, a declined confirmation touches nothing, and the record is deleted last so a failed removal keeps the task visible. Stale records — a closed issue, a gone target branch, or no committed work left — produce a Vietnamese diagnosis pointing at `discard` instead of silently proceeding.

### Patch Changes

- 984530c: Queue runs and recovery guidance now match durable reality. `sandcastle run --all` checks `.sandcastle/recovery/` before dispatching each issue: an issue with a preserved recovery record is skipped — never reimplemented — and points at `sandcastle retry <issue-number>`; a corrupt record is skipped with manual file-cleanup guidance instead of a failing `retry`/`discard` loop. Queue summaries only claim recovery state is retained when a readable record was actually written, and failures that left no usable record say so plainly. `status` and `discard` now treat a failed `target..source` comparison — including a deleted or renamed target branch — as unknown rather than "0 unmerged commits", so they never call uncertain work landed, empty, or stale; a zero-commit implementation failure is described as incomplete, and `discard` warns that the unmerged count could not be determined before deleting anything.
- 1038e4a: Point the package repository metadata and contributor issue workflow at the maintained fork.
- b63da20: Preserve agent stream boundaries and bound tool-call display args. Pi's lowercase `bash` tool events now surface the executed command instead of being dropped by the case-sensitive allowlist; Devin plain-text lines keep their newline delimiters in terminal and buffered output; and every provider's tool_call args — allowlisted fields, JSON-dump fallbacks, and raw argument strings alike — are capped at 300 characters with a visible ellipsis so one oversized or unfamiliar argument cannot flood output. Antigravity result events now also extract structured `{error: {message}}` objects.
- 3943837: Fix install docs that recommended bare `npx sandcastle …`. Without a local or global install, npx resolves `sandcastle` as a package name and runs an unrelated legacy npm package instead of this CLI. `README.md` and `INSTALL.md` now consistently use `npx @lengoctu70/sandcastle …`, and the `INSTALL.md` troubleshooting table warns about the unscoped-package name collision.
- 0768897: Fix a host process leak in the `noSandbox()` (host mode) provider. `close()` was a no-op and `exec` spawned `sh -c` with no process group, so cancellation, idle timeout, and the completion-timeout force-complete (ADR 0019) abandoned the agent's children — `gh`/git subprocesses, MCP servers — on the host. Every spawned host execution is now tracked for the handle's lifetime; on POSIX the shell runs `detached` as a process-group leader so teardown signals the whole group (`kill(-pgid)`, SIGTERM then SIGKILL after `terminationGraceMs`), and on Windows the tree is killed via `taskkill /PID /T /F`. Termination is guarded so already-exited processes and unrelated or reused pids are never signalled, `close()` is idempotent, and a shutdown-registry hook reaps trees on host `SIGINT`/`SIGTERM`/`exit`. `exec` also accepts an `AbortSignal` so `run()`'s abort path kills the tree immediately. Container sandbox lifecycle is unchanged.
- fc710ab: Hardened every GitHub CLI call `sandcastle run`/`init` makes. `gh` is now always spawned as a fixed executable plus argv with no command shell on any platform — including Windows, where `cmd.exe` previously re-interpreted report content — and completion/failure report bodies travel to `gh issue comment` through stdin (`--body-file -`) instead of a `--body` command-line argument, so multiline text, shell metacharacters, percent signs, Unicode, and reports longer than the Windows 8,191-character command-line limit all reach GitHub literally and can never execute secondary commands. The `Sandcastle` label lookup now uses `gh label list --search` with GitHub's case-insensitive label semantics, so repositories with an existing `sandcastle` label work and repositories with more than 200 labels no longer fail preflight. GitHub failures are now distinct typed causes with actionable Vietnamese guidance: malformed JSON responses, timeouts, spawn failures, unauthenticated state, and permission failures (HTTP 403) each surface their own fix, and an `gh auth status` timeout or spawn error is no longer misreported as "please log in". The displayed authentication detail now names the active account and host (e.g. `Logged in to github.com account <user>`) instead of only the hostname, without exposing credentials.
- 02133ba: Protect host Git state before workflow execution. `sandcastle init` (github-issues) and `sandcastle run` now validate that the working directory is a usable Git repository with a resolvable HEAD before any `gh` probe, label creation, or agent invocation — a non-git directory or an unborn repository surfaces an actionable repository error instead of a raw plumbing crash or a mislabeled GitHub permission failure. A dirty active checkout is reported before the agent starts when the checkout is the target branch (tracked modifications would block the landing's fast-forward merge), so agent quota is never spent on work that cannot land. Host mode (`noSandbox`) no longer writes `git config --global` identity or `safe.directory` entries — those writes stay inside container sandbox boundaries. The built-in `TARGET_BRANCH` prompt argument in `createWorktree` flows now names the host's target branch rather than the worktree's source branch.
- 15eb415: A verification failure that appears only in the integrated tree is now repairable instead of an immediate stop (ADR 0024). The merger-role agent repairs the already-merged state inside the integration worktree — same bounded pattern as source-stage repair, with the integrated failure's exact command and head+tail diagnostic fenced into the prompt — for at most two attempts, each re-running all configured verification commands on the merged tree. Every committed repair is folded back onto the source branch with a fast-forward merge, so the fix survives the disposable integration worktree, is included when a target-drift rebuild re-merges, and is what a later `sandcastle retry` integrates — a retry never replays the unchanged merge known to fail. A repair that leaves the worktree dirty fails honestly rather than landing unverified state. The recovery record and run reports carry the new `integrationVerificationRepair` attempt counter alongside the existing budgets.
- 2b6caa4: Keep recovery durable after code lands (#37, F013/F045). Once a run merges work into the target branch, the recovery record now persists as an explicit post-landing state — `landed-awaiting-report` or `landed-awaiting-close`, carrying the exact completion report and landed SHA — instead of being deleted before the GitHub report and issue close run. A report or close failure no longer strands a merged-but-open issue with no record: `sandcastle retry <issue>` finishes only the outstanding GitHub steps (reposting the stored report, then closing) without invoking an agent or repeating the merge, and the source branch plus recovery metadata are only removed after the report posts and the issue closes — ADR 0023's report-before-close order is preserved, so a report failure never closes the issue first. `sandcastle status` and `sandcastle discard` now describe landed-pending records honestly instead of marking them stale.
- 970b831: `sandcastle init` is now non-destructive across common package-file encodings and first-run states. The scaffolded `.sandcastle/.gitignore` includes `recovery/` from the start, so the first workflow failure no longer dirties a tracked file. A `package.json` with a UTF-8 BOM is accepted for package-manager detection, dependency checks, verification-candidate detection, and `sandcastle` script insertion; rewrites preserve the BOM, the file's existing LF or CRLF line endings, and unrelated content. A `scripts` field that isn't a string map (array, `null`, primitive) is now reported and left untouched instead of being coerced, and a defined non-string `sandcastle` entry goes through the explicit conflict resolution rather than being silently overwritten. `!`...``shell expressions inside`<!-- -->` comments in prompt files are now inert — the blank template's example commands can no longer execute and crash the first run on an unborn repository.
- 5606f6e: Make settings and recovery state durable under interruption and concurrency (#36). `.sandcastle/settings.json` and `.sandcastle/recovery/issue-<N>.json` are now written to a same-directory temporary file, flushed to disk, and atomically renamed into place — readers observe either the complete old document or the complete new one, never a truncated file, and a failed replacement preserves the prior document with an actionable Vietnamese diagnostic instead of leaving litter. In-process `updateProjectSettings` read-modify-write operations are serialized per repository so parallel queue workers can no longer lose each other's verification-status updates. `sandcastle retry <issue>` now acquires a cross-process lock file (`.sandcastle/recovery/issue-<N>.lock`) before it can touch the worktree or Git index — a second concurrent retry for the same issue is refused with the lock path and holding pid; a lock left by a dead process is broken as stale, while an unattributable lock file is reported rather than silently deleted.
- 37b20d5: Coordinate `sandcastle run` integration in dedicated worktrees and narrow the shared mutation lock to repository-mutation seams (#32). Queued issue runs now hold the shared FIFO lock only while creating or pruning worktrees, checking the target branch's freshness and updating its ref, and performing shared cleanup — agent invocations, the bounded merge-conflict repair, and all verification commands run outside the lock so parallel issues stay genuinely concurrent (ADR 0025). Sandcastle-owned merges explicitly override user Git merge policy: the integration merge runs with `-c merge.ff=false` so `merge.ff=only` can no longer abort it, and the merge-to-head landing merge runs with `-c merge.ff=true` so it keeps normal fast-forward-or-merge behavior regardless of user config. A target branch that moves between the freshness check and the ref update is now diagnosed as drift and consumes the same bounded integration-rebuild budget instead of failing immediately — the ref is still never force-updated. Workflow results and recovery records now include every commit the integration machinery created (the merge commit, repair commits, and the deterministic merge completion), and shared worktree/branch cleanup runs inside the same locked landing section as the ref update so a sibling can never prune mid-landing. The generated parallel-planner merger phases now pin `branchStrategy: { type: "merge-to-head" }` and `copyToWorktree` explicitly, so host-mode scaffolds merge in a dedicated integration worktree — never in the user's active checkout.
- 5c78fe7: Harden provider invocation and discovery so the configured agent choice actually reaches the CLI and unsupported behavior is reported honestly:
  - **Grok** unattended runs no longer pass `--prompt-file /dev/stdin` to `cmd.exe` on Windows (which has no `/dev/stdin`). `GrokOptions.execPlatform` selects the platform of the shell that will interpret the command: `"win32"` writes the prompt to a private temp file and hands its real path to `--prompt-file` (self-cleaning via `& del`), while POSIX shells — including containers on a Windows host — keep stdin delivery.
  - **Devin** `--model` resolution in init now accepts every selector the live CLI advertises — the family slug, a catalog alias (e.g. `opus`), or an exact variant `model_uid` (e.g. `claude-opus-5-high`) — while keeping family and variant selection distinct: a variant selector resolves the family as `model` and the uid as `effort`, which `DevinOptions.variant` passes back to `--model` unchanged (ADR 0021).
  - **Pi** interactive sessions now receive the configured thinking level (`pi --thinking`), matching print mode.
  - **OpenCode** interactive sessions never emit the `--variant` flag the TUI does not support; a configured variant now prints an explicit notice that it applies only to unattended `opencode run`. Print mode rejects prompts over 120 KiB (UTF-8 bytes) before spawn with an actionable error instead of `E2BIG`.
  - **Copilot** readiness now recognizes a native `copilot login` account through `config.json`'s documented `loggedInUsers` record (env tokens → native login → `gh` fallback, in the CLI's documented precedence); only the non-secret `host`/`login` fields are read.
  - **Grok discovery** no longer recommends a `Default model:` value that is not a catalog member — an unlisted alias degrades to a real catalog entry instead of crashing the headless picker.

- 2a9e762: Repair agents now receive complete, instruction-safe verification evidence (F035/F061). `VerificationCommandResult` gains an `output` channel alongside the report-oriented `outputTail`: the combined stdout/stderr is bounded to 64KiB with head+tail preservation, so the root compiler or test error — usually emitted first, previously cut by the 4,000-char tail — reaches the repair prompt verbatim while GitHub reports keep their shorter bounded summary. The repair, merge-conflict, and resume prompts now wrap captured diagnostics in a fence one backtick longer than any backtick run inside the content (CommonMark's longer-fence rule), so diagnostic text containing Markdown fences, XML-like tags, shell text, or instruction-shaped lines can never close its boundary and become prompt structure; the same helper protects the fenced blocks in the Vietnamese completion and failure reports. Recovery records written before the `output` field existed parse it as the old `outputTail` value, so retries still offer the best available diagnostic.
- debf6ec: Fixes from review of the host-first GitHub Issues workflow. Generated prompts on the GitHub Issues tracker no longer instruct the agent to close or comment on issues — issue mutation is orchestrator-owned and happens only after verification and landing (ADR 0023); self-managed trackers (Beads, Custom) keep their agent-side close instructions. Host-mode scaffolds no longer emit a `GH_TOKEN` placeholder in `.env.example` for GitHub Issues, since the host `gh` CLI reuses the existing `gh auth login` session (container providers still scaffold it). Banned "RALPH" terminology and the "Completed by Sandcastle" signature are gone from generated templates — commit prefixes are now `SANDCASTLE:` and prompts use generic autonomous-agent wording. The parallel planner templates bound concurrency through a worker pool (`parallelism` from `.sandcastle/settings.json`, clamped to 1–4, `SANDCASTLE_MAX_PARALLEL` env override, default 2) instead of launching every planned issue at once. Grok's discovered effort list is marked non-exhaustive, so init accepts an unlisted `--reasoning-effort` value as unverified rather than rejecting a newer CLI's legitimate effort name. The interactive sandbox picker lists Host first, marks it "(khuyến nghị)", and preselects it (ADR 0021).
- 72ca617: Review-fix hardening for the spec-24 queue/recovery work. `sandcastle discard` now takes the same per-issue retry lock `retry` holds — a discard invoked while a retry is in progress refuses with guidance instead of deleting the worktree/branch out from under the running workflow. Post-landing cleanup in `sandcastle run` (worktree remove/prune and source-branch delete after the GitHub report + close) now runs inside the shared queue lock, so a parallel `--all` sibling's `worktree add` can never race the prune. Host-mode verification commands get a hard settle deadline: a spawned grandchild that inherits the stdout/stderr pipes can no longer wedge a run forever — on timeout the whole process tree is terminated (process-group kill on POSIX, `taskkill /T` on Windows) and the command reports an honest `timedOut` result. `sandcastle configure --model` on a host project no longer replays the persisted effort as an explicit flag — a stale effort neither survives silently on an incompatible model nor hard-errors naming a flag the user never passed; the new model's catalog default applies. And scaffolding the Grok agent on a container sandbox (docker/podman) now emits `execPlatform: "linux"`, so a Windows host no longer passes a host temp path that does not exist inside the container.
- 54fa3ab: Bound every agent-discovery probe by a hard settlement deadline so `sandcastle init` and `sandcastle configure` can no longer hang when a probed CLI exits but a spawned descendant (daemon, MCP server, background worker) keeps the inherited stdout/stderr pipes open. At the probe's timeout the whole process tree is signalled (process-group kill on POSIX, `taskkill /T /F` on Windows), and after a short SIGKILL grace the owned streams are closed and the probe resolves exactly once with a typed `timedOut` result — settlement no longer waits on stdio EOF. On Windows, a missing executable probed through `cmd.exe` is now correctly reported as `not-installed` (ENOENT) instead of `wrong-product`: the `'x' is not recognized as an internal or external command` answer is mapped back to the spawn-error contract. Existing Vietnamese timeout guidance (`hết thời gian chờ`) now always reaches the user.
- b4a853e: Make host-mode agent invocation outcomes and teardown truthful. An early child exit while the prompt is being written now surfaces as a handled invocation failure instead of an unhandled `EPIPE` crash, and a process killed by a signal reports a non-zero exit code (128 + signal, e.g. 137/143) rather than a disguised success. Each invocation now owns an internal abort controller: caller cancellation, idle timeout, and the ADR 0019 completion timeout all abort the spawned process tree and wait — bounded — for it to fully settle before `invokeAgent` returns, so lifecycle Git operations (`checkout --detach`, merge, branch cleanup) never overlap a live agent tree. The silence-based completion window is unchanged: trailing output still resets it and no absolute deadline was added. Completion-signal detection now accumulates across the whole streamed conversation, so a signal seen in an earlier turn survives a later result event that drops it. On POSIX, teardown no longer attempts `kill(-pid)` for non-detached children whose pid may have been recycled as an unrelated process group.
- 617c53e: Run `sandcastle run` verification inside the configured execution environment instead of always on the host (F062). Previously, container-selected workflows (`sandbox: "docker"`/`"podman"`) executed verification commands with bare host `exec`, so a configured sandbox was silently bypassed. Both verification stages now run through an execution boundary bound to the state being checked: the source stage runs against the implementation worktree and the integrated stage against the integration worktree — host mode executes directly on the host worktree, while docker/podman start a sandbox over that worktree (same mount wiring the agent run uses) and `exec` inside it, then tear it down. Completion and failure reports now label which environment and stage each command ran in, source and integrated results stay in separate fields on the result and the recovery record, and `verificationStatus` can no longer report `"passed"` when commands were configured but never ran or only partially ran — empty or partial evidence yields `"unavailable"`/`"failed"` instead. Timed-out commands are marked `timedOut` on their per-command record and rendered distinctly in reports and failure guidance.

## 0.12.0

### Minor Changes

- 1e15922: Bump default Claude Code model from `claude-opus-4-7` to `claude-opus-4-8`. The new default applies to the `DEFAULT_MODEL` constant, the `claude-code` agent entry surfaced by `sandcastle init`, and the scaffolded templates (`blank`, `parallel-planner`, `parallel-planner-with-review`). Passing an explicit model to `claudeCode(...)` is unaffected.
- 0f577a4: Add `sandbox.exec(command, options?)` to the `Sandbox` handle returned by `createSandbox()` (and by `worktree.createSandbox()`). The method delegates to the provider handle's `exec()` and returns the full `ExecResult` — non-zero `exitCode` is surfaced, not thrown — so harnesses can run shell commands (tests, lints, custom verification gates) directly in the same warm sandbox between `run()` calls without reaching for the underlying provider handle. `cwd` defaults to the sandbox repo path so behavior is consistent across providers; pass `cwd` to override.

### Patch Changes

- c505d49: Fix file-mode logging so streamed agent text flows as contiguous prose instead of one chunk per line. Added a dedicated `textChunk` streaming method to the display service (raw, no implied newline in file mode) and pointed the text-delta buffer at it, leaving the line-oriented `text()` for discrete entries like context-window summaries. Structured entries (tool calls, status, summaries) still always begin on their own line, even when they immediately follow a mid-line streamed chunk.

## 0.11.0

### Minor Changes

- 9f3f6d5: Add `maxRetries` to `Output.object` and `Output.string` for built-in retry of structured-output runs. When extraction or validation fails, `run()` resumes the failed agent session and feeds back a token-efficient description of the error so the agent can re-emit a corrected tag, up to `maxRetries` extra attempts (default: `0`). Retries require an agent provider that supports session resumption (`claudeCode`, `codex`, `pi`); calling `run()` with `maxRetries > 0` against a non-resumable provider (`cursor`, `opencode`, `copilot`) fails at entry with a clear error.
- bce86dd: Add `resumeSession` to `sandbox.run()` and expose `.resume(prompt, options?)` / `.fork(prompt, options?)` on `SandboxRunResult`. The new options mirror `RunOptions.resumeSession` and `RunResult.resume()/fork()`, but continue the agent session _inside an existing long-lived `createSandbox()` container_ — so the container, worktree, and on-ready dependencies stay warm across implement → review → edit phases instead of each phase paying container boot. Resume is gated on the session-capture fix in this release; non-bind-mount providers skip capture and therefore have nothing to resume from.

### Patch Changes

- bce86dd: Fix `createSandbox().run()` and `createWorktree().run()` not capturing the agent session on bind-mount providers — `iterations[].usage` stayed `undefined`, and the resulting `"Context window: NNNk"` line never printed. The `reuseFactoryLayer` that both entry points install was dropping `bindMountHandle` from the `SandboxInfo` it passed to the orchestrator, so the session-capture gate (`provider.captureSessions && provider.sessionStorage && sessionId && bindMountHandle`) silently no-op'd. The handle is now plumbed through, gated on `sandbox.tag === "bind-mount"` so isolated and no-sandbox providers still bypass capture cleanly.
- f7879c5: Fix `createWorktree({ branchStrategy: { type: "merge-to-head" } })` not merging the agent's commits back to the host's current branch. `wt.run()`, `wt.interactive()`, and `wt.createSandbox()` previously forwarded the worktree's temp branch as an explicit branch, which routed `SandboxLifecycle` through its "explicit branch" path and skipped the merge step entirely — commits landed on the temp branch but never on HEAD. They now pass `branch: undefined` (so the lifecycle records the host's current branch and merges back to it) while keeping the worktree's source branch alive for subsequent calls.
- 0e1df92: Fix Cursor Dockerfile failing on macOS hosts where the user's GID is `20` (already used by the `dialout` group in `node:22-bookworm`). `groupmod`/`usermod` in the Cursor template now use `-o` (`--non-unique`), matching the other agent templates.
- 702d829: Fix `noSandbox()` failing with `spawn sh ENOENT` in PowerShell / `cmd.exe` on Windows. The provider now routes `exec` commands through `cmd.exe /d /s /c` on Windows and spawns interactive agents with `shell: true` so npm `.cmd`/`.ps1` wrappers (e.g. `claude.cmd`) resolve via `PATHEXT`. POSIX hosts are unchanged.
- 9a895ba: Fix Docker bind-mount sandbox failing on Windows hosts with `too many colons` when launched via `interactive()` (non-head strategy), `worktree.interactive()`, or `worktree.run()`. These three entry points called `resolveGitMounts` but skipped the `patchGitMountsForWindows` step, so the parent `.git` mount kept its `C:\...` sandbox path and Docker rejected the resulting volume string. They now mirror the existing wiring in `SandboxFactory` and `createSandbox`.
- 595e21e: Improve the `WorktreeManager` error raised when the requested branch is already checked out in the host's main working tree (or any other unmanaged worktree). The message now explains why this happens — sandcastle's branch and merge-to-head strategies run the agent in a git worktree under `.sandcastle/worktrees/`, and git refuses to check out the same branch in two worktrees at once — and tells the caller to pick a different branch or switch the main working tree first. No behaviour change: sandcastle still does not attempt smart recovery here.

## 0.10.0

### Minor Changes

- e445b70: Add `verbose` option to the `logging` configuration on `run()`, `createSandbox().run()`, and `createWorktree().run()`.

  When set to `true`:
  - In file mode (`{ type: "file", path, verbose: true }`), every raw stdout line the agent emits is appended verbatim to the same log file at `path` in real time, interleaved with the human-readable log output.
  - In stdout/terminal mode (`{ type: "stdout", verbose: true }`), raw lines are written to `process.stdout`.

  Includes lines the provider's stream parser would otherwise drop (e.g. tool-use blocks for unrecognised tools) — exactly what's needed to debug a stuck or unexpectedly silent agent.

  A new `{ type: "raw"; line; iteration; timestamp }` variant is also surfaced through `onAgentStreamEvent`, so callers forwarding to external observability systems get every raw line too.

## 0.9.0

### Minor Changes

- 47184de: Capture Claude Code subagent / workflow session transcripts to the host alongside the main session. Previously only the main `<sessionId>.jsonl` was copied off the sandbox; transcripts written by the `Agent` tool and the `Workflow` tool under `<sessionId>/subagents/agent-*.jsonl` were lost on teardown. They are now captured with the same sandbox→host `cwd` rewrite. Failure to capture an individual subagent transcript is best-effort and logs a warning; the main session capture remains fatal on failure.

### Patch Changes

- 86aec83: `sandcastle init` now scaffolds `CLAUDE_CODE_OAUTH_TOKEN=` (with a commented `ANTHROPIC_API_KEY=` fallback) for the Claude Code agent, and the next-steps copy points users at `claude setup-token` instead of the closed issue #191.
- 03dcc25: Guard `substitutePromptArgs` against `undefined`/`null` values in `promptArgs`. Previously, a present-but-nullish value (e.g. `{ TITLE: undefined }` from an orchestrator's `JSON.parse` output) bypassed the existence check and crashed with an unguarded `TypeError` on `.toString()`. Now surfaces a clean `PromptError` naming the offending key. `findMissingPromptArgKeys` also treats present-but-nullish values as missing, so the interactive prompt-fill flow asks the user to supply the value rather than failing through.

## 0.8.0

### Minor Changes

- cf92a17: Add `permissionMode` to `claudeCode()` and `approvalsReviewer` to `codex()` — provider-level options for AI-mediated per-tool approval, an alternative to full bypass for AFK host runs (`noSandbox()` + `run()`).

  `claudeCode({ permissionMode: "auto" })` emits `--permission-mode auto` instead of `--dangerously-skip-permissions`. Accepts any of Claude's permission modes: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.

  `codex({ approvalsReviewer: "auto_review" })` swaps `--dangerously-bypass-approvals-and-sandbox` for `-a on-request -s danger-full-access -c approvals_reviewer="auto_review"` so Codex's reviewer agent evaluates each approval prompt.

### Patch Changes

- 932302b: Bump the Codex default model from `gpt-5.4-mini` to `gpt-5.4` in `sandcastle init` scaffolding and the interactive agent picker. The previous default was underpowered for implementation work.
- c6c3026: Fix `opencode()` interactive sessions (and the `init` scaffold's opencode `setupCommand`) seeding the prompt with `-p`, which is the `opencode run`/`attach` basic-auth password flag, not a prompt seed. Use `--prompt` (the TUI's long-form-only seed flag) instead. The TUI pre-fills the textbox but does not auto-submit (see [sst/opencode#3937](https://github.com/sst/opencode/issues/3937)).

## 0.7.0

### Minor Changes

- 22113ca: `sandcastle init` now supports fully non-interactive setup. Every interactive prompt has a paired CLI flag (`--issue-tracker`, `--create-label`, `--build-image`, `--install-template-deps`) on top of the existing `--agent` / `--template` / `--sandbox` / `--model` / `--image-name`. When stdin is not a TTY and a flag is missing for a prompt that would otherwise fire, init fails fast with a message naming the missing flag instead of crashing on the prompt library.

### Patch Changes

- 0b397a1: Strengthen the `simple-loop` and `sequential-reviewer` prompts so an empty pre-expanded `LIST_TASKS_COMMAND` result is treated as ground truth, not as a stale snapshot. The "do not re-query" hint now frames the filtered list as the sole source of truth, and the `# Done` completion criterion explicitly equates an empty list with completion. Prevents the agent from running its own unfiltered `gh issue list` when the filtered list is `[]`.
- c6880a4: Fix `createSandbox` (and `createWorktree`) reusing a stale worktree when called twice for the same named branch. A reused worktree holds a local copy of the branch that never moves on its own, so a re-run loop (review → push fixes → re-run) was reading stale code even though `origin/<branch>` had moved ahead.

  On the **clean** worktree-reuse path of the **branch** strategy, sandcastle now runs `git fetch origin <branch>` followed by `git merge --ff-only origin/<branch>` so the worktree picks up new upstream commits. The refresh only runs when it is provably safe — clean tree and strictly behind origin. **Dirty**, **diverged** (unpushed commits), or **fetch fails** (offline) → skip the refresh, reuse as-is, log why. Fetch failure is non-fatal and never breaks the run. First creation, the merge-to-head strategy, and the head strategy are untouched. See ADR 0003 for the full rationale.

## 0.6.6

### Patch Changes

- ddc26ba: Add `completionTimeoutSeconds` to handle agents that emit the completion signal but never exit. When an agent prints `<promise>COMPLETE</promise>` (or any configured `completionSignal`) but a child process it spawned — a `gh`/git subprocess, a long-lived MCP server, etc. — keeps the exec's stdout pipe open, the parent never reaches EOF. Previously the run waited the full `idleTimeoutSeconds` (default 10 minutes) before failing with `AgentIdleTimeoutError`, discarding any commits the agent had already made. The orchestrator now scans buffered output as it streams, and once a completion signal is detected it swaps the idle timer for a shorter **completion timeout** (default 60 seconds). On expiry the iteration resolves successfully with a warning, `result.commits` and `result.completionSignal` are populated, and session capture runs as normal. The timer resets on every subsequent output line so trailing data (Codex `turn.completed` usage, Claude Code terminal `result`, structured-output tags emitted after the marker) is still captured. A clean process exit always wins the race, so healthy runs gain zero added latency. The new `completionTimeoutSeconds` option (also accepted by `createSandbox()` and `createWorktree()` runs) tunes the window; it is independent of `idleTimeoutSeconds` and is not clamped against it. See ADR 0019.
- e078db5: `Sandbox.run()` (from `createSandbox()`) and `Worktree.run()` (from `createWorktree()`) now emit the run-complete status line and the `Context window: NNNk` line for each iteration with usage data, mirroring the behaviour of the top-level `run()` entry point. Previously these lines only showed up from `run()`, so callers using the lower-level wrappers never saw the completion status or token-count summaries even when usage was available.
- 932aa70: Add resume support to the `pi()` agent provider. Pi sessions captured during a run can now be continued via `RunResult.resume(prompt)` or `run({ resumeSession: "<id>" })`, mirroring Claude Code and Codex. Pi's JSONL session under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<id>.jsonl` is captured to the host with its header `cwd` rewritten and resumed back into the sandbox via `pi --session <id>`. Session capture defaults to on; opt out with `pi("model", { captureSessions: false })`. Pi's print-mode `--no-session` flag is no longer hard-coded so iterations are persisted by default.
- 1201b4d: Add a `thinking` option to the `pi()` agent provider. Pass `pi("model", { thinking: "high" })` to forward `--thinking <level>` to the pi CLI. Accepted levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`.
- b9b9712: Add typed diagnostics to prompt-expansion errors so a downstream orchestrator can branch on them programmatically instead of parsing the message. `PromptExpansionTimeoutError` now carries `elapsedMs` (the wall-clock time the shell expression actually ran before timing out, measured at the throw site) alongside the existing `timeoutMs`; `PromptError` carries an optional `exitCode` when the failure was a non-zero exit from a `` !`command` `` expansion. Both values are reflected in the formatted error message so a human reading the log can tell a 30s contention timeout from an instant auth failure. Follows ADR-0020 (fail-fast prompt expansion); no retry behaviour changes.
- 72637ae: Replace the `SessionStore`-based public API with pure JSONL transfer helpers. The previous `hostSessionStore`, `sandboxSessionStore`, `codexHostSessionStore`, `codexSandboxSessionStore` exports and the `SessionStore` type were the implementation seam used internally to read/write agent session files. They are now removed in favour of pure-string helpers — `transferClaudeSession(jsonl, fromCwd, toCwd)` and `transferCodexSession(jsonl, fromCwd, toCwd)` — that rewrite a session JSONL without touching the filesystem. Path helpers (`claudeHostSessionPath`, `claudeSandboxSessionPath`, `encodeProjectPath`) and the host-side scan utilities (`findClaudeSessionOnHost`, `findCodexSessionOnHost`, `HostSessionLookup`) are exposed instead, so callers building a custom `AgentSessionStorage` do their own file I/O at the call site. The built-in `claudeCode()` and `codex()` providers are unchanged for end users — only direct consumers of the removed store factories need to migrate.
- 58f335f: Add `RunResult.fork(prompt, options?)` as the sibling of `RunResult.resume()` for fan-out workflows. Both run exactly one iteration that continues from the last captured agent session, but `.fork()` leaves the parent session JSONL intact and writes the child under a new session id — the underlying mechanism is `claude --resume <id> --fork-session` for Claude Code and `codex exec fork <id>` for Codex. `fork` is present only on results from providers with `sessionStorage` (Claude Code, Codex).

  Fork isolates the agent session only — not the branch, worktree, or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires giving each child a distinct branch via `branchStrategy: { type: "branch", branch: "..." }`; the default `head` and `merge-to-head` strategies are not safe for concurrent forks. See ADR 0018 for the design rationale and the fan-out caveat.

  Also: `generateTempBranchName` now appends a 6-hex-char random suffix to its `sandcastle/<YYYYMMDD-HHMMSS>` format. The previous second-granularity timestamp collided under any concurrent invocation, not just fork.

- b46dae7: Fix `syncOut` failing on the second run against the same isolated sandbox. `git am` rewrites SHAs on the host, so on every run after the first the previous host `HEAD` was unknown to the sandbox and `git format-patch hostHead..HEAD` aborted with `fatal: Invalid revision range`, losing the run's commits when the sandbox was torn down.

  `syncOut` now tracks the last-synced commit in a sandbox-owned ref `refs/sandcastle/sync-base` and uses it as the patch base, falling back to host `HEAD` only when the ref is absent (run 1). The same ref is read by `SandboxLifecycle` via the new exported `countCommitsToSync` helper, fixing the related "No commits to sync out" misreport on run 2+. See ADR 0017.

## 0.6.5

### Patch Changes

- 0b2ec99: Detect the host package manager (npm, pnpm, yarn, or bun) during `sandcastle init` and use it for the install commands shown in the next steps. For templates that import `zod` on the host (the planner templates), init now offers to install it with the detected package manager when it isn't already declared — preventing the `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` crash on the first run.

## 0.6.4

### Patch Changes

- 157dafc: Add a hint to the `sequential-reviewer` and `simple-loop` implement prompts noting that the issue list is already filtered and discouraging an unfiltered re-query, so the agent is less likely to bypass the configured label filter when the list is empty.

## 0.6.3

### Patch Changes

- 1a7e2f5: Add a "Custom" issue tracker option to `sandcastle init`. Selecting it scaffolds the project in a deliberately broken-until-configured state plus a `.sandcastle/SETUP_ISSUE_TRACKER.md` prompt you feed to your coding agent, which wires up your own issue tracker by editing the scaffolded files in place. Init skips the image build for this option (the Dockerfile is intentionally unfinished) and prints a per-agent setup command in the next steps.
- 8f79a12: Use the scoped package name (`@ai-hero/sandcastle`) in the quick-start docs so `npx` resolves this package rather than the unrelated unscoped `sandcastle` package on npm. Also refresh the docs site getting-started page, which referenced removed `sandcastle init`/`sandcastle run` commands.
- b7595bc: Rename the "backlog manager" concept to "issue tracker" across `sandcastle init` — the selection prompt now reads "Select an issue tracker:", and the generated Dockerfile placeholder is `{{ISSUE_TRACKER_TOOLS}}`. Pure rename with no behaviour change.

## 0.6.2

### Patch Changes

- b141975: The `codex()` agent provider now surfaces per-iteration token usage from its `turn.completed` stream events, so the `Context window: NNNk` line is reported for Codex runs (previously only Claude Code). Codex's `{ input_tokens, cached_input_tokens, output_tokens }` shape is mapped onto Sandcastle's usage model with the cached portion counted as cache-read tokens, avoiding double-counting in the display. Usage flows directly from the stream, so it works even when session capture is disabled or there is no bind-mount.

## 0.6.1

### Patch Changes

- e2c5431: `copilot()` agent provider now parses the `copilot --output-format json` JSONL stream. Text deltas (`assistant.message_delta`), `bash` tool calls (`tool.execution_start`), the final assistant message (`assistant.message`), and the session id (terminal `result` event) are surfaced as `StreamEvent`s, so the Orchestrator's `result.stdout`, `logging.onAgentStreamEvent` timeline, and stderr-empty error fallback now work for Copilot the same as they do for Claude Code, Codex, and Pi. Previously `parseStreamLine` was a no-op.
- d0afa21: Make planner branch names deterministic. The parallel-planner and parallel-planner-with-review templates previously asked the agent to assign a branch name in the format `sandcastle/issue-{id}-{slug}`, where the slug was re-derived on every planning iteration. Because each iteration runs a fresh agent, this produced a different branch each time, forking new branches off HEAD and discarding accumulated progress. The format is now the deterministic `sandcastle/issue-{id}`, so re-planning the same issue resumes the existing branch.
- abac106: Fix `resumeSession` precheck false-negative for the no-sandbox provider. When running on the host with no sandbox, the agent writes its session in place under a cwd-derived directory that Sandcastle was reconstructing from the host repo path — missing the worktree path, symlink-resolved paths (e.g. macOS `/tmp` → `/private/tmp`), and the agent's `.`→`-` encoding. The precheck now locates the session by its unique id via a new `findByIdOnHost` capability on `AgentSessionStorage`, so no-sandbox resume works regardless of how the agent encodes its cwd. Sandboxed (docker/podman) runs are unchanged.
- f34bf0a: Add a `copilot` agent provider for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (`@github/copilot`). Use it like the other agent factories: `copilot("claude-sonnet-4.5")`. Authentication is via `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. `sandcastle init` now offers GitHub Copilot CLI as an agent option, with a Dockerfile that installs the CLI via `npm install -g @github/copilot`.
- 6bcaa7a: The `parallel-planner` and `parallel-planner-with-review` init templates now parse the planner's `<plan>` output with `Output.object` and a Zod schema instead of a bespoke regex helper. The templates depend on Zod, but any [Standard Schema](https://standardschema.dev) validator (Valibot, ArkType, …) works; `sandcastle init` now reminds you to install one. A missing tag or malformed plan JSON now throws `StructuredOutputError`.
- f64e203: Fix the `sequential-reviewer` template processing the entire backlog in a single pass: the implementer now runs for one iteration so each outer loop handles one issue on its own branch, and the loop stops once the backlog is exhausted. Also fix the empty review diff in both `sequential-reviewer` and `parallel-planner-with-review` templates — `review-prompt.md` now diffs the branch against `{{TARGET_BRANCH}}` (the fork point) instead of `{{SOURCE_BRANCH}}`, which equals the branch itself and always produced an empty diff.
- 6165660: Share a single `SIGINT`/`SIGTERM`/`exit` handler across sandboxes. Previously every `createSandbox()`, `docker()`, and `podman()` sandbox added its own process signal listeners, so running more than ~5 concurrent sandboxes tripped Node's `MaxListenersExceededWarning`. Cleanup now routes through one shared registry that installs a single listener per event and fans out to each sandbox's teardown.

  Behavior change on interrupt: with a Docker/Podman sandbox, the container's signal handler used to call `process.exit` before `createSandbox()`'s handler ran, so the "Worktree preserved" recovery guidance was silently skipped. The shared handler runs every teardown (container removal **and** the guidance) before exiting once with code 1, so the guidance now prints on `Ctrl-C`.

- 46eb483: Fix worktree creation failing under non-English git locales. `WorktreeManager` matched git's human-readable stderr (e.g. "invalid reference") to decide control flow, but git localizes those strings, so in a non-English locale the new-branch fallback never fired and worktree creation broke outright. Git is now invoked with `LC_ALL=C` so its messages are always English and machine-stable.

## 0.6.0

### Minor Changes

- bc9216f: Add a `cursor()` agent provider. Cursor is selectable during `sandcastle init` (with a provider-specific Dockerfile and `CURSOR_API_KEY` env scaffold) and importable directly as `cursor(model, options?)`. Print mode runs the Cursor Agent CLI with `--output-format stream-json`, passing the prompt as a positional argument (guarded against the argv size limit) and parsing Cursor's top-level `tool_call` events. Cursor is non-resumable (no filesystem-backed session storage), consistent with ADR 0012/0016.

### Patch Changes

- 8562a7e: Fix the Beads `CLOSE_TASK_COMMAND` template, which passed the completion message as a positional argument (`bd close <ID> "Completed by Sandcastle"`). `bd close` parsed it as a second issue ID and errored. It now uses the `--reason=` flag.
- 825aadf: Fix `RangeError: Invalid string length` crash on long agent runs. When streaming `exec` output via `onLine`, sandbox providers accumulated every line and joined them into one string at completion; past V8's ~512MB max string length this threw inside a `close` event handler — an uncaught exception that bypassed `Promise.allSettled` and took down the whole run, including parallel pipelines. Streamed stdout and stderr are now kept in a bounded rolling tail (default 64KiB, configurable per provider via `maxOutputTailChars`). Live output to `onLine` is unaffected.
- 73e9e7c: Add `"xhigh"` to the `ClaudeCodeOptions.effort` union to match the Claude CLI's `--effort` levels.
- 746e0ca: Add resume support for the Codex agent provider and move session storage behind provider-owned session stores.

  The per-provider session transfer is now owned by the provider's `sessionStorage.transfer` (ADR 0012). The free `transferSession` export is removed from the public API — agent providers apply their own format-specific `cwd` rewriting internally.

- 2318bb4: Add a `devices` option to the Docker and Podman sandbox providers that maps to `--device` flags, exposing host devices to the container (e.g. `/dev/kvm`). Each entry is a full device spec in `host[:container[:permissions]]` form; when omitted, no `--device` flags are added. SELinux `--security-opt` handling is intentionally out of scope and left to the user.
- c878b14: Add a `cpus` option to the Docker and Podman sandbox providers that maps to the `--cpus` flag on `docker run` / `podman run`, limiting the CPU resources available to the container. Accepts fractional values (e.g. `1.5`); when omitted, the container is left unconstrained.
- b233f40: Expose more sandbox lifecycle timeouts via the `Timeouts` interface. In addition to `copyToWorktreeMs`, you can now override `gitSetupMs` (in-sandbox git setup commands, default 10 000 ms), `commitCollectionMs` (collecting the run's commits, default 30 000 ms), and `mergeToHostMs` (merging a temp branch back to the host branch, default 30 000 ms). These are accepted anywhere `timeouts` already is — `run()`, `createSandbox()`, `interactive()`, and `createWorktree()`. Unset keys keep their defaults.
- 702c761: Fix `sandcastle init` ignoring the selected sandbox provider in the generated main file. Choosing Podman now rewrites the `docker` import and `docker()` call sites to `podman`, instead of always scaffolding `docker`.
- 18ae734: Expand the generated `.env.example` comment for `GH_TOKEN` (GitHub Issues backlog manager) to link the fine-grained token creation page and list the required repository permissions: Issues (Read and write) and Metadata (Read).
- 15d70ef: Add a `groups` option to the Docker and Podman sandbox providers that maps to `--group-add` flags, granting the container user supplementary group membership (e.g. for a bind-mounted Docker socket). Accepts group names or numeric GIDs; when omitted, no `--group-add` flags are added.
- cd5fd13: Fix `sandcastle docker build-image` / `podman build-image` failing on macOS hosts. The generated Dockerfile now aligns the agent UID/GID with `groupmod -o` / `usermod -o` (`--non-unique`), so a host GID that collides with a reserved GID in `node:22-bookworm` (notably macOS's primary group `staff` = GID 20, occupied by `dialout`) no longer aborts the build with `GID '20' already exists`. Existing scaffolds need to re-run `sandcastle init` or add `-o` to the `groupmod`/`usermod` line by hand.
- f1d5ddc: Fix worktree management on Windows by normalizing path separators. `git worktree list` reports paths with forward slashes even on Windows, while `node:path.join` uses backslashes — so `create()` would misclassify a reusable managed worktree as an external one and throw "already checked out", and `pruneStale()` would treat every active worktree as orphaned and delete it out from under running sandboxes. Path comparisons now normalize separators before matching.
- bca035e: Add an `agent` option to `opencode()`, mapping to OpenCode's own `--agent` flag (e.g. `opencode("model", { agent: "build" })`). It selects a named agent/mode inside OpenCode for both headless (`run`) and interactive invocations, and is distinct from Sandcastle's `--agent` provider selector.
- 1e23181: Fix dropped OpenCode output. The print command now passes `--format json` so OpenCode emits the structured event stream the parser consumes — previously it emitted plain text, so the parser received nothing and live output, tool calls, and the session ID were all dropped. `--dangerously-skip-permissions` is now passed in the sandbox so runs no longer hang on permission prompts. `parseStreamLine` surfaces assistant text and the final result from `text` events, tool calls from `tool_use` events (`bash`, `webfetch`, `task`, with a JSON fallback for other tools, gated on the completed status), the session ID from `step_start`, and error messages from `error` events.
- a3f1c04: Fix orphaned worktrees when sandbox start fails (e.g. a missing Docker image). `run()`, `createSandbox()`, and `interactive()` now remove the freshly-created worktree if any setup step after worktree creation fails, instead of leaving it behind to require a manual `git worktree remove --force`. Covers all three worktree-creating branch strategies for bind-mount, isolated, and no-sandbox providers.
- 0b74ab6: Raise the GitHub Issues backlog manager's list command to `--limit 100` so the parallel planner sees the full backlog instead of `gh`'s default 30, preventing foundation issues from being silently truncated out of the dependency graph.
- fbad1a4: Retry transient git setup exec failures during `withSandboxLifecycle`. Under heavy parallelism the `git config` / `git rev-parse` commands run at sandbox start could fail with exit 126 (`cannot exec`) or 137 (killed) from a momentary container exec race rather than a real git error. These are now retried (each attempt still bounded by the existing per-command timeout); genuine non-transient git failures and hangs still fail fast. `ExecError` also gains an optional `exitCode` field carrying the failing command's exit code.
- 8aee234: Add a `--sandbox` flag to `sandcastle init` to select the sandbox provider (`docker` or `podman`) non-interactively, mirroring `--agent`.
- 87285a7: Fix `syncOut` deleting the entire `.sandcastle` directory after a successful sync. Cleanup of temporary patch artifacts removed the whole `.sandcastle` directory once `patches/` was empty, wiping tracked files (e.g. `Dockerfile`, config) from the synced worktree. It now removes only the `patches/` directory.

## 0.5.12

### Patch Changes

- 581dc80: `StructuredOutputError` now carries `sessionId` and `sessionFilePath` from the run that produced the failed output, so callers can resume that session with feedback to re-emit corrected output instead of repeating the work.

## 0.5.11

### Patch Changes

- 5ac972a: Bump default Claude Code model from `claude-opus-4-6` to `claude-opus-4-7`.
- 7cefd7c: Allow `noSandbox()` in `run()` and `createSandbox()`. Previously it was only accepted by `interactive()`. Use this when running Sandcastle from inside an already-isolated environment (containerized CI, VM, sandbox host) and you want the agent to operate directly on the host without a nested container.

## 0.5.10

### Patch Changes

- 95d63a4: Apply `:z` SELinux label by default on Docker bind mounts, matching the existing Podman behavior. Adds `selinuxLabel` option to `DockerOptions` (`"z"` | `"Z"` | `false`, default `"z"`). Extracts shared `formatVolumeMount` from Podman provider into `src/mountUtils.ts` so both providers use the same volume-mount formatter.
- 9bf43df: Auto-create parent directories for file-target bind mounts under `/home/agent`. When a user mount targets a single file whose sandbox-side parent directory may not exist in the image (e.g. `/home/agent/.codex/auth.json`), both Docker and Podman providers now run `mkdir -p` + `chown` on the parent at container start. File mounts whose parent is outside `/home/agent` fail at config time with a clear error and remediation guidance.
- adbb3cc: Add `variant` option to the `opencode` agent provider for controlling reasoning effort via opencode's `--variant` CLI flag.

## 0.5.9

### Patch Changes

- 1b742cb: Replace hardcoded "GitHub issues" language in simple-loop and sequential-reviewer templates with backlog-agnostic wording so scaffolded projects read correctly regardless of the chosen backlog manager.
- a85d6c0: Add Docker UID alignment via build-arg and pre-flight diagnostic. Dockerfile templates now accept `AGENT_UID`/`AGENT_GID` build-args (default 1000) and `sandcastle docker build-image` defaults them to the host UID/GID. The Docker provider gains `containerUid`/`containerGid` options and a pre-flight `docker image inspect` check that catches UID mismatches before container start. See ADR-0014.
- 856e6b7: fix: unescape `\n`, `\r`, `\t`, and `\\` in double-quoted `.env` values to match standard dotenv semantics
- 77590d0: fix: sequential-reviewer template uses createSandbox so implementer and reviewer share a branch

  The sequential-reviewer template previously used `merge-to-head` for the implementer, which merged the temp branch into HEAD and deleted it. The reviewer then tried to create a worktree for the host branch (e.g. `main`), which was already checked out — causing a git worktree conflict.

  Restructured to use `createSandbox()` with an explicit named branch, so both the implementer and reviewer run in the same sandbox on the same branch. This matches the pattern used by the parallel-planner-with-review template.

- c9f8348: Fix Docker mount failures on Windows hosts by switching from `-v host:sandbox` to `--mount type=bind,source=...,target=...` format (avoiding colon ambiguity with drive letters), and adding missing `patchGitMountsForWindows` calls in `createSandbox` and `createSandboxFromWorktree` code paths.
- 0fd2e74: Add structured output support: `Output.object({ tag, schema })` and `Output.string({ tag })` extract typed, validated payloads from agent stdout. Adds `output` option to `RunOptions` with overloaded return type, `StructuredOutputError` for extraction failures, and entry-time validation for `maxIterations === 1` and tag-in-prompt checks.

## 0.5.8

### Patch Changes

- 7400ead: Add a short hint to the `parallel-planner` and `parallel-planner-with-review` plan prompts noting that the issues list is already filtered, so the planner agent is less likely to requery and pick up issues outside the configured filter.
- 21b6442: Fix Windows hosts emitting backslash separators for in-container paths during session capture/resume and `copyPaths`. `sandboxSessionStore`, `defaultSessionPathsLayer`, and `startSandbox`'s `copyPaths` now use POSIX joins for paths that target the Linux container, so `docker cp` / `podman cp` no longer reject them on Windows.

## 0.5.7

### Patch Changes

- 904ad82: Fix `PromptError: Prompt argument "{{TASK_ID}}" has no matching value in promptArgs` thrown on every iteration of the `simple-loop`, `sequential-reviewer`, and `parallel-planner*` merge flows after `sandcastle init`. The `VIEW_TASK_COMMAND` and `CLOSE_TASK_COMMAND` registry values used to embed `{{TASK_ID}}`, which got baked into prompts whose runtime promptArgs do not include `TASK_ID`. They now use a plain `<ID>` placeholder for the agent to fill in from surrounding context.

## 0.5.6

### Patch Changes

- 54b5111: Add `timeouts.copyToWorktreeMs` option to override the host-to-worktree copy timeout (default: 60 000 ms).
- d8484ca: Surface fallback `cp -R` failures from `copyToWorktree` as a typed `CopyToWorktreeError` instead of silently swallowing them
- b6cc84f: Fix `WorktreeManager.pruneStale` deleting active worktrees when `.sandcastle` (or any ancestor of the repo directory) is a symlink. `git worktree list` returns canonicalized paths, so the un-canonicalized prefix never matched the active set and parallel `createSandbox()` calls would wipe each other's worktrees mid-run, surfacing as `spawn /bin/sh ENOENT`.
- 26920ca: Fix `branchStrategy.baseBranch` being silently dropped when calling `sandcastle.run()` with a worktree-based sandbox. New branches now correctly fork from the requested `baseBranch` instead of the host's HEAD.
- bbb0f39: Fix `encodeProjectPath` to handle Windows paths by replacing backslashes with hyphens and stripping drive-letter colons, producing a valid single directory-name component on Windows.
- b2123e4: Add optional `timeoutMs` field to hook objects, allowing per-hook timeout overrides with fallback to the default 60s
- a658fcc: Update Quick Start install command to recommend `--save-dev` and note that Sandcastle is a dev/CI tool
- 425b77e: Use APFS clonefile (`cp -cR`) on macOS for copy-to-worktree instead of GNU `--reflink=auto`, giving Mac users instant copy-on-write on APFS volumes

## 0.5.5

### Patch Changes

- e868d2d: Fix `createWorktree` failing with "already exists" when reusing a preserved mid-rebase worktree. Collision detection now also matches by target path, covering the detached-HEAD state during an in-progress rebase.

## 0.5.4

### Patch Changes

- 9c8516d: Surface agent error details in `AgentError` when stderr is empty. Error events emitted to stdout by Codex and Pi, plus OpenCode's result text, are now parsed and included in the error message instead of being dropped.
- b2cc893: Show context window size per iteration in the run summary. Each iteration with usage data emits a `Context window: NNNk` line (tokens rounded up to the nearest 1000) in both terminal and log-to-file mode.
- 2843c1b: Support `baseBranch` when creating sandboxes, so new branches can be forked from a specified ref. Available both on `createSandbox` and in the named branch strategy.
- d860e84: Fix Beads Dockerfile build failure on arm64 hosts (e.g. Apple Silicon). The image now builds on both amd64 and arm64.
- fdd9b9e: Fix built-in review prompt templates so they respect the configured source branch instead of always diffing against `main`.
- cfbeb67: Fix parallel-planner-with-review template to capture reviewer result and merge commits from both implementer and reviewer runs
- eb03260: Fix transient worktree creation failure when `branch.autoSetupMerge` or `push.autoSetupRemote` is enabled globally
- 4032e64: Inline prompts (`prompt: "..."`) are now passed to the agent literally — no `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. Fixes #453: callers that build inline prompts from arbitrary content (issue bodies, PR descriptions) no longer fail when that content happens to contain `{{...}}`. Passing `promptArgs` alongside an inline prompt is now an error; use `promptFile` to opt into template behavior.
- 6bc4d74: Fix `PromptPreprocessor` executing `` !`...` `` patterns that arrive via `promptArgs` substitution. Argument values are now treated as inert data: only shell blocks written in the raw template are executed. Previously, any caller passing text through `promptArgs` (issue titles, bodies, docs excerpts, etc.) could hit spurious command execution — or, with untrusted inputs, remote shell execution — because the preprocessor scanned the fully-assembled prompt after substitution.
- 359907e: Add `onAgentStreamEvent` option to `logging` in log-to-file mode. The callback receives each `text` chunk and `toolCall` emitted by the agent, with the iteration number and a timestamp, so callers can forward the agent's output stream to an external observability system. Errors thrown by the callback are swallowed so a broken forwarder cannot kill the run.
- ce1bf1b: Support tilde expansion in `sandboxPath` for Docker and Podman mount configs.

  Users can now write `sandboxPath: "~/.npm"` and it expands to `/home/agent/.npm` inside the sandbox. The expansion uses the provider's declared `sandboxHomedir` (`"/home/agent"` for Docker and Podman). Using `~` in `sandboxPath` with a provider that has no `sandboxHomedir` throws a descriptive error at mount resolution time.

## 0.5.3

### Patch Changes

- 2e7147b: Show commit-aware sync logs only for isolated sandboxes. Displays "Syncing N commit(s) to host" when commits exist or "No commits to sync out" when there are none, instead of the generic "Syncing changes to host" message. Bind-mount providers no longer show sync logs since sync-out only applies to isolated sandboxes.
- b0d5400: Fix git worktree mounts broken on Windows hosts (issue #410). On Windows, the parent `.git` directory is now mounted at a deterministic POSIX path inside the sandbox, and the worktree's `.git` file is patched with a corrected `gitdir:` path that resolves inside the Linux container.

## 0.5.2

### Patch Changes

- 1c71374: Add AbortSignal support for cancelling runs and interactive sessions. Pass `signal` to `run()`, `interactive()`, `Sandbox.run()`, `Sandbox.interactive()`, or any Worktree equivalent. Aborting kills the in-flight agent subprocess; handles remain usable for subsequent calls. Lifecycle hooks (`host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady`) are also cancelled when the signal fires.
- 148905b: Expose per-iteration token usage on `IterationResult` via a new `usage?: IterationUsage` field. Returns raw token counts (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) for Claude Code runs. Non-Claude agent providers return `undefined`.
- 95ef2bd: Fix Codex agent provider not logging output during runs.
- 6ca70c1: Fix session resume failing with `docker cp (in) failed` / `podman cp (in) failed` when the sandbox's project directory didn't yet exist.
- 8d4e8ef: Fix Windows paths breaking Docker/Podman volume mounts. Backslashes in host paths and Windows-style sandbox paths are now normalized before reaching the container runtime.
- a971e1e: Faster sandbox startup — remove the recursive `chown` that ran on every Docker and Podman container start. Add `containerUid`/`containerGid` options to the Podman provider for controlling in-container ownership.
- 49c461e: Fix duplicate command entries appearing in the task log. Each command now appears once (with its token count).
- a2dff20: Remove `throwOnDuplicateWorktree` option; worktrees are now always reused — clean worktrees log a message, dirty worktrees log a warning.
- 51d668c: Fix runs failing when prompts exceed 128 KB on Linux. Prompts are now delivered via stdin instead of command-line arguments, avoiding the `execve(2)` argument size limit.
- 308a1f6: `Worktree.run()` now accepts `resumeSession` to resume a prior Claude Code session by ID, matching the existing support on top-level `run()`.

## 0.5.1

### Patch Changes

- ba6121e: Add a `cwd` option to `createSandbox()`, `createWorktree()`, `run()`, and `interactive()`. When provided, `cwd` replaces `process.cwd()` as the host repo directory used for worktrees, `.sandcastle/.env`, logs, patches, and git operations, letting you drive Sandcastle from outside the target repo. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is raised when the path does not exist or is not a directory.
- f872268: Fix session capture, which always failed with "Could not find the file". Sandcastle was looking for session JSONLs under a `sessions/` subdirectory that Claude Code does not actually use.

## 0.5.0

### Minor Changes

- 800e743: Restructure hooks API to group by execution location (`host` vs `sandbox`). The old flat `hooks: { onSandboxReady }` shape is replaced with `hooks: { host?: { onWorktreeReady?, onSandboxReady? }, sandbox?: { onSandboxReady? } }`. Host hooks run on the developer's machine; sandbox hooks run inside the container. Breaking change (pre-1.0).

### Patch Changes

- 4515aa9: Add `copyFileIn` and `copyFileOut` methods to `BindMountSandboxHandle` for moving individual files between the host and the sandbox. Docker uses `docker cp`, Podman uses `podman cp`, and the new `testBindMount()` provider uses a plain filesystem copy.
- 3aa9d9a: Fix Podman sandbox failing on macOS when host UID differs from 1000 by chowning /home/agent to the host UID:GID after container start, matching Docker provider behavior.
- 0a84413: **Breaking:** Replace `RunResult.iterationsRun` with `RunResult.iterations: IterationResult[]`. Each `IterationResult` carries an optional `sessionId` extracted from Claude Code's stream-json init line. Consumers needing the iteration count should read `iterations.length`. Non-Claude agent providers produce `sessionId: undefined`. The same change applies to `OrchestrateResult`, `SandboxRunResult`, and `WorktreeRunResult`.
- 85eb071: Add session capture and resume for Claude Code:
  - **Capture:** after each iteration, the agent's session is saved to the host at `~/.claude/projects/<encoded>/sessions/<id>.jsonl` so it can be replayed or inspected locally with Claude Code's usual tooling. Adds `captureSessions` option to `claudeCode()` (default `true`) and `sessionFilePath` to `IterationResult`.
  - **Resume:** adds `resumeSession` option to `run()` for continuing a prior Claude Code conversation in a new sandbox run. Incompatible with `maxIterations > 1`.
  - Exposes the underlying `SessionStore` interface and `transferSession` helper for users who want to move sessions between the host and a sandbox directly.

## 0.4.8

### Patch Changes

- c8cfcc6: Add timeout to the isolated provider `copyPaths` loop in `startSandbox`. The entire copy loop is now wrapped with `withTimeout` (120s), producing a `CopyToWorktreeTimeoutError` on expiry, consistent with the per-step timeout pattern used elsewhere in the sandbox lifecycle.
- bab11e9: Add `network` option to Docker and Podman sandbox providers for custom container networking
- a2c580f: Make Dockerfile generation aware of the selected backlog manager. When "beads" is chosen, the Dockerfile installs beads CLI tools instead of GitHub CLI.
- a2fd5ad: Generate `.env.example` dynamically during `sandcastle init` based on selected agent and backlog manager instead of copying a static file from the template directory.
- 20741fe: Fix parallel-planner templates to use {{CLOSE_TASK_COMMAND}} placeholder instead of hardcoded "close the issue" language, and replace "GitHub issue" with backlog-agnostic wording
- b7880ec: Make `prompt`/`promptFile` optional in `interactive()` — when neither is provided, the agent TUI launches with no initial prompt (the full prompt pipeline is skipped).
- aea1131: Add per-step timeouts across the sandbox lifecycle. Every lifecycle step is now wrapped with `Effect.timeoutFail` via a `withTimeout` utility, producing a step-specific tagged error on expiry. Breaking: `TimeoutError` renamed to `AgentIdleTimeoutError` with `timeoutMs` field replacing `idleTimeoutSeconds`.
- c261079: Support relative paths in MountConfig for bind-mount sandbox providers. `hostPath` relative paths resolve from `process.cwd()`, and `sandboxPath` relative paths resolve from the sandbox repo directory.
- d13acc3: Remove unnecessary `copyToWorktree` and `branchStrategy` from planner and merger agents in parallel planner templates. These lightweight agents (maxIterations: 1) now default to head mode, avoiding the overhead of copying node_modules into worktrees.
- 0f8a99a: Remove semaphore concurrency limiter from parallel-planner-with-review template. Issue pipelines now run concurrently via Promise.allSettled without a concurrency cap, matching the parallel-planner template.
- bf23e83: Rename workspace terminology back to worktree across the codebase. All public API types and functions renamed from `Workspace*` to `Worktree*` (e.g. `createWorktree()`, `Worktree`, `WorktreeBranchStrategy`). `copyToWorkspace` renamed to `copyToWorktree`. `sandboxWorkspacePath` renamed to `sandboxRepoPath` and `SANDBOX_WORKSPACE_DIR` to `SANDBOX_REPO_DIR` for sandbox-internal paths. Source files renamed accordingly (`WorktreeManager.ts`, `CopyToWorktree.ts`, `createWorktree.ts`).

## 0.4.7

### Patch Changes

- 6d0c1fb: Make `sandbox` optional in `InteractiveOptions`, defaulting to `noSandbox()`

## 0.4.6

### Patch Changes

- fdeccd4: Change agent provider `buildPrintCommand` and `buildInteractiveArgs` to accept an options object `{ prompt, dangerouslySkipPermissions }` instead of a bare prompt string. The `claudeCode()` factory now conditionally includes `--dangerously-skip-permissions` based on the boolean.
- f413493: Add backlog manager selection to `sandcastle init` (GitHub Issues or Beads). All templates use placeholders (`{{LIST_TASKS_COMMAND}}`, `{{VIEW_TASK_COMMAND}}`, `{{CLOSE_TASK_COMMAND}}`) replaced at scaffold time with the correct commands for the chosen manager. Parallel-planner uses `{ id: string }` instead of `{ number: number }` in plan JSON, `TASK_ID` instead of `ISSUE_NUMBER` in prompt args, and raw IDs in log output. Selecting Beads skips the "Create Sandcastle label" step.
- 0e2e5fe: Fix `sandcastle init` to strip `--label Sandcastle` from scaffolded prompt files when user declines label creation
- f413493: Add `interactive()` API for launching interactive agent sessions inside sandboxes, replacing the old `interactive` CLI command. Includes the `sandbox.interactive()` method on `createSandbox()`, full prompt preprocessing (promptFile, shell expressions, argument substitution), all three branch strategies, `onSandboxReady` hooks, `copyToWorkspace` for worktree providers, env resolution, and `interactiveExec` on Docker and Podman providers. ClackDisplay now shows intro/summary and progress (creating worktree, copying files, starting sandbox, syncing, merging, commit collection) for interactive sessions.
- 29d224d: Add interactive arg collection for missing prompt arguments. When `interactive()` encounters `{{KEY}}` placeholders with no matching prompt argument, it prompts the user at the terminal via `@clack/prompts` text input. Built-in args (`SOURCE_BRANCH`, `TARGET_BRANCH`) are excluded from prompting. `run()` behavior is unchanged.
- 83a86f6: Add no-sandbox provider for interactive mode. `noSandbox()` runs the agent directly on the host with no container isolation — only accepted by `interactive()`, not `run()` or `createSandbox()`. The agent does not receive `--dangerously-skip-permissions`, so the user manages permissions themselves. Import from `@ai-hero/sandcastle/sandboxes/no-sandbox`.
- f413493: Fix Podman integration: rootless mode support with `--userns=keep-id` flag (configurable via `userns` option), pre-flight image existence check, Podman Machine detection on macOS/Windows, 5s timeout on signal handler cleanup, correct `:ro,z` syntax for SELinux-labeled readonly bind mounts, and `interactiveExec` for interactive agent sessions via `podman exec -it`.
- 0cde1a2: Add PodmanLifecycle module and `sandcastle podman build-image` / `sandcastle podman remove-image` CLI commands, mirroring the existing Docker CLI commands for Podman users.
- 530a8af: Fix Podman container crashes: rename base image's `node` user (UID 1000) to `agent` instead of creating a new user, so `--userns=keep-id` maps to the correct home directory owner. Override entrypoint in `podman run` to avoid double-sleep when the image already defines `ENTRYPOINT ["sleep", "infinity"]`.
- 8bcb78e: Add post-agent logging to withSandboxLifecycle for syncing, merging, and commit collection phases
- 1844288: Rename `copyToSandbox` option to `copyToWorkspace` across the public API (`run()`, `interactive()`, `createSandbox()`) and rename internal module `CopyToSandbox.ts` to `CopyToWorkspace.ts`. This aligns with the formalized distinction between "sandbox" (isolation boundary) and "workspace" (directory where the agent runs). No behavior changes.
- 35feb6f: Add sandbox provider selection (Docker / Podman) to `sandcastle init`. Selecting Podman writes `Containerfile` instead of `Dockerfile` and uses Podman-specific build commands.
- c54e389: Show per-command estimated token counts in the "Expanding shell expressions" taskLog after shell expressions resolve

## 0.4.5

### Patch Changes

- e84ffe3: Add a Codex `effort` option that forwards `model_reasoning_effort` to Codex for exec and interactive runs.

## 0.4.4

### Patch Changes

- 98d22da: Add `applyToHost` lifecycle callback to `SandboxInfo` so isolated providers can sync changes to the host worktree before host-side git operations. Fix `baseHead` recording to use the host worktree instead of the sandbox, ensuring correct commit collection after `syncOut` creates new SHAs via `format-patch`/`am`.
- be40c63: `createSandbox()` now uses the shared `startSandbox` helper, adding support for isolated sandbox providers (e.g. Vercel, Daytona). Each `run()` call syncs commits back to the host worktree via `applyToHost`.
- 0d393c9: Write SandboxError messages to the log file when run() fails in file-logging mode
- c0a4db3: Isolated sandbox providers now create worktrees, matching the bind-mount lifecycle. This enables proper branch strategy support (merge-to-head and named branches) and failure-mode worktree preservation for isolated providers.
- 973ed21: Run onSandboxReady hooks and shell expressions in parallel for faster environment setup
- 4f99506: Allow optional whitespace inside prompt argument placeholders so that both `{{ARG}}` and `{{ ARG }}` resolve identically

## 0.4.3

### Patch Changes

- e3fd351: Add `sudo` option to hook commands and `exec()` interface for running commands with elevated privileges inside sandboxes
- a30acb3: Strip matching surrounding quotes from .env file values so that `KEY="value"` and `KEY='value'` are parsed as `value` instead of including literal quote characters
- f1fdd4f: Log files now append between runs instead of overwriting. Each run writes a `--- Run started: <ISO timestamp> ---` delimiter header, preserving logs from previous runs of the same branch+agent combination.

## 0.4.2

### Patch Changes

- cd2a219: Fix templates crashing with "copyToSandbox is not supported with head branch strategy" by adding explicit `branchStrategy: { type: "merge-to-head" }` to all template `run()` calls that use `copyToSandbox`.
- 2cafddd: Use sandbox provider's `workspacePath` instead of hardcoded `/home/agent/workspace` for sandbox-side commands, fixing Vercel sandbox support where the workspace is at `/vercel/sandbox/workspace`.

## 0.4.1

### Patch Changes

- 0bb95e2: Add CODING_STANDARDS.md to reviewer-based templates (sequential-reviewer, parallel-planner-with-review) so the reviewer agent has concrete standards to enforce during code review.
- bb444af: Add optional `mounts` config to `docker()` and `podman()` providers for mounting host directories (e.g. package manager caches) into sandbox containers. Each mount supports `hostPath` (with `~` expansion), `sandboxPath`, and optional `readonly` flag. Throws a clear error if a host path does not exist.
- 16315da: Add Daytona isolated sandbox provider (`@ai-hero/sandcastle/sandboxes/daytona`)
- a8e7d72: Add OpenCode as a built-in agent provider. The `opencode()` factory returns an `AgentProvider` that invokes `opencode run` with raw stdout passthrough (no JSON stream parsing). Includes CLI registry entry, init scaffold with Dockerfile template, and documentation.
- 9d6dfba: Add `parallel-planner-with-review` template that combines parallel execution with per-branch code review using `createSandbox`. Also fix `maxIterations` defaults: sequential-reviewer reviewer 10→1, parallel-planner merger 10→1.
- 859f2f5: Add Podman sandbox provider (`sandcastle/sandboxes/podman`) as a bind-mount provider mirroring Docker's behavior with SELinux label support
- d917d69: Allow sandbox providers and agent providers to accept `env: Record<string, string>` at construction time. Provider env is merged with the `.sandcastle/.env` resolver output at launch, with provider values taking precedence. Agent and sandbox provider env must not have overlapping keys.
- 6192024: Add `throwOnDuplicateWorktree` option to `RunOptions` and `CreateSandboxOptions`. When set to `false`, a worktree collision reuses the existing worktree instead of failing. Defaults to `true` (current behavior).
- 22ec222: Add Vercel isolated sandbox provider (`sandcastle/sandboxes/vercel`) using `@vercel/sandbox` SDK
- 0d08a33: Buffer Pi provider text deltas before display to prevent one-word-per-line terminal output in stdout mode
- 448c9da: Support directories in `copyIn` for isolated sandbox providers and rename `copyOut` to `copyFileOut`
- c30f690: Derive CLI version from package.json instead of hardcoding it.
- 6e7738d: Fix sequential-reviewer template: replace broken prompt argument placeholders with self-contained issue selection and closure logic matching the simple-loop pattern
- a43cfe4: Merge `exec` and `execStreaming` into a single `exec` method with an optional `onLine` callback in options.

  **Breaking change (pre-1.0):** The `execStreaming` method has been removed from `BindMountSandboxHandle`, `IsolatedSandboxHandle`, and `SandboxService`. Use `exec(command, { onLine: (line) => ... })` instead.

  **Migration:** Replace `handle.execStreaming(cmd, onLine, { cwd })` with `handle.exec(cmd, { onLine, cwd })`.

- d1b75e4: Move `branchStrategy` from sandbox provider config to `run()` options. Branch strategy is now specified as an optional field on `RunOptions` instead of on provider factory functions like `docker()`. When omitted, defaults to `{ type: "head" }` for bind-mount providers and `{ type: "merge-to-head" }` for isolated providers. Using `{ type: "head" }` with an isolated provider now throws a clear runtime error.
- 8265b88: Remove Docker-specific language from JSDoc comments on provider-agnostic APIs
- 90c017d: Reset idle timer on any stdout line from the sandbox, not just parsed structured events. This prevents false idle timeouts for providers that emit non-JSON output (e.g. TUI-based agents).

## 0.4.0

### Minor Changes

- 40a756f: Replace `worktree` config with `branchStrategy` on the sandbox provider. Define `BranchStrategy` types (`head`, `merge-to-head`, `branch`) and wire them into bind-mount and isolated providers. `IsolatedSandboxProvider` exposes `branchStrategy` (defaulting to `{ type: "merge-to-head" }`), `testIsolated()` accepts a `branchStrategy` option, and TypeScript prevents `{ type: "head" }` on isolated providers at compile time. The deprecated `worktree` field on `RunOptions` and the `WorktreeMode` type have been removed. README documentation, code examples, the "How it works" section, and option tables have been updated to use `branchStrategy` terminology throughout.

### Patch Changes

- 6a16d69: Make chownInContainer non-fatal so sandbox startup doesn't crash when chown -R fails on macOS VirtioFS read-only bind mounts
- 105f1ef: Fix pi parser to handle current pi-mono JSON stream format
- 7bf0961: Remove TokenUsage feature from all providers and orchestrator. The TokenUsage interface, extractUsage helper, formatUsageRows function, and usage summary display have been deleted. ParsedStreamEvent's result variant no longer carries a usage field.
- c8df3a1: Point users to #191 for using Claude subscription instead of an API key in .env.example, README, and init CLI output

## 0.3.0

### Minor Changes

- 5b04e73: ### Breaking changes
  - `sandbox` is now a required option on `run()` and `createSandbox()`
  - `imageName` removed from top-level `RunOptions` and `CreateSandboxOptions` — image configuration now lives inside the sandbox provider (e.g. `docker({ imageName })`)
  - `docker()` factory is exported exclusively from `@ai-hero/sandcastle/sandboxes/docker`
  - `sandcastle build-image` and `sandcastle remove-image` are now `sandcastle docker build-image` and `sandcastle docker remove-image`

  ### New features
  - Pluggable sandbox provider abstraction with bind-mount and isolated provider types
  - `createBindMountSandboxProvider` and `createIsolatedSandboxProvider` factories
  - Filesystem-based test isolated provider
  - Git bundle sync-in for isolated providers
  - `copyToSandbox` support for isolated providers via `copyIn` after sync-in
  - Git format-patch/am sync-out for committed changes
  - Git diff/apply sync-out for uncommitted changes
  - Untracked file extraction via `copyOut` back to the host
  - Artifact persistence and recovery for failed sync-out (patches saved to `.sandcastle/patches/<timestamp>/`)

## 0.2.4

### Patch Changes

- 4d79ab9: Add optional `effort` parameter to `claudeCode()` for controlling Claude Code's reasoning effort level (`low`, `medium`, `high`, `max`)

## 0.2.3

### Patch Changes

- 01846be: Fix Docker sandbox failing when run from a git worktree. When `.git` is a worktree file (not a directory), also mount the parent repository's `.git` directory so git can resolve the repository inside the container.

## 0.2.2

### Patch Changes

- 008e539: Use `.mts` extension for scaffolded main file to fix ESM resolution in projects without `"type": "module"` in package.json. When the project's package.json has `"type": "module"`, the file is scaffolded as `main.ts` instead.

## 0.2.1

### Patch Changes

- fc62054: Fixed npm global install permission error in PI and Codex agent Dockerfiles by running `npm install -g` as root before switching to the `agent` user.

## 0.2.0

### Minor Changes

- 674e426: Add `{ mode: 'none' }` worktree variant that bind-mounts the host working directory directly into the sandbox container. No worktree is created, pruned, or cleaned up, and no merge step runs after iterations complete. Commits go directly onto the host's checked-out branch. `copyToSandbox` throws a runtime error with `mode: 'none'`. Both `SOURCE_BRANCH` and `TARGET_BRANCH` built-in prompt arguments resolve to the host's current branch.

### Patch Changes

- 77765bb: Add codex agent provider: `codex(model)` factory, stream parser for Codex CLI's `--json` JSONL output, Dockerfile template, init scaffolding, and CLI support
- 1f2134d: Add pi as a supported agent provider. `pi(model)` factory function is exported from `@ai-hero/sandcastle`. Pi's `--mode json` JSONL output is parsed correctly (message_update, tool_execution_start, agent_end events). `sandcastle init --agent pi` scaffolds a working setup with pi's Dockerfile and correct `main.ts`. `sandcastle interactive --agent pi` launches an interactive pi session.
- 3aff5f5: Refactor AgentProvider to runtime-only factory pattern. `run()` now requires `agent: claudeCode("model")` instead of `model: "..."`. The `claudeCode` factory and `AgentProvider` type are now exported from the package. Removed: `getAgentProvider`, `parseStreamJsonLine`, `formatToolCall`, `DEFAULT_MODEL` from public API.
- 75b4400: Bump default idle timeout from 5 minutes to 10 minutes to reduce spurious TimeoutError failures during long agent operations
- c62b429: Wire CLI interactive command for multi-agent support. The `interactive` command now accepts `--agent` and `--model` flags, uses the provider's `buildInteractiveArgs()` for docker exec, and displays the provider name in status messages.
- b1dd427: Add `createSandbox()` programmatic API for reusable sandboxes across multiple `run()` calls
- 54e76e0: Decouple init scaffolding from runtime providers. `envManifest` and `dockerfileTemplate` removed from `AgentProvider` interface. `sandcastle init` now has `--agent` and `--model` flags with interactive agent selection. Dockerfile templates owned by init's internal registry. Each template carries a static `.env.example` file copied as-is during scaffold. Scaffolded `main.ts` is rewritten with the selected agent factory and model.
- f35fa48: Log periodic idle warnings every minute of agent inactivity
- fabf0f7: Use run name instead of agent name in worktree and branch naming. When a `name` is provided to `run()`, worktree directories and temp branches now include the run name (e.g. `sandcastle/<name>/<timestamp>`) instead of the agent provider name. Renamed `sanitizeAgentName` to `sanitizeName`.
- cce183a: Replace top-level `branch` option on `RunOptions` with a `worktree` discriminated union that explicitly models two workspace modes: `{ mode: 'temp-branch' }` (default) and `{ mode: 'branch', branch: string }`. This is a breaking change — the old `branch` field is removed.

## 0.1.8

### Patch Changes

- 783b4cd: Base worktree cleanup on uncommitted changes rather than run success/failure.

  Previously, worktrees were always preserved on failure and always removed on success. Now the decision is based on whether the worktree has uncommitted changes (unstaged modifications, staged changes, or untracked files):
  - Success + clean worktree: remove silently (same as before)
  - Success + dirty worktree: preserve and print "uncommitted changes" message
  - Failure + clean worktree: remove and print "no uncommitted changes" message
  - Failure + dirty worktree: preserve with current preservation message

  `RunResult` now includes an optional `preservedWorktreePath` field set when a successful run leaves a worktree behind due to uncommitted changes. `TimeoutError.preservedWorktreePath` and `AgentError.preservedWorktreePath` are only set when the worktree is actually preserved (dirty), not on every failure.

## 0.1.7

### Patch Changes

- 5eef716: Inject `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` as built-in prompt arguments. These are available in any prompt without passing them via `promptArgs`. Passing either key in `promptArgs` now fails with an error.
- 78ef034: Fix sandbox crash on macOS by setting `HOME=/home/agent` in the container environment. Previously, Docker's `--user` flag caused `HOME` to default to `/`, making `git config --global` fail with a permission error on `//.gitconfig`.
- fed9a66: Replace wall-clock timeout with idle-based timeout that resets on each agent output event.
  - Rename `timeoutSeconds` → `idleTimeoutSeconds` in `RunOptions` and `OrchestrateOptions`
  - Change default from 1200s (20 min) to 300s (5 min)
  - Timeout now tracks from last received message (text or tool call), not run start
  - Error message updated to: "Agent idle for N seconds — no output received. Consider increasing the idle timeout with --idle-timeout."

- b16e0e0: Support multiple completion signals via `completionSignal: string | string[]`. The result field `wasCompletionSignalDetected: boolean` is replaced by `completionSignal?: string` — the matched signal string, or `undefined` if none fired.
- 0f48ef8: Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

  When a run session ends in failure, the sandbox (Docker container) is removed but the
  worktree is now preserved on the host. A message is printed with the worktree path and
  manual cleanup instructions. On successful completion, both the sandbox and worktree
  are removed as before.

  `TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
  so programmatic callers can inspect or build on the preserved worktree.

## 0.1.6

### Patch Changes

- 1cd8bdb: Remove single-branch shortcut in parallel-planner template; always use the merge agent

## 0.1.5

### Patch Changes

- 1cd8bdb: Close GitHub issue when single-branch merge is performed directly in parallel-planner template

## 0.1.4

### Patch Changes

- 8e08f7e: Document custom completion signal in the Early termination README section
- 6f9d3be: Fix CLI option tables to show correct default `--image-name` as `sandcastle:<repo-dir-name>` instead of `sandcastle:local`
- 4c94c5f: Fix README incorrectly describing `.sandcastle/prompt.md` as a default for `promptFile`. Neither `prompt` nor `promptFile` has a default — omitting both causes an error. The `.sandcastle/prompt.md` path is a convention scaffolded by `sandcastle init`, not an automatic fallback.
- 0d93587: Include run name in log filename to prevent overwrites in multi-agent workflows. When `name` is passed to `run()`, it is appended to the log filename (e.g. `main-implementer.log` instead of `main.log`).
- 26683b5: Lead the API section with a simple run() example before the full options reference.
- 3e32b7b: Remove `sandcastle interactive` CLI command documentation from README
- 762642e: Remove stale `patches/` entry from scaffolded `.sandcastle/.gitignore`. Nothing in Sandcastle creates a `.sandcastle/patches/` directory — the worktree-based architecture eliminated patch-based sync.

## 0.1.3

### Patch Changes

- 8b43a04: Remove pnpm/corepack from default sandbox Dockerfile template. The base Node.js image already includes npm, so the `corepack enable` step is unnecessary overhead. All init templates now use `npm install` and `npm run` instead of pnpm equivalents.
- 925506d: Replace pnpm with npm in README documentation
- 74b3f3b: Replace pnpm with npm in scaffold templates. All generated prompt files and main.ts hooks now use `npm install` and `npm run` instead of pnpm, consistent with the project's migration to npm.

## 0.1.2

### Patch Changes

- 3ece5cb: Removed unused `mkdir -p /home/agent/repos` from Dockerfile template. The workspace is bind-mounted at `/home/agent/workspace`, so this directory was never used.

## 0.1.1

### Patch Changes

- 0f61f59: Filter issue lists by `Sandcastle` label in all templates. `sandcastle init` now offers to create the label on the repo.

## 0.1.0

### Minor Changes

- a5cff39: Hide `agent` option from public API. The `agent` field has been removed from `RunOptions` and the `--agent` CLI flag has been removed from `init` and `interactive` commands. Agent selection is now hardcoded to `claude-code` internally. The agent provider system remains as an internal implementation detail.

### Patch Changes

- f11fd90: Add JSDoc comments to all public-facing type properties: `RunResult`, `LoggingOption`, and `PromptArgs`.
- 1fc5e32: Add kitchen-sink `run()` example to README with inline JSDoc-style comments on every option. Also updates the `RunOptions` table to remove the hidden `agent` field, fix the `maxIterations` default (1, not 5), fix the `timeoutSeconds` default (1200, not 900), update the `imageName` default, and add the missing `name` and `copyToSandbox` fields. Removes the removed `--agent` flag from the `sandcastle init` and `sandcastle interactive` CLI tables.
- b713226: Migrate from npm to pnpm across the project (issue #168).
  - Added `packageManager: "pnpm@10.7.0"` to `package.json`
  - Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
  - Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
  - Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
  - Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
  - Updated `README.md` development and hooks examples to use pnpm
  - Updated `InitService.ts` next-steps text to reference pnpm

- cd429c0: Replace --ff-only with regular merge for worktree merge-back (issue #162)

  When the agent finishes, Sandcastle now uses `git merge` instead of `git merge --ff-only` to integrate the temp branch back into the host branch. This allows users to make commits on the host branch while Sandcastle is running without causing merge-back failures. Fast-forward still happens naturally when the host branch hasn't moved; only the requirement that it _must_ fast-forward is removed.

- db3adec: Show run name instead of provider name in log-to-file summary (issue #160).

  When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.

- df9fe6c: Surface tool calls in run logs (issues #163, #164, #165, #166).

  `parseStreamJsonLine` now returns an array of events per line. Assistant messages may produce `text` and/or `tool_call` items. Tool calls are filtered to an allowlist (Bash, WebSearch, WebFetch, Agent) with per-tool arg extraction, and displayed interleaved with agent text output. The Display service gains a `toolCall(name, formattedArgs)` method rendered as a dim-styled step in terminal mode and a plain log line in log-to-file mode.

- dbe5989: Update 'How it works' section in README to describe the worktree-based architecture, replacing the outdated sync-in/sync-out description. Also fix related references to sync-in/sync-out throughout the README.

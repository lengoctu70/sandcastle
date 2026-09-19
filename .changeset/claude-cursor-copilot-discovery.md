---
"@lengoctu70/sandcastle": minor
---

Fingerprint Claude Code, Cursor, and Copilot before offering them in host mode. `sandcastle init --sandbox host` now discovers all four supported agents through the shared discovery contract, each adapter probing its real executable without touching subscriptions:

- **Claude Code** (`claude`) — fingerprinted by the `(Claude Code)` product mark in `claude --version`; `claude auth status` JSON (`loggedIn`) verifies the login. Claude Code exposes no model-list command, so a verified report carries an empty catalog.
- **Cursor** (`agent`) — the command-name-collision case: `agent` can resolve to a different product entirely, so the adapter requires Cursor markers in `agent --help` (`Cursor Agent`, `CURSOR_API_KEY`, `Authenticate with Cursor`) — Grok's `agent` answers `grok 1.0.30`/`Grok Build TUI` and reports `wrong-product`. Auth comes from `CURSOR_API_KEY` or `agent status`; the live catalog is read from `agent models`.
- **Copilot** (`copilot`) — fingerprinted by `GitHub Copilot` in `copilot --version` or `--help` (older builds print a bare version). Auth follows the documented credential chain: `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`, then `gh auth status`. Copilot has no model-list command either, so it reports `ready` with an empty catalog.

Agents with no catalog command keep the `--model` flag or registry default and persist `modelSource: "manual-unverified"` instead of pretending a verified pick; distinct Vietnamese guidance covers `not-installed`, `wrong-product`, and `unauthenticated`, and a non-ready report stops non-interactive init before anything is scaffolded. Runtime provider behavior is unchanged — discovery only inspects, never installs or logs in.

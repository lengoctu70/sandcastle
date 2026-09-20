---
"@lengoctu70/sandcastle": patch
---

Harden provider invocation and discovery so the configured agent choice actually reaches the CLI and unsupported behavior is reported honestly:

- **Grok** unattended runs no longer pass `--prompt-file /dev/stdin` to `cmd.exe` on Windows (which has no `/dev/stdin`). `GrokOptions.execPlatform` selects the platform of the shell that will interpret the command: `"win32"` writes the prompt to a private temp file and hands its real path to `--prompt-file` (self-cleaning via `& del`), while POSIX shells — including containers on a Windows host — keep stdin delivery.
- **Devin** `--model` resolution in init now accepts every selector the live CLI advertises — the family slug, a catalog alias (e.g. `opus`), or an exact variant `model_uid` (e.g. `claude-opus-5-high`) — while keeping family and variant selection distinct: a variant selector resolves the family as `model` and the uid as `effort`, which `DevinOptions.variant` passes back to `--model` unchanged (ADR 0021).
- **Pi** interactive sessions now receive the configured thinking level (`pi --thinking`), matching print mode.
- **OpenCode** interactive sessions never emit the `--variant` flag the TUI does not support; a configured variant now prints an explicit notice that it applies only to unattended `opencode run`. Print mode rejects prompts over 120 KiB (UTF-8 bytes) before spawn with an actionable error instead of `E2BIG`.
- **Copilot** readiness now recognizes a native `copilot login` account through `config.json`'s documented `loggedInUsers` record (env tokens → native login → `gh` fallback, in the CLI's documented precedence); only the non-secret `host`/`login` fields are read.
- **Grok discovery** no longer recommends a `Default model:` value that is not a catalog member — an unlisted alias degrades to a real catalog entry instead of crashing the headless picker.

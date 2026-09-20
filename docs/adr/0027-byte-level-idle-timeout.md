# Byte-level idle timeout and unframed agent output

The idle timeout used to measure _complete stdout lines_: the sandbox exec splits output with `readline`, and only a `line` event — a newline-terminated chunk, or the final flush at EOF — reset the timer. `devin -p` streams its narration as text bytes continuously but never emits `\n`, so a healthy planner that spends ten minutes reading the repository produced zero lines and was killed by `AgentIdleTimeoutError` at exactly the default 600 s, with its real output flushed only as the process died. Print-mode Devin is therefore an **unframed output** provider: byte stream, no line framing.

The sandbox `exec` contract now carries `onData(chunk)`, which every sandbox provider (no-sandbox, docker, podman, vercel) must fire for each raw stdout chunk as it arrives — including the bytes of a partial, unterminated line. The Orchestrator resets the idle timer on every chunk, so "idle" means "zero stdout bytes for the window" — a working agent that streams anything stays alive regardless of its output's framing, and a genuinely hung process that writes nothing still fails. `stderr` deliberately does not count: a stuck process can spam stderr, and only stdout bytes evidence progress on the task.

Providers whose output is unframed additionally define `AgentProvider.parseStreamChunk`. The Orchestrator feeds each chunk through it so the text surfaces as live `text` stream events — `devin -p` narration now appears in the run log as it happens rather than in one block at exit. For such a provider, `text` events produced by `parseStreamLine` are dropped because the same bytes already arrived via chunks (no double-reporting at EOF); other event types still apply, so a provider that mixes framed and unframed output keeps its structured events.

The timeout itself is configurable end to end: `idleTimeoutSeconds` in `.sandcastle/settings.json` sets the project default, and `--idle-timeout` on `sandcastle run`/`sandcastle retry` overrides it per invocation. Both flow through every `wt.run` call in the issue workflow — planning, implementation, review, and all repair passes — so no phase keeps a hidden hardcoded bound.

## Considered alternatives

- **Just raise the timeout.** A larger bound shrinks the false-positive rate but keeps the wrong signal — a slow-reading agent still dies, and the log stays blind for the whole run.
- **Process liveness instead of output.** "Alive process" cannot distinguish a working agent from a hung one; output bytes are the observable proxy for progress and already exist on every provider.
- **`devin acp` structured events.** Devin's ACP subcommand would give real tool-call events, not just text. Deferred — it is a provider-specific protocol change, whereas this fix is generic and repairs the failure for every present and future provider whose CLI can pause between lines.
- **Provider-specific opt-out.** Audited: every other provider already emits newline-delimited JSON (Claude Code, Codex, Cursor, OpenCode, Copilot, Grok, Antigravity, Pi). Devin is the only unframed one today; the generic `onData` contract covers any future one without a per-provider patch.

## Consequences

- A run that produces truly zero stdout for `idleTimeoutSeconds` still fails — the failure mode is preserved, only the signal definition changed.
- Partial ANSI escape sequences can straddle a chunk boundary; a truncated sequence may leak a few literal characters into a `text` event. Cosmetic and rare — `devin -p` output is plain text when piped.
- Unframed providers gain live text visibility but still no tool-call events — that needs `devin acp`, which remains follow-up work.

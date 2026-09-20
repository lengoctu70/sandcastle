---
"@lengoctu70/sandcastle": minor
---

Fix false idle-timeout kills for agents whose print mode streams text without newlines (`devin -p`). The sandbox `exec` contract gains `onData(chunk)` — raw stdout bytes as they arrive — and the idle timer now resets on any stdout byte instead of only complete lines, so a working agent that stays line-silent no longer fails at 600s. Providers with unframed output can define `parseStreamChunk`, which Devin implements so its narration surfaces live in the run log instead of in one block at exit. `sandcastle run`/`retry` accept `--idle-timeout <seconds>`, and `.sandcastle/settings.json` accepts `idleTimeoutSeconds`; both flow to every agent invocation in the issue workflow (ADR 0027).

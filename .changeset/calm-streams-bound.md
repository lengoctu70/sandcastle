---
"@lengoctu70/sandcastle": patch
---

Preserve agent stream boundaries and bound tool-call display args. Pi's lowercase `bash` tool events now surface the executed command instead of being dropped by the case-sensitive allowlist; Devin plain-text lines keep their newline delimiters in terminal and buffered output; and every provider's tool_call args — allowlisted fields, JSON-dump fallbacks, and raw argument strings alike — are capped at 300 characters with a visible ellipsis so one oversized or unfamiliar argument cannot flood output. Antigravity result events now also extract structured `{error: {message}}` objects.

---
"@lengoctu70/sandcastle": patch
---

Bound every agent-discovery probe by a hard settlement deadline so `sandcastle init` and `sandcastle configure` can no longer hang when a probed CLI exits but a spawned descendant (daemon, MCP server, background worker) keeps the inherited stdout/stderr pipes open. At the probe's timeout the whole process tree is signalled (process-group kill on POSIX, `taskkill /T /F` on Windows), and after a short SIGKILL grace the owned streams are closed and the probe resolves exactly once with a typed `timedOut` result — settlement no longer waits on stdio EOF. On Windows, a missing executable probed through `cmd.exe` is now correctly reported as `not-installed` (ENOENT) instead of `wrong-product`: the `'x' is not recognized as an internal or external command` answer is mapped back to the spawn-error contract. Existing Vietnamese timeout guidance (`hết thời gian chờ`) now always reaches the user.

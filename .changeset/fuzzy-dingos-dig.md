---
"@lengoctu70/sandcastle": patch
---

Fix a host process leak in the `noSandbox()` (host mode) provider. `close()` was a no-op and `exec` spawned `sh -c` with no process group, so cancellation, idle timeout, and the completion-timeout force-complete (ADR 0019) abandoned the agent's children — `gh`/git subprocesses, MCP servers — on the host. Every spawned host execution is now tracked for the handle's lifetime; on POSIX the shell runs `detached` as a process-group leader so teardown signals the whole group (`kill(-pgid)`, SIGTERM then SIGKILL after `terminationGraceMs`), and on Windows the tree is killed via `taskkill /PID /T /F`. Termination is guarded so already-exited processes and unrelated or reused pids are never signalled, `close()` is idempotent, and a shutdown-registry hook reaps trees on host `SIGINT`/`SIGTERM`/`exit`. `exec` also accepts an `AbortSignal` so `run()`'s abort path kills the tree immediately. Container sandbox lifecycle is unchanged.

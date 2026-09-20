<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png">
    <img alt="Sandcastle" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## Bắt đầu nhanh

> Hướng dẫn ngắn nhất để cài đặt và chạy Sandcastle — dùng lại tài khoản subscription của agent CLI bạn đã đăng nhập trên máy. Tài liệu tham khảo chi tiết phía dưới (API, sandbox providers, prompts, templates, CLI options) vẫn bằng tiếng Anh.

### Bạn cần có

- [Node.js](https://nodejs.org/) và [Git](https://git-scm.com/).
- [GitHub CLI (`gh`)](https://cli.github.com/) đã đăng nhập (`gh auth login`) — Sandcastle dùng `gh` để đọc issue, đăng báo cáo và đóng issue.
- Một agent CLI đã cài và đăng nhập sẵn trên máy — ví dụ Claude Code, Codex, Pi, OpenCode, Devin, Cursor, Copilot, Grok hoặc Antigravity. **Không cần API key**: chế độ host tái sử dụng phiên đăng nhập subscription hiện có của agent.
- (Không bắt buộc) [Docker](https://www.docker.com/) hoặc [Podman](https://podman.io/) nếu bạn muốn agent chạy trong container thay vì trên host.

### 1. Cài đặt

```bash
npm i -D @lengoctu70/sandcastle
```

(Không cần cài cũng được — `npx @lengoctu70/sandcastle init` chạy thẳng từ npm.)

### 2. Khởi tạo trong repo của bạn

```bash
npx sandcastle init
```

Init hỏi bạn bằng tiếng Việt (mọi bước đều có flag tương đương cho chế độ non-interactive — xem [`sandcastle init`](#sandcastle-init)):

- **Nơi chạy agent**: `host`, `docker` hoặc `podman`.
- **Agent + model + effort**: trong chế độ host, init tự khám phá các agent CLI đã cài, kiểm tra đăng nhập, và liệt kê model/effort thật từ chính CLI đó.
- **Workflow**: chọn theo kết quả bạn muốn — một issue có review (khuyến nghị), nhanh tuần tự, song song, hoặc workflow tùy chỉnh.
- **Issue tracker**: chọn `github-issues` để Sandcastle làm việc với GitHub Issue.
- **Lệnh xác minh**: init phát hiện sẵn các lệnh như `npm run typecheck`, `npm test`… để bạn xác nhận hoặc chỉnh sửa.

Khi chọn `github-issues`, init kiểm tra `gh` đã cài và đăng nhập trước khi scaffold, và chỉ tạo label `Sandcastle` trên repo sau khi bạn xác nhận. Init cũng tự thêm script này vào `package.json`:

```json
"scripts": {
  "sandcastle": "sandcastle run"
}
```

### 3. Chạy

Gắn label `Sandcastle` cho các issue bạn muốn giao cho Sandcastle, rồi:

```bash
npm run sandcastle
```

Bạn sẽ được hỏi chọn **một issue** đang mở, chạy **tất cả tuần tự**, hoặc **tất cả song song** (giới hạn `parallelism` 1–4). Trong CI/script không tương tác, dùng `sandcastle run --issue <N>` hoặc `sandcastle run --all`.

### Chế độ host — hiểu rõ trước khi chọn

Chế độ host là đường đi khuyến nghị cho subscription: agent chạy trực tiếp trên máy của bạn trong một **git worktree riêng** (không đụng vào checkout đang mở), tái sử dụng phiên đăng nhập CLI hiện có — không cần cài lại agent hay copy API key vào container.

**Worktree KHÔNG phải cách ly hệ điều hành.** Agent vẫn giữ toàn bộ quyền truy cập tệp và tiến trình của tài khoản bạn. Nếu cần ranh giới bảo mật thực sự, chọn `docker` hoặc `podman` trong init — agent chạy trong container riêng với image do Sandcastle build (`sandcastle docker build-image` / `sandcastle podman build-image`).

Sandcastle cũng **xác minh danh tính** của executable trước khi tin đó là agent bạn chọn: một lệnh trùng tên (ví dụ `agent` trỏ tới sản phẩm khác) bị báo `wrong-product` thay vì bị gọi nhầm.

### Model và effort: khám phá trực tiếp, không đoán

Init đọc catalog model/effort **trực tiếp từ CLI của agent** — không hard-code "model mới nhất". Khi agent có nhiều model provider (Pi, OpenCode, Devin), model được nhóm theo provider; model và effort được khuyến nghị đánh dấu `(khuyến nghị)`.

Nếu discovery thất bại, bạn có 3 lựa chọn an toàn: **thử lại**, **nhập model thủ công** — lựa chọn được lưu là `modelSource: "manual-unverified"` và UI không bao giờ trình bày nó là đã xác minh — hoặc **dừng lại** trước khi scaffold. Đổi sau bằng [`sandcastle configure`](#sandcastle-configure).

### Mỗi lần chạy diễn ra thế nào

Với mỗi issue được chọn, Sandcastle tự làm trọn chuỗi:

1. **Implement** — agent làm việc trên nhánh `sandcastle/issue-<N>` trong worktree riêng; agent **không** nhận được quyền đóng issue.
2. **Xác minh** — các lệnh xác minh bạn đã xác nhận chạy trong worktree, trong đúng môi trường đã cấu hình (host chạy trực tiếp trên máy; docker/podman chạy bên trong sandbox gắn với worktree đó).
3. **Merge tích hợp** — kết quả merge trong một worktree tích hợp riêng, rồi xác minh lại lần nữa trên cây đã merge trong cùng môi trường đó.
4. **Landing** — nhánh đích chỉ được cập nhật sau khi xác minh pass và tip nhánh không bị động.
5. **Báo cáo + đóng** — Sandcastle đăng báo cáo hoàn thành tiếng Việt lên issue rồi mới `gh issue close`.

### Sửa tự động có giới hạn

- Xác minh thất bại → agent sửa trong cùng worktree, **tối đa 2 lần** (tiếp tục đúng agent session khi agent hỗ trợ resume).
- Xung đột merge → **tối đa 1 lần** sửa trong worktree tích hợp.
- Nhánh đích bị động trong lúc merge → dựng lại tích hợp **tối đa 1 lần**; Sandcastle không bao giờ force-update.

### Khi một tác vụ thất bại

Issue vẫn **mở** kèm báo cáo thất bại tiếng Việt; nhánh + worktree + chi tiết lỗi được giữ trong `.sandcastle/recovery/`:

```bash
sandcastle status      # liệt kê các tác vụ thất bại được giữ lại
sandcastle retry <N>   # tiếp tục từ đúng bước đã dừng — không chọn lại issue, không implement lại
sandcastle discard <N> # xóa worktree + nhánh + bản ghi (hỏi xác nhận, hoặc --yes)
```

### Issue chỉ đóng sau khi code đã nằm trên nhánh đích

`gh issue close` chỉ chạy **sau khi** code của issue đã pass xác minh và được merge — "closed" nghĩa là hoàn thành thật trong repo, không phải "agent nói xong".

---

_Tài liệu tham khảo đầy đủ bên dưới — API, sandbox providers, prompts, templates, CLI options — vẫn bằng tiếng Anh._

## What Is Sandcastle?

A TypeScript library for orchestrating AI coding agents in isolated sandboxes:

1. You invoke agents with a single `sandcastle.run()`.
2. Sandcastle handles sandboxing the agent with a configurable branch strategy.
3. The commits made on the branches get merged back.

Sandcastle is provider-agnostic — it ships with built-in providers for Docker, Podman, and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents.

## Prerequisites

- [Git](https://git-scm.com/)
- A sandbox provider — Sandcastle needs an isolated environment to run agents in. Built-in options:
  - [Docker Desktop](https://www.docker.com/) — most common for local development
  - [Podman](https://podman.io/) — rootless alternative to Docker
  - [Vercel](https://vercel.com/) — cloud-based Firecracker microVMs via `@vercel/sandbox`
  - Or [create your own](#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`

## Quick start

1. Install the package:

```bash
npm install --save-dev @lengoctu70/sandcastle
```

2. Run `npx @lengoctu70/sandcastle init`. This scaffolds a `.sandcastle` directory with all the files needed.

```bash
npx @lengoctu70/sandcastle init
```

3. Edit `.sandcastle/.env` and fill in your default values for `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` on your host to get one). To use an Anthropic API key instead, uncomment and fill in `ANTHROPIC_API_KEY`.

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

4. Launch the workflow. Init adds a `"sandcastle": "sandcastle run"` script to your `package.json`, so the normal command is:

```bash
npm run sandcastle
```

(Advanced: you can also execute the scaffolded file directly with `npx tsx .sandcastle/main.ts` — or `main.mts`.)

```typescript
// 3. Run the agent via the JS API
import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(), // or podman(), vercel(), or your own provider
  promptFile: ".sandcastle/prompt.md",
});
```

## Sandbox Providers

Sandcastle uses a `SandboxProvider` to create isolated environments. The `sandbox` option on `run()`, `interactive()`, and `createSandbox()` accepts any provider, including `noSandbox()` — opt in to running the agent directly on the host when container isolation is undesired. Built-in providers:

| Provider   | Import path                                   | Type       | Accepted by                                 |
| ---------- | --------------------------------------------- | ---------- | ------------------------------------------- |
| Docker     | `@lengoctu70/sandcastle/sandboxes/docker`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Podman     | `@lengoctu70/sandcastle/sandboxes/podman`     | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| Vercel     | `@lengoctu70/sandcastle/sandboxes/vercel`     | Isolated   | `run()`, `createSandbox()`, `interactive()` |
| No-sandbox | `@lengoctu70/sandcastle/sandboxes/no-sandbox` | None       | `run()`, `createSandbox()`, `interactive()` |

Worktree methods (`wt.run()`, `wt.interactive()`, `wt.createSandbox()`) accept the same providers as their top-level counterparts. `wt.interactive()` defaults to `noSandbox()` when no sandbox is specified.

```typescript
import { run, interactive, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";
import { podman } from "@lengoctu70/sandcastle/sandboxes/podman";
import { vercel } from "@lengoctu70/sandcastle/sandboxes/vercel";
import { noSandbox } from "@lengoctu70/sandcastle/sandboxes/no-sandbox";

// Docker, Podman, and Vercel are interchangeable in run() and createSandbox():
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "...",
});

// No-sandbox runs the agent directly on the host — accepted by run(),
// createSandbox(), and interactive(). Skips container isolation entirely:
await interactive({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: noSandbox(),
  prompt: "...", // optional — omit to launch the TUI with no initial prompt
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});
```

You can also [create your own provider](#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`.

## API

Sandcastle exports a programmatic `run()` function for use in scripts, CI pipelines, or custom tooling. The examples below use `docker()`, but any `SandboxProvider` works in its place.

```typescript
import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.iterations); // per-iteration results with optional sessionId
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### All options

```typescript
import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

// Stand-in for your observability client used by onAgentStreamEvent below.
const myLogger = console;

const result = await run({
  // Agent provider — required. Pass a model string to claudeCode().
  // Optional second arg for provider-specific options like effort level.
  agent: claudeCode("claude-opus-4-8", { effort: "high" }),

  // Sandbox provider — required. Any SandboxProvider works (docker, podman, vercel, or custom).
  // Provider-specific config (like imageName, mounts) lives inside the provider factory call.
  sandbox: docker({
    imageName: "sandcastle:local",
    // Optional: override the UID/GID used for --user flag (defaults to host UID/GID).
    // Must match the UID baked into the image. Pre-flight check catches mismatches.
    // containerUid: 1000,
    // containerGid: 1000,
    // Optional: mount host directories into the sandbox (e.g. package manager caches)
    // hostPath supports absolute, tilde-expanded (~), and relative paths (resolved from cwd).
    // sandboxPath supports absolute and relative paths (resolved from the sandbox repo directory).
    mounts: [
      { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true },
      { hostPath: "data", sandboxPath: "data" }, // mounts <cwd>/data → <sandbox-repo>/data
    ],
    // Optional: SELinux volume label — "z" (default, shared), "Z" (private), or false (none).
    // No-op on non-SELinux systems (Docker Desktop on macOS/Windows, Linux without SELinux).
    selinuxLabel: "z",
    // Optional: provider-level env vars merged at launch time
    env: { DOCKER_SPECIFIC: "value" },
    // Optional: attach container to Docker network(s) — string or string[]
    network: "my-network",
    // Optional: add the container user to supplementary groups via --group-add.
    // Accepts group names or numeric GIDs (e.g. for a bind-mounted Docker socket).
    groups: ["docker", 999],
    // Optional: expose host devices via --device. Each entry is a full device
    // spec in host[:container[:permissions]] form (e.g. "/dev/kvm").
    devices: ["/dev/kvm"],
    // Optional: limit CPU resources via --cpus. Fractional values allowed (e.g. 1.5).
    // cpus: 2,
  }),

  // Host repo directory — replaces process.cwd() as the anchor for
  // .sandcastle/ artifacts (worktrees, logs, env, patches) and git operations.
  // Relative paths resolve against process.cwd(). Defaults to process.cwd().
  cwd: "../other-repo",

  // Branch strategy — controls how the agent's changes relate to branches.
  // Defaults to { type: "head" } for bind-mount and { type: "merge-to-head" } for isolated providers.
  branchStrategy: { type: "branch", branch: "agent/fix-42" },

  // Prompt source — provide one of these, not both.
  // Note: promptFile resolves against process.cwd(), NOT cwd.
  promptFile: ".sandcastle/prompt.md", // path to a prompt file
  // prompt: "Fix issue #42 in this repo", // OR an inline prompt string

  // Values substituted for {{KEY}} placeholders in the prompt.
  promptArgs: {
    ISSUE_NUMBER: "42",
  },

  // Maximum number of agent iterations to run before stopping. Default: 1
  maxIterations: 5,

  // Display name for this run, shown as a prefix in log output.
  name: "fix-issue-42",

  // Lifecycle hooks grouped by where they run: host or sandbox.
  hooks: {
    host: {
      onWorktreeReady: [{ command: "cp .env.example .env" }],
      onSandboxReady: [{ command: "echo setup done" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },

  // Host-relative file paths to copy into the sandbox before the container starts.
  // Not supported with branchStrategy: { type: "head" }.
  copyToWorktree: [".env"],

  // Override default timeouts for built-in lifecycle steps.
  // Unset keys keep their defaults.
  timeouts: {
    copyToWorktreeMs: 120_000, // default: 60_000
    gitSetupMs: 30_000, // default: 10_000
    commitCollectionMs: 60_000, // default: 30_000
    mergeToHostMs: 60_000, // default: 30_000
  },

  // How to record progress. Default: write to a file under .sandcastle/logs/
  logging: {
    type: "file",
    path: ".sandcastle/logs/my-run.log",
    // Optional: forward the agent's output stream to your own observability system.
    // Fires for each text chunk, tool call, and raw stdout line the agent
    // produces. Errors thrown by the callback are swallowed so a broken
    // forwarder cannot kill the run.
    onAgentStreamEvent: (event) => {
      // event is { type: "text" | "toolCall" | "raw", iteration, timestamp, ... }
      myLogger.info(event);
    },
    // Optional: append every raw stdout line the agent emits to the same
    // log file, interleaved with the human-readable output. Includes lines
    // the provider's stream parser would otherwise drop. Intended for
    // debugging stuck or unexpected agent behaviour.
    verbose: true,
  },
  // logging: { type: "stdout", verbose: true }, // OR terminal mode (verbose: raw lines to stdout)

  // String (or array of strings) the agent emits to end the iteration loop early.
  // Default: "<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // Idle timeout in seconds — resets whenever the agent produces output. Default: 600 (10 minutes)
  idleTimeoutSeconds: 600,

  // Grace window in seconds after the agent emits a completion signal but
  // before its process has exited (a "hanging process" — typically a spawned
  // `gh`/git child or MCP server keeping stdout open). Resets on every
  // subsequent output line so trailing data is still captured. Default: 60
  completionTimeoutSeconds: 60,

  // Structured output — extract a typed payload from the agent's stdout.
  // Requires maxIterations === 1 and the tag must appear in the prompt.
  // output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
  // output: Output.string({ tag: "summary" }),
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

### `createSandbox()` — reusable sandbox

Use `createSandbox()` when you need to run multiple agents (or multiple rounds of the same agent) inside a single sandbox. It creates the sandbox once, and you call `sandbox.run()` as many times as you need. This avoids repeated container startup costs and keeps all runs on the same branch.

Use `run()` instead when you only need a single one-shot invocation — it handles sandbox lifecycle automatically.

#### Basic single-run usage

```typescript
import { createSandbox, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Fix issue #42 in this repo.",
});

console.log(result.commits); // [{ sha: "abc123" }]
```

#### Multi-run implement-then-review

```typescript
import { createSandbox, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// Step 1: implement
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// Step 2: review on the same branch, same container
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

Commits from all `run()` calls accumulate on the same branch. The sandbox container stays alive between runs, so installed dependencies and build artifacts persist.

`sandbox.exec()` lets the harness run shell commands directly in the same warm sandbox — handy for gating an implement step on a quick verification before kicking off the review:

```typescript
await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// Verify before review — non-zero exitCode is returned, not thrown.
const tests = await sandbox.exec("npm test");
if (tests.exitCode !== 0) {
  throw new Error(`Tests failed:\n${tests.stdout}\n${tests.stderr}`);
}

await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

`cwd` defaults to the sandbox repo path, matching `interactive()`. Pass `cwd` to override.

#### Automatic cleanup with `await using`

`await using` calls `sandbox.close()` automatically when the block exits. If the sandbox has uncommitted changes, the worktree is preserved on disk; if clean, both container and worktree are removed.

#### Manual `close()` with `CloseResult`

```typescript
const sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});
// ... run agents ...
const closeResult = await sandbox.close();
if (closeResult.preservedWorktreePath) {
  console.log(`Worktree preserved at ${closeResult.preservedWorktreePath}`);
}
```

#### `CreateSandboxOptions`

| Option           | Type            | Default         | Description                                                                                                         |
| ---------------- | --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `branch`         | string          | —               | **Required.** Explicit branch for the sandbox                                                                       |
| `sandbox`        | SandboxProvider | —               | **Required.** Sandbox provider (e.g. `docker()`, `podman()`)                                                        |
| `cwd`            | string          | `process.cwd()` | Host repo directory — relative paths resolve against `process.cwd()`                                                |
| `hooks`          | SandboxHooks    | —               | Lifecycle hooks (`host.*`, `sandbox.*`) — run once at creation time                                                 |
| `copyToWorktree` | string[]        | —               | Host-relative file paths to copy into the sandbox at creation time                                                  |
| `timeouts`       | Timeouts        | —               | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |

#### `Sandbox`

| Property / Method       | Type                                                                     | Description                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `branch`                | string                                                                   | The branch the sandbox is on                                                                                              |
| `worktreePath`          | string                                                                   | Host path to the worktree                                                                                                 |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                       | Invoke an agent inside the existing sandbox                                                                               |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>`       | Launch an interactive session in the sandbox                                                                              |
| `exec(cmd, options?)`   | `(command: string, options?: SandboxExecOptions) => Promise<ExecResult>` | Run a shell command in the sandbox. `cwd` defaults to the sandbox repo path. Non-zero `exitCode` is returned, not thrown. |
| `close()`               | `() => Promise<CloseResult>`                                             | Tear down the container and sandbox                                                                                       |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                                    | Auto teardown via `await using`                                                                                           |

#### `SandboxRunOptions`

| Option                     | Type               | Default                       | Description                                                                                                                          |
| -------------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                    | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-8")`)                                                                  |
| `prompt`                   | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                 |
| `promptFile`               | string             | —                             | Path to prompt file (mutually exclusive with `prompt`)                                                                               |
| `promptArgs`               | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                                 |
| `maxIterations`            | number             | `1`                           | Maximum iterations to run                                                                                                            |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | String(s) the agent emits to stop the iteration loop early                                                                           |
| `idleTimeoutSeconds`       | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                          |
| `completionTimeoutSeconds` | number             | `60`                          | Grace window after the completion signal is seen but the agent process hasn't exited                                                 |
| `name`                     | string             | —                             | Display name for the run                                                                                                             |
| `logging`                  | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                                     |
| `resumeSession`            | string             | —                             | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host. |
| `signal`                   | AbortSignal        | —                             | Cancels the run when aborted; handle stays usable afterward                                                                          |

#### `SandboxRunResult`

| Field                      | Type                                                                                     | Description                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `iterations`               | `IterationResult[]`                                                                      | Per-iteration results (use `.length` for the count)                                                                                 |
| `completionSignal`         | string?                                                                                  | The matched completion signal string, or `undefined` if none fired                                                                  |
| `stdout`                   | string                                                                                   | Combined agent output from all iterations                                                                                           |
| `commits`                  | `{ sha }[]`                                                                              | Commits created during the run                                                                                                      |
| `logFilePath`              | string?                                                                                  | Path to the log file (only when logging to a file)                                                                                  |
| `resume(prompt, options?)` | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | Continue the captured session for one iteration inside the same warm sandbox. Present only when the provider captured a session id. |
| `fork(prompt, options?)`   | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | Fork the captured session for one iteration inside the same warm sandbox. The parent session is left intact (ADR 0018).             |

#### `CloseResult`

| Field                   | Type    | Description                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `preservedWorktreePath` | string? | Host path to the preserved worktree, set when it had uncommitted changes |

### `createWorktree()` — independent worktree lifecycle

Use `createWorktree()` when you need a worktree (git worktree) as an independent, first-class concept — separate from any sandbox. This is useful when you want to run an interactive session first and then hand the same worktree to a sandboxed AFK agent.

Only `branch` and `merge-to-head` strategies are accepted; `head` is a compile-time type error since it means no worktree.

Pass `cwd` to target a repo other than `process.cwd()`. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is thrown if the path does not exist or is not a directory.

```typescript
import { createWorktree, claudeCode } from "@lengoctu70/sandcastle";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  copyToWorktree: ["node_modules"],
  cwd: "/path/to/other-repo", // optional — defaults to process.cwd()
});

console.log(wt.worktreePath); // host path to the worktree
console.log(wt.branch); // "agent/fix-42"

// Run an interactive session in the worktree (defaults to noSandbox)
await wt.interactive({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "Explore the codebase and understand the bug.",
});

// Run an AFK agent in the worktree (sandbox is required)
const result = await wt.run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker({ imageName: "sandcastle:myrepo" }),
  prompt: "Fix issue #42.",
  maxIterations: 3,
});
console.log(result.commits); // commits made during the run

// Create a long-lived sandbox from the worktree
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

await using sandbox = await wt.createSandbox({
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// sandbox.close() tears down the container only — the worktree stays
await sandbox.close();

// wt.close() cleans up the worktree
```

`wt.close()` checks for uncommitted changes: if the worktree is dirty, it's preserved on disk; if clean, it's removed. `await using` calls `close()` automatically. The worktree persists after `run()`, `interactive()`, and `createSandbox()` complete, so you can hand it to another agent or inspect it.

With `branchStrategy: { type: "merge-to-head" }`, each `wt.run()` / `wt.interactive()` merges the agent's commits back to the host's current branch before returning, and the worktree's source branch is preserved across calls so subsequent ones can reuse the same handle. (This differs from top-level `run()`, where the temp branch is deleted after the merge.)

**Split ownership**: When a sandbox is created via `wt.createSandbox()`, `sandbox.close()` tears down the container only — the worktree remains. `wt.close()` is responsible for worktree cleanup. This differs from the top-level `createSandbox()`, where `sandbox.close()` owns both container and worktree.

#### `CreateWorktreeOptions`

| Option           | Type                   | Default | Description                                                                                                         |
| ---------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `branchStrategy` | WorktreeBranchStrategy | —       | **Required.** `{ type: "branch", branch }` or `{ type: "merge-to-head" }`                                           |
| `copyToWorktree` | string[]               | —       | Host-relative file paths to copy into the worktree at creation time                                                 |
| `timeouts`       | Timeouts               | —       | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |

#### `Worktree`

| Property / Method        | Type                                                                  | Description                                         |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `branch`                 | string                                                                | The branch the worktree is on                       |
| `worktreePath`           | string                                                                | Host path to the worktree                           |
| `run(options)`           | `(options: WorktreeRunOptions) => Promise<WorktreeRunResult>`         | Run an AFK agent in the worktree (sandbox required) |
| `interactive(options)`   | `(options: WorktreeInteractiveOptions) => Promise<InteractiveResult>` | Run an interactive agent session in the worktree    |
| `createSandbox(options)` | `(options: WorktreeCreateSandboxOptions) => Promise<Sandbox>`         | Create a long-lived sandbox backed by this worktree |
| `close()`                | `() => Promise<CloseResult>`                                          | Clean up the worktree (preserves if dirty)          |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                                 | Auto cleanup via `await using`                      |

#### `WorktreeInteractiveOptions`

| Option       | Type                   | Default       | Description                                                                                       |
| ------------ | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `agent`      | AgentProvider          | —             | **Required.** Agent provider                                                                      |
| `sandbox`    | AnySandboxProvider     | `noSandbox()` | Sandbox provider (defaults to no sandbox)                                                         |
| `prompt`     | string                 | —             | Inline prompt (mutually exclusive with `promptFile`)                                              |
| `promptFile` | string                 | —             | Path to prompt file                                                                               |
| `name`       | string                 | —             | Optional session name                                                                             |
| `hooks`      | SandboxHooks           | —             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                           |
| `promptArgs` | PromptArgs             | —             | Key-value map for `{{KEY}}` placeholder substitution                                              |
| `env`        | Record<string, string> | —             | Environment variables to inject into the sandbox                                                  |
| `signal`     | AbortSignal            | —             | Cancel the session when aborted. The worktree is preserved on disk. Rejects with `signal.reason`. |

#### `WorktreeRunOptions`

| Option                     | Type                   | Default | Description                                                                                                                          |
| -------------------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                    | AgentProvider          | —       | **Required.** Agent provider                                                                                                         |
| `sandbox`                  | SandboxProvider        | —       | **Required.** Sandbox provider (AFK agents must be sandboxed)                                                                        |
| `prompt`                   | string                 | —       | Inline prompt (mutually exclusive with `promptFile`)                                                                                 |
| `promptFile`               | string                 | —       | Path to prompt file                                                                                                                  |
| `maxIterations`            | number                 | 1       | Maximum iterations to run                                                                                                            |
| `completionSignal`         | string \| string[]     | —       | Substring(s) to stop the iteration loop early                                                                                        |
| `idleTimeoutSeconds`       | number                 | 600     | Idle timeout in seconds                                                                                                              |
| `completionTimeoutSeconds` | number                 | 60      | Grace window after completion signal is seen but agent process hasn't exited                                                         |
| `name`                     | string                 | —       | Optional run name                                                                                                                    |
| `logging`                  | LoggingOption          | file    | Logging mode                                                                                                                         |
| `hooks`                    | SandboxHooks           | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                              |
| `promptArgs`               | PromptArgs             | —       | Key-value map for `{{KEY}}` placeholder substitution                                                                                 |
| `env`                      | Record<string, string> | —       | Environment variables to inject into the sandbox                                                                                     |
| `resumeSession`            | string                 | —       | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host. |
| `signal`                   | AbortSignal            | —       | Cancel the run when aborted. Kills the in-flight agent subprocess; the worktree is preserved on disk. Rejects with `signal.reason`.  |

#### `WorktreeRunResult`

| Property           | Type                | Description                                            |
| ------------------ | ------------------- | ------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)    |
| `completionSignal` | string              | The matched completion signal, or undefined            |
| `stdout`           | string              | Combined stdout output from all agent iterations       |
| `commits`          | { sha: string }[]   | List of commits made by the agent during the run       |
| `branch`           | string              | The branch name the agent worked on                    |
| `logFilePath`      | string              | Path to the log file, if logging was drained to a file |

#### `WorktreeCreateSandboxOptions`

| Option           | Type            | Default | Description                                                                                                         |
| ---------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `sandbox`        | SandboxProvider | —       | **Required.** Sandbox provider (e.g. `docker()`)                                                                    |
| `hooks`          | SandboxHooks    | —       | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                             |
| `copyToWorktree` | string[]        | —       | Host-relative file paths to copy into the worktree at creation time                                                 |
| `timeouts`       | Timeouts        | —       | Override built-in lifecycle step timeouts (`copyToWorktreeMs`, `gitSetupMs`, `commitCollectionMs`, `mergeToHostMs`) |

## How it works

Sandcastle uses a **branch strategy** configured on the sandbox provider to control how the agent's changes relate to branches. There are three strategies:

- **Head** (`{ type: "head" }`) — The agent writes directly to the host working directory. No worktree, no branch indirection. This is the default for bind-mount providers like `docker()`.
- **Merge-to-head** (`{ type: "merge-to-head" }`) — Sandcastle creates a temporary branch in a git worktree. The agent works on the temp branch, and changes are merged back to HEAD when done. The temp branch is cleaned up after merge.
- **Branch** (`{ type: "branch", branch: "foo" }`) — Commits land on an explicitly named branch in a git worktree. Re-running with the same branch reuses the existing worktree and fast-forwards it from `origin` when safe — see [ADR 0003](docs/adr/0003-reuse-worktree-by-default.md).

For bind-mount providers (like Docker), the worktree directory is bind-mounted into the container — the agent writes directly to the host filesystem through the mount, so no sync is needed.

From your point of view, you just configure `branchStrategy: { type: 'branch', branch: 'foo' }` on `run()`, and get a commit on branch `foo` once it's complete. All 100% local.

## Prompts

Sandcastle uses a flexible prompt system. You write the prompt, and the engine executes it — no opinions about workflow, task management, or context sources are imposed.

### Prompt resolution

You must provide exactly one of:

1. `prompt: "inline string"` — pass an inline prompt directly via `RunOptions`
2. `promptFile: "./path/to/prompt.md"` — point to a specific file via `RunOptions`

`prompt` and `promptFile` are mutually exclusive — providing both is an error. If neither is provided, `run()` throws an error asking you to supply one.

**Inline prompts (`prompt: "..."`) are passed to the agent literally.** No `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. If you need values interpolated into an inline prompt, build the string in JavaScript (`` `Work on ${branch}…` ``). Passing `promptArgs` alongside an inline prompt is an error — switch to `promptFile` to use substitution.

The substitution and expansion features below apply **only** to prompts sourced from `promptFile`.

> **Convention**: `sandcastle init` scaffolds `.sandcastle/prompt.md` and all templates explicitly reference it via `promptFile: ".sandcastle/prompt.md"`. This is a convention, not an automatic fallback — Sandcastle does not read `.sandcastle/prompt.md` unless you pass it as `promptFile`.

### Dynamic context with `` !`command` ``

Use `` !`command` `` expressions in your prompt to pull in dynamic context. Each expression is replaced with the command's stdout before the prompt is sent to the agent. All expressions in a prompt run **in parallel** for faster expansion.

Commands run **inside the sandbox** after `sandbox.onSandboxReady` hooks complete, so they see the same repo state the agent sees (including installed dependencies).

```markdown
# Open issues

!`gh issue list --state open --label Sandcastle --json number,title,body,comments,labels --limit 100`

# Recent commits

!`git log --oneline -10`
```

If any command exits with a non-zero code, the run fails immediately with an error.

### Prompt arguments with `{{KEY}}`

Use `{{KEY}}` placeholders in your prompt to inject values from the `promptArgs` option. This is useful for reusing the same prompt file across multiple runs with different parameters.

```typescript
import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: "./my-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42, PRIORITY: "high" },
});
```

In the prompt file:

```markdown
Work on issue #{{ISSUE_NUMBER}} (priority: {{PRIORITY}}).
```

Prompt argument substitution runs on the host before shell expression expansion, so `{{KEY}}` placeholders inside `` !`command` `` expressions are replaced first:

```markdown
!`gh issue view {{ISSUE_NUMBER}} --json body -q .body`
```

A `{{KEY}}` placeholder with no matching prompt argument is an error. Unused prompt arguments produce a warning.

`` !`command` `` expansion only runs on shell blocks written in the prompt file itself. Any `` !`…` `` pattern that appears inside an argument value is treated as inert text — it won't be executed against the host shell. This makes it safe to pass user-authored content (issue titles, PR descriptions, docs excerpts) through `promptArgs`. The same applies inside `<!-- -->` HTML comments: example expressions documented there are never executed.

### Built-in prompt arguments

Sandcastle automatically injects two built-in prompt arguments into every prompt:

| Placeholder         | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `{{SOURCE_BRANCH}}` | The branch the agent works on (determined by the branch strategy) |
| `{{TARGET_BRANCH}}` | The host's active branch at `run()` time                          |

Use them in your prompt without passing them via `promptArgs`:

```markdown
You are working on {{SOURCE_BRANCH}}. When diffing, compare against {{TARGET_BRANCH}}.
```

Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` is an error — built-in prompt arguments cannot be overridden.

### Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

This is useful for task-based workflows where the agent should stop once it has finished, rather than running all remaining iterations.

You can override the default signal by passing `completionSignal` to `run()`. It accepts a single string or an array of strings:

```ts
await run({
  // ...
  completionSignal: "DONE",
});

// Or pass multiple signals — the loop stops on the first match:
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

Tell the agent to output your chosen string(s) in the prompt, and the orchestrator will stop when it detects any of them. The matched signal is returned as `result.completionSignal`.

#### Hanging processes after the completion signal

The agent process is expected to exit shortly after emitting the completion signal. When a child it spawned — a `gh`/git subprocess, a long-lived MCP server, etc. — inherits the agent's stdout pipe and keeps it open, the parent process can linger long past its logical end. Sandcastle would otherwise wait for the full `idleTimeoutSeconds` and fail with `AgentIdleTimeoutError`, throwing away the commits the agent already made.

Instead, once the completion signal is observed in the output buffer, Sandcastle swaps in a short **completion timeout** (default 60 s). When it expires, the run resolves successfully with a warning that the process was hanging; `result.commits` and `result.completionSignal` are populated as if the process had exited cleanly. The timer resets on every subsequent output line, so trailing data emitted after the signal — token-usage events, terminal `result` events, a structured-output `<tag>` — is still captured.

A clean process exit always wins the race, so healthy runs gain zero added latency. The completion timeout only matters when the process hangs.

Tune the window with `completionTimeoutSeconds`:

```ts
await run({
  // ...
  completionTimeoutSeconds: 30, // shorter grace window
});
```

This is independent of `idleTimeoutSeconds`. They cover different phases: `idleTimeoutSeconds` runs **before** any signal is seen (genuinely stuck agent → fail); `completionTimeoutSeconds` runs **after** the signal is seen (hanging process → succeed with warning). See [ADR 0019](docs/adr/0019-completion-timeout-for-hanging-process.md).

### Structured output

Use `Output.object()` to extract a typed, schema-validated JSON payload from the agent's stdout. The agent emits its answer inside an XML tag you specify, and Sandcastle parses, validates, and returns it on `result.output`. The schema can be any [Standard Schema](https://standardschema.dev) validator — the examples below use [Zod](https://zod.dev), but Valibot, ArkType, and others work identically. See [ADR 0010](docs/adr/0010-structured-output.md) for design rationale.

```ts
import { run, Output, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";
import { z } from "zod";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: `Analyze the code, and output the result as JSON inside <result> tags.
    The result must match this schema:
    { summary: string; score: string }
  `,
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
  }),
});

console.log(result.output.summary); // typed as string
console.log(result.output.score); // typed as number
```

`Output.string({ tag })` extracts the tag contents as a plain string (trimmed, no JSON parsing). Both helpers require `maxIterations` to be `1` (the default). The resolved prompt must contain the configured opening tag literal.

When extraction or validation fails, `run()` throws a `StructuredOutputError`. Alongside `tag`, `rawMatched`, `cause`, `commits`, `branch`, and `preservedWorktreePath`, the error carries the `sessionId` (and `sessionFilePath`, when the session was captured) of the run that produced the bad output.

Pass `maxRetries` to have Sandcastle handle the retry loop for you. Each retry resumes the same agent session and feeds back a token-efficient description of the error, so the agent can re-emit a corrected tag without redoing the work. Retries require an agent provider that supports session resumption (`claudeCode`, `codex`, `pi`, `grok`) — calling `run()` with `maxRetries > 0` against a non-resumable provider (`cursor`, `opencode`, `copilot`, `devin`, `antigravity`) throws immediately.

```ts
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Analyze the code and emit JSON inside <result> tags.",
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
    maxRetries: 2, // 2 retries on top of the initial attempt
  }),
});
```

If you need to drive the retry loop manually — for example, to customise the feedback prompt or rotate models on each attempt — leave `maxRetries` at its default of `0` and resume the failed session yourself:

```ts
import { run, Output, StructuredOutputError } from "@lengoctu70/sandcastle";

try {
  return await run({ ...opts, output });
} catch (e) {
  if (e instanceof StructuredOutputError && e.sessionId) {
    return await run({
      ...opts,
      output,
      resumeSession: e.sessionId,
      prompt: `Your previous output failed: ${e.message}. Re-emit it inside <${e.tag}> tags.`,
    });
  }
  throw e;
}
```

### Templates

`sandcastle init` prompts you to choose a sandbox provider (Host, Docker, or Podman), an issue tracker (GitHub Issues, Beads, or Custom), and a template, which scaffolds a ready-to-use prompt and `main.mts` suited to a specific workflow. If your project's `package.json` has `"type": "module"`, the file will be named `main.ts` instead. Choosing **Custom** scaffolds the project in a deliberately broken-until-configured state plus a `.sandcastle/SETUP_ISSUE_TRACKER.md` prompt you feed to your coding agent, which wires up your own tracker by editing the scaffolded files in place. Five templates are available:

| Template                       | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `blank`                        | Bare scaffold — write your own prompt and orchestration                   |
| `simple-loop`                  | Picks issues one by one in a loop                                         |
| `sequential-reviewer`          | Implements issues one by one, with a code review step after each          |
| `parallel-planner`             | Plans parallelizable issues, executes on separate branches, then merges   |
| `parallel-planner-with-review` | Plans parallelizable issues, executes with per-branch review, then merges |

Who closes an issue depends on the configured tracker: on GitHub Issues the generated prompts never close or comment — `sandcastle run` reports and closes each issue only after its work is verified and landed — while self-managed trackers (Beads, Custom) keep their agent-side close commands. The parallel templates also bound concurrency: at most `parallelism` issues run at once (1–4, set with `sandcastle configure --parallelism`), and `SANDCASTLE_MAX_PARALLEL` overrides that for a single run.

Select a template during `sandcastle init` when prompted, or re-run init in a fresh repo to try a different one. When **Host** is the sandbox provider, `simple-loop` and `sequential-reviewer` scaffold host-native mains instead: `noSandbox()` in a git worktree (explicit `merge-to-head` for `simple-loop`; a shared explicit branch for `sequential-reviewer` so implement and review stay in the same worktree), host `node_modules` reuse via `copyToWorktree`, and no container-only install hooks.

## CLI commands

### `sandcastle init`

Scaffolds the `.sandcastle/` config directory and builds the container image. This is the first command you run in a new repo. You choose a sandbox provider (Host, Docker, or Podman) during init — selecting Podman writes a `Containerfile` instead of `Dockerfile` and uses `sandcastle podman build-image` for the build step. Selecting **Host** runs the agent directly on your machine via `noSandbox()` — it reuses your agent CLI's existing login (no API key to copy), writes no Dockerfile/Containerfile, builds no image, and pins `branchStrategy: { type: "merge-to-head" }` so the agent works in a separate git worktree. In the parallel planner templates every concurrent implementer instead gets its own explicit `{ type: "branch" }` branch and host worktree, with review sharing the implementation's worktree and no container-only setup generated. A worktree is **not** OS isolation — the agent keeps your user privileges, so choose Docker or Podman when you need a real security boundary.

In host mode, init also _discovers_ agents that support it (Codex, Pi, OpenCode, Devin, Claude Code, Cursor, Copilot, Grok, and Antigravity): it verifies the executable on `PATH` is the real CLI — a command name alone is never proof, since e.g. `agent` can resolve to a different product than Cursor — checks you're logged in, and reads the live model catalog so you pick a model and reasoning effort that actually exist — the choice is persisted to `settings.json` and generated into `main.mts`. Pi models are grouped by model provider and pick a thinking level; for OpenCode, models are grouped by provider (`opencode`, `opencode-go`, `openai`, …) and each model's reasoning effort is its catalog variant (`opencode run --variant`); for Devin, thinking levels are model variants in the account catalog (`devin models list --format json`), so the effort picker lists exact `model_uid`s like `claude-opus-5-high` and the chosen uid is passed to `--model` unchanged — no separate effort flag exists; for Grok, the probe tries `grok` first, then the `agent` alias xAI installs under the same binary (identity always comes from observed output, so a Cursor `agent` is never claimed as Grok), and `grok models` doubles as the login check and live catalog, with `--reasoning-effort` gating the effort choices (the observed list is advisory — an unlisted value is accepted as unverified rather than rejected, because the CLI never enumerates its valid set); for Antigravity, `agy models` doubles as the sign-in check and live catalog, and the reasoning effort is encoded in the model slug (`gemini-3.8-flash-high` → `--effort high`). Agents whose CLI has no catalog command (Claude Code, Copilot) still get identity and login verification, then keep the `--model` flag or the agent's default model marked as unverified rather than pretending it was checked. Without `--agent`, init probes every registered adapter at once and lists the verified-ready agents first — each hint shows the installed version and live model count — while unavailable agents sit behind an "other agents" choice that shows whether each is missing, not logged in, the wrong executable, or hit a discovery error, along with what to do about it and a recheck option. If the agent you want can't be verified, init offers a retry, an explicit manual entry (persisted as unverified, never presented as discovered), or a safe stop — all before anything is scaffolded. The non-interactive equivalent is `--allow-unverified`: with it, a `--model`/`--effort` pair that couldn't be verified against the live catalog is accepted and marked `manual-unverified`; without it those runs exit non-zero with the same guidance.

Init detects your host package manager (npm, pnpm, yarn, or bun) from a `packageManager` field or lockfile, defaulting to npm. Templates whose `main` file imports a host dependency — the planner templates import [Zod](https://zod.dev) for their `<plan>` output schema — prompt you to install it with that package manager when it isn't already in your `package.json`, so the first `npx tsx .sandcastle/main.ts` doesn't fail with `ERR_MODULE_NOT_FOUND`.

Init also detects candidate verification commands — `package.json` scripts (`typecheck`, `lint`, `test`, `build`, in run order via the detected package manager) plus non-npm markers such as `Cargo.toml`, `go.mod`, Python test configs, and a `Makefile` `test:` target — and lets you confirm, edit, or explicitly skip them. The result is persisted to `settings.json` as `verificationCommands` with an honest `verificationStatus` (`skipped` when declined, `unavailable` when nothing could be detected — a skipped setup is never reported as passed). In non-interactive runs, pass `--verification-commands` with a comma-separated list or `--skip-verification`; without a flag, headless init adopts whatever was detected.

For the GitHub Issues tracker, init first verifies the working directory is a usable Git repository with a resolvable HEAD — a non-git directory or an unborn repository fails with repository guidance before any `gh` call. It then verifies the `gh` CLI is installed and authenticated (`gh auth status`) before anything is scaffolded — interactive runs offer a recheck after `gh auth login`, headless runs fail with guidance. Creating the `Sandcastle` label on the repository only happens after explicit confirmation (`--create-label true`), and permission failures are reported with gh's own error line.

Finally, init inserts `"sandcastle": "sandcastle run"` into your `package.json` scripts (creating a minimal `package.json` when none exists) so the normal launch is `npm run sandcastle`. Unrelated scripts are preserved, and an existing `sandcastle` script with different content is never silently overwritten — interactive init asks first, while non-interactive init fails unless `--overwrite-script true|false` decides.

Every interactive prompt has a paired `--flag` so the entire init can run non-interactively (e.g. in CI or a scripted setup). When stdin is not a TTY and a required flag is missing, init fails fast with a clear error rather than wedging on a prompt.

| Option                    | Required | Default                      | Description                                                                                                                                                                              |
| ------------------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--image-name`            | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                                                                                                                        |
| `--agent`                 | No       | Interactive prompt           | Agent to use (`claude-code`, `pi`, `codex`, `cursor`, `opencode`, `copilot`, `devin`, `grok`, `antigravity`)                                                                             |
| `--model`                 | No       | Agent's default model        | Model to use (e.g. `claude-sonnet-4-6`). Defaults to agent's default                                                                                                                     |
| `--effort`                | No       | Model's default effort       | Reasoning effort (e.g. `low`, `medium`, `high`). With `--sandbox host` and a discoverable agent, validated against the model's live catalog                                              |
| `--allow-unverified`      | No       | `false`                      | With `--sandbox host`: accept a `--model`/`--effort` pair that live discovery could not verify, persisted as `manual-unverified`. Without it, unverifiable selections fail with guidance |
| `--sandbox`               | No       | Interactive prompt           | Sandbox provider to use (`host`, `docker`, `podman`)                                                                                                                                     |
| `--template`              | No       | Interactive prompt           | Template to scaffold (e.g. `blank`, `simple-loop`)                                                                                                                                       |
| `--issue-tracker`         | No       | Interactive prompt           | Issue tracker to use (`github-issues`, `beads`, `custom`)                                                                                                                                |
| `--create-label`          | No       | Interactive prompt           | `true` / `false` — whether to create the `Sandcastle` GitHub label (only with `--issue-tracker github-issues`; requires an installed, authenticated `gh`)                                |
| `--build-image`           | No       | Interactive prompt           | `true` / `false` — whether to build the sandbox image now (silently ignored with `--issue-tracker custom`)                                                                               |
| `--install-template-deps` | No       | Interactive prompt           | `true` / `false` — whether to install template host deps (e.g. `zod` for the planner templates)                                                                                          |
| `--verification-commands` | No       | Detected candidates          | Comma-separated verification commands to persist (e.g. `"npm run typecheck,npm test"`); overrides detection. Cannot be combined with `--skip-verification`                               |
| `--skip-verification`     | No       | `false`                      | Skip verification-command setup — `settings.json` records `verificationStatus: "skipped"`                                                                                                |
| `--overwrite-script`      | No       | Interactive prompt           | `true` / `false` — resolve a conflicting existing `"sandcastle"` package script: overwrite with `"sandcastle run"` or keep it. Required when a conflict is hit non-interactively         |

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (customize as needed)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/, worktrees/, recovery/
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

### `sandcastle configure`

Updates durable project settings in `.sandcastle/settings.json` without re-scaffolding — the command loads the file, displays the current values, and writes only `settings.json` through the same update path init uses, so generated prompts, `main.mts`/`main.ts`, `CODING_STANDARDS.md`, `package.json`, and your other customizations stay byte-for-byte intact. A cancelled or failed run leaves the prior settings in place: nothing is written until every choice resolves.

With no flags on an interactive terminal, a section menu walks through shared agent/model/effort, verification commands, parallelism, and per-role overrides before you confirm the save. Every section also has flags so the whole update can run non-interactively; a bare `configure` on a non-TTY just prints the current settings.

On a `host` sandbox, changing the shared agent/model/effort reuses init's live discovery — switching agents re-probes the executable for its real model catalog, and `--model`/`--effort` are validated against it (`modelSource: "discovered"`). Docker and Podman projects keep the static registry instead, since probing host CLIs says nothing about what the image installs; values there persist as `manual-unverified`.

Per-role overrides (`planner`, `implementer`, `reviewer`, `merger`) let one role diverge from the shared agent/model/effort — e.g. a cheaper model for the planner. Clearing an override restores inheritance from the shared defaults.

| Option                    | Required | Default         | Description                                                                                                                                                                                 |
| ------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent`                 | No       | Current setting | Change the shared agent. On a host sandbox its live discovery re-resolves model and effort                                                                                                  |
| `--model`                 | No       | Current setting | Change the shared model. On a host sandbox it is validated against the agent's live catalog                                                                                                 |
| `--effort`                | No       | Current setting | Change the shared reasoning effort (e.g. `low`, `medium`, `high`). Cannot be combined with `--clear-effort`                                                                                 |
| `--clear-effort`          | No       | `false`         | Remove the configured shared effort                                                                                                                                                         |
| `--allow-unverified`      | No       | `false`         | Host sandbox: accept `--model`/`--effort` without live-catalog verification (persisted as `manual-unverified`). Without it, discovery failures exit non-zero                                |
| `--verification-commands` | No       | Current list    | Replace the ordered verification commands (comma-separated, e.g. `"npm run typecheck,npm test"`); clears `verificationStatus`. Cannot be combined with `--skip-verification`                |
| `--skip-verification`     | No       | `false`         | Clear the verification commands and record `verificationStatus: "skipped"`                                                                                                                  |
| `--parallelism`           | No       | Current setting | Bounded parallelism for parallel workflows (integer `1`–`4`)                                                                                                                                |
| `--set-role`              | No       | —               | Per-role override entry `"role.field=value"` (role: `planner`/`implementer`/`reviewer`/`merger`; field: `agent`/`model`/`effort`). Repeatable, e.g. `--set-role planner.model=gpt-5.4-mini` |
| `--clear-role`            | No       | —               | Remove a role's override so it inherits the shared defaults (`planner`/`implementer`/`reviewer`/`merger`). Repeatable                                                                       |

Fails with a clear error when `settings.json` is missing or malformed — run `sandcastle init` first.

### `sandcastle run`

Runs the full issue workflow for one or all eligible GitHub Issues — the normal entry point after `init` (usually via `npm run sandcastle`). It requires a usable Git repository with a resolvable HEAD, the `github-issues` issue tracker, an installed and authenticated `gh` CLI, and the `Sandcastle` label on the repository — all checked up front, before any agent work. When the target branch is your current checkout, uncommitted tracked changes there are also reported up front, since the landing's fast-forward merge would refuse to overwrite them — so agent quota is never spent on work that cannot land.

Interactively, `run` first asks for the scope: **one issue** (you then pick from the open `Sandcastle`-labeled issues), **all eligible issues sequentially**, or **all eligible issues in parallel** bounded by the configured `parallelism`. Non-interactively (CI, scripts), `--issue <number>` selects one issue deterministically and `--all` queues every open `Sandcastle`-labeled issue; without a TTY and without either flag it fails fast. `--all` and `--issue` are mutually exclusive.

For `--all`, issues run in ascending issue-number order and each gets the identical single-issue pipeline below — its own `sandcastle/issue-<number>` branch, worktree, integration worktree, verification, landing, report, and (on failure) recovery record. Sequential is the default (`parallelism` 1); parallel mode caps how many issues are in flight at once — the bound comes from `--parallelism` when given, otherwise the `parallelism` in `settings.json` (integer 1–4, set it with `sandcastle configure --parallelism`). There is no unbounded option. A failing issue never aborts the others: in-flight issues finish, the queue continues, and the run ends with a Vietnamese summary listing which issues landed and which failed (failed issues stay open with their recovery state). Integration and landing are serialized across concurrent issues, so parallel runs can never race the target branch.

For the selected issue, Sandcastle then owns the whole sequence (ADR 0023/0024): the configured agent implements it on a dedicated `sandcastle/issue-<number>` branch in its own worktree — the agent never sees issue-closing instructions — the configured verification commands run in that worktree through the configured execution environment — `sandbox: "host"` executes them on the host worktree, while `docker`/`podman` start a sandbox bound to that worktree and exec inside it — the result is merged in a separate integration worktree based on the target branch's current tip, verification runs again on the integrated tree through the same environment, and the target branch is updated only after integrated verification passes and a freshness check confirms the target hasn't moved (fast-forward when it's your current checkout, atomic compare-and-swap otherwise — never a force-update).

The persisted `workflow` in `settings.json` decides which optional phases wrap that pipeline: `parallel-planner` adds a read-only planning pass whose plan text is injected into the implementation prompt, `sequential-reviewer` adds a review pass over the committed branch diff that may commit corrections, and `parallel-planner-with-review` runs both; `simple-loop` and `blank` run the base pipeline, and an unrecognized workflow id falls back to it with a warning. Each workflow role — `planner`, `implementer`, `reviewer`, and `merger` (merge-conflict repair) — resolves its own agent/model/effort by layering `roleOverrides` over the shared settings (configure them with `sandcastle configure --set-role`/`--clear-role`), and a persisted `agentExecutable` (e.g. a Grok binary discovered under its `agent` alias) is reused only by the shared agent it was probed for — it never follows a role override onto a different provider. Planning and review are also recovery phases: a run that stops in either records it, and `sandcastle retry` re-enters at the right stage while planner/reviewer sessions never displace the implementer session that retries resume.

Deterministic failures get bounded automatic repair instead of an immediate stop (ADR 0024): a failed source-stage verification sends the exact failed command and its output back to the agent in the same worktree — resuming the same agent session when the provider supports native resume (Claude Code, Codex, Pi, Grok), otherwise a fresh invocation against the preserved worktree with the task and failure inlined — for at most two repairs, each re-running all verification commands. A merge conflict triggers at most one repair inside the integration worktree itself (the agent resolves the conflicted files and commits the merge there), after which all verification commands re-run on the integrated tree before landing. A failure that appears only in the integrated tree triggers the same bounded repair pattern inside the integration worktree — the merger-role agent repairs the already-merged state with the integrated failure's command and output, at most two attempts — and each committed repair is folded back onto the source branch so it survives the disposable worktree, a target-drift rebuild, and a later `retry`. If the target branch moved while integrating, Sandcastle discards the integration state and rebuilds it on the new tip at most once — it never force-updates a moved branch.

When a repair budget is exhausted (or the failure isn't repairable), the run stops safely: it posts a Vietnamese failure report naming the phase and the attempts spent, keeps the issue open, preserves the source branch and worktree, and writes a machine-local recovery record to `.sandcastle/recovery/issue-<number>.json` (ignored by git) carrying the issue identity, branches, target base SHA, failure phase, attempt counters, verification results, and agent session id. The record survives process exit — `sandcastle status` lists it, `sandcastle retry <issue-number>` continues the preserved work, and `sandcastle discard <issue-number>` removes it after confirmation.

Only after landing does Sandcastle post a Vietnamese completion report (outcome, landed commits and change summary, executed verification, cautions — including how many repairs were needed) and then close the issue. On any pre-landing failure it posts a Vietnamese failure report instead, keeps the issue open, preserves the source branch and worktree under `.sandcastle/` for recovery, and never leaves your active checkout conflicted.

| Option          | Required | Default                        | Description                                                                      |
| --------------- | -------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `--issue`       | No       | Interactive run-scope picker   | GitHub issue number to implement — mutually exclusive with `--all`               |
| `--all`         | No       | `false`                        | Run every open `Sandcastle`-labeled issue (ascending issue-number order)         |
| `--parallelism` | No       | Configured `parallelism` (1–4) | Cap on how many `--all` issues run at once — `1` is sequential; requires `--all` |

### `sandcastle status`

Lists every preserved failed task — one entry per recovery record under `.sandcastle/recovery/`. Each entry shows the issue, the phase it stopped in, when it failed, how often it was retried, the preserved source branch and worktree (including whether they still exist), the bounded-repair attempts already spent, and the first line of the recorded error. Stale signals are marked explicitly — a missing source branch, a branch with no unmerged commits (possibly landed elsewhere), or a worktree that is gone (a `retry` rebuilds it from the branch). A record Sandcastle cannot parse is reported as corrupt — it is never silently dropped. With nothing preserved, `status` reports there are no failed tasks.

### `sandcastle retry <issue-number>`

Continues one preserved failed task. The recovery record pins the task: `retry` never re-selects an issue, never creates a new implementation branch, and never starts the work over. It re-enters the workflow at the recorded failure phase — re-running verification (with a fresh bounded repair budget), or going straight to the integration/landing sequence when the failure happened there — inside the preserved worktree and on the preserved source branch. When the record carries an agent session id and the provider supports session storage, the next agent invocation resumes that session across the process restart; otherwise a fresh invocation against the preserved code carries the issue identity and failure context.

A successful `retry` runs the normal safe path: verification, integration, freshness-checked landing, the Vietnamese completion report, issue closure, and cleanup of the recovery record, worktree, and branch. A `retry` that fails again rewrites the record with the new failure phase and an incremented retry count. Stale records are diagnosed in Vietnamese instead of being silently used — the issue now closed (work may have landed elsewhere), the target branch gone, or no committed work left to continue — and point at `sandcastle discard` for cleanup.

### `sandcastle discard <issue-number>`

Permanently deletes one preserved failed task: the preserved worktree, the source branch, and the recovery record. It first lists exactly what will be removed. Interactive runs ask for confirmation first; a declined confirmation leaves everything untouched. Non-interactive runs (no TTY) require `--yes`, so scripts can never delete preserved work accidentally. The record is deleted last — if removing a worktree or branch fails, the record survives so the task stays visible in `status`. Missing or corrupt records produce a Vietnamese diagnosis and nothing is removed.

| Option  | Required | Default             | Description                                            |
| ------- | -------- | ------------------- | ------------------------------------------------------ |
| `--yes` | No       | Interactive confirm | Confirm the discard — required when stdin is not a TTY |

### `sandcastle docker build-image`

Rebuilds the Docker image from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile. On Linux/macOS, the build automatically passes `--build-arg AGENT_UID=$(id -u)` and `AGENT_GID=$(id -g)` so the image's `agent` user matches the host UID — this prevents permission errors on image-built files without runtime chown.

| Option         | Required | Default                      | Description                                                                       |
| -------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name                                                                 |
| `--dockerfile` | No       | —                            | Path to a custom Dockerfile (build context will be the current working directory) |

### `sandcastle docker remove-image`

Removes the Docker image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Docker image name |

### `sandcastle podman build-image`

Builds the Podman image from an existing `.sandcastle/` directory. Use this after modifying the Containerfile.

| Option            | Required | Default                      | Description                                                                          |
| ----------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `--image-name`    | No       | `sandcastle:<repo-dir-name>` | Podman image name                                                                    |
| `--containerfile` | No       | —                            | Path to a custom Containerfile (build context will be the current working directory) |

### `sandcastle podman remove-image`

Removes the Podman image.

| Option         | Required | Default                      | Description       |
| -------------- | -------- | ---------------------------- | ----------------- |
| `--image-name` | No       | `sandcastle:<repo-dir-name>` | Podman image name |

### `RunOptions`

| Option                     | Type               | Default                       | Description                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                    | AgentProvider      | —                             | **Required.** Agent provider (e.g. `claudeCode("claude-opus-4-8")`, `pi("claude-sonnet-4-6")`, `codex("gpt-5.4")`, `cursor("composer-2")`, `opencode("opencode/big-pickle")`, `copilot("claude-sonnet-4.5")`, `devin("claude-opus-5")`, `grok("grok-4.6")`, `antigravity("gemini-3.8-flash-high")`) |
| `sandbox`                  | SandboxProvider    | —                             | **Required.** Sandbox provider (e.g. `docker()`, `podman()`, `docker({ imageName: "sandcastle:local" })`)                                                                                                                                                                                           |
| `cwd`                      | string             | `process.cwd()`               | Host repo directory — anchor for `.sandcastle/` artifacts and git operations. Relative paths resolve against `process.cwd()`.                                                                                                                                                                       |
| `prompt`                   | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                                                                                                                                                                                |
| `promptFile`               | string             | —                             | Path to prompt file (mutually exclusive with `prompt`). Resolves against `process.cwd()`, **not** `cwd`.                                                                                                                                                                                            |
| `maxIterations`            | number             | `1`                           | Maximum iterations to run                                                                                                                                                                                                                                                                           |
| `hooks`                    | SandboxHooks       | —                             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                                                                                                                                                                                             |
| `name`                     | string             | —                             | Display name for the run, shown as a prefix in log output                                                                                                                                                                                                                                           |
| `promptArgs`               | PromptArgs         | —                             | Key-value map for `{{KEY}}` placeholder substitution                                                                                                                                                                                                                                                |
| `branchStrategy`           | BranchStrategy     | per-provider default          | Branch strategy: `{ type: 'head' }`, `{ type: 'merge-to-head' }`, or `{ type: 'branch', branch: '…' }`                                                                                                                                                                                              |
| `copyToWorktree`           | string[]           | —                             | Host-relative file paths to copy into the sandbox before start (not supported with `branchStrategy: { type: 'head' }`)                                                                                                                                                                              |
| `logging`                  | object             | file (auto-generated)         | `{ type: 'file', path }` or `{ type: 'stdout' }`                                                                                                                                                                                                                                                    |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | String or array of strings the agent emits to stop the iteration loop early                                                                                                                                                                                                                         |
| `idleTimeoutSeconds`       | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                                                                                                                                                                                         |
| `completionTimeoutSeconds` | number             | `60`                          | Grace window in seconds after the completion signal is observed but the agent process has not exited (hanging process). See [Hanging processes after the completion signal](#hanging-processes-after-the-completion-signal).                                                                        |
| `resumeSession`            | string             | —                             | Resume a prior session by ID for agents that support resume. Incompatible with `maxIterations > 1`. Session file must exist on host.                                                                                                                                                                |
| `signal`                   | AbortSignal        | —                             | Cancel the run when aborted. Kills the in-flight agent subprocess and cancels lifecycle hooks; the worktree is preserved on disk. Rejects with `signal.reason`.                                                                                                                                     |
| `timeouts`                 | Timeouts           | —                             | Override default timeouts for built-in lifecycle steps: `copyToWorktreeMs` (60 000), `gitSetupMs` (10 000), `commitCollectionMs` (30 000), `mergeToHostMs` (30 000).                                                                                                                                |
| `output`                   | OutputDefinition   | —                             | Structured output definition (`Output.object(…)` or `Output.string(…)`). Requires `maxIterations === 1`. See [Structured output](#structured-output).                                                                                                                                               |

### `RunResult`

| Field              | Type                | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)                |
| `completionSignal` | string?             | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string              | Agent output                                                       |
| `commits`          | `{ sha }[]`         | Commits created during the run                                     |
| `branch`           | string              | Target branch name                                                 |
| `logFilePath`      | string?             | Path to the log file (only when logging to a file)                 |
| `output`           | T?                  | Typed structured output (only present when `output` option is set) |

### `IterationResult`

| Field             | Type              | Description                                                                                                                         |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | string?           | Agent session ID from the provider stream, or `undefined` if the provider does not emit one                                         |
| `sessionFilePath` | string?           | Absolute host path to the captured session JSONL, or `undefined` when capture is off                                                |
| `usage`           | `IterationUsage`? | Token usage snapshot from the last assistant message, or `undefined` when capture is off or provider does not support usage parsing |

### `IterationUsage`

| Field                      | Type   | Description                                |
| -------------------------- | ------ | ------------------------------------------ |
| `inputTokens`              | number | Input tokens consumed                      |
| `cacheCreationInputTokens` | number | Tokens used to create prompt cache entries |
| `cacheReadInputTokens`     | number | Tokens read from prompt cache              |
| `outputTokens`             | number | Output tokens generated                    |

### Session capture

After each resumable provider iteration, Sandcastle automatically captures the agent's session file from the sandbox to the host. Claude Code sessions are stored under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`; Codex sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`; Pi sessions are stored under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`; Grok sessions are directory trees under `~/.grok/sessions/<percent-encoded-cwd>/<session-id>/` (the whole tree is captured, lock files excluded). Any provider-specific `cwd` fields are rewritten to match the host repo root, so the provider's native resume command works.

For Claude Code, any `Agent`-tool or `Workflow`-tool subagent transcripts written under `<session-id>/subagents/agent-*.jsonl` are captured alongside the main session. Subagent capture is best-effort: a failure on an individual transcript logs a warning and lets siblings and the main session through. Main-session capture failure still fails the run (see below).

Session capture is enabled by default for `claudeCode()`, `codex()`, `pi()`, and `grok()` and can be opted out via `captureSessions: false`. Providers without `sessionStorage` do not attempt capture. Capture failure fails the run.

### Session resume

Pass `resumeSession` to `run()` to continue a prior Claude Code, Codex, Pi, or Grok conversation inside a new sandbox:

```typescript
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Continue where you left off",
  resumeSession: "abc-123-def",
});
```

You can also continue the last captured session from a result:

```typescript
const first = await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(),
  prompt: "Draft a plan",
});

const second = await first.resume?.("Now implement the plan");
```

`resume` is present only on results from resumable providers (Claude Code, Codex, Pi, Grok) — hence the optional-chaining call.

Before the sandbox starts, Sandcastle validates that the session file exists on the host and transfers it into the sandbox with `cwd` fields rewritten to match the sandbox-side path. Claude Code receives `--resume <id>`; Codex receives `codex exec resume <id>` with the prompt piped over stdin; Pi receives `--session <id>`; Grok receives `--resume <id>` and its session directory tree is transferred (Grok stores sessions as directories under `~/.grok/sessions/`, not single JSONL files).

Constraints:

- `resumeSession` is incompatible with `maxIterations > 1` (throws before sandbox creation).
- The provider's host session file must exist (throws before sandbox creation).
- Only iteration 1 receives the resume flag; subsequent iterations (if any) start fresh.
- Providers without resume support reject `resumeSession`.

### Session fork

`RunResult.fork(prompt, options?)` is the sibling of `.resume()`: it continues from the last captured session but leaves the parent session JSONL untouched and writes the child under a new session id. The mechanism is the agent's native fork flag — `claude --resume <id> --fork-session` for Claude Code, `codex exec fork <id>` for Codex.

Fork enables fan-out workflows where a single parent run is the starting point for several independent children:

```typescript
const parent = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Read the codebase and summarise the data model",
});

const [reviewA, reviewB] = await Promise.all([
  parent.fork?.("Review the migration plan", {
    branchStrategy: { type: "branch", branch: "review-a" },
  }),
  parent.fork?.("Audit the auth layer", {
    branchStrategy: { type: "branch", branch: "review-b" },
  }),
]);
```

**Fork is session-only.** `--fork-session` and `codex exec fork` isolate the agent session JSONL — they do **not** isolate the branch, worktree, or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires the caller to give each child a distinct `branch` via `branchStrategy: { type: "branch", branch: "..." }`. The default `head` and `merge-to-head` strategies are **not** safe for concurrent forks: `head` shares the host working directory across all children, and `merge-to-head` races `git merge` against the same HEAD. See [ADR 0018](docs/adr/0018-fork-is-session-only.md).

`fork` is present only on results from providers with `sessionStorage` (Claude Code, Codex, Grok) — hence the optional-chaining call. The same single-iteration and session-file constraints as `.resume()` apply.

### `ClaudeCodeOptions`

The `claudeCode()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: claudeCode("claude-opus-4-8", { effort: "high" });
```

| Option            | Type                                                                                           | Default | Description                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                      | —       | Claude Code reasoning effort level (`max` is Opus only)                                                                                                                                             |
| `env`             | `Record<string, string>`                                                                       | `{}`    | Environment variables injected by this agent provider                                                                                                                                               |
| `captureSessions` | `boolean`                                                                                      | `true`  | Capture agent session JSONL to host for `claude --resume`                                                                                                                                           |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` | —       | Maps to Claude's `--permission-mode` flag. When set, replaces Sandcastle's default `--dangerously-skip-permissions` on AFK runs. Use `"auto"` for AI-mediated per-tool approve/deny without bypass. |

### `CodexOptions`

The `codex()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: codex("gpt-5.4", { effort: "high" });
```

| Option              | Type                        | Default | Description                                                                                                                                                                                                           |
| ------------------- | --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`            | `string`                    | —       | Codex reasoning effort via `model_reasoning_effort`. Free-form because valid values are model-dependent and read live from Codex's catalog at `init` (observed: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`)     |
| `env`               | `Record<string, string>`    | `{}`    | Environment variables injected by this agent provider                                                                                                                                                                 |
| `captureSessions`   | `boolean`                   | `true`  | Capture Codex rollout JSONL to host for resume                                                                                                                                                                        |
| `approvalsReviewer` | `"user"` \| `"auto_review"` | —       | Maps to Codex's `approvals_reviewer` config. When `"auto_review"`, swaps `--dangerously-bypass-approvals-and-sandbox` for `-a on-request -s danger-full-access` so the reviewer agent evaluates each approval prompt. |

### `PiOptions`

The `pi()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: pi("claude-sonnet-4-6", { thinking: "high" });
```

| Option            | Type                                                                                | Default | Description                                              |
| ----------------- | ----------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| `thinking`        | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | —       | Pi reasoning effort level via the `--thinking` flag      |
| `env`             | `Record<string, string>`                                                            | `{}`    | Environment variables injected by this agent provider    |
| `captureSessions` | `boolean`                                                                           | `true`  | Capture pi session JSONL to host for `pi --session <id>` |

### `DevinOptions`

The `devin()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: devin("claude-opus-5", { variant: "claude-opus-5-high" });
```

| Option           | Type                                                       | Default | Description                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variant`        | `string`                                                   | —       | Exact Devin variant `model_uid` (e.g. `"claude-opus-5-high"`, `"MODEL_GPT_5_2_XHIGH"`). Devin encodes thinking level in the model identifier — when set, this replaces the family/alias as the `--model` value. |
| `permissionMode` | `"auto"` \| `"accept-edits"` \| `"smart"` \| `"dangerous"` | —       | Maps to Devin's `--permission-mode` flag. When set, replaces the `--permission-mode dangerous` Sandcastle passes on AFK runs.                                                                                   |
| `env`            | `Record<string, string>`                                   | `{}`    | Environment variables injected by this agent provider                                                                                                                                                           |

Devin runs non-interactively via `devin -p` (plain-text output, no JSON stream) and keeps sessions in a SQLite store, so it is non-resumable like `cursor`/`opencode`/`copilot`.

### `GrokOptions`

The `grok()` factory accepts an optional second argument for provider-specific options:

```typescript
agent: grok("grok-4.6", { effort: "high" });
```

| Option            | Type                                                                                           | Default  | Description                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`          | `string`                                                                                       | —        | Grok reasoning effort via `--reasoning-effort`. Free-form because the CLI does not enumerate values; `init` surfaces the discovered set (`low`, `medium`, `high`, `xhigh` on 1.0.30)                                                                                   |
| `env`             | `Record<string, string>`                                                                       | `{}`     | Environment variables injected by this agent provider                                                                                                                                                                                                                  |
| `captureSessions` | `boolean`                                                                                      | `true`   | Capture the Grok session directory tree to host for `grok --resume <id>`                                                                                                                                                                                               |
| `executable`      | `string`                                                                                       | `"grok"` | Grok executable name — xAI also ships the same binary as `agent`; set this when only that entrypoint is on PATH                                                                                                                                                        |
| `execPlatform`    | `string`                                                                                       | host     | Platform of the shell that will run the print command. `"win32"` delivers the prompt via a real temp file (cmd.exe has no `/dev/stdin`); any other value keeps POSIX stdin delivery — pass e.g. `"linux"` when the provider runs inside a container on a Windows host. |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` \| `"plan"` | —        | Maps to Grok's `--permission-mode` flag. When set, replaces Sandcastle's default `--always-approve` on AFK runs. Use `"auto"` for AI-mediated per-tool approve/deny on unsandboxed runs.                                                                               |

### `AntigravityOptions`

The `antigravity()` factory drives the Google Antigravity CLI (`agy`) in its headless stream-json mode — the prompt travels on stdin as one NDJSON `user` message, so large prompts never hit argv size limits:

```typescript
agent: antigravity("gemini-3.8-flash-high", { effort: "high" });
```

| Option   | Type                     | Default | Description                                                                                                                                                                                                                               |
| -------- | ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort` | `string`                 | —       | Reasoning effort via `--effort` (`low`, `medium`, `high`). Model-dependent: agy encodes effort in the model slug (`gemini-3.8-flash-high` requires `high`); models without a suffix (e.g. `claude-sonnet-4-6`) reject `--effort` entirely |
| `env`    | `Record<string, string>` | `{}`    | Environment variables injected by this agent provider                                                                                                                                                                                     |

Antigravity stores conversations as SQLite databases indexed by a shared `conversation_summaries.db`, so a single session file cannot be transferred host↔sandbox while preserving resume state ([ADR 0016](docs/adr/0016-resume-requires-filesystem-backed-sessions.md)). The provider is therefore **non-resumable** for now (`resumeSession`, `RunResult.resume`, and `RunResult.fork` are unavailable), even though `agy --conversation <id>` works natively on the host. Install `agy` via `curl -fsSL https://antigravity.google/cli/install.sh | bash` and sign in by launching `agy` interactively; in containers, `GEMINI_API_KEY` plus `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` authenticates without OAuth.

### Provider `env`

Both **agent providers** and **sandbox providers** accept an optional `env: Record<string, string>` in their options. These environment variables are merged with the `.sandcastle/.env` resolver output at launch time:

```typescript
await run({
  agent: claudeCode("claude-opus-4-8", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { DOCKER_SPECIFIC_VAR: "value" },
  }),
  prompt: "Fix issue #42",
});
```

**Merge rules:**

- Provider env (agent + sandbox) overrides `.sandcastle/.env` resolver output for shared keys
- Agent provider env and sandbox provider env **must not overlap** — if they share any key, `run()` throws an error
- When `env` is not provided, it defaults to `{}`

Environment variables are also resolved automatically from `.sandcastle/.env` and `process.env` — no need to pass them to the API. The required variables depend on the **agent provider** (see `sandcastle init` output for details).

## Custom Sandbox Providers

Sandcastle ships with built-in providers for Docker, Podman, and Vercel, but you can create your own. A sandbox provider tells Sandcastle how to execute commands in an isolated environment. There are two kinds:

- **Bind-mount** — the sandbox can mount a host directory. Sandcastle creates a worktree on the host and the provider mounts it in. No file sync needed. Use this for Docker, Podman, or any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. a cloud VM). The provider handles syncing code in and out via `copyIn` and `copyFileOut`. Use this when the sandbox cannot access the host filesystem.

### The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function. The handle exposes:

| Method         | Required   | Description                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------------- |
| `exec`         | Both       | Run a command, optionally streaming stdout line-by-line via `options.onLine` |
| `close`        | Both       | Tear down the sandbox                                                        |
| `copyFileIn`   | Bind-mount | Copy a single file from the host into the sandbox                            |
| `copyFileOut`  | Both       | Copy a single file from the sandbox to the host                              |
| `copyIn`       | Isolated   | Copy a file or directory from the host into the sandbox                      |
| `worktreePath` | Both       | Absolute path to the repo directory inside the sandbox                       |

### `ExecResult`

Every `exec` call returns an `ExecResult`:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### Bind-mount provider example

A minimal bind-mount provider that shells out to local processes (no container):

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@lengoctu70/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile as fsCopyFile, mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    create: async (
      options: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath;

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line); // forward each line to Sandcastle
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          await fsMkdir(dirname(sandboxPath), { recursive: true });
          await fsCopyFile(hostPath, sandboxPath);
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await fsMkdir(dirname(hostPath), { recursive: true });
          await fsCopyFile(sandboxPath, hostPath);
        },

        close: async () => {
          // nothing to tear down for a local process
        },
      };
    },
  });
```

### Isolated provider example

A minimal isolated provider using a temp directory:

```typescript
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type ExecResult,
} from "@lengoctu70/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const tempDir = () =>
  createIsolatedSandboxProvider({
    name: "temp-dir",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-"));
      const worktreePath = join(root, "workspace");
      await mkdir(worktreePath, { recursive: true });

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyIn: async (hostPath: string, sandboxPath: string) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
```

### Branch strategies

A branch strategy controls where the agent's commits land. Configure it when constructing the provider:

| Strategy        | Behavior                                                                 | Bind-mount | Isolated  |
| --------------- | ------------------------------------------------------------------------ | ---------- | --------- |
| `head`          | Agent writes directly to the host working directory. No worktree created | Default    | N/A       |
| `merge-to-head` | Sandcastle creates a temp branch, merges back to HEAD when done          | Supported  | Default   |
| `branch`        | Commits land on an explicit named branch you provide                     | Supported  | Supported |

**When to use each:**

- **`head`** — fast iteration during development. No branch indirection, no merge step. Only works with bind-mount providers since the agent needs direct host filesystem access.
- **`merge-to-head`** — safe default for automation. The agent works on a throwaway branch; if something goes wrong, HEAD is untouched. Use this for CI or unattended runs.
- **`branch`** — when you want commits on a specific branch (e.g. for a PR). Pass `{ type: "branch", branch: "agent/fix-42" }`.

Branch strategy is now configured on `run()`, not on the provider:

```typescript
import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

// head — direct write, bind-mount only (default for bind-mount providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "…",
});
// merge-to-head — temp branch, merge back (default for isolated providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: tempDir(),
  prompt: "…",
});
// branch — explicit named branch
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "…",
});
```

### Passing to `run()`

Pass your custom provider via the `sandbox` option — it works the same as the built-in `docker()` provider:

```typescript
import { run, claudeCode } from "@lengoctu70/sandcastle";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: localProcess(), // your custom provider
  prompt: "Fix issue #42 in this repo.",
});
```

### Reference implementations

For real-world examples, see:

- [`src/sandboxes/docker.ts`](src/sandboxes/docker.ts) — bind-mount provider using Docker containers (with SELinux label support)
- [`src/sandboxes/vercel.ts`](src/sandboxes/vercel.ts) — isolated provider using Vercel Firecracker microVMs via `@vercel/sandbox`
- [`src/sandboxes/podman.ts`](src/sandboxes/podman.ts) — bind-mount provider using Podman containers (with SELinux label support)
- [`src/sandboxes/test-isolated.ts`](src/sandboxes/test-isolated.ts) — isolated provider using temp directories (used in tests)

## Configuration

### Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

### Custom Dockerfile

The `.sandcastle/Dockerfile` controls the sandbox environment. The default template installs:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- **Claude Code CLI**
- A non-root `agent` user (required — Claude runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for Claude to run as
- `git` (required for commits and branch operations)
- `gh` (required for issue fetching)
- Claude Code CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

### Hooks

Hooks are grouped by **where** they run — `host` (on the developer's machine) or `sandbox` (inside the container):

```ts
hooks: {
  host: {
    onWorktreeReady: [{ command: "cp .env.example .env" }],
    onSandboxReady:  [{ command: "echo sandbox is up" }],
  },
  sandbox: {
    onSandboxReady: [
      { command: "npm install", timeoutMs: 300_000 },
      { command: "apt-get install -y ffmpeg", sudo: true },
    ],
  },
}
```

| Hook                     | Runs on | When                                         | Working directory                           |
| ------------------------ | ------- | -------------------------------------------- | ------------------------------------------- |
| `host.onWorktreeReady`   | Host    | After `copyToWorktree`, before sandbox start | Worktree path (host repo root under `head`) |
| `host.onSandboxReady`    | Host    | After sandbox is up                          | Worktree path (host repo root under `head`) |
| `sandbox.onSandboxReady` | Sandbox | After sandbox is up                          | Sandbox repo directory                      |

**Ordering:** `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel).

- **Host hooks** accept `{ command: string; timeoutMs?: number }` — no `sudo`, no `cwd`. Use `cd` or inline env in the command string.
- **Sandbox hooks** accept `{ command: string; sudo?: boolean; timeoutMs?: number }` — set `sudo: true` for elevated privileges.
- **`timeoutMs`** overrides the default 60 s per-hook timeout. Useful for long-running setup commands like dependency installs (e.g. `timeoutMs: 300_000` for 5 minutes).
- Within each hook point, sandbox hooks run in parallel; host hooks within `onSandboxReady` also run in parallel with sandbox hooks. `host.onWorktreeReady` hooks run sequentially in declared order.
- If any hook exits non-zero, setup fails fast.
- When a `signal` is passed to `run()`, it is threaded to all hooks — aborting the signal cancels any in-flight hook commands.

## Development

```bash
npm install
npm run build    # Bundle with tsup
npm test         # Run tests with vitest
npm run typecheck # Type-check
```

## License

MIT

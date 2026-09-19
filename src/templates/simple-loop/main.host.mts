import { run, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// Simple loop: an agent that picks open issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — host mode runs the agent directly on this machine,
  // reusing your existing CLI login. No container is started and no API key
  // is needed here.
  sandbox: noSandbox(),

  // The agent provider. Pass a model string to claudeCode() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-8 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: claudeCode("claude-sonnet-4-6"),

  // Path to the prompt file. Shell expressions inside are evaluated in the
  // worktree at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — merge-to-head creates a temporary branch in a separate
  // worktree for the agent to work on, then merges the result back to HEAD
  // when the run completes. Host mode pins this explicitly: the no-sandbox
  // default is `head`, which would let the agent edit your checkout directly.
  branchStrategy: { type: "merge-to-head" },

  // Copy node_modules from the host into the worktree before the agent starts.
  // Host mode reuses your installed dependencies as-is — they are already
  // built for this machine, so no install step runs inside the worktree.
  // If the project needs a setup step per worktree (e.g. a codegen script),
  // add `hooks: { host: { onWorktreeReady: [...] } }` — host hooks run on this
  // machine inside the fresh worktree.
  copyToWorktree: ["node_modules"],
});

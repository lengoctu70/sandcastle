// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open issues, builds a dependency
//                      graph, and outputs a <plan> JSON listing unblocked issues
//                      with their target branch names.
//   Phase 2 (Execute): sonnet agents run with bounded parallelism (see
//                      MAX_PARALLEL below), each working a single issue on
//                      its own branch.
//   Phase 3 (Merge):   A sonnet agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Init added the package.json script "sandcastle": "sandcastle run" — npm run sandcastle

import { readFileSync } from "node:fs";

import * as sandcastle from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// sandcastle:sandbox-setup:start
// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];
// sandcastle:sandbox-setup:end

// Bounded parallelism: at most this many implementer agents run at once.
// `sandcastle init` wrote the project's limit to .sandcastle/settings.json
// (`parallelism`, 1–4) and `sandcastle configure` updates it — re-read it on
// every run so a configured change applies without editing this file. The
// SANDCASTLE_MAX_PARALLEL env var wins over the file; both are clamped to the
// supported 1–4 range, and 2 is the fallback when neither is usable.
const MAX_PARALLEL = (() => {
  const clamp = (n: number): number => Math.min(Math.max(n, 1), 4);
  const env = Number(process.env.SANDCASTLE_MAX_PARALLEL);
  if (Number.isInteger(env) && env > 0) return clamp(env);
  try {
    const settings: unknown = JSON.parse(
      readFileSync(".sandcastle/settings.json", "utf-8"),
    );
    const n =
      typeof settings === "object" && settings !== null
        ? Number((settings as Record<string, unknown>).parallelism)
        : NaN;
    if (Number.isInteger(n) && n > 0) return clamp(n);
  } catch {
    // No readable settings file — fall through to the default.
  }
  return 2;
})();

// Runs `fn` over `items` with at most `limit` invocations in flight — a small
// worker pool standing in for Promise.allSettled(items.map(…)), which would
// start every planned issue at once and exhaust the subscription and the
// machine. Like allSettled, one rejection never cancels the rest and results
// keep input order.
const mapSettled = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    /* sandcastle:sandbox-hooks */ hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute
  //
  // Spawn one sonnet agent per issue, at most MAX_PARALLEL running at once.
  // Each agent works on its own branch so there are no conflicts during
  // execution — merging happens in Phase 3.
  //
  // mapSettled keeps the allSettled contract: one failing agent doesn't
  // cancel the others.
  // -------------------------------------------------------------------------
  const settled = await mapSettled(issues, MAX_PARALLEL, (issue) =>
    sandcastle.run({
      /* sandcastle:sandbox-hooks */ hooks,
      copyToWorktree,
      // Each agent starts on its own branch via branchStrategy on run().
      sandbox: docker(),
      branchStrategy: { type: "branch", branch: issue.branch },
      name: "implementer",
      // Give each agent plenty of room to implement and iterate on tests.
      maxIterations: 100,
      // Sonnet for execution: fast and capable enough for typical issue work.
      agent: sandcastle.claudeCode("claude-sonnet-4-6"),
      promptFile: "./.sandcastle/implement-prompt.md",
      // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
      // and {{BRANCH}} placeholders in implement-prompt.md before the
      // agent sees the prompt.
      promptArgs: {
        TASK_ID: issue.id,
        ISSUE_TITLE: issue.title,
        BRANCH: issue.branch,
      },
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<
          Awaited<ReturnType<typeof sandcastle.run>>
        >;
        issue: (typeof issues)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One sonnet agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still works.
  //
  // The merger — including its conflict resolution — runs in a dedicated
  // integration worktree (`merge-to-head`), never in your active checkout;
  // the integrated result merges back only after it succeeds. `copyToWorktree`
  // reuses the host's node_modules so merge-time tests can run there.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues were worked on.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    /* sandcastle:sandbox-hooks */ hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    copyToWorktree,
    // Merge in a dedicated integration worktree — the active checkout stays
    // untouched until the merged result lands back on this branch.
    branchStrategy: { type: "merge-to-head" },
    // Sonnet is sufficient for merge conflict resolution.
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");

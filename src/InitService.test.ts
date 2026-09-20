import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  getAgent,
  listTemplates,
  listWorkflowOptions,
  listIssueTrackers,
  getIssueTracker,
  getSandboxProvider,
  detectVerificationCandidates,
  ensureSandcastleScript,
  SANDCASTLE_SCRIPT_COMMAND,
} from "./InitService.js";
import type {
  AgentEntry,
  PackageManager,
  ScaffoldOptions,
} from "./InitService.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { substitutePromptArgs } from "./PromptArgumentSubstitution.js";
import { preprocessPrompt, SHELL_BLOCK_MARKER } from "./PromptPreprocessor.js";
import { makeLocalSandbox } from "./testSandbox.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const silentDisplayLayer = () =>
  SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]));

const claudeCodeAgent = getAgent("claude-code")!;
const piAgent = getAgent("pi")!;
const codexAgent = getAgent("codex")!;
const cursorAgent = getAgent("cursor")!;
const opencodeAgent = getAgent("opencode")!;
const copilotAgent = getAgent("copilot")!;
const grokAgent = getAgent("grok")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("uses agent dockerfileTemplate for Dockerfile (with templateArgs substitution)", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    // Template has {{ISSUE_TRACKER_TOOLS}} replaced — should contain GitHub CLI (default issue tracker)
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("GitHub CLI");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  // --- Dynamic .env.example generation ---

  it.each([
    {
      agent: claudeCodeAgent,
      expectedKey: "CLAUDE_CODE_OAUTH_TOKEN=",
      unexpectedKey: "OPENAI_KEY=",
      expectClaudeSetupTokenHint: true,
    },
    {
      agent: piAgent,
      expectedKey: "ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: codexAgent,
      expectedKey: "OPENAI_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: opencodeAgent,
      expectedKey: "OPENCODE_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: cursorAgent,
      expectedKey: "CURSOR_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: grokAgent,
      expectedKey: "XAI_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
  ])(
    "generates .env.example with $agent.name env var",
    async ({
      agent,
      expectedKey,
      unexpectedKey,
      expectClaudeSetupTokenHint,
    }) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain(expectedKey);
      expect(envExample).not.toContain(unexpectedKey);
      expect(envExample).not.toContain("issues/191");
      if (expectClaudeSetupTokenHint) {
        expect(envExample).toContain("claude setup-token");
      } else {
        expect(envExample).not.toContain("claude setup-token");
      }
    },
  );

  it("generates .env.example with GH_TOKEN when issue tracker is github-issues", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      issueTracker: getIssueTracker("github-issues"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("GH_TOKEN=");
    expect(envExample).toContain(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(envExample).toContain("Issues");
    expect(envExample).toContain("Metadata");
  });

  it("generates .env.example without GH_TOKEN when issue tracker is beads", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      issueTracker: getIssueTracker("beads"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).not.toContain("GH_TOKEN=");
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes .env, logs/, worktrees/, and recovery/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    // `recovery/` must be ignored from the first scaffold — the first
    // workflow failure creates it and must not dirty a tracked file.
    expect(gitignore).toContain("recovery/");
    expect(gitignore).not.toContain("patches/");
  });

  it("Dockerfile template contains worktree mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_REPO_DIR);
  });

  it.each([
    claudeCodeAgent,
    piAgent,
    codexAgent,
    cursorAgent,
    opencodeAgent,
    copilotAgent,
  ])(
    "$name Dockerfile aligns UID/GID with -o so a host GID colliding with a reserved base-image GID (e.g. macOS staff=20) doesn't fail the build",
    async (agent) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("groupmod -o -g $AGENT_GID node");
      expect(dockerfile).toContain(
        "usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node",
      );
    },
  );

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and inert comment hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
    // The `!`...`` usage examples only appear inside HTML comments — they
    // are documentation and must never be marked for shell execution.
    const substituted = await Effect.runPromise(
      substitutePromptArgs(prompt, {}).pipe(
        Effect.provide(silentDisplayLayer()),
      ),
    );
    expect(substituted).not.toContain(SHELL_BLOCK_MARKER);
  });

  it("blank template produces skeleton prompt and main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    // `!`...`` examples live inside <!-- --> comments — inert at run time.
    expect(prompt).toContain("<!--");
    const substituted = await Effect.runPromise(
      substitutePromptArgs(prompt, {}).pipe(
        Effect.provide(silentDisplayLayer()),
      ),
    );
    expect(substituted).not.toContain(SHELL_BLOCK_MARKER);
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
  });

  it("blank prompt expands without executing anything in an unborn repository", async () => {
    // makeLocalSandbox runs `sh -c` — POSIX-only.
    if (process.platform === "win32") return;
    const dir = await makeDir();
    // `git init` with no commits: an unborn HEAD. `git log` exits 128 here,
    // so if a comment example were marked as a shell block, expansion would
    // fail the run with PromptError.
    execSync("git init", { cwd: dir, stdio: "ignore" });
    await runScaffold(dir, { templateName: "blank" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const layer = silentDisplayLayer();
    const marked = await Effect.runPromise(
      substitutePromptArgs(prompt, {}).pipe(Effect.provide(layer)),
    );
    const expanded = await Effect.runPromise(
      preprocessPrompt(marked, makeLocalSandbox(dir), dir).pipe(
        Effect.provide(layer),
      ),
    );
    expect(expanded).toBe(prompt);
  });

  it("blank template main.mts imports from @lengoctu70/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@lengoctu70/sandcastle"');
  });

  it("blank template main.mts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    // Should not contain the template's original model
    expect(mainTs).not.toContain('claudeCode("claude-opus-4-8")');
  });

  it("scaffolds main.mts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-opus-4-8")');
  });

  it("injects the selected effort into the generated codex() call", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: "gpt-5.6-sol",
      settings: { effort: "xhigh" },
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.6-sol", { effort: "xhigh" })');
    // And the same effort is persisted to settings.json.
    const settings = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.effort).toBe("xhigh");
  });

  it("leaves the single-argument factory call when no effort is selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.6-sol" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.6-sol")');
    expect(mainTs).not.toContain("effort");
  });

  it("injects the selected effort into the generated grok() call", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: grokAgent,
      model: "grok-4.6",
      settings: { effort: "high" },
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('grok("grok-4.6", { effort: "high" })');
    const settings = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.effort).toBe("high");
  });

  it("injects the selected effort into the generated pi() call as thinking", async () => {
    const dir = await makeDir();
    // Pi's factory option is `thinking` — the persisted effort reaches the
    // CLI as `--thinking` without the user editing generated code.
    await runScaffold(dir, {
      agent: piAgent,
      model: "anthropic/claude-sonnet-4-5",
      settings: { effort: "high" },
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain(
      'pi("anthropic/claude-sonnet-4-5", { thinking: "high" })',
    );
    const settings = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.effort).toBe("high");
  });

  it("injects the selected variant into the generated opencode() call", async () => {
    const dir = await makeDir();
    // OpenCode's reasoning-effort seam is the model variant — the discovered
    // value is emitted as `{ variant: "…" }` so `opencode run --variant`
    // receives it (OpenCodeOptions.variant).
    await runScaffold(dir, {
      agent: opencodeAgent,
      model: "openai/gpt-5.6-sol",
      settings: { effort: "high", modelSource: "discovered" },
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain(
      'opencode("openai/gpt-5.6-sol", { variant: "high" })',
    );
    const settings = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.effort).toBe("high");
    expect(settings.modelSource).toBe("discovered");
  });

  it("does not inject effort into factories that do not accept one", async () => {
    const dir = await makeDir();
    // `cursor` declares no effortOption — an effort override stays in
    // settings.json but must not appear in the generated factory call.
    await runScaffold(dir, {
      agent: cursorAgent,
      model: "composer-2",
      settings: { effort: "high" },
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('cursor("composer-2")');
    expect(mainTs).not.toContain("effort");
  });

  // --- Template-specific tests ---

  it("simple-loop template produces main.mts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.mts imports from @lengoctu70/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@lengoctu70/sandcastle"');
  });

  it("simple-loop main.mts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    // When scaffolded with default model, simple-loop uses claude-opus-4-8
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.mts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @lengoctu70/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@lengoctu70/sandcastle"');
    });

    it("main.mts uses createSandbox so implementer and reviewer share a sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.mts does not use merge-to-head (incompatible with reviewer handoff)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("merge-to-head");
    });

    it("main.mts only reviews when implementer produces commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement.commits.length");
    });

    it("implement-prompt.md contains issue selection and the do-not-close rule, not prompt argument placeholders", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      // GitHub Issues: the agent never closes or comments — Sandcastle does
      // (ADR 0023). No issue-mutating command may reach the prompt.
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("gh issue comment");
      expect(prompt).toContain("do NOT close or comment on the issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).not.toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("implement-prompt.md hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(
        "already been filtered to issues ready for work",
      );
      expect(prompt).toContain("sole source of truth");
      expect(prompt).toContain("Do not run your own unfiltered query");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      // Should have guiding comment, not opinionated defaults
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });

    it("main.mts runs the implementer for a single iteration (one issue per outer pass)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"'),
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 1");
      expect(implementerSection).not.toContain("maxIterations: 100");
    });

    it("main.mts stops the loop when the implementer produces no commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const noCommitIndex = mainTs.indexOf("!implement.commits.length");
      const section = mainTs.slice(noCommitIndex, noCommitIndex + 400);
      expect(section).toContain("break");
      expect(section).not.toContain("continue");
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".sandcastle"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    const ghIssues = getIssueTracker("github-issues")!;
    const customManager = getIssueTracker("custom")!;
    const dockerProvider = getSandboxProvider("docker")!;
    // Non-custom issue tracker keeps the template-driven next steps; the
    // custom branch is exercised separately below.
    const next = (
      template: string,
      mainFilename: string,
      packageManager: PackageManager = "npm",
    ) =>
      getNextStepsLines(
        template,
        mainFilename,
        ghIssues,
        claudeCodeAgent,
        packageManager,
        dockerProvider,
      );

    it("blank template returns steps mentioning .env and main filename (not npx sandcastle run)", () => {
      const lines = next("blank", "main.mts");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("main.mts");
      expect(joined).not.toContain("npx sandcastle run");
    });

    it("non-blank template returns steps mentioning .env, package.json scripts, and npm run sandcastle", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("non-blank template includes a note about customizing the install command", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install");
      expect(joined).toContain("onSandboxReady");
    });

    it("non-blank template mentions copyToWorktree and node_modules", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("copyToWorktree");
      expect(joined).toContain("node_modules");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      // Steps are Vietnamese per ADR 0026.
      expect(joined).toMatch(/customiz|review|read|chỉnh sửa|đọc/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = next("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read|chỉnh sửa|đọc/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = next("parallel-planner", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read|chỉnh sửa|đọc/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = next("blank", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = next("simple-loop", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses main.ts filename when passed", () => {
      const lines = next("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("main.mts");
    });

    it("reviewer template mentions CODING_STANDARDS.md customization", () => {
      const lines = next("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("CODING_STANDARDS.md");
    });

    it("non-reviewer template does not mention CODING_STANDARDS.md", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("blank template does not mention CODING_STANDARDS.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("planner template includes a step to install a schema validator", () => {
      const lines = next("parallel-planner", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install zod");
      expect(joined).toContain("standardschema.dev");
    });

    it("parallel-planner-with-review template includes the schema validator step", () => {
      const lines = next("parallel-planner-with-review", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install zod");
    });

    it("planner zod step uses the detected package manager's add command", () => {
      expect(next("parallel-planner", "main.mts", "pnpm").join("\n")).toContain(
        "pnpm add zod",
      );
      expect(next("parallel-planner", "main.mts", "yarn").join("\n")).toContain(
        "yarn add zod",
      );
      expect(next("parallel-planner", "main.mts", "bun").join("\n")).toContain(
        "bun add zod",
      );
    });

    it("claude-code agent gets a `claude setup-token` hint under the env-vars step", () => {
      const blank = next("blank", "main.mts").join("\n");
      const nonBlank = next("simple-loop", "main.mts").join("\n");
      expect(blank).toContain("claude setup-token");
      expect(blank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(nonBlank).toContain("claude setup-token");
      expect(nonBlank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("non-claude-code agents do not get the `claude setup-token` hint", () => {
      const piLines = getNextStepsLines(
        "simple-loop",
        "main.mts",
        ghIssues,
        piAgent,
        "npm",
        dockerProvider,
      ).join("\n");
      const codexLines = getNextStepsLines(
        "blank",
        "main.mts",
        ghIssues,
        codexAgent,
        "npm",
        dockerProvider,
      ).join("\n");
      expect(piLines).not.toContain("claude setup-token");
      expect(piLines).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(codexLines).not.toContain("claude setup-token");
      expect(codexLines).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("next steps no longer link to the closed issues/191 workaround", () => {
      const blank = next("blank", "main.mts").join("\n");
      const nonBlank = next("simple-loop", "main.mts").join("\n");
      expect(blank).not.toContain("issues/191");
      expect(nonBlank).not.toContain("issues/191");
    });

    it("non-planner template does not mention installing zod", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("zod");
    });

    it("custom issue tracker points at the setup doc and the agent's setup command, regardless of template", () => {
      const lines = getNextStepsLines(
        "simple-loop",
        "main.mts",
        customManager,
        claudeCodeAgent,
        "npm",
        dockerProvider,
      );
      const joined = lines.join("\n");
      expect(joined).toContain("SETUP_ISSUE_TRACKER.md");
      expect(joined).toContain(claudeCodeAgent.setupCommand);
      // The template-driven steps must not leak into the custom branch.
      expect(joined).not.toContain("npm run sandcastle");
    });

    it("custom issue tracker warns the setup command runs on the host", () => {
      const lines = getNextStepsLines(
        "blank",
        "main.mts",
        customManager,
        getAgent("opencode")!,
        "npm",
        dockerProvider,
      );
      const joined = lines.join("\n");
      expect(joined.toLowerCase()).toContain("host");
      expect(joined).toContain(getAgent("opencode")!.setupCommand);
    });

    // --- Host mode next steps (ADR 0021/0026) ---

    const hostProvider = getSandboxProvider("host")!;
    const hostNext = (
      template: string,
      mainFilename: string,
      issueTracker = ghIssues,
    ) =>
      getNextStepsLines(
        template,
        mainFilename,
        issueTracker,
        claudeCodeAgent,
        "npm",
        hostProvider,
      ).join("\n");

    it("host mode next steps are Vietnamese and reuse the host CLI login", () => {
      const joined = hostNext("blank", "main.mts");
      expect(joined).toContain("Các bước tiếp theo");
      expect(joined).toContain("đăng nhập");
      expect(joined).toContain("dùng lại phiên đăng nhập CLI");
      expect(joined).toContain("không cần API key");
    });

    it("host mode next steps never mention images, builds, or API-key setup", () => {
      for (const template of ["blank", "simple-loop", "parallel-planner"]) {
        const joined = hostNext(template, "main.mts");
        expect(joined).not.toContain("build-image");
        expect(joined).not.toContain("Dockerfile");
        expect(joined).not.toContain("image");
        expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
        expect(joined).not.toContain("claude setup-token");
        // "không cần API key" is the only permitted mention of API keys —
        // an explicit statement that none is needed, never a setup step.
        expect(joined).not.toContain("Set the required env vars");
        // Package-script and run instructions are retained.
        expect(joined).toContain("npm run sandcastle");
      }
    });

    it("host mode next steps mention env only when the tracker needs it", () => {
      const beads = getIssueTracker("beads")!;
      const withGithub = hostNext("blank", "main.mts", ghIssues);
      const withBeads = hostNext("blank", "main.mts", beads);
      // On the host, `gh` reuses the existing login — github-issues needs no
      // env vars, same as beads. (A custom tracker takes the dedicated
      // setup-doc steps instead of this list.)
      expect(withGithub).not.toContain(".env.example");
      expect(withBeads).not.toContain(".env.example");
    });

    it.each(["parallel-planner", "parallel-planner-with-review"])(
      "host mode next steps for %s cover host dependency reuse and the plan schema",
      (template) => {
        const joined = hostNext(template, "main.mts");
        // copyToWorktree is the host-mode dependency reuse mechanism — no
        // container install hook exists to mention.
        expect(joined).toContain('copyToWorktree: ["node_modules"]');
        expect(joined).toContain("npm install zod");
        expect(joined).not.toMatch(/container|onSandboxReady/i);
        if (template === "parallel-planner-with-review") {
          expect(joined).toContain("CODING_STANDARDS.md");
        }
      },
    );

    it("host mode + custom tracker keeps the English custom setup steps", () => {
      const joined = getNextStepsLines(
        "blank",
        "main.mts",
        customManager,
        claudeCodeAgent,
        "npm",
        hostProvider,
      ).join("\n");
      expect(joined).toContain("SETUP_ISSUE_TRACKER.md");
      // No image exists, so the "image isn't built yet" aside is dropped.
      expect(joined).not.toContain("image isn't built yet");
      expect(joined).not.toContain("build the image");
    });
  });

  // ---------------------------------------------------------------------
  // Workflow options (ADR 0025/0026): the interactive picker presents
  // Vietnamese outcome labels bound to stable internal template ids.
  // ---------------------------------------------------------------------

  describe("listWorkflowOptions", () => {
    it("presents Vietnamese outcome labels bound to stable template ids", () => {
      const options = listWorkflowOptions();
      // Order is the pick order: reviewed sequential first (recommended),
      // fast sequential, the two parallel workflows, then custom/blank.
      expect(options.map((o) => o.template)).toEqual([
        "sequential-reviewer",
        "simple-loop",
        "parallel-planner",
        "parallel-planner-with-review",
        "blank",
      ]);
      expect(options[0]).toMatchObject({
        template: "sequential-reviewer",
        recommended: true,
      });
      // Exactly one recommended choice.
      expect(options.filter((o) => o.recommended)).toHaveLength(1);

      const templateNames = listTemplates().map((t) => t.name);
      for (const option of options) {
        // Every outcome maps to a real, stable template id — never renamed.
        expect(templateNames).toContain(option.template);
        // The label is an outcome, not the codename; the id stays visible
        // in the hint for traceability.
        expect(option.label).not.toBe(option.template);
        expect(option.label.length).toBeGreaterThan(0);
        expect(option.hint).toContain(option.template);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Verification-command detection (ADR 0024)
  // ---------------------------------------------------------------------

  describe("detectVerificationCandidates", () => {
    const runDetect = (dir: string, packageManager: PackageManager = "npm") =>
      Effect.runPromise(
        detectVerificationCandidates(dir, packageManager).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );

    it("detects npm scripts in canonical run order (typecheck, lint, test, build)", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: {
            dev: "vite",
            build: "tsup",
            test: "vitest run",
            lint: "eslint .",
            typecheck: "tsgo --noEmit",
          },
        }),
      );
      expect(await runDetect(dir)).toEqual([
        "npm run typecheck",
        "npm run lint",
        "npm test",
        "npm run build",
      ]);
    });

    it("renders scripts with the detected package manager", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { typecheck: "tsc --noEmit", test: "vitest" },
        }),
      );
      expect(await runDetect(dir, "pnpm")).toEqual([
        "pnpm run typecheck",
        "pnpm run test",
      ]);
    });

    it("skips the npm-init placeholder test script — it always fails", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            test: 'echo "Error: no test specified" && exit 1',
            typecheck: "tsc --noEmit",
          },
        }),
      );
      expect(await runDetect(dir)).toEqual(["npm run typecheck"]);
    });

    it("detects non-npm candidates from config markers", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "go.mod"), "module example.com/x\n");
      await writeFile(join(dir, "pyproject.toml"), "[project]\n");
      expect(await runDetect(dir)).toEqual(["go test ./...", "pytest"]);
    });

    it("detects a Makefile only when it declares a test: target", async () => {
      const withTarget = await makeDir();
      await writeFile(
        join(withTarget, "Makefile"),
        "build:\n\techo build\n\ntest:\n\techo test\n",
      );
      expect(await runDetect(withTarget)).toEqual(["make test"]);

      const without = await makeDir();
      await writeFile(join(without, "Makefile"), "build:\n\techo build\n");
      expect(await runDetect(without)).toEqual([]);
    });

    it("combines npm scripts and non-npm markers, npm first", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      await writeFile(join(dir, "Cargo.toml"), "[package]\n");
      expect(await runDetect(dir)).toEqual(["npm test", "cargo test"]);
    });

    it("returns an empty list when nothing is detected", async () => {
      const dir = await makeDir();
      expect(await runDetect(dir)).toEqual([]);
    });

    it("ignores a malformed package.json and still detects non-npm markers", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      await writeFile(join(dir, "go.mod"), "module example.com/x\n");
      expect(await runDetect(dir)).toEqual(["go test ./..."]);
    });

    it("reads scripts from a package.json with a UTF-8 BOM", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        "\uFEFF" +
          JSON.stringify({
            scripts: { typecheck: "tsc --noEmit", test: "vitest" },
          }),
      );
      expect(await runDetect(dir)).toEqual(["npm run typecheck", "npm test"]);
    });
  });

  // ---------------------------------------------------------------------
  // package.json `sandcastle` script (ADR 0026)
  // ---------------------------------------------------------------------

  describe("ensureSandcastleScript", () => {
    const runEnsure = (
      dir: string,
      options?: Parameters<typeof ensureSandcastleScript>[1],
    ) =>
      Effect.runPromise(
        ensureSandcastleScript(dir, options).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );

    const readPkg = async (dir: string) =>
      JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as {
        scripts?: Record<string, string>;
      };

    it("adds the script to an existing package.json, preserving unrelated content", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify(
          {
            name: "my-project",
            version: "1.2.3",
            scripts: { test: "vitest", dev: "vite" },
            dependencies: { zod: "^4.0.0" },
          },
          null,
          2,
        ),
      );

      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "added" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts).toEqual({
        test: "vitest",
        dev: "vite",
        sandcastle: SANDCASTLE_SCRIPT_COMMAND,
      });
      expect(SANDCASTLE_SCRIPT_COMMAND).toBe("sandcastle run");
      expect((pkg as { name?: string }).name).toBe("my-project");
    });

    it("creates a minimal package.json when none exists", async () => {
      const dir = await makeDir();
      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "created-package-json" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts?.["sandcastle"]).toBe("sandcastle run");
    });

    it("reports already-correct when the script is already right", async () => {
      const dir = await makeDir();
      const original = JSON.stringify(
        { scripts: { sandcastle: "sandcastle run" } },
        null,
        2,
      );
      await writeFile(join(dir, "package.json"), original);
      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "already-correct" });
      // Untouched — byte-identical.
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(original);
    });

    it("reports a conflict without writing when resolution is ask", async () => {
      const dir = await makeDir();
      const original = JSON.stringify(
        {
          scripts: {
            sandcastle: "npx tsx .sandcastle/main.mts",
            test: "vitest",
          },
        },
        null,
        2,
      );
      await writeFile(join(dir, "package.json"), original);
      const outcome = await runEnsure(dir, { resolution: "ask" });
      expect(outcome).toEqual({
        kind: "conflict",
        existing: "npx tsx .sandcastle/main.mts",
      });
      // Never silently overwritten — the file is byte-identical.
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(original);
    });

    it("keeps an existing script when resolution is keep", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { sandcastle: "echo mine" } }),
      );
      const outcome = await runEnsure(dir, { resolution: "keep" });
      expect(outcome).toEqual({ kind: "kept-existing" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts?.["sandcastle"]).toBe("echo mine");
    });

    it("overwrites an existing script when resolution is overwrite", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { sandcastle: "echo mine", test: "vitest" },
        }),
      );
      const outcome = await runEnsure(dir, { resolution: "overwrite" });
      expect(outcome).toEqual({ kind: "overwritten" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts).toEqual({
        sandcastle: "sandcastle run",
        test: "vitest",
      });
    });

    it("skips a malformed package.json rather than rewriting it", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "skipped-malformed" });
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(
        "not valid json{{{",
      );
    });

    it("accepts a UTF-8 BOM and preserves it on rewrite", async () => {
      const dir = await makeDir();
      const original =
        "\uFEFF" +
        JSON.stringify(
          { name: "bom-project", scripts: { test: "vitest" } },
          null,
          2,
        ) +
        "\n";
      await writeFile(join(dir, "package.json"), original);

      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "added" });
      const rewritten = await readFile(join(dir, "package.json"), "utf-8");
      expect(rewritten.startsWith("\uFEFF")).toBe(true);
      const pkg = JSON.parse(rewritten.slice(1)) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      expect(pkg.name).toBe("bom-project");
      expect(pkg.scripts).toEqual({
        test: "vitest",
        sandcastle: SANDCASTLE_SCRIPT_COMMAND,
      });
    });

    it("preserves CRLF line endings on rewrite", async () => {
      const dir = await makeDir();
      const original =
        '{\r\n  "name": "crlf-project",\r\n  "scripts": {\r\n    "test": "vitest"\r\n  }\r\n}\r\n';
      await writeFile(join(dir, "package.json"), original);

      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "added" });
      const rewritten = await readFile(join(dir, "package.json"), "utf-8");
      // Every line break is CRLF — no bare LF introduced.
      expect(rewritten.replaceAll("\r\n", "")).not.toContain("\n");
      const pkg = JSON.parse(rewritten) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      expect(pkg.name).toBe("crlf-project");
      expect(pkg.scripts).toEqual({
        test: "vitest",
        sandcastle: SANDCASTLE_SCRIPT_COMMAND,
      });
    });

    it("keeps LF line endings LF-only on rewrite", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }, null, 2) + "\n",
      );
      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "added" });
      const rewritten = await readFile(join(dir, "package.json"), "utf-8");
      expect(rewritten).not.toContain("\r");
    });

    it("adds a scripts block to a package.json that has none", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "no-scripts", version: "0.1.0" }, null, 2),
      );
      const outcome = await runEnsure(dir);
      expect(outcome).toEqual({ kind: "added" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts).toEqual({
        sandcastle: SANDCASTLE_SCRIPT_COMMAND,
      });
      expect((pkg as { name?: string }).name).toBe("no-scripts");
    });

    it.each([
      { label: "an array", scripts: ["echo a", "echo b"] },
      { label: "a string", scripts: "npm test" },
      { label: "null", scripts: null },
      { label: "a number", scripts: 3 },
    ])(
      "reports and preserves malformed scripts ($label)",
      async ({ scripts }) => {
        const dir = await makeDir();
        const original = JSON.stringify({ name: "x", scripts }, null, 2);
        await writeFile(join(dir, "package.json"), original);
        const outcome = await runEnsure(dir);
        expect(outcome).toEqual({ kind: "malformed-scripts" });
        // Byte-identical — reported, never coerced or overwritten.
        expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(
          original,
        );
      },
    );

    it("reports a conflict for a non-string sandcastle entry rather than overwriting it", async () => {
      const dir = await makeDir();
      const original = JSON.stringify(
        { scripts: { sandcastle: 42, test: "vitest" } },
        null,
        2,
      );
      await writeFile(join(dir, "package.json"), original);
      const outcome = await runEnsure(dir, { resolution: "ask" });
      expect(outcome).toEqual({ kind: "conflict", existing: "42" });
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(original);
    });

    it("keeps a non-string sandcastle entry when resolution is keep", async () => {
      const dir = await makeDir();
      const original = JSON.stringify(
        { scripts: { sandcastle: { run: "echo hi" } } },
        null,
        2,
      );
      await writeFile(join(dir, "package.json"), original);
      const outcome = await runEnsure(dir, { resolution: "keep" });
      expect(outcome).toEqual({ kind: "kept-existing" });
      expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(original);
    });

    it("overwrites a non-string sandcastle entry only when resolution is overwrite", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { sandcastle: [1, 2], test: "vitest" } }),
      );
      const outcome = await runEnsure(dir, { resolution: "overwrite" });
      expect(outcome).toEqual({ kind: "overwritten" });
      const pkg = await readPkg(dir);
      expect(pkg.scripts).toEqual({
        sandcastle: SANDCASTLE_SCRIPT_COMMAND,
        test: "vitest",
      });
    });
  });

  it("persists verificationCommands and verificationStatus into settings.json", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      settings: {
        verificationCommands: ["npm run typecheck", "npm test"],
      },
    });
    let settings = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.verificationCommands).toEqual([
      "npm run typecheck",
      "npm test",
    ]);
    // Configured-but-not-yet-run: no status key — never reported passed.
    expect("verificationStatus" in settings).toBe(false);

    const skippedDir = await makeDir();
    await runScaffold(skippedDir, {
      settings: { verificationStatus: "skipped" },
    });
    settings = JSON.parse(
      await readFile(join(skippedDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.verificationCommands).toEqual([]);
    expect(settings.verificationStatus).toBe("skipped");

    const unavailableDir = await makeDir();
    await runScaffold(unavailableDir, {
      settings: { verificationStatus: "unavailable" },
    });
    settings = JSON.parse(
      await readFile(
        join(unavailableDir, ".sandcastle", "settings.json"),
        "utf-8",
      ),
    );
    expect(settings.verificationStatus).toBe("unavailable");
  });

  it("scaffolds pi agent with pi Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with pi factory import when pi agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('pi("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.4-mini")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds cursor agent with cursor Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).toContain('ENV PATH="/home/agent/.local/bin:$PATH"');
    expect(dockerfile).toContain("ARG AGENT_UID=1000");
    expect(dockerfile).toContain("ARG AGENT_GID=1000");
    expect(dockerfile).toMatch(
      /USER \$\{AGENT_UID\}:\$\{AGENT_GID\}[\s\S]*RUN curl https:\/\/cursor\.com\/install -fsS \| bash/,
    );
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with cursor factory import when cursor agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('cursor("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  // --- createLabel option ---

  it("simple-loop prompt.md retains --label Sandcastle when createLabel is true", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: true });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("simple-loop prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: false });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    // The gh issue list command should still be valid
    expect(prompt).toContain("gh issue list");
    // No double spaces in gh commands from removal
    expect(prompt).not.toMatch(/gh issue list {2}/);
  });

  it("parallel-planner plan-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "parallel-planner",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "plan-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("sequential-reviewer implement-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "sequential-reviewer",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / the close instruction used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (simple-loop,
    // sequential-reviewer's implement, parallel-planner*'s merge),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
      { template: "parallel-planner", file: "merge-prompt.md" },
      { template: "parallel-planner-with-review", file: "merge-prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".sandcastle", file), "utf-8");
      expect(prompt, `${template}/${file}`).not.toContain("{{TASK_ID}}");
    }
  });

  it("createLabel defaults to true (label retained when not specified)", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  describe("parallel-planner template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts uses npm install hook and imports sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
      expect(mainTs).toContain("sandcastle");
    });

    it("main.mts imports from @lengoctu70/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@lengoctu70/sandcastle"');
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // All factory calls should use the specified model (default: claude-opus-4-8)
      expect(mainTs).toContain("claude-opus-4-8");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("main.mts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
      expect(envExample).toContain("GH_TOKEN=");
    });
  });

  describe("parallel-planner-with-review template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, review-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @lengoctu70/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@lengoctu70/sandcastle"');
    });

    it("main.mts uses createSandbox for shared sandbox per branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
    });

    it("main.mts runs implementer then reviewer sequentially within each sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("implement.commits.length > 0");
    });

    it("main.mts captures reviewer result and merges commits from both runs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Reviewer result must be captured, not discarded
      expect(mainTs).toContain("const review = await sandbox.run");
      // Commits from both implementer and reviewer must be merged
      expect(mainTs).toContain("implement.commits");
      expect(mainTs).toContain("review.commits");
    });

    it("main.mts runs issue pipelines through the bounded worker pool", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("mapSettled(issues, MAX_PARALLEL");
      expect(mainTs).not.toContain("await Promise.allSettled(");
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1, merger=1", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Check planner maxIterations: 1 (near "planner" name)
      const plannerSection = mainTs.slice(
        mainTs.indexOf('name: "planner"') - 200,
        mainTs.indexOf('name: "planner"') + 200,
      );
      expect(plannerSection).toContain("maxIterations: 1");

      // Check implementer maxIterations: 100
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"') - 200,
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf('name: "reviewer"') - 200,
        mainTs.indexOf('name: "reviewer"') + 200,
      );
      expect(reviewerSection).toContain("maxIterations: 1");

      // Check merger maxIterations: 1
      const mergerSection = mainTs.slice(
        mainTs.indexOf('name: "merger"') - 200,
        mainTs.indexOf('name: "merger"') + 200,
      );
      expect(mergerSection).toContain("maxIterations: 1");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("parallel-planner-with-review appears in listTemplates()", () => {
      const templates = listTemplates();
      expect(
        templates.some((t) => t.name === "parallel-planner-with-review"),
      ).toBe(true);
    });

    it("common files are still generated", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
      expect(envExample).toContain("GH_TOKEN=");
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claude-opus-4-8");
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
  });

  // --- Issue tracker ---

  describe("Issue tracker registry", () => {
    it("listIssueTrackers returns github-issues and beads", () => {
      const managers = listIssueTrackers();
      expect(managers.some((m) => m.name === "github-issues")).toBe(true);
      expect(managers.some((m) => m.name === "beads")).toBe(true);
    });

    it("getIssueTracker returns github-issues entry with expected templateArgs", () => {
      const manager = getIssueTracker("github-issues");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("GitHub Issues");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "gh issue list",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("labels");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("comments");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("--limit 100");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "gh issue view",
      );
      // ADR 0023: GitHub Issues carries no close command — the generated
      // prompts instruct the agent not to mutate the issue; `sandcastle run`
      // reports and closes it after verified landing.
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).toContain(
        "do NOT close or comment",
      );
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).not.toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.MERGE_CLOSE_INSTRUCTION).not.toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("GitHub CLI");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("gh");
    });

    it("getIssueTracker returns beads entry with expected templateArgs", () => {
      const manager = getIssueTracker("beads");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Beads");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toBe("bd ready --json");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("bd show");
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).toContain(
        "bd close",
      );
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).toContain(
        "--reason=",
      );
      expect(manager!.templateArgs.MERGE_CLOSE_INSTRUCTION).toContain(
        "bd close",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("beads");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("libicu72");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "corepack enable",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).not.toContain("gh");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).not.toContain(
        "x86_64-linux-gnu",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "dpkg-architecture -qDEB_HOST_MULTIARCH",
      );
    });

    it("getIssueTracker returns custom entry with broken-until-configured templateArgs", () => {
      const manager = getIssueTracker("custom");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Custom");
      // Only the list command is a real shell expression — it hard-fails the
      // run (exit 1) and points at the setup doc.
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("exit 1");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(">&2");
      // View/close are inline text markers, not runnable commands.
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("view command");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).toContain(
        "close command",
      );
      expect(manager!.templateArgs.CLOSE_TASK_INSTRUCTION).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.templateArgs.MERGE_CLOSE_INSTRUCTION).toContain(
        "close command",
      );
      // Dockerfile install block is a TODO comment pointing at the doc.
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("TODO");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.envExample).toContain("TODO");
      expect(manager!.envExample).toContain("SETUP_ISSUE_TRACKER.md");
    });

    it("listIssueTrackers includes custom", () => {
      const managers = listIssueTrackers();
      expect(managers.some((m) => m.name === "custom")).toBe(true);
    });

    it("getIssueTracker returns undefined for unknown manager", () => {
      expect(getIssueTracker("nonexistent")).toBeUndefined();
    });
  });

  describe("Agent setupCommand", () => {
    it.each([
      {
        name: "claude-code",
        command: `claude "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "codex",
        command: `codex "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "cursor",
        command: `agent "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      { name: "pi", command: `pi "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"` },
      {
        name: "opencode",
        command: `opencode --prompt "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "copilot",
        command: `copilot -i "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
    ])(
      "$name has the expected interactive setupCommand",
      ({ name, command }) => {
        expect(getAgent(name)!.setupCommand).toBe(command);
      },
    );
  });

  describe("Issue tracker scaffold", () => {
    it("simple-loop with github-issues keeps issue mutation out of the prompt (ADR 0023)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      // Read-side gh commands stay; the close/comment command is gone.
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("gh issue comment");
      // The explicit do-not-mutate instruction is present instead.
      expect(prompt).toContain("do NOT close or comment on the issue");
      expect(prompt).toContain("Never mutate the issue");
      // The banned completion signature never reaches generated prompts.
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_INSTRUCTION}}");
      expect(prompt).not.toContain("{{ISSUE_MUTATION_RULES}}");
    });

    it("simple-loop with beads produces prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_INSTRUCTION}}");
      expect(prompt).not.toContain("{{ISSUE_MUTATION_RULES}}");
    });

    it("generated prompts carry no banned 'RALPH' terminology or completion signature", async () => {
      // CONTEXT.md bans "RALPH" and the "Completed by Sandcastle" signature —
      // neither may reach generated prompt files for any tracker.
      const cases: Array<{ template: string; files: string[] }> = [
        { template: "simple-loop", files: ["prompt.md"] },
        { template: "sequential-reviewer", files: ["implement-prompt.md"] },
        {
          template: "parallel-planner",
          files: ["implement-prompt.md", "merge-prompt.md"],
        },
        {
          template: "parallel-planner-with-review",
          files: ["implement-prompt.md", "merge-prompt.md"],
        },
      ];
      for (const tracker of ["github-issues", "beads", "custom"]) {
        for (const { template, files } of cases) {
          const dir = await makeDir();
          await runScaffold(dir, {
            templateName: template,
            issueTracker: getIssueTracker(tracker),
          });
          for (const file of files) {
            const prompt = await readFile(
              join(dir, ".sandcastle", file),
              "utf-8",
            );
            expect(prompt, `${tracker}/${template}/${file}`).not.toContain(
              "RALPH",
            );
            expect(prompt, `${tracker}/${template}/${file}`).not.toContain(
              "Completed by Sandcastle",
            );
          }
        }
      }
    });

    it("simple-loop with beads skips --label Sandcastle (no label to strip)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues retains --label Sandcastle when createLabel is true", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: true,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues strips --label Sandcastle when createLabel is false", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: false,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
      expect(prompt).toContain("gh issue list");
    });

    it("scaffold without issueTracker defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("simple-loop prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    it("simple-loop prompt hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(
        "already been filtered to issues ready for work",
      );
      expect(prompt).toContain("sole source of truth");
      expect(prompt).toContain("Do not run your own unfiltered query");
    });

    // --- custom issue tracker ---

    const customManager = getIssueTracker("custom");

    it("custom scaffolds .sandcastle/SETUP_ISSUE_TRACKER.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      // Goal + interview + the three commands the agent must produce.
      expect(setup).toContain("list");
      expect(setup).toContain("view");
      expect(setup).toContain("close");
      // It must explicitly tell the agent to remove the exit 1 sentinel.
      expect(setup).toContain("exit 1");
      // The markers the agent will actually find in the scaffolded files.
      expect(setup).toContain(customManager!.templateArgs.VIEW_TASK_COMMAND);
      // The close marker is embedded inside the instruction args the
      // scaffolded prompts carry.
      expect(setup).toContain("close command — see");
    });

    it("custom SETUP doc references the chosen provider's build-image command", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
        sandboxProvider: getSandboxProvider("podman"),
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      expect(setup).toContain("sandcastle podman build-image");
      expect(setup).not.toContain("sandcastle docker build-image");
    });

    it("non-custom issue trackers do not scaffold SETUP_ISSUE_TRACKER.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md")),
      ).rejects.toThrow();
    });

    it("custom Dockerfile leaves a TODO install block instead of a real CLI", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("TODO");
      expect(dockerfile).toContain("SETUP_ISSUE_TRACKER.md");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      // No real issue-tracker CLI baked in yet.
      expect(dockerfile).not.toContain("GitHub CLI");
    });

    it("custom simple-loop prompt hard-fails the list command with a pointer to the doc", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("exit 1");
      expect(prompt).toContain("SETUP_ISSUE_TRACKER.md");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("custom .env.example carries a TODO for tracker env vars", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("TODO");
      expect(envExample).toContain("SETUP_ISSUE_TRACKER.md");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer with github-issues keeps issue mutation out of the implement-prompt (ADR 0023)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("gh issue comment");
      expect(prompt).toContain("do NOT close or comment on the issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_INSTRUCTION}}");
      expect(prompt).not.toContain("{{ISSUE_MUTATION_RULES}}");
    });

    it("sequential-reviewer with beads produces implement-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_INSTRUCTION}}");
      expect(prompt).not.toContain("{{ISSUE_MUTATION_RULES}}");
    });

    it("sequential-reviewer implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- blank ---

    it("blank with github-issues produces prompt with gh issue list example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("blank with beads produces prompt with bd ready example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- parallel-planner ---

    it("parallel-planner with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: z.string()");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.issues");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with github-issues keeps issue mutation out of the merge-prompt (ADR 0023)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      // No close/comment command — Sandcastle reports and closes each issue
      // after its merged work is verified and landed.
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("gh issue comment");
      expect(prompt).toContain("Do not close or comment on any issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{MERGE_CLOSE_INSTRUCTION}}");
    });

    it("parallel-planner with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{MERGE_CLOSE_INSTRUCTION}}");
    });

    it("parallel-planner implement-prompt carries no close command, only the do-not-close rule", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("close the issue when done");
      // GitHub Issues (the default tracker): explicit do-not-close instruction.
      expect(prompt).toContain("Do NOT close or comment on the issue");
      expect(prompt).not.toContain("{{INCOMPLETE_TASK_INSTRUCTION}}");
    });

    it("parallel-planner main.mts bounds concurrency instead of launching every issue at once", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // The worker pool caps in-flight implementers at MAX_PARALLEL — the
      // unbounded Promise.allSettled(issues.map(…)) call is gone (the name
      // still appears in the mapSettled doc comment, so assert the call).
      expect(main).toContain("mapSettled(issues, MAX_PARALLEL");
      expect(main).toContain("const MAX_PARALLEL");
      expect(main).not.toContain("await Promise.allSettled(");
      // The configured limit is re-read from settings.json each run so
      // `sandcastle configure` (parallelism 1–4) takes effect; the env var
      // overrides it, and 2 is the fallback.
      expect(main).toContain(".sandcastle/settings.json");
      expect(main).toContain("parallelism");
      expect(main).toContain("SANDCASTLE_MAX_PARALLEL");
      expect(main).toContain("return 2;");
      expect(main).toContain("Math.min(Math.max(n, 1), 4)");
    });

    it("parallel-planner implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- parallel-planner-with-review ---

    it("parallel-planner-with-review with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: z.string()");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner-with-review main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.issues");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner-with-review main.mts bounds concurrency instead of launching every pipeline at once", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Same bounded worker pool as parallel-planner: at most MAX_PARALLEL
      // implement→review pipelines in flight (the name still appears in the
      // mapSettled doc comment, so assert the call).
      expect(main).toContain("mapSettled(issues, MAX_PARALLEL");
      expect(main).toContain("const MAX_PARALLEL");
      expect(main).not.toContain("await Promise.allSettled(");
      expect(main).toContain(".sandcastle/settings.json");
      expect(main).toContain("SANDCASTLE_MAX_PARALLEL");
      expect(main).toContain("return 2;");
    });

    it("parallel-planner-with-review implement-prompt carries no close command, only the do-not-close rule", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).toContain("Do NOT close or comment on the issue");
      expect(prompt).not.toContain("{{INCOMPLETE_TASK_INSTRUCTION}}");
    });

    it("parallel-planner-with-review implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner-with-review with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with github-issues keeps issue mutation out of the merge-prompt (ADR 0023)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("gh issue comment");
      expect(prompt).toContain("Do not close or comment on any issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{MERGE_CLOSE_INSTRUCTION}}");
    });

    it("parallel-planner-with-review with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("Completed by Sandcastle");
      expect(prompt).not.toContain("{{MERGE_CLOSE_INSTRUCTION}}");
    });

    it("parallel-planner-with-review implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- Dockerfile issue tracker tools ---

    it("scaffold with github-issues produces Dockerfile with GitHub CLI install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        issueTracker: getIssueTracker("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("gh");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("scaffold with beads produces Dockerfile with beads install (no GitHub CLI)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        issueTracker: getIssueTracker("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("libicu72");
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).not.toContain("GitHub CLI");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      expect(dockerfile).not.toContain("x86_64-linux-gnu");
      expect(dockerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + podman produces Containerfile with beads install", async () => {
      const dir = await makeDir();
      const podmanProvider = getSandboxProvider("podman")!;
      await runScaffold(dir, {
        issueTracker: getIssueTracker("beads"),
        sandboxProvider: podmanProvider,
      });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("beads");
      expect(containerfile).toContain("libicu72");
      expect(containerfile).not.toContain("GitHub CLI");
      expect(containerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      expect(containerfile).not.toContain("x86_64-linux-gnu");
      expect(containerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + pi agent produces Dockerfile with beads install and pi agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        agent: piAgent,
        model: "claude-sonnet-4-6",
        issueTracker: getIssueTracker("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
      expect(dockerfile).not.toContain("GitHub CLI");
    });
  });

  // --- ESM extension detection ---

  describe("main file extension detection", () => {
    it("scaffolds main.mts when no package.json exists", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).resolves.toBeUndefined();
    });

    it("scaffolds main.mts when package.json has no type field", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("@lengoctu70/sandcastle");
    });

    it("scaffolds main.mts when package.json has type: commonjs", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "commonjs" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.ts")),
      ).resolves.toBeUndefined();
      // main.mts should NOT exist
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).rejects.toThrow();
    });

    it("main.ts scaffolded with type: module has correct imports and factory calls", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("@lengoctu70/sandcastle");
      expect(mainContent).toContain('claudeCode("claude-opus-4-8")');
    });

    it("main.ts scaffolded with type: module rewrites agent factory correctly", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain('pi("claude-sonnet-4-6")');
      expect(mainContent).not.toContain("claudeCode");
    });

    it("comments in scaffolded main.ts reference main.ts, not main.mts", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).not.toContain("main.mts");
      expect(mainContent).toContain("main.ts");
    });

    it("scaffolds main.mts when package.json is invalid JSON", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has a UTF-8 BOM and type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        "\uFEFF" + JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox provider selection
  // ---------------------------------------------------------------------------

  describe("sandbox provider", () => {
    const dockerProvider = getSandboxProvider("docker")!;
    const podmanProvider = getSandboxProvider("podman")!;

    it("selecting docker writes Dockerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("selecting podman writes Containerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("FROM node:22-bookworm");
      expect(containerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("selecting podman does not write Dockerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
    });

    it("selecting docker does not write Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting podman rewrites the main file to import and call podman", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { podman } from "@lengoctu70/sandcastle/sandboxes/podman"',
      );
      expect(mainTs).toContain("sandbox: podman()");
      expect(mainTs).not.toContain("docker");
    });

    it("selecting podman rewrites every docker() call site", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: podmanProvider,
        templateName: "parallel-planner",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("docker");
      // parallel-planner calls the factory three times
      expect(mainTs.match(/sandbox: podman\(\)/g)).toHaveLength(3);
    });

    it("selecting docker leaves the main file importing and calling docker", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { run, claudeCode } from "@lengoctu70/sandcastle"',
      );
      expect(mainTs).toContain(
        'import { docker } from "@lengoctu70/sandcastle/sandboxes/docker"',
      );
      expect(mainTs).toContain("sandbox: docker()");
    });

    // --- Host mode (ADR 0021) — backed by the existing noSandbox provider ---

    const hostProvider = getSandboxProvider("host")!;

    it("selecting host writes no Dockerfile or Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: hostProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting host rewrites the main file to import and call noSandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: hostProvider });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Two-phase rewrite: the import subpath is `no-sandbox` while the
      // factory identifier is `noSandbox` — a single word replace would
      // produce `sandboxes/noSandbox`.
      expect(mainTs).toContain(
        'import { noSandbox } from "@lengoctu70/sandcastle/sandboxes/no-sandbox"',
      );
      expect(mainTs).toContain("sandbox: noSandbox()");
      expect(mainTs).not.toContain("docker");
      expect(mainTs).not.toContain("podman");
    });

    it("selecting host injects merge-to-head into run() calls without a branchStrategy", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: hostProvider });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // The no-sandbox runtime default is `head`; host mode must work in a
      // separate worktree instead of editing the user's checkout directly.
      expect(mainTs).toContain('branchStrategy: { type: "merge-to-head" }');
      // Injected after the sandbox option, inside the run({...}) options.
      const runCall = mainTs.slice(mainTs.indexOf("run({"));
      expect(runCall.indexOf("sandbox: noSandbox()")).toBeLessThan(
        runCall.indexOf('branchStrategy: { type: "merge-to-head" }'),
      );
    });

    it("selecting host leaves explicit branchStrategy on run() untouched", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "parallel-planner",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandbox: noSandbox()");
      // The per-issue branch strategy is preserved verbatim — not clobbered
      // by the merge-to-head injection.
      expect(mainTs).toContain(
        'branchStrategy: { type: "branch", branch: issue.branch }',
      );
      // ...while calls that pinned no strategy (planner, merger) got
      // merge-to-head injected.
      expect(
        mainTs.match(/branchStrategy: \{ type: "merge-to-head" \}/g)!.length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("selecting host does not inject branchStrategy into createSandbox calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "sequential-reviewer",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // createSandbox takes an explicit `branch`, not `branchStrategy` — the
      // injector only touches run({...}) calls selecting noSandbox().
      const createCall = mainTs.slice(
        mainTs.indexOf("createSandbox({"),
        mainTs.indexOf("});", mainTs.indexOf("createSandbox({")),
      );
      expect(createCall).toContain("sandbox: noSandbox()");
      expect(createCall).not.toContain("branchStrategy");
      // Member calls on the reusable sandbox handle carry no sandbox option,
      // so they are never rewritten.
      expect(mainTs).toContain("sandbox.run(");
    });

    it.each(["parallel-planner", "parallel-planner-with-review"])(
      "selecting host generates a branch-isolated host workflow for %s",
      async (templateName) => {
        const dir = await makeDir();
        await runScaffold(dir, {
          sandboxProvider: hostProvider,
          templateName,
        });

        const mainTs = await readFile(
          join(dir, ".sandcastle", "main.mts"),
          "utf-8",
        );
        expect(mainTs).toContain(
          'import { noSandbox } from "@lengoctu70/sandcastle/sandboxes/no-sandbox"',
        );
        // Bounded concurrency applies on the host too — the worker pool
        // survives provider rewriting.
        expect(mainTs).toContain("mapSettled(issues, MAX_PARALLEL");

        // Host dependency reuse stays; the container-only `npm install`
        // sandbox hook, its declaration, and its comments are stripped.
        expect(mainTs).toContain('copyToWorktree = ["node_modules"]');
        expect(mainTs).not.toContain("const hooks");
        expect(mainTs).not.toContain("hooks,");
        expect(mainTs).not.toContain("npm install");
        expect(mainTs).not.toContain("onSandboxReady");
        expect(mainTs).not.toMatch(/container/i);
        expect(mainTs).not.toContain("sandcastle:sandbox-");

        // The per-issue concurrency block binds an explicit branch from the
        // plan — never a shared head or merge-to-head worktree.
        const implementerBlock = mainTs.slice(
          mainTs.indexOf("mapSettled(issues"),
          mainTs.indexOf("settled.entries()"),
        );
        expect(implementerBlock).toContain("issue.branch");
        expect(implementerBlock).not.toContain('type: "merge-to-head"');
        expect(implementerBlock).not.toContain('type: "head"');

        // Planner and merger keep their target-branch responsibilities via
        // the injected merge-to-head — one per call, never on implementers.
        expect(
          mainTs.match(/branchStrategy: \{ type: "merge-to-head" \}/g),
        ).toHaveLength(2);
        expect(mainTs).not.toContain('type: "head"');

        if (templateName === "parallel-planner") {
          // Each concurrent implementer gets its own explicit branch (and
          // therefore its own host worktree).
          expect(mainTs).toContain(
            'branchStrategy: { type: "branch", branch: issue.branch }',
          );
        } else {
          // The reviewer runs inside the same createSandbox worktree, on the
          // same explicit branch, as the implementation it evaluates.
          const pipeline = mainTs.slice(
            mainTs.indexOf("createSandbox({"),
            mainTs.indexOf("sandbox.close()"),
          );
          expect(pipeline).toContain("branch: issue.branch");
          expect(pipeline.match(/await sandbox\.run\(/g)).toHaveLength(2);
        }
        // planner + per-issue implementer/createSandbox + merger
        expect(mainTs.match(/sandbox: noSandbox\(\)/g)).toHaveLength(3);
      },
    );

    it.each([
      ["docker", "parallel-planner"],
      ["podman", "parallel-planner"],
      ["docker", "parallel-planner-with-review"],
      ["podman", "parallel-planner-with-review"],
    ])(
      "keeps the %s container workflow for %s byte-identical",
      async (providerName, templateName) => {
        const dir = await makeDir();
        await runScaffold(dir, {
          sandboxProvider: getSandboxProvider(providerName),
          templateName,
        });

        const mainTs = await readFile(
          join(dir, ".sandcastle", "main.mts"),
          "utf-8",
        );
        // Reconstruct the expected output from the template source: marker
        // comments are stripped back to the original text, so only the
        // standard agent/model and provider rewrites apply — the generated
        // file must not otherwise change.
        const templateSource = await readFile(
          join(import.meta.dirname, "templates", templateName, "main.mts"),
          "utf-8",
        );
        const expected = templateSource
          .replace("// sandcastle:sandbox-setup:start\n", "")
          .replace("\n// sandcastle:sandbox-setup:end", "")
          .replace(/\/\* sandcastle:sandbox-hooks \*\/ hooks,/g, "hooks,")
          .replace(/claudeCode\("[^"]+"\)/g, 'claudeCode("claude-opus-4-8")')
          .replace(/sandboxes\/docker\b/g, `sandboxes/${providerName}`)
          .replace(/\bdocker\b/g, providerName);
        expect(mainTs).toBe(expected);
        // The container setup survives intact — install hook and all.
        expect(mainTs).toContain("const hooks");
        expect(mainTs).toContain("npm install");
        expect(mainTs).not.toContain("sandcastle:sandbox-");
      },
    );

    it("selecting host omits agent API-key env entries and GitHub's GH_TOKEN", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        issueTracker: getIssueTracker("github-issues"),
      });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      // Host mode reuses the agent's existing CLI login — no agent auth env.
      expect(envExample).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(envExample).not.toContain("ANTHROPIC_API_KEY");
      expect(envExample).not.toContain("OPENAI_KEY");
      expect(envExample).toContain("No agent API key is required");
      // Host + GitHub Issues: the `gh` CLI reuses `gh auth login` on this
      // machine, so no token is scaffolded (ADR 0021).
      expect(envExample).not.toContain("GH_TOKEN");
    });

    it("selecting docker keeps GH_TOKEN in .env.example for github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: dockerProvider,
        issueTracker: getIssueTracker("github-issues"),
      });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      // The container path still needs the token — gh inside the image has
      // no host login to reuse.
      expect(envExample).toContain("GH_TOKEN=");
    });

    it("selecting host persists sandbox 'host' in settings.json", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: hostProvider });

      const settings = JSON.parse(
        await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
      );
      expect(settings.sandbox).toBe("host");
    });

    it("host + custom tracker writes a setup doc with no image-build step", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        issueTracker: getIssueTracker("custom"),
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      expect(setup).not.toContain("build-image");
      expect(setup).toContain("no sandbox image");
      // The tracker CLI must live on the host, not in an image.
      expect(setup).toContain("install and authenticate it on this machine");
    });

    it("docker + custom tracker keeps the image-build step in the setup doc", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: dockerProvider,
        issueTracker: getIssueTracker("custom"),
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      expect(setup).toContain("sandcastle docker build-image");
    });

    // --- Host mode sequential workflows (ADR 0021) ---
    //
    // simple-loop and sequential-reviewer ship provider-native
    // `main.host.mts` variants: the container-only `npm install` sandbox hook
    // and container-oriented comments cannot be produced by rewriting the
    // shared main.mts, so the variant replaces it wholesale when the host
    // provider is selected.

    it("host simple-loop runs noSandbox in a worktree with explicit merge-to-head", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "simple-loop",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { noSandbox } from "@lengoctu70/sandcastle/sandboxes/no-sandbox"',
      );
      expect(mainTs).toContain("sandbox: noSandbox()");
      // The no-sandbox runtime default is `head`; host mode must work in a
      // separate worktree instead of editing the user's checkout directly.
      expect(mainTs).toContain('branchStrategy: { type: "merge-to-head" }');
      // Host dependency reuse is retained — host node_modules is copied into
      // the worktree, so the workflow needs no install step at all.
      expect(mainTs).toContain('copyToWorktree: ["node_modules"]');
    });

    it("host simple-loop drops the container-only install hook and image references", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "simple-loop",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const { readdir, access } = await import("node:fs/promises");
      // The docker template's `hooks.sandbox.onSandboxReady: npm install`
      // exists to fix up container binaries — meaningless on the host.
      expect(mainTs).not.toContain("onSandboxReady");
      expect(mainTs).not.toContain("npm install");
      expect(mainTs).not.toContain("docker");
      expect(mainTs).not.toContain("podman");
      expect(mainTs).not.toContain("isolated container");
      expect(mainTs).not.toContain("image");
      // No image files or leftover variant sources in the scaffold.
      const entries = await readdir(join(dir, ".sandcastle"));
      expect(entries).not.toContain("Dockerfile");
      expect(entries).not.toContain("Containerfile");
      expect(entries).not.toContain("main.host.mts");
      await expect(
        access(join(dir, ".sandcastle", "prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("host sequential-reviewer shares one host worktree for implement and review", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "sequential-reviewer",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandboxes/no-sandbox");
      const createCall = mainTs.slice(
        mainTs.indexOf("createSandbox({"),
        mainTs.indexOf("});", mainTs.indexOf("createSandbox({")),
      );
      expect(createCall).toContain("sandbox: noSandbox()");
      // The explicit branch is the shared task worktree — implementation and
      // review run in it back-to-back, so there is deliberately no
      // merge-to-head (incompatible with the reviewer handoff).
      expect(createCall).toContain("branch");
      expect(createCall).toContain("copyToWorktree");
      expect(mainTs).not.toContain("merge-to-head");
      // Both phases run on the same sandbox handle = same host worktree.
      expect(mainTs.match(/sandbox\.run\(\{/g)).toHaveLength(2);
      expect(mainTs).toContain('name: "implementer"');
      expect(mainTs).toContain('name: "reviewer"');
      expect(mainTs).toContain("sandbox.close");
    });

    it("host sequential-reviewer drops the container-only install hook", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: hostProvider,
        templateName: "sequential-reviewer",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("onSandboxReady");
      expect(mainTs).not.toContain("npm install");
      expect(mainTs).not.toContain("docker");
      expect(mainTs).not.toContain("podman");
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(join(dir, ".sandcastle"));
      expect(entries).not.toContain("main.host.mts");
      // Reviewer prompts and the standards file still ship.
      expect(entries).toContain("implement-prompt.md");
      expect(entries).toContain("review-prompt.md");
      expect(entries).toContain("CODING_STANDARDS.md");
    });

    it("host sequential templates still write settings.json with the workflow + sandbox", async () => {
      for (const template of ["simple-loop", "sequential-reviewer"]) {
        const dir = await makeDir();
        await runScaffold(dir, {
          sandboxProvider: hostProvider,
          templateName: template,
        });

        const settings = JSON.parse(
          await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
        );
        expect(settings.sandbox).toBe("host");
        expect(settings.workflow).toBe(template);
      }
    });

    // --- Container-provider regression: docker/podman output is unchanged ---

    it("docker sequential mains are byte-identical to their templates", async () => {
      // With the template's own agent/model there is nothing to rewrite, so
      // the scaffolded main must equal the template file byte for byte.
      for (const template of ["simple-loop", "sequential-reviewer"]) {
        const dir = await makeDir();
        await runScaffold(dir, {
          sandboxProvider: dockerProvider,
          templateName: template,
          model: "claude-sonnet-4-6",
        });

        const generated = await readFile(
          join(dir, ".sandcastle", "main.mts"),
          "utf-8",
        );
        const source = await readFile(
          join(import.meta.dirname, "templates", template, "main.mts"),
          "utf-8",
        );
        expect(generated).toBe(source);
      }
    });

    it("podman sequential mains equal the docker output with the provider swapped", async () => {
      for (const template of ["simple-loop", "sequential-reviewer"]) {
        const dir = await makeDir();
        await runScaffold(dir, {
          sandboxProvider: podmanProvider,
          templateName: template,
          model: "claude-sonnet-4-6",
        });

        const generated = await readFile(
          join(dir, ".sandcastle", "main.mts"),
          "utf-8",
        );
        const source = await readFile(
          join(import.meta.dirname, "templates", template, "main.mts"),
          "utf-8",
        );
        // The long-standing provider rewrite is a whole-word docker→podman
        // swap; the host-variant seam must not alter it.
        expect(generated).toBe(source.replace(/\bdocker\b/g, "podman"));
      }
    });
  });
});

import { NodeFileSystem } from "@effect/platform-node";
import type { FileSystem } from "@effect/platform";
import { Cause, Effect, Exit } from "effect";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAgent,
  getIssueTracker,
  getSandboxProvider,
  scaffold,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";
import {
  loadProjectSettings,
  loadProjectSettingsAsync,
  makeProjectSettings,
  projectSettingsPath,
  saveProjectSettings,
  updateProjectSettings,
} from "./ProjectSettings.js";
import {
  ProjectSettingsIoError,
  ProjectSettingsMalformedError,
  ProjectSettingsNotFoundError,
  ProjectSettingsUnsupportedVersionError,
  ProjectSettingsValidationError,
} from "./ProjectSettings.js";
import type { ProjectSettings } from "./ProjectSettings.js";

const makeDir = () => mkdtemp(join(tmpdir(), "project-settings-"));

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const failureOf = async <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (!Exit.isFailure(exit)) {
    throw new Error("Expected the effect to fail, but it succeeded");
  }
  return Cause.squash(exit.cause) as E;
};

const defaultScaffold: ScaffoldOptions = {
  agent: getAgent("claude-code")!,
  model: "claude-opus-4-8",
};

const runScaffold = (dir: string, options?: Partial<ScaffoldOptions>) =>
  run(scaffold(dir, { ...defaultScaffold, ...options }));

const fullSettings = (): ProjectSettings =>
  makeProjectSettings({
    agent: "claude-code",
    model: "claude-opus-4-8",
    effort: "max",
    agentExecutable: "claude",
    modelSource: "discovered",
    workflow: "parallel-planner-with-review",
    sandbox: "host",
    verificationCommands: ["npm run typecheck", "npm test"],
    parallelism: 4,
    roleOverrides: {
      planner: { agent: "codex", model: "gpt-5.4", effort: "high" },
      reviewer: { model: "claude-opus-4-8" },
    },
    issueTracker: "github-issues",
  });

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("ProjectSettings round-trip", () => {
  it("writes and reloads every supported value unchanged", async () => {
    const dir = await makeDir();
    const settings = fullSettings();

    await run(saveProjectSettings(dir, settings));
    const loaded = await run(loadProjectSettings(dir));

    expect(loaded).toEqual(settings);

    // The file lives at the documented location and is versioned.
    const raw = JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(raw["version"]).toBe(1);
    expect(projectSettingsPath(dir)).toBe(
      join(dir, ".sandcastle", "settings.json"),
    );
  });

  it("round-trips minimal settings with optional fields omitted", async () => {
    const dir = await makeDir();
    const settings = makeProjectSettings({
      agent: "pi",
      model: "claude-sonnet-4-6",
      workflow: "blank",
      sandbox: "podman",
      issueTracker: "beads",
    });

    await run(saveProjectSettings(dir, settings));
    const loaded = await run(loadProjectSettings(dir));

    expect(loaded).toEqual(settings);
    const raw = await readFile(projectSettingsPath(dir), "utf-8");
    expect(raw).not.toContain('"effort"');
    expect(raw).not.toContain('"agentExecutable"');
    expect(raw).not.toContain('"roleOverrides"');
    // Manual entry is the honest default — never claimed as discovered.
    expect(loaded.modelSource).toBe("manual-unverified");
    expect(loaded.parallelism).toBe(1);
  });

  it("loads a file written from a loaded-then-resaved document identically", async () => {
    const dir = await makeDir();
    const settings = fullSettings();
    await run(saveProjectSettings(dir, settings));
    const first = await readFile(projectSettingsPath(dir), "utf-8");

    const loaded = await run(loadProjectSettings(dir));
    await run(saveProjectSettings(dir, loaded));
    const second = await readFile(projectSettingsPath(dir), "utf-8");

    expect(second).toBe(first);
  });

  it("round-trips agentExecutable — the probed executable alias (#27)", async () => {
    const dir = await makeDir();
    const settings = makeProjectSettings({
      agent: "grok",
      model: "grok-4.6",
      agentExecutable: "agent",
      modelSource: "discovered",
      workflow: "simple-loop",
      sandbox: "host",
      issueTracker: "github-issues",
    });

    await run(saveProjectSettings(dir, settings));
    const loaded = await run(loadProjectSettings(dir));

    expect(loaded).toEqual(settings);
    const raw = await readFile(projectSettingsPath(dir), "utf-8");
    expect(raw).toContain('"agentExecutable": "agent"');
  });
});

// ---------------------------------------------------------------------------
// scaffold() integration — the observable init seam
// ---------------------------------------------------------------------------

describe("scaffold writes initial settings", () => {
  it("stores the init choices so later commands can reload them", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const loaded = await run(loadProjectSettings(dir));
    expect(loaded).toEqual({
      version: 1,
      agent: "claude-code",
      model: "claude-opus-4-8",
      modelSource: "manual-unverified",
      workflow: "blank",
      sandbox: "docker",
      verificationCommands: [],
      parallelism: 1,
      issueTracker: "github-issues",
    } satisfies ProjectSettings);
  });

  it("reflects the chosen tracker, sandbox, template, and settings overrides", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: getAgent("codex")!,
      model: "gpt-5.4",
      templateName: "parallel-planner",
      issueTracker: getIssueTracker("beads"),
      sandboxProvider: getSandboxProvider("podman"),
      settings: {
        effort: "ultra",
        modelSource: "discovered",
        verificationCommands: ["npm run typecheck"],
        parallelism: 3,
        roleOverrides: { merger: { model: "gpt-5.4-mini" } },
      },
    });

    const loaded = await run(loadProjectSettings(dir));
    expect(loaded).toEqual({
      version: 1,
      agent: "codex",
      model: "gpt-5.4",
      effort: "ultra",
      modelSource: "discovered",
      workflow: "parallel-planner",
      sandbox: "podman",
      verificationCommands: ["npm run typecheck"],
      parallelism: 3,
      roleOverrides: { merger: { model: "gpt-5.4-mini" } },
      issueTracker: "beads",
    } satisfies ProjectSettings);
  });

  it("can represent host mode even though no SandboxProviderEntry exists for it", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      settings: { sandbox: "host" },
    });

    const loaded = await run(loadProjectSettings(dir));
    expect(loaded.sandbox).toBe("host");
  });

  it("persists the probed executable alias from scaffold settings overrides", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: getAgent("grok")!,
      model: "grok-4.6",
      settings: { agentExecutable: "agent", sandbox: "host" },
    });

    const loaded = await run(loadProjectSettings(dir));
    expect(loaded.agent).toBe("grok");
    expect(loaded.agentExecutable).toBe("agent");
    // And the generated main passes it to the grok() factory options.
    const main = await readFile(join(dir, ".sandcastle", "main.mts"), "utf-8");
    expect(main).toContain('grok("grok-4.6", { executable: "agent" })');
  });

  it("defaults parallelism to 2 for parallel workflows and 1 otherwise", async () => {
    const parallelDir = await makeDir();
    await runScaffold(parallelDir, { templateName: "parallel-planner" });
    expect((await run(loadProjectSettings(parallelDir))).parallelism).toBe(2);

    const reviewDir = await makeDir();
    await runScaffold(reviewDir, {
      templateName: "parallel-planner-with-review",
    });
    expect((await run(loadProjectSettings(reviewDir))).parallelism).toBe(2);

    const sequentialDir = await makeDir();
    await runScaffold(sequentialDir, { templateName: "sequential-reviewer" });
    expect((await run(loadProjectSettings(sequentialDir))).parallelism).toBe(1);
  });

  it("keeps the old scaffold contract: config.json is still not written", async () => {
    const dir = await makeDir();
    await runScaffold(dir);
    const files = await readdir(join(dir, ".sandcastle"));
    expect(files).toContain("settings.json");
    expect(files).not.toContain("config.json");
  });
});

// ---------------------------------------------------------------------------
// Load diagnostics — distinct, actionable, Vietnamese
// ---------------------------------------------------------------------------

describe("loadProjectSettings diagnostics", () => {
  it("missing settings.json fails with guidance to run init/configure", async () => {
    const dir = await makeDir();

    const err = await failureOf(loadProjectSettings(dir));

    expect(err).toBeInstanceOf(ProjectSettingsNotFoundError);
    const notFound = err as ProjectSettingsNotFoundError;
    expect(notFound.settingsPath).toBe(projectSettingsPath(dir));
    expect(notFound.message).toContain("Không tìm thấy");
    expect(notFound.message).toContain("sandcastle init");
    expect(notFound.message).toContain("sandcastle configure");
  });

  it("a pre-settings scaffold (existing .sandcastle/, no file) reports the same migration path", async () => {
    const dir = await makeDir();
    // Simulate a project scaffolded before the settings seam existed.
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", "prompt.md"), "# custom prompt");

    const err = await failureOf(loadProjectSettings(dir));

    expect(err).toBeInstanceOf(ProjectSettingsNotFoundError);
    expect((err as Error).message).toContain("sandcastle configure");
  });

  it("malformed JSON fails with a distinct diagnostic naming the file", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(projectSettingsPath(dir), "{ not json !");

    const err = await failureOf(loadProjectSettings(dir));

    expect(err).toBeInstanceOf(ProjectSettingsMalformedError);
    const malformedErr = err as ProjectSettingsMalformedError;
    expect(malformedErr.settingsPath).toBe(projectSettingsPath(dir));
    expect(malformedErr.message).toContain("không hợp lệ");
    expect(malformedErr.message).toContain("sandcastle init");
    expect(malformedErr.message).not.toContain("Không tìm thấy");
  });

  it("schema-invalid content (bad parallelism) is reported as malformed", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      projectSettingsPath(dir),
      JSON.stringify({ ...fullSettings(), parallelism: 9 }),
    );

    const err = await failureOf(loadProjectSettings(dir));

    expect(err).toBeInstanceOf(ProjectSettingsMalformedError);
    expect((err as Error).message).toContain("parallelism");
  });

  it("unknown top-level keys are rejected rather than silently dropped", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      projectSettingsPath(dir),
      JSON.stringify({ ...fullSettings(), typoField: true }),
    );

    const err = await failureOf(loadProjectSettings(dir));

    expect(err).toBeInstanceOf(ProjectSettingsMalformedError);
    expect((err as Error).message).toContain("typoField");
  });

  it.each([2, "1", 0])(
    "unsupported version %s fails distinctly from malformed",
    async (version) => {
      const dir = await makeDir();
      await mkdir(join(dir, ".sandcastle"));
      await writeFile(
        projectSettingsPath(dir),
        JSON.stringify({ ...fullSettings(), version }),
      );

      const err = await failureOf(loadProjectSettings(dir));

      expect(err).toBeInstanceOf(ProjectSettingsUnsupportedVersionError);
      const versionErr = err as ProjectSettingsUnsupportedVersionError;
      expect(versionErr.foundVersion).toBe(version);
      expect(versionErr.message).toContain("cập nhật Sandcastle");
      expect(versionErr.message).toContain("sandcastle init");
    },
  );
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("updateProjectSettings", () => {
  it("patches fields and returns the updated settings", async () => {
    const dir = await makeDir();
    await run(saveProjectSettings(dir, fullSettings()));

    const updated = await run(
      updateProjectSettings(dir, {
        model: "claude-sonnet-4-6",
        parallelism: 2,
        verificationCommands: ["make check"],
      }),
    );

    expect(updated.model).toBe("claude-sonnet-4-6");
    expect(updated.parallelism).toBe(2);
    expect(updated.verificationCommands).toEqual(["make check"]);
    // Untouched fields survive.
    expect(updated.agent).toBe("claude-code");
    expect(updated.workflow).toBe("parallel-planner-with-review");
    expect(updated.sandbox).toBe("host");

    const reloaded = await run(loadProjectSettings(dir));
    expect(reloaded).toEqual(updated);
  });

  it("merges role overrides per key and removes them on null", async () => {
    const dir = await makeDir();
    await run(saveProjectSettings(dir, fullSettings()));

    const updated = await run(
      updateProjectSettings(dir, {
        roleOverrides: {
          planner: { effort: "low" }, // merge into existing planner override
          reviewer: null, // remove reviewer override entirely
          merger: { agent: "pi" }, // add a new role override
        },
      }),
    );

    expect(updated.roleOverrides).toEqual({
      planner: { agent: "codex", model: "gpt-5.4", effort: "low" },
      merger: { agent: "pi" },
    });
  });

  it("clears an optional field with null and drops emptied role override objects", async () => {
    const dir = await makeDir();
    await run(saveProjectSettings(dir, fullSettings()));

    const updated = await run(
      updateProjectSettings(dir, {
        effort: null,
        roleOverrides: { planner: { agent: null, model: null, effort: null } },
      }),
    );

    expect(updated.effort).toBeUndefined();
    expect(updated.roleOverrides).toEqual({
      reviewer: { model: "claude-opus-4-8" },
    });
    const raw = await readFile(projectSettingsPath(dir), "utf-8");
    expect(raw).not.toContain('"effort"');
  });

  it("rejects an invalid patch without writing", async () => {
    const dir = await makeDir();
    const original = fullSettings();
    await run(saveProjectSettings(dir, original));
    const before = await readFile(projectSettingsPath(dir), "utf-8");

    const err = await failureOf(updateProjectSettings(dir, { parallelism: 0 }));

    expect(err).toBeInstanceOf(ProjectSettingsValidationError);
    expect(await readFile(projectSettingsPath(dir), "utf-8")).toBe(before);
  });

  it("surfaces the not-found diagnostic when no settings file exists", async () => {
    const dir = await makeDir();
    const err = await failureOf(updateProjectSettings(dir, { model: "x" }));
    expect(err).toBeInstanceOf(ProjectSettingsNotFoundError);
  });

  it("never rewrites prompts, workflow code, or other .sandcastle files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const before = new Map<string, string>();
    for (const name of await readdir(configDir)) {
      before.set(name, await readFile(join(configDir, name), "utf-8"));
    }
    // A user customization that must survive a settings update.
    const promptPath = join(configDir, "prompt.md");
    await writeFile(promptPath, before.get("prompt.md") + "\n# my edits\n");
    const customizedPrompt = await readFile(promptPath, "utf-8");

    await run(
      updateProjectSettings(dir, {
        model: "claude-sonnet-4-6",
        effort: "high",
      }),
    );

    const after = await readdir(configDir);
    expect(new Set(after)).toEqual(new Set(before.keys()));
    for (const name of after) {
      const content = await readFile(join(configDir, name), "utf-8");
      if (name === "settings.json") {
        expect(content).toContain("claude-sonnet-4-6");
      } else {
        expect(content).toBe(
          name === "prompt.md" ? customizedPrompt : before.get(name),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// save validation
// ---------------------------------------------------------------------------

describe("saveProjectSettings validation", () => {
  it.each([0, 5, 2.5])(
    "rejects parallelism %s outside the 1–4 bound",
    async (parallelism) => {
      const dir = await makeDir();
      const err = await failureOf(
        saveProjectSettings(dir, {
          ...fullSettings(),
          parallelism,
        }),
      );
      expect(err).toBeInstanceOf(ProjectSettingsValidationError);
      expect((err as Error).message).toContain("parallelism");
    },
  );

  it("rejects a sandbox choice the schema cannot represent", async () => {
    const dir = await makeDir();
    const err = await failureOf(
      saveProjectSettings(dir, {
        ...fullSettings(),
        sandbox: "vercel" as never,
      }),
    );
    expect(err).toBeInstanceOf(ProjectSettingsValidationError);
  });
});

// ---------------------------------------------------------------------------
// Promise API — the seam re-exported through index.ts
// ---------------------------------------------------------------------------

describe("Promise API (index.ts seam)", () => {
  it("loadProjectSettingsAsync resolves settings and rejects with the typed error", async () => {
    const dir = await makeDir();
    const settings = fullSettings();
    await run(saveProjectSettings(dir, settings));

    await expect(loadProjectSettingsAsync(dir)).resolves.toEqual(settings);

    const emptyDir = await makeDir();
    await expect(loadProjectSettingsAsync(emptyDir)).rejects.toBeInstanceOf(
      ProjectSettingsNotFoundError,
    );
  });
});

import { exec } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).not.toContain("run");
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).toContain("podman");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).toContain("beads");
      expect(output).toContain("custom");
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
  });

  it("init writes a reloadable .sandcastle/settings.json with the chosen options", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { stdout } = await runCli(
      "init --agent claude-code --model claude-opus-4-8 --template simple-loop --sandbox podman --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      version: 1,
      agent: "claude-code",
      model: "claude-opus-4-8",
      modelSource: "manual-unverified",
      workflow: "simple-loop",
      sandbox: "podman",
      issueTracker: "beads",
      verificationCommands: [],
      parallelism: 1,
    });
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker custom ignores --build-image and scaffolds without trying to build", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    // --build-image is meaningless for the custom tracker (Dockerfile is
    // deliberately broken until configured) and must be silently ignored
    // rather than fail-fast or attempt a build.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker custom --build-image true",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
  });

  it("init --sandbox host scaffolds host mode with the warning and no image", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // No --build-image flag: host mode must not prompt for one even
    // non-interactively — there is no image to build.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox host --issue-tracker beads",
      hostDir,
    );

    // The Vietnamese trust warning is shown before the choice is saved —
    // a worktree is not OS isolation (ADR 0021).
    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("KHÔNG phải là sự cô lập");
    // Vietnamese host-mode completion/next steps, no image instructions.
    expect(stdout).toContain("Khởi tạo xong");
    expect(stdout).not.toContain("build-image");
    expect(stdout).not.toContain("docker build");

    // No image file, and the generated main uses noSandbox + merge-to-head.
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).not.toContain("Dockerfile");
    expect(entries).not.toContain("Containerfile");
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain("sandboxes/no-sandbox");
    expect(main).toContain("noSandbox()");
    expect(main).toContain('branchStrategy: { type: "merge-to-head" }');

    // The host choice is persisted to settings.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.sandbox).toBe("host");
  });

  it("init --sandbox host --template simple-loop scaffolds a runnable host worktree workflow", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { stdout } = await runCli(
      "init --agent claude-code --template simple-loop --sandbox host --issue-tracker beads",
      hostDir,
    );

    // Host-mode trust warning + Vietnamese completion, no image instructions.
    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("Khởi tạo xong");
    expect(stdout).not.toContain("build-image");

    // The generated main runs the agent on the host in a separate worktree
    // with explicit merge-to-head, and carries no container-only setup.
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).not.toContain("Dockerfile");
    expect(entries).not.toContain("Containerfile");
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain("sandboxes/no-sandbox");
    expect(main).toContain("noSandbox()");
    expect(main).toContain('branchStrategy: { type: "merge-to-head" }');
    expect(main).toContain('copyToWorktree: ["node_modules"]');
    expect(main).not.toContain("onSandboxReady");
    expect(main).not.toContain("npm install");
    expect(main).not.toContain("docker");

    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings.sandbox).toBe("host");
    expect(settings.workflow).toBe("simple-loop");
  });

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "init --sandbox host --template %s scaffolds a branch-isolated host workflow",
    async (template) => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");

      // --install-template-deps false declines the zod offer (parallel
      // templates declare a zod dependency for the planner's <plan> schema).
      const { stdout } = await runCli(
        `init --agent claude-code --template ${template} --sandbox host --issue-tracker beads --install-template-deps false`,
        hostDir,
      );

      expect(stdout).toContain("Khởi tạo xong");
      const entries = await readdir(join(hostDir, ".sandcastle"));
      expect(entries).not.toContain("Dockerfile");
      expect(entries).not.toContain("Containerfile");

      const main = await readFile(
        join(hostDir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("sandboxes/no-sandbox");
      expect(main).toContain("noSandbox()");
      // Every concurrent implementer works on its own explicit branch; the
      // container-only install hook never reaches host output.
      expect(main).toContain("issue.branch");
      expect(main).not.toContain("npm install");
      expect(main).not.toContain("onSandboxReady");
      expect(main).not.toContain("sandcastle:sandbox-");
    },
  );

  // ---------------------------------------------------------------------
  // Host-mode agent discovery (ADR 0021): `init --agent codex --sandbox host`
  // probes the `codex` executable on PATH — fingerprint, login status, and
  // the live model catalog — then persists the selection. These tests use a
  // fake `codex` executable in a temp shim dir prepended to PATH; no real
  // CLI or subscription is ever touched.
  // ---------------------------------------------------------------------

  /**
   * Write a fake `codex` executable (a node script) into `dir`. `auth`
   * toggles `codex login status` between the real logged-in line and a
   * logged-out failure. The app-server branch answers the piped JSON-RPC
   * `initialize`/`model/list` requests with a two-model catalog.
   */
  const writeFakeCodex = async (dir: string, auth: boolean) => {
    const shim = join(dir, "codex");
    const loginLine = auth
      ? `console.log("Logged in using ChatGPT"); process.exit(0);`
      : `console.error("Not logged in"); process.exit(1);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("codex-cli 0.150.1");
  process.exit(0);
} else if (key === "login status") {
  ${loginLine}
} else if (key === "app-server") {
  let buf = "";
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => {
    for (const line of buf.split("\\n")) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id === undefined) continue;
      if (msg.method === "initialize") {
        console.log(JSON.stringify({ id: msg.id, result: {
          codexHome: "/tmp", platformFamily: "unix",
          platformOs: "macos", userAgent: "fake-codex" } }));
      } else if (msg.method === "model/list") {
        console.log(JSON.stringify({ id: msg.id, result: { data: [
          { id: "gpt-5.6-sol", model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol", description: "Everyday workhorse",
            isDefault: true, hidden: false, defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deep" },
              { reasoningEffort: "xhigh", description: "Deepest" }] },
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra", description: "Hardest problems",
            isDefault: false, hidden: false, defaultReasoningEffort: "xhigh",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium" },
              { reasoningEffort: "xhigh" }] },
        ], nextCursor: null } }));
      }
    }
    // Let the process exit naturally once stdin closes so piped stdout
    // fully flushes.
  });
} else {
  process.exit(1);
}
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  /** PATH containing the shim dir plus node's own dir (for /usr/bin/env node). */
  const shimmedPath = (shimDir: string) =>
    `${shimDir}:${dirname(process.execPath)}:${process.env.PATH}`;

  it("init --sandbox host --agent codex discovers and persists the recommended model and effort", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("Khởi tạo xong");

    // Discovered defaults: catalog's isDefault model + its default effort.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      modelSource: "discovered",
      sandbox: "host",
    });

    // And the generated main passes both to the codex() factory — no manual
    // edits needed for the discovered choices to reach the CLI.
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('codex("gpt-5.6-sol", { effort: "medium" })');
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent codex honors --model/--effort validated against the live catalog", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent codex --model gpt-5.6-terra --effort xhigh --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "xhigh",
      modelSource: "discovered",
    });
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('codex("gpt-5.6-terra", { effort: "xhigh" })');
  });

  it("init --sandbox host --agent codex rejects a model missing from the live catalog", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    try {
      await execAsync(
        `node ${cliPath} init --agent codex --model gpt-4-turbo --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("gpt-4-turbo");
      expect(output).toContain("không có trong catalog");
      expect(output).toContain("gpt-5.6-sol");
      expect(output).toContain("gpt-5.6-terra");
    }
  });

  it("init --sandbox host --agent codex rejects an effort the model does not support", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    try {
      await execAsync(
        `node ${cliPath} init --agent codex --model gpt-5.6-terra --effort low --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('"low"');
      expect(output).toContain("không được model");
      // terra only supports medium/xhigh in the fake catalog
      expect(output).toContain("xhigh");
    }
  });

  it("init --sandbox host --agent codex fails with login guidance when unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("codex login");
      // Nothing was scaffolded — the stop happens before any writes.
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init --sandbox host --agent codex fails with install guidance when codex is not on PATH", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    // A PATH with only node's own directory — no codex anywhere.
    const bareShimDir = await mkdtemp(join(tmpdir(), "empty-path-"));
    const barePath = `${bareShimDir}:${dirname(process.execPath)}`;

    try {
      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: barePath } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("Chưa tìm thấy Codex CLI");
      expect(output).toContain("npm install -g @openai/codex");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  // ---------------------------------------------------------------------
  // Host-mode Pi discovery (ADR 0021): `init --agent pi --sandbox host`
  // probes the `pi` executable — bare `--version`, the `--help` product
  // fingerprint, `pi --list-models` for auth + catalog, and read-only
  // `pi auth check` evidence — then persists the selection. These tests use
  // a fake `pi` executable in a temp shim dir prepended to PATH; no real CLI
  // or provider account is ever touched.
  // ---------------------------------------------------------------------

  /**
   * Write a fake `pi` executable (a node script) into `dir`. `auth` toggles
   * `pi --list-models` between a provider-grouped table and the real
   * "No models available" message. Every invocation emits the `[paseo-team]`
   * extension line on stderr, like the observed install.
   */
  const writeFakePi = async (dir: string, auth: boolean) => {
    const shim = join(dir, "pi");
    const modelsBlock = auth
      ? `console.log(\`provider   model                 context  max-out  thinking  images
anthropic  claude-opus-4-1       200K     32K      yes       yes
anthropic  claude-sonnet-4-5     200K     64K      yes       yes
google     gemini-3-pro-preview  1M       64K      yes       yes
openai     gpt-5.2               400K     128K     yes       yes\`);`
      : `console.log("No models available. Use /login to log into a provider via OAuth or API key.");`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.join(" ");
console.error("[paseo-team] PASEO_PI_ROLE unset — extension passive");
if (key === "--version") {
  console.log("0.84.4");
  process.exit(0);
}
if (key === "--help") {
  console.log("pi - AI coding assistant with read, bash, edit, write tools\\n\\nUsage:\\n  pi [options]");
  process.exit(0);
}
if (key === "--list-models") {
  ${modelsBlock}
  process.exit(0);
}
if (key.startsWith("auth check")) {
  const p = args[args.indexOf("--provider") + 1];
  console.log(JSON.stringify({ status: "ready", provider: p, authType: "api_key" }));
  process.exit(0);
}
process.exit(1);
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  it("init --sandbox host --agent pi discovers and persists the recommended model and thinking level", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-pi-"));
    await writeFakePi(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent pi --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("Khởi tạo xong");

    // Discovered defaults: pi's default-provider model + its default
    // thinking level, marked discovered.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "pi",
      model: "google/gemini-3-pro-preview",
      effort: "medium",
      modelSource: "discovered",
      sandbox: "host",
    });

    // The generated main passes both to the pi() factory — `thinking` is
    // pi's name for the effort option.
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain(
      'pi("google/gemini-3-pro-preview", { thinking: "medium" })',
    );
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent pi honors --model/--effort validated against the live catalog", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-pi-"));
    await writeFakePi(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent pi --model anthropic/claude-sonnet-4-5 --effort xhigh --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      effort: "xhigh",
      modelSource: "discovered",
    });
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain(
      'pi("anthropic/claude-sonnet-4-5", { thinking: "xhigh" })',
    );
  });

  it("init --sandbox host --agent pi fails with login guidance when no provider is configured", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-pi-"));
    await writeFakePi(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent pi --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("/login");
      // Nothing was scaffolded — the stop happens before any writes.
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init --sandbox host --agent pi fails with install guidance when pi is not on PATH", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const bareShimDir = await mkdtemp(join(tmpdir(), "empty-path-"));
    // Unlike the codex case, a real `pi` can live in node's own bin dir
    // (global npm install) — so PATH gets only a scratch dir with a `node`
    // symlink and nothing else.
    await symlink(process.execPath, join(bareShimDir, "node"));
    const barePath = bareShimDir;

    try {
      await execAsync(
        `node ${cliPath} init --agent pi --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: barePath } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("Chưa tìm thấy Pi");
      expect(output).toContain(
        "npm install -g @earendil-works/pi-coding-agent",
      );
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  // ---------------------------------------------------------------------
  // Same discovery seam for OpenCode: `--version` is a bare number so
  // identity comes from `--help`; auth readiness comes from `auth list`;
  // the verbose catalog carries `variants` used as effort choices.
  // ---------------------------------------------------------------------

  /**
   * Write a fake `opencode` executable (a node script) into `dir`. `auth`
   * toggles `opencode auth list` between one stored credential and an empty
   * list. The catalog is a two-model verbose document: one variant-free
   * `opencode` model first (the non-interactive default pick), one `openai`
   * model with variants.
   */
  const writeFakeOpenCode = async (dir: string, auth: boolean) => {
    const shim = join(dir, "opencode");
    const authLines = auth
      ? `console.log("●  OpenAI oauth"); console.log("└  1 credential"); process.exit(0);`
      : `console.log("└  0 credentials"); process.exit(0);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("1.18.31");
  process.exit(0);
} else if (key === "--help") {
  console.log([
    "Commands:",
    "  opencode run [message..]     run opencode with a message",
    "  opencode models [provider]   list all available models",
    "  opencode providers           manage AI providers and credentials",
    "  opencode serve               starts a headless opencode server",
  ].join("\\n"));
  process.exit(0);
} else if (key === "auth list") {
  ${authLines}
} else if (key === "models --verbose") {
  console.log("opencode/big-pickle");
  console.log(JSON.stringify({
    id: "big-pickle", providerID: "opencode", name: "Big Pickle",
    status: "active", variants: {},
  }, null, 2));
  console.log("openai/gpt-5.6-sol");
  console.log(JSON.stringify({
    id: "gpt-5.6-sol", providerID: "openai", name: "GPT-5.6 Sol",
    status: "active",
    variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
  }, null, 2));
  process.exit(0);
} else {
  process.exit(1);
}
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  it("init --sandbox host --agent opencode discovers providers and persists model + variant as effort", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
    await writeFakeOpenCode(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent opencode --model openai/gpt-5.6-sol --effort high --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "opencode",
      model: "openai/gpt-5.6-sol",
      effort: "high",
      modelSource: "discovered",
      sandbox: "host",
    });

    // The variant reaches the generated opencode() call — which the factory
    // emits as `opencode run --variant high`.
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain(
      'opencode("openai/gpt-5.6-sol", { variant: "high" })',
    );
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent opencode persists no effort for a variant-free model", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
    await writeFakeOpenCode(shimDir, true);

    // Non-interactive default: the catalog's first entry (big-pickle) has
    // `variants: {}` — no effort is invented and none is persisted.
    const { stdout } = await execAsync(
      `node ${cliPath} init --agent opencode --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "opencode",
      model: "opencode/big-pickle",
      modelSource: "discovered",
    });
    expect(settings.effort).toBeUndefined();
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('opencode("opencode/big-pickle")');
    expect(main).not.toContain("variant");
  });

  it("init --sandbox host --agent opencode fails with login guidance when unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
    await writeFakeOpenCode(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent opencode --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("opencode auth login");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });
});

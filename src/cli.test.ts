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
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadProjectSettings } from "./ProjectSettings.js";

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
    expect(stdout).toContain("run");
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

    expect(stdout).toContain("Khởi tạo xong");
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

    expect(stdout).toContain("Khởi tạo xong");
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
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    // gh readiness is probed before the label question — provide an
    // authenticated fake gh so the missing-flag failure is what surfaces.
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true });

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
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

    expect(stdout).toContain("Khởi tạo xong");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
  });

  it("init --sandbox host scaffolds host mode with the warning and no image", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    // Host-mode init now fingerprints `claude` — provide a fake executable.
    const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    await writeFakeClaude(shimDir, true);

    // No --build-image flag: host mode must not prompt for one even
    // non-interactively — there is no image to build.
    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
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
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    await writeFakeClaude(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template simple-loop --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
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
      if (process.platform === "win32") return; // POSIX shim only
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
      await writeFakeClaude(shimDir, true);

      // --install-template-deps false declines the zod offer (parallel
      // templates declare a zod dependency for the planner's <plan> schema).
      const { stdout } = await execAsync(
        `node ${cliPath} init --agent claude-code --template ${template} --sandbox host --issue-tracker beads --install-template-deps false`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
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

  it("init --sandbox host --agent claude-code persists the flag model as manual-unverified (no catalog)", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    await writeFakeClaude(shimDir, true);

    // Claude Code is verified and logged in, but its CLI exposes no model
    // catalog — the --model flag is accepted without catalog validation and
    // the selection is honestly marked unverified rather than "discovered".
    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --model claude-sonnet-4-6 --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "claude-code",
      model: "claude-sonnet-4-6",
      modelSource: "manual-unverified",
      sandbox: "host",
    });
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('claudeCode("claude-sonnet-4-6")');
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent claude-code fails with login guidance when unauthenticated", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    await writeFakeClaude(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      // Login guidance names the host login command, not an API key.
      expect(output).toContain("claude auth login");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

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

  /**
   * Write a fake `claude` executable into `dir` answering the two probes the
   * Claude Code adapter runs: `--version` (product fingerprint) and
   * `auth status` (JSON `loggedIn`). Host-mode init for claude-code now runs
   * discovery, so tests must never touch the machine's real `claude`.
   */
  const writeFakeClaude = async (dir: string, auth: boolean) => {
    const shim = join(dir, "claude");
    const authLine = auth
      ? `console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth" })); process.exit(0);`
      : `console.log(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
} else if (key === "auth status") {
  ${authLine}
} else {
  process.exit(1);
}
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  /**
   * Write a fake `gh` executable into `dir` answering the exact subcommands
   * init probes: `--version` (install check), `auth status` (login check),
   * and `label create` (label setup). Never reaches the real GitHub CLI or
   * real credentials.
   */
  const writeFakeGh = async (
    dir: string,
    options: {
      authenticated?: boolean;
      labelCreate?: "ok" | "exists" | "denied";
    } = {},
  ) => {
    const shim = join(dir, "gh");
    const authenticated = options.authenticated !== false;
    const labelCreate = options.labelCreate ?? "ok";
    const authBlock = authenticated
      ? `console.log("github.com"); process.exit(0);`
      : `console.error("You are not logged into any GitHub hosts. Run gh auth login to authenticate."); process.exit(1);`;
    const labelBlock =
      labelCreate === "ok"
        ? `console.log("✓ Label created"); process.exit(0);`
        : labelCreate === "exists"
          ? `console.error("the label 'Sandcastle' already exists"); process.exit(1);`
          : `console.error("gh: Resource not accessible by integration (HTTP 403)"); process.exit(1);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") { console.log("gh version 2.90.0 (2026-04-16)"); process.exit(0); }
if (key === "auth status") { ${authBlock} }
if (key.startsWith("label create")) { ${labelBlock} }
process.exit(1);
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

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
  // --allow-unverified (ADR 0021): the non-interactive parity for the
  // picker's "manual entry (unverified)" recovery choice. With it, a
  // --model/--effort pair that discovery could not verify is accepted and
  // honestly marked `manual-unverified` in settings.json; without it the
  // same situations exit non-zero with the actionable guidance.
  // ---------------------------------------------------------------------

  it("init --help exposes --allow-unverified", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--allow-unverified");
  });

  it("init --sandbox host --agent codex --allow-unverified accepts --model/--effort when unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, false);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent codex --model custom-model --effort ultra --template blank --sandbox host --issue-tracker beads --allow-unverified`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    // The values were never checked against a live catalog — settings must
    // say manual-unverified, and must keep saying it when reloaded later.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "codex",
      model: "custom-model",
      effort: "ultra",
      modelSource: "manual-unverified",
      sandbox: "host",
    });
    const loaded = await Effect.runPromise(
      loadProjectSettings(hostDir).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    expect(loaded.modelSource).toBe("manual-unverified");
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('codex("custom-model", { effort: "ultra" })');
  });

  it("init --sandbox host --agent codex --allow-unverified without --model still fails naming the flag", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads --allow-unverified`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      // The actionable guidance plus the flag that makes the manual entry
      // explicit — no silent default is ever substituted.
      expect(output).toContain("codex login");
      expect(output).toContain("--model");
      expect(output).toContain("--allow-unverified");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init --sandbox host --agent codex --allow-unverified accepts a model outside the live catalog", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent codex --model gpt-4-turbo --template blank --sandbox host --issue-tracker beads --allow-unverified`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      model: "gpt-4-turbo",
      modelSource: "manual-unverified",
    });
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('codex("gpt-4-turbo")');
  });

  it("init --sandbox host --agent codex --allow-unverified keeps an unsupported effort as manual-unverified", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
    await writeFakeCodex(shimDir, true);

    // terra only supports medium/xhigh in the fake catalog — "low" is
    // accepted but the whole selection is honestly marked unverified.
    const { stdout } = await execAsync(
      `node ${cliPath} init --agent codex --model gpt-5.6-terra --effort low --template blank --sandbox host --issue-tracker beads --allow-unverified`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      model: "gpt-5.6-terra",
      effort: "low",
      modelSource: "manual-unverified",
    });
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('codex("gpt-5.6-terra", { effort: "low" })');
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

  // ---------------------------------------------------------------------
  // Devin discovery (ADR 0021): `init --agent devin --sandbox host` probes
  // the `devin` executable on PATH — the `devin ` version fingerprint,
  // `devin auth status`, and the account-scoped `devin models list --format
  // json` catalog — then persists the selection. These tests use a fake
  // `devin` executable in a temp shim dir prepended to PATH; no real CLI or
  // subscription is ever touched.
  // ---------------------------------------------------------------------

  /**
   * Write a fake `devin` executable (a node script) into `dir`. `auth`
   * toggles `devin auth status` between the real logged-in line and a
   * logged-out failure. The catalog is a two-family Devin-shaped document:
   * thinking levels are variant `model_uid`s, never a separate effort flag.
   */
  const writeFakeDevin = async (dir: string, auth: boolean) => {
    const shim = join(dir, "devin");
    const authLine = auth
      ? `console.log("Logged in (via Devin)."); process.exit(0);`
      : `console.error("Not logged in"); process.exit(1);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("devin 3000.10.31 (b98cc431)");
  process.exit(0);
} else if (key === "auth status") {
  ${authLine}
} else if (key === "models list --format json") {
  console.log(JSON.stringify({ families: [
    { family_label: "Claude Opus 5", family_uid: "claude-opus-5",
      slug: "claude-opus-5", aliases: ["opus"], variants: [
        { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium",
          cost_tier: "High cost" },
        { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High",
          cost_tier: "High cost" },
        { model_uid: "claude-opus-5-max", label: "Claude Opus 5 Max",
          cost_tier: "High cost" }] },
    { family_label: "Claude Sonnet 5", family_uid: "claude-sonnet-5",
      slug: "claude-sonnet-5", aliases: ["sonnet"], variants: [
        { model_uid: "claude-sonnet-5-low", label: "Claude Sonnet 5 Low" },
        { model_uid: "claude-sonnet-5-medium", label: "Claude Sonnet 5 Medium" },
        { model_uid: "claude-sonnet-5-high", label: "Claude Sonnet 5 High" }] },
  ] }));
  process.exit(0);
} else {
  process.exit(1);
}
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  it("init --sandbox host --agent devin discovers and persists the recommended model", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-devin-"));
    await writeFakeDevin(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent devin --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("Khởi tạo xong");

    // Discovered default: the catalog's first (flagship) family. Devin's
    // catalog declares no default variant, so no effort is persisted —
    // `--model claude-opus-5` lets Devin resolve the family default itself.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "devin",
      model: "claude-opus-5",
      modelSource: "discovered",
      sandbox: "host",
    });
    expect(settings.effort).toBeUndefined();

    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain('devin("claude-opus-5")');
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent devin persists a chosen variant model_uid as effort", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-devin-"));
    await writeFakeDevin(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent devin --model claude-sonnet-5 --effort claude-sonnet-5-high --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      model: "claude-sonnet-5",
      effort: "claude-sonnet-5-high",
      modelSource: "discovered",
    });
    // The exact model_uid is generated as the variant option — it reaches
    // Devin's --model unchanged, with no invented effort flag.
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain(
      'devin("claude-sonnet-5", { variant: "claude-sonnet-5-high" })',
    );
  });

  it("init --sandbox host --agent devin rejects a variant the family does not offer", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-devin-"));
    await writeFakeDevin(shimDir, true);

    try {
      await execAsync(
        `node ${cliPath} init --agent devin --model claude-sonnet-5 --effort claude-opus-5-max --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('"claude-opus-5-max"');
      expect(output).toContain("không được model");
      // sonnet only offers low/medium/high uids in the fake catalog
      expect(output).toContain("claude-sonnet-5-high");
    }
  });

  it("init --sandbox host --agent devin fails with login guidance when unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-devin-"));
    await writeFakeDevin(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent devin --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("devin auth login");
      // Nothing was scaffolded — the stop happens before any writes.
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  // ---------------------------------------------------------------------
  // Host-mode discovery for `--agent antigravity`: a fake `agy` executable
  // answers --version / --help / models like the real CLI. No real binary or
  // subscription is ever touched.
  // ---------------------------------------------------------------------

  const AGY_HELP = `Usage of agy:
  --dangerously-skip-permissions  Auto-approve all tool permission requests
  --effort                        Reasoning effort (low|medium|high)
  --input-format                  Input format for print mode (text, stream-json)
  --model                         Model for the current CLI session
  --prompt-interactive            Run an initial prompt interactively

Available subcommands:
  mic-serve       Serve this machine's microphone
  models          List available models
`;

  const AGY_CATALOG = `Fetching available models...
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
`;

  /**
   * Write a fake `agy` executable (a node script) into `dir`. `auth` toggles
   * `agy models` between the TSV catalog and the real sign-in notice.
   */
  const writeFakeAgy = async (dir: string, auth: boolean) => {
    const shim = join(dir, "agy");
    const modelsBranch = auth
      ? `console.log(${JSON.stringify(AGY_CATALOG)}); process.exit(0);`
      : `console.log("Please sign in to view available models. Launch the CLI without arguments to sign in."); process.exit(0);`;
    await writeFile(
      shim,
      `#!/usr/bin/env node
const key = process.argv.slice(2).join(" ");
if (key === "--version") {
  console.log("1.2.7");
  process.exit(0);
} else if (key === "--help") {
  console.log(${JSON.stringify(AGY_HELP)});
  process.exit(0);
} else if (key === "models") {
  ${modelsBranch}
} else {
  process.exit(1);
}
`,
    );
    await chmod(shim, 0o755);
    return shim;
  };

  it("init --sandbox host --agent antigravity discovers and persists the recommended model and effort", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-agy-"));
    await writeFakeAgy(shimDir, true);

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent antigravity --template blank --sandbox host --issue-tracker beads`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Cảnh báo chế độ host");
    expect(stdout).toContain("Khởi tạo xong");

    // Discovered defaults: the catalog's first model + its slug-encoded effort.
    const settings = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "settings.json"), "utf-8"),
    );
    expect(settings).toMatchObject({
      agent: "antigravity",
      model: "gemini-3.8-flash-high",
      effort: "high",
      modelSource: "discovered",
      sandbox: "host",
    });

    // Generated main calls the antigravity factory with the discovered effort.
    const main = await readFile(
      join(hostDir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(main).toContain(
      'antigravity("gemini-3.8-flash-high", { effort: "high" })',
    );
    expect(main).toContain("sandboxes/no-sandbox");
    expect(main).toContain("noSandbox()");
  });

  it("init --sandbox host --agent antigravity rejects an effort the model does not support", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-agy-"));
    await writeFakeAgy(shimDir, true);

    try {
      // claude-sonnet-4-6 exposes no effort choices — like the real CLI, which
      // rejects --effort for this model outright.
      await execAsync(
        `node ${cliPath} init --agent antigravity --model claude-sonnet-4-6 --effort high --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('"high"');
      expect(output).toContain("không được model");
    }
  });

  it("init --sandbox host --agent antigravity fails with login guidance when unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-agy-"));
    await writeFakeAgy(shimDir, false);

    try {
      await execAsync(
        `node ${cliPath} init --agent antigravity --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("Chạy `agy`");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init --sandbox host --agent antigravity fails with install guidance when agy is not on PATH", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const bareShimDir = await mkdtemp(join(tmpdir(), "empty-path-"));
    const barePath = `${bareShimDir}:${dirname(process.execPath)}`;

    try {
      await execAsync(
        `node ${cliPath} init --agent antigravity --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: barePath } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("Chưa tìm thấy Antigravity CLI");
      expect(output).toContain("antigravity.google/cli/install.sh");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  // ---------------------------------------------------------------------
  // Ticket #15 — GitHub readiness, verification detection, package script
  // ---------------------------------------------------------------------

  const readSettings = async (dir: string) =>
    JSON.parse(
      await readFile(join(dir, ".sandcastle", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;

  it("init --issue-tracker github-issues fails with repo guidance in a non-git directory (before gh probe or label)", async () => {
    if (process.platform === "win32") return;
    // No initRepo at all — cwd is a plain directory. The repository gate runs
    // before any `gh` probe or label mutation, so an authenticated fake gh
    // must not be consulted (F060: "not a git repository" must not masquerade
    // as a GitHub permission failure).
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true, labelCreate: "ok" });

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("không nằm trong một Git repository");
      // The repo error surfaces as itself — not as a label/permission error.
      expect(output).not.toContain("label");
      const entries = await readdir(hostDir);
      expect(entries).not.toContain(".sandcastle");
      expect(entries).not.toContain("package.json");
    }
  });

  it("init --issue-tracker github-issues fails with commit guidance on an unborn repository (before gh probe or label)", async () => {
    if (process.platform === "win32") return;
    // `git init` but no commit — HEAD does not resolve.
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true, labelCreate: "ok" });

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("chưa có commit");
      expect(output).not.toContain("label");
      const entries = await readdir(hostDir);
      expect(entries).not.toContain(".sandcastle");
    }
  });

  it("init --issue-tracker github-issues fails with install guidance when gh is missing", async () => {
    if (process.platform === "win32") return; // POSIX shim only
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    // PATH with only node and git — the repo gate (#31) needs real git to
    // see the usable checkout; `gh` alone is absent so its install guidance
    // is what must surface.
    const bareShimDir = await mkdtemp(join(tmpdir(), "empty-path-"));
    await symlink(process.execPath, join(bareShimDir, "node"));
    const gitBin = (await execAsync("command -v git")).stdout.trim();
    await symlink(gitBin, join(bareShimDir, "git"));

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false`,
        { cwd: hostDir, env: { ...process.env, PATH: bareShimDir } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("GitHub CLI");
      expect(output).toContain("cli.github.com");
      // The gh gate runs before any writes — nothing was left behind.
      const entries = await readdir(hostDir);
      expect(entries).not.toContain(".sandcastle");
      expect(entries).not.toContain("package.json");
    }
  });

  it("init --issue-tracker github-issues fails with login guidance when gh is unauthenticated", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: false });

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("gh auth login");
      const entries = await readdir(hostDir);
      expect(entries).not.toContain(".sandcastle");
      expect(entries).not.toContain("package.json");
    }
  });

  it("init --issue-tracker github-issues --create-label false completes with an authenticated gh and no label", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true });

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("Khởi tạo xong");
    const settings = await readSettings(hostDir);
    expect(settings["issueTracker"]).toBe("github-issues");
    // --create-label false → the scaffolded prompt does not filter by label.
    const prompt = await readFile(
      join(hostDir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label");
  });

  it("init --issue-tracker github-issues --create-label true creates the Sandcastle label", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true, labelCreate: "ok" });

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain('Đã tạo label "Sandcastle"');
    expect(stdout).toContain("Khởi tạo xong");
    // Confirmed label → the scaffolded prompt filters issues by it.
    const prompt = await readFile(
      join(hostDir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label");
  });

  it("init --issue-tracker github-issues --create-label true treats an existing label as fine", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, {
      authenticated: true,
      labelCreate: "exists",
    });

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain("đã tồn tại");
    expect(stdout).toContain("Khởi tạo xong");
  });

  it("init --issue-tracker github-issues --create-label true fails clearly when label creation is denied", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, {
      authenticated: true,
      labelCreate: "denied",
    });

    try {
      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      // Vietnamese failure report carrying gh's own error line.
      expect(output).toContain('Không tạo được label "Sandcastle"');
      expect(output).toContain("403");
      expect(output).toContain("--create-label false");
      // Label failure happens before any writes.
      const entries = await readdir(hostDir);
      expect(entries).not.toContain(".sandcastle");
      expect(entries).not.toContain("package.json");
    }
  });

  it("init detects package.json scripts as verification commands in canonical order", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
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

    await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    const settings = await readSettings(hostDir);
    // Run order: cheap checks first, tests, then the full build.
    expect(settings["verificationCommands"]).toEqual([
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
    ]);
    // Configured but not yet run — no status key (never reported passed).
    expect("verificationStatus" in settings).toBe(false);
  });

  it("init detects non-npm verification candidates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(join(hostDir, "go.mod"), "module example.com/x\n");

    await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    const settings = await readSettings(hostDir);
    expect(settings["verificationCommands"]).toEqual(["go test ./..."]);
  });

  it("init records verificationStatus unavailable when nothing is detected", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    const settings = await readSettings(hostDir);
    expect(settings["verificationCommands"]).toEqual([]);
    expect(settings["verificationStatus"]).toBe("unavailable");
  });

  it("init --skip-verification persists status skipped, ignoring detected candidates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false --skip-verification",
      hostDir,
    );

    const settings = await readSettings(hostDir);
    expect(settings["verificationCommands"]).toEqual([]);
    expect(settings["verificationStatus"]).toBe("skipped");
    expect(stdout).toContain("Đã bỏ qua lệnh xác minh");
  });

  it("init --verification-commands persists the explicit list instead of detection", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );

    await runCli(
      `init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false --verification-commands "make test, ./check.sh"`,
      hostDir,
    );

    const settings = await readSettings(hostDir);
    expect(settings["verificationCommands"]).toEqual([
      "make test",
      "./check.sh",
    ]);
  });

  it("init --verification-commands combined with --skip-verification fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        `init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false --verification-commands "npm test" --skip-verification`,
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("cannot be combined");
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init adds the sandcastle script to package.json, preserving unrelated scripts", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify(
        {
          name: "my-project",
          scripts: { test: "vitest", dev: "vite" },
        },
        null,
        2,
      ),
    );

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain('Đã thêm script "sandcastle"');
    const pkg = JSON.parse(
      await readFile(join(hostDir, "package.json"), "utf-8"),
    ) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe("my-project");
    expect(pkg.scripts).toEqual({
      test: "vitest",
      dev: "vite",
      sandcastle: "sandcastle run",
    });
  });

  it("init creates a minimal package.json with the sandcastle script when none exists", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Đã tạo package.json");
    const pkg = JSON.parse(
      await readFile(join(hostDir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["sandcastle"]).toBe("sandcastle run");
  });

  it("init fails clearly on a conflicting sandcastle script in non-interactive mode — nothing is written", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    const original = JSON.stringify({
      name: "conflict-fixture",
      scripts: { sandcastle: "echo mine", test: "vitest" },
    });
    await writeFile(join(hostDir, "package.json"), original);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain('"sandcastle" script');
      expect(output).toContain("--overwrite-script");
      // Never silently overwritten — and the failure happens before
      // scaffolding, so no partial .sandcastle/ is left behind.
      expect(await readFile(join(hostDir, "package.json"), "utf-8")).toBe(
        original,
      );
      expect(await readdir(hostDir)).not.toContain(".sandcastle");
    }
  });

  it("init --overwrite-script true replaces a conflicting sandcastle script", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({
        scripts: { sandcastle: "echo mine", test: "vitest" },
      }),
    );

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false --overwrite-script true",
      hostDir,
    );

    expect(stdout).toContain("Đã ghi đè");
    const pkg = JSON.parse(
      await readFile(join(hostDir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts).toEqual({
      sandcastle: "sandcastle run",
      test: "vitest",
    });
  });

  it("init --overwrite-script false keeps the existing script and warns", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({
        scripts: { sandcastle: "echo mine", test: "vitest" },
      }),
    );

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false --overwrite-script false",
      hostDir,
    );

    expect(stdout).toContain("Giữ nguyên");
    const pkg = JSON.parse(
      await readFile(join(hostDir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["sandcastle"]).toBe("echo mine");
    // Next steps don't claim `npm run sandcastle` works — they warn that the
    // kept script prevents it.
    expect(stdout).toContain("KHÔNG khởi động");
    expect(stdout).not.toContain("init đã thêm script");
  });

  it("init github-issues end-to-end: gh ready, label created, detection and script insertion", async () => {
    if (process.platform === "win32") return;
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({
        name: "e2e-fixture",
        scripts: { test: "vitest", typecheck: "tsc --noEmit" },
      }),
    );
    const shimDir = await mkdtemp(join(tmpdir(), "fake-gh-"));
    await writeFakeGh(shimDir, { authenticated: true, labelCreate: "ok" });

    const { stdout } = await execAsync(
      `node ${cliPath} init --agent claude-code --template sequential-reviewer --sandbox docker --issue-tracker github-issues --create-label true --build-image false`,
      { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
    );

    expect(stdout).toContain('Đã tạo label "Sandcastle"');
    expect(stdout).toContain('Đã thêm script "sandcastle"');
    expect(stdout).toContain("Khởi tạo xong");

    const settings = await readSettings(hostDir);
    expect(settings).toMatchObject({
      agent: "claude-code",
      workflow: "sequential-reviewer",
      sandbox: "docker",
      issueTracker: "github-issues",
      verificationCommands: ["npm run typecheck", "npm test"],
    });

    const pkg = JSON.parse(
      await readFile(join(hostDir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["sandcastle"]).toBe("sandcastle run");
    expect(pkg.scripts["test"]).toBe("vitest");

    // The scaffolded workflow files exist.
    const sandcastleFiles = await readdir(join(hostDir, ".sandcastle"));
    expect(sandcastleFiles).toContain("settings.json");
    expect(sandcastleFiles).toContain("main.mts");
  });

  // ---------------------------------------------------------------------
  // `sandcastle configure` (ticket #16): updates `.sandcastle/settings.json`
  // through updateProjectSettings only — prompts, workflow code, and
  // package.json stay byte-for-byte identical. vitest workers have no TTY,
  // so these tests exercise the flag-driven non-interactive path; a bare
  // `configure` displays the current settings instead of prompting. A
  // cancelled interactive run can't be simulated without a TTY — the
  // failed-run tests cover the "prior settings intact" guarantee since the
  // write only happens after every choice resolves.
  // ---------------------------------------------------------------------
  describe("configure", () => {
    const configure = (args: string, cwd: string, env?: NodeJS.ProcessEnv) =>
      execAsync(`node ${cliPath} configure ${args}`, {
        cwd,
        ...(env !== undefined ? { env } : {}),
      });

    const settingsFile = (dir: string) =>
      join(dir, ".sandcastle", "settings.json");

    /** Scaffold a docker+beads project — no shims needed (no host probe, no gh). */
    const initDockerProject = async (hostDir: string) => {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
        hostDir,
      );
    };

    /** Every file under `root`, mapped to its UTF-8 content. */
    const snapshotTree = async (root: string): Promise<Map<string, string>> => {
      const files = new Map<string, string>();
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else files.set(p, await readFile(p, "utf-8"));
        }
      };
      await walk(root);
      return files;
    };

    /**
     * Assert `after` is `before` plus possibly a changed settings.json — same
     * file set, every other file byte-identical.
     */
    const expectOnlySettingsChanged = (
      hostDir: string,
      before: Map<string, string>,
      after: Map<string, string>,
    ) => {
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, content] of after) {
        if (path === settingsFile(hostDir)) continue;
        expect(content, `${path} must be byte-identical`).toBe(
          before.get(path),
        );
      }
    };

    it("configure --help exposes the flag surface", async () => {
      const { stdout } = await runCli("configure --help", process.cwd());
      for (const flag of [
        "--agent",
        "--model",
        "--effort",
        "--clear-effort",
        "--allow-unverified",
        "--verification-commands",
        "--skip-verification",
        "--parallelism",
        "--set-role",
        "--clear-role",
      ]) {
        expect(stdout).toContain(flag);
      }
    });

    it("configure errors when settings.json is missing", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);

      try {
        await configure("", hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain(
          "Không tìm thấy tệp cấu hình Sandcastle",
        );
      }
    });

    it("configure errors on malformed settings.json", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      await writeFile(settingsFile(hostDir), "not json{");

      try {
        await configure("", hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("không hợp lệ");
      }
    });

    it("configure errors on an unsupported settings version", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const raw = JSON.parse(
        await readFile(settingsFile(hostDir), "utf-8"),
      ) as Record<string, unknown>;
      raw["version"] = 2;
      await writeFile(settingsFile(hostDir), JSON.stringify(raw, null, 2));

      try {
        await configure("", hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("không được hỗ trợ");
      }
    });

    it("configure with no flags prints current settings and changes nothing (non-interactive)", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const before = await readFile(settingsFile(hostDir), "utf-8");

      const { stdout } = await configure("", hostDir);
      // The current settings are displayed…
      expect(stdout).toContain("Cấu hình Sandcastle hiện tại");
      expect(stdout).toContain("claude-code");
      expect(stdout).toContain("claude-opus-4-8");
      // …and nothing was written.
      expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
    });

    it("configure --parallelism/--verification-commands update settings while every other file stays byte-identical", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await writeFile(
        join(hostDir, "package.json"),
        JSON.stringify({
          name: "cfg-fixture",
          scripts: { test: "vitest", typecheck: "tsc --noEmit" },
        }),
      );
      await initDockerProject(hostDir);
      // Customize the scaffold the way a user would — these edits must survive.
      await writeFile(
        join(hostDir, ".sandcastle", "prompt.md"),
        (await readFile(join(hostDir, ".sandcastle", "prompt.md"), "utf-8")) +
          "\nCUSTOM USER EDITS — do not erase\n",
      );
      await writeFile(
        join(hostDir, ".sandcastle", "main.mts"),
        (await readFile(join(hostDir, ".sandcastle", "main.mts"), "utf-8")) +
          "\n// user customization\n",
      );
      await writeFile(join(hostDir, ".sandcastle", "NOTES.md"), "user notes\n");
      const pkgBefore = await readFile(join(hostDir, "package.json"), "utf-8");
      const treeBefore = await snapshotTree(join(hostDir, ".sandcastle"));

      await configure(
        '--parallelism 3 --verification-commands "npm test, make check"',
        hostDir,
      );

      const settings = await readSettings(hostDir);
      expect(settings["parallelism"]).toBe(3);
      expect(settings["verificationCommands"]).toEqual([
        "npm test",
        "make check",
      ]);
      // A rewritten command list clears the stale status back to
      // "configured, not yet run" — the key is absent.
      expect("verificationStatus" in settings).toBe(false);
      // package.json (with its init-added sandcastle script) is untouched.
      expect(await readFile(join(hostDir, "package.json"), "utf-8")).toBe(
        pkgBefore,
      );
      const treeAfter = await snapshotTree(join(hostDir, ".sandcastle"));
      // settings.json may differ — everything else must be identical.
      expectOnlySettingsChanged(hostDir, treeBefore, treeAfter);
    });

    it.each([0, 5, 99])(
      "configure --parallelism %i fails and leaves settings intact",
      async (n) => {
        const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
        await initRepo(hostDir);
        await initDockerProject(hostDir);
        const before = await readFile(settingsFile(hostDir), "utf-8");

        try {
          await configure(`--parallelism ${n}`, hostDir);
          expect.fail("Expected command to fail");
        } catch (err: unknown) {
          const { stdout, stderr } = err as {
            stdout: string;
            stderr: string;
          };
          expect(stdout + stderr).toContain("--parallelism");
          expect(stdout + stderr).toContain("1");
          expect(stdout + stderr).toContain("4");
        }
        expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
      },
    );

    it("configure --set-role/--clear-role manage per-role overrides and restore inheritance", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);

      await configure(
        "--set-role planner.model=gpt-5.4-mini --set-role planner.effort=low --set-role merger.agent=codex",
        hostDir,
      );
      let settings = await readSettings(hostDir);
      expect(settings["roleOverrides"]).toEqual({
        planner: { model: "gpt-5.4-mini", effort: "low" },
        merger: { agent: "codex" },
      });

      // Clearing one role drops just that override; the other survives.
      await configure("--clear-role planner", hostDir);
      settings = await readSettings(hostDir);
      expect(settings["roleOverrides"]).toEqual({
        merger: { agent: "codex" },
      });

      // Clearing the last override removes the roleOverrides key entirely —
      // every role inherits the shared defaults again.
      await configure("--clear-role merger", hostDir);
      settings = await readSettings(hostDir);
      expect("roleOverrides" in settings).toBe(false);
    });

    it("configure --set-role rejects malformed entries with clear errors", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const before = await readFile(settingsFile(hostDir), "utf-8");

      const cases: [string, string][] = [
        ["--set-role planner.model", "expects"],
        ["--set-role bogus.model=x", 'unknown role "bogus"'],
        ["--set-role planner.bogus=x", 'unknown field "bogus"'],
        ["--set-role planner.model=", "empty value"],
        ["--set-role planner.agent=nonexistent", 'unknown agent "nonexistent"'],
      ];
      for (const [args, needle] of cases) {
        try {
          await configure(args, hostDir);
          expect.fail(`Expected "${args}" to fail`);
        } catch (err: unknown) {
          const { stdout, stderr } = err as {
            stdout: string;
            stderr: string;
          };
          expect(stdout + stderr).toContain(needle);
        }
        expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
      }
    });

    it("configure fails when --set-role and --clear-role target the same role", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);

      try {
        await configure(
          "--set-role planner.model=x --clear-role planner",
          hostDir,
        );
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("cannot both target");
      }
    });

    it("configure --verification-commands conflicts with --skip-verification, and an empty list fails", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const before = await readFile(settingsFile(hostDir), "utf-8");

      try {
        await configure(
          '--verification-commands "npm test" --skip-verification',
          hostDir,
        );
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("cannot be combined");
      }
      try {
        await configure('--verification-commands ""', hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("at least one command");
      }
      expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
    });

    it("configure --skip-verification clears commands and records status skipped", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await writeFile(
        join(hostDir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest" } }),
      );
      await initDockerProject(hostDir);
      // Init detected `npm test` — configure must be able to turn it off.
      expect((await readSettings(hostDir))["verificationCommands"]).toEqual([
        "npm test",
      ]);

      await configure("--skip-verification", hostDir);
      const settings = await readSettings(hostDir);
      expect(settings["verificationCommands"]).toEqual([]);
      expect(settings["verificationStatus"]).toBe("skipped");
    });

    it("configure --model/--effort on a container project apply as manual-unverified without touching files", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const treeBefore = await snapshotTree(join(hostDir, ".sandcastle"));

      await configure("--model claude-sonnet-4-6 --effort high", hostDir);
      const settings = await readSettings(hostDir);
      expect(settings).toMatchObject({
        agent: "claude-code",
        model: "claude-sonnet-4-6",
        effort: "high",
        // No live catalog was consulted on a docker project — honest label.
        modelSource: "manual-unverified",
      });
      const treeAfter = await snapshotTree(join(hostDir, ".sandcastle"));
      expectOnlySettingsChanged(hostDir, treeBefore, treeAfter);
    });

    it("configure --agent on a container project swaps to the registry default model", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      // Persist an effort first so the agent swap's reset is observable.
      await configure("--effort high", hostDir);

      await configure("--agent pi", hostDir);
      const settings = await readSettings(hostDir);
      expect(settings).toMatchObject({
        agent: "pi",
        // pi's registry default — the old model/effort don't carry over.
        model: "claude-sonnet-4-6",
        modelSource: "manual-unverified",
      });
      expect(settings["effort"]).toBeUndefined();
    });

    it("configure --agent on a host project re-discovers model and effort; every other file is unchanged", async () => {
      if (process.platform === "win32") return; // POSIX shim only
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-agents-"));
      await writeFakeClaude(shimDir, true);
      await writeFakeCodex(shimDir, true);

      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env: { ...process.env, PATH: shimmedPath(shimDir) } },
      );
      // A user customization that must survive.
      await writeFile(
        join(hostDir, ".sandcastle", "main.mts"),
        (await readFile(join(hostDir, ".sandcastle", "main.mts"), "utf-8")) +
          "\n// user customization\n",
      );
      const treeBefore = await snapshotTree(join(hostDir, ".sandcastle"));

      await configure("--agent codex", hostDir, {
        ...process.env,
        PATH: shimmedPath(shimDir),
      });

      const settings = await readSettings(hostDir);
      // The changed agent re-ran live discovery: catalog default + effort.
      expect(settings).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        modelSource: "discovered",
        sandbox: "host",
      });
      const treeAfter = await snapshotTree(join(hostDir, ".sandcastle"));
      expectOnlySettingsChanged(hostDir, treeBefore, treeAfter);
      // Explicitly: the generated main still carries the init-time agent —
      // configure never rewrites workflow code.
      const main = await readFile(
        join(hostDir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain('claudeCode("claude-opus-4-8")');
      expect(main).toContain("user customization");
    });

    it("configure --model/--effort on a host project validate against the live catalog", async () => {
      if (process.platform === "win32") return;
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
      await writeFakeCodex(shimDir, true);
      const env = { ...process.env, PATH: shimmedPath(shimDir) };

      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env },
      );

      await configure("--model gpt-5.6-terra --effort xhigh", hostDir, env);
      let settings = await readSettings(hostDir);
      expect(settings).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-terra",
        effort: "xhigh",
        modelSource: "discovered",
      });

      // --effort alone re-validates against the persisted model's catalog —
      // terra only supports medium/xhigh, so medium is accepted.
      await configure("--effort medium", hostDir, env);
      settings = await readSettings(hostDir);
      expect(settings).toMatchObject({
        model: "gpt-5.6-terra",
        effort: "medium",
        modelSource: "discovered",
      });
    });

    it("configure --effort on a host project fails for a catalog-unsupported value", async () => {
      if (process.platform === "win32") return;
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
      await writeFakeCodex(shimDir, true);
      const env = { ...process.env, PATH: shimmedPath(shimDir) };

      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env },
      );
      const before = await readFile(settingsFile(hostDir), "utf-8");

      // sol's catalog efforts are low/medium/high/xhigh — "ultra" is rejected.
      try {
        await configure("--effort ultra", hostDir, env);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("ultra");
        expect(stdout + stderr).toContain("không được model");
      }
      expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
    });

    it("configure --agent fails with login guidance and leaves settings intact when discovery fails", async () => {
      if (process.platform === "win32") return;
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-agents-"));
      await writeFakeClaude(shimDir, true);
      await writeFakeCodex(shimDir, false); // unauthenticated
      const env = { ...process.env, PATH: shimmedPath(shimDir) };

      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env },
      );
      const before = await readFile(settingsFile(hostDir), "utf-8");

      try {
        await configure("--agent codex", hostDir, env);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("codex login");
      }
      // A failed configure writes nothing — prior settings stay intact.
      expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
    });

    it("configure --agent --allow-unverified accepts the flag pair when discovery cannot verify", async () => {
      if (process.platform === "win32") return;
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-agents-"));
      await writeFakeClaude(shimDir, true);
      await writeFakeCodex(shimDir, false);
      const env = { ...process.env, PATH: shimmedPath(shimDir) };

      await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env },
      );

      await configure(
        "--agent codex --model custom-model --effort ultra --allow-unverified",
        hostDir,
        env,
      );
      const settings = await readSettings(hostDir);
      expect(settings).toMatchObject({
        agent: "codex",
        model: "custom-model",
        effort: "ultra",
        modelSource: "manual-unverified",
      });
    });

    it("configure --clear-effort removes the persisted effort", async () => {
      if (process.platform === "win32") return;
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const shimDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
      await writeFakeCodex(shimDir, true);
      const env = { ...process.env, PATH: shimmedPath(shimDir) };

      await execAsync(
        `node ${cliPath} init --agent codex --template blank --sandbox host --issue-tracker beads`,
        { cwd: hostDir, env },
      );
      expect((await readSettings(hostDir))["effort"]).toBe("medium");

      await configure("--clear-effort", hostDir, env);
      const settings = await readSettings(hostDir);
      expect("effort" in settings).toBe(false);
      // The model stays discovered — clearing effort never un-verifies it.
      expect(settings["modelSource"]).toBe("discovered");
    });

    it("configure rejects --effort combined with --clear-effort and empty flag values", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);
      const before = await readFile(settingsFile(hostDir), "utf-8");

      try {
        await configure("--effort high --clear-effort", hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("cannot be combined");
      }
      try {
        await configure('--effort ""', hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("--clear-effort");
      }
      expect(await readFile(settingsFile(hostDir), "utf-8")).toBe(before);
    });

    it("configure --agent nonexistent fails listing available agents", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await initDockerProject(hostDir);

      try {
        await configure("--agent nonexistent", hostDir);
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("nonexistent");
        expect(stdout + stderr).toContain("claude-code");
      }
    });
  });
});

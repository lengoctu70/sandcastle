import { nodeDiscoveryExec } from "./discovery/nodeExec.js";
import type { DiscoveryExec } from "./discovery/contract.js";

/**
 * GitHub CLI readiness checks for `sandcastle init` (ADR 0026).
 *
 * When the `github-issues` tracker is selected, init verifies `gh` is
 * installed and authenticated on the host *before* anything is scaffolded —
 * issue operations must not fail after agent work has already completed.
 * Every probe goes through the injected {@link DiscoveryExec} process
 * boundary (same seam as agent discovery), so tests substitute fake
 * executables on PATH and never touch real GitHub accounts.
 *
 * User-facing strings (`detail`, messages built from these results in
 * cli.ts) are Vietnamese per ADR 0026; command names stay English.
 */

/** Ready state of the host's `gh` executable. */
export type GhReadiness =
  | {
      readonly kind: "ready";
      /** Parsed `gh --version` line, e.g. `"2.90.0"`. */
      readonly version?: string;
      /** First `gh auth status` account line (e.g. the logged-in account). */
      readonly authDetail?: string;
    }
  /** `gh` is not on PATH (spawn ENOENT). */
  | { readonly kind: "not-installed" }
  /** `gh` exists but `gh auth status` reports no usable login. */
  | { readonly kind: "unauthenticated"; readonly detail?: string }
  /** The CLI answered unexpectedly (non-zero `--version`, timeout, …). */
  | { readonly kind: "error"; readonly detail?: string };

const PROBE_TIMEOUT_MS = 15_000;

const firstLine = (text: string): string | undefined => {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line;
};

/**
 * Parse the `gh --version` banner (`"gh version 2.90.0 (2026-04-16)"`) down
 * to the bare version for status messages.
 */
const parseGhVersion = (stdout: string): string | undefined => {
  const match = stdout.match(/gh version (\S+)/);
  return match?.[1] ?? firstLine(stdout);
};

/**
 * Probe `gh --version` then `gh auth status`. Never throws — every outcome
 * is data on {@link GhReadiness}. `gh auth status` exits non-zero when no
 * host is authenticated; its report goes to stderr on failure.
 */
export const probeGhReadiness = async (
  exec: DiscoveryExec = nodeDiscoveryExec,
): Promise<GhReadiness> => {
  const version = await exec("gh", ["--version"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (version.spawnError !== undefined) {
    return version.spawnError === "ENOENT"
      ? { kind: "not-installed" }
      : { kind: "error", detail: version.spawnError };
  }
  if (version.exitCode !== 0) {
    return {
      kind: "error",
      detail:
        firstLine(version.stderr) ??
        `gh --version exited with code ${version.exitCode ?? "null"}`,
    };
  }

  const auth = await exec("gh", ["auth", "status"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (auth.exitCode === 0) {
    return {
      kind: "ready",
      version: parseGhVersion(version.stdout),
      authDetail: firstLine(auth.stdout) ?? firstLine(auth.stderr),
    };
  }
  return {
    kind: "unauthenticated",
    detail: firstLine(auth.stderr) ?? firstLine(auth.stdout),
  };
};

/** Outcome of attempting `gh label create "Sandcastle"`. */
export type SandcastleLabelResult =
  | { readonly kind: "created" }
  | { readonly kind: "already-exists" }
  /** Creation failed — `detail` carries gh's own error line (e.g. HTTP 403). */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Create the `Sandcastle` label on the current repository. Runs in the
 * caller's working directory (gh resolves the repo from cwd/remotes). An
 * already-existing label is reported separately — it is a fine outcome, not
 * an error. Any other failure (permissions, no remote, network) returns
 * `failed` with the CLI's error line for a Vietnamese report upstream.
 */
export const createSandcastleLabel = async (
  exec: DiscoveryExec = nodeDiscoveryExec,
): Promise<SandcastleLabelResult> => {
  const res = await exec(
    "gh",
    [
      "label",
      "create",
      "Sandcastle",
      "--description",
      "Issues for Sandcastle to work on",
      "--color",
      "F9A825",
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (res.exitCode === 0) return { kind: "created" };
  const output = `${res.stderr}\n${res.stdout}`.trim();
  if (/already exists/i.test(output)) return { kind: "already-exists" };
  return {
    kind: "failed",
    detail:
      firstLine(res.stderr) ??
      firstLine(res.stdout) ??
      `gh label create exited with code ${res.exitCode ?? "null"}`,
  };
};

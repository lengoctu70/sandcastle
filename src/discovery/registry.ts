import type {
  AgentDiscoveryAdapter,
  AgentDiscoveryReport,
  DiscoveryExec,
} from "./contract.js";
import { codexDiscoveryAdapter } from "./codex.js";
import { opencodeDiscoveryAdapter } from "./opencode.js";
import { nodeDiscoveryExec } from "./nodeExec.js";

/**
 * The discovery adapter registry — one adapter per discoverable agent.
 *
 * Adding an agent's discovery is deliberately additive: create the adapter
 * file next to `codex.ts`, then append ONE line here. Agents without an
 * adapter simply aren't discoverable yet — the init picker joins this list
 * with the scaffold agent registry and keeps undiscoverable agents on the
 * static path (ticket #14 renders the full per-agent state list).
 */
const DISCOVERY_ADAPTERS: readonly AgentDiscoveryAdapter[] = [
  codexDiscoveryAdapter,
  opencodeDiscoveryAdapter,
];

/** All registered discovery adapters, in display order. */
export const listDiscoveryAdapters = (): readonly AgentDiscoveryAdapter[] =>
  DISCOVERY_ADAPTERS;

/** The adapter serving one agent registry name (e.g. `"codex"`), if any. */
export const getDiscoveryAdapter = (
  agent: string,
): AgentDiscoveryAdapter | undefined =>
  DISCOVERY_ADAPTERS.find((adapter) => adapter.agent === agent);

const unexpectedErrorReport = (
  adapter: AgentDiscoveryAdapter,
  error: unknown,
): AgentDiscoveryReport => ({
  agent: adapter.agent,
  executable: adapter.executable,
  state: "error",
  models: [],
  detail: error instanceof Error ? error.message : String(error),
  guidance:
    `Không khám phá được ${adapter.agent}: ` +
    `${error instanceof Error ? error.message : String(error)}`,
});

/**
 * Probe one agent by registry name. Returns `undefined` when no adapter
 * exists for it. Adapters are contract-bound to report failures as
 * `state: "error"` rather than reject — this wrapper enforces it anyway so a
 * faulty adapter can never sink the picker.
 */
export const discoverAgent = async (
  agent: string,
  exec: DiscoveryExec = nodeDiscoveryExec,
): Promise<AgentDiscoveryReport | undefined> => {
  const adapter = getDiscoveryAdapter(agent);
  if (adapter === undefined) return undefined;
  try {
    return await adapter.discover(exec);
  } catch (e) {
    return unexpectedErrorReport(adapter, e);
  }
};

/**
 * Probe every registered agent. One adapter's failure never prevents the
 * others from reporting — each report stands alone.
 */
export const discoverAgents = async (
  exec: DiscoveryExec = nodeDiscoveryExec,
): Promise<AgentDiscoveryReport[]> =>
  Promise.all(
    DISCOVERY_ADAPTERS.map(async (adapter) => {
      try {
        return await adapter.discover(exec);
      } catch (e) {
        return unexpectedErrorReport(adapter, e);
      }
    }),
  );

import { run, claudeCode } from "@lengoctu70/sandcastle";
import { docker } from "@lengoctu70/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this file directly with: npx tsx .sandcastle/main.mts
// Init added the package.json script "sandcastle": "sandcastle run" — npm run sandcastle

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: "./.sandcastle/prompt.md",
});

---
"@lengoctu70/sandcastle": minor
---

Add an OpenCode discovery adapter to the shared discovery flow. `sandcastle init --agent opencode --sandbox host` now verifies the `opencode` executable by its `--help` fingerprint (block-art logo / `opencode <cmd>` command list, since `--version` prints only a bare number), checks credential readiness via `opencode auth list`, and reads the live `opencode models --verbose` catalog — models are grouped by provider (`opencode`, `opencode-go`, `openai`, …) and each model's `variants` become its valid effort choices, so a model without variants offers none. The picked model and variant persist to `settings.json` as `modelSource: "discovered"` and generate `opencode("<provider/model>", { variant: "<effort>" })`, which the factory passes through as `--variant`. Vietnamese guidance covers not-installed, wrong-product, and unauthenticated states; malformed catalog data is a terminal discovery error while unknown fields stay tolerated.

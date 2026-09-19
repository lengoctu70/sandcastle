---
"@lengoctu70/sandcastle": minor
---

Rename the distributable package from `@ai-hero/sandcastle` to `@lengoctu70/sandcastle` so the fork publishes under the owner's npm scope (ADR 0022). The executable stays `sandcastle`; install with `npm install --save-dev @lengoctu70/sandcastle` and scaffold with `npx @lengoctu70/sandcastle init`. All generated `main.mts`/host-variant imports and the repo's own `.sandcastle/` orchestration files now resolve `@lengoctu70/sandcastle` and its `./sandboxes/*` subpaths, and repository metadata points at `lengoctu70/sandcastle`.

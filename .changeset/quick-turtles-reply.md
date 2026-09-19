---
"@ai-hero/sandcastle": minor
---

Persist a versioned `.sandcastle/settings.json` during `init` and expose a shared load/save/update seam (`ProjectSettings`, `loadProjectSettings`, `saveProjectSettings`, `updateProjectSettings`) so future `run` and `configure` commands can reload the selected agent, model, effort, workflow, sandbox, verification commands, parallelism, per-role overrides, and issue tracker without re-prompting. Settings diagnostics are Vietnamese and actionable; saves never rewrite generated prompts or workflow files.

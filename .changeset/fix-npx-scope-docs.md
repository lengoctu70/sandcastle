---
"@lengoctu70/sandcastle": patch
---

Fix install docs that recommended bare `npx sandcastle …`. Without a local or global install, npx resolves `sandcastle` as a package name and runs an unrelated legacy npm package instead of this CLI. `README.md` and `INSTALL.md` now consistently use `npx @lengoctu70/sandcastle …`, and the `INSTALL.md` troubleshooting table warns about the unscoped-package name collision.

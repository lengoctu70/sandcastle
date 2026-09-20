---
"@lengoctu70/sandcastle": patch
---

`sandcastle init` is now non-destructive across common package-file encodings and first-run states. The scaffolded `.sandcastle/.gitignore` includes `recovery/` from the start, so the first workflow failure no longer dirties a tracked file. A `package.json` with a UTF-8 BOM is accepted for package-manager detection, dependency checks, verification-candidate detection, and `sandcastle` script insertion; rewrites preserve the BOM, the file's existing LF or CRLF line endings, and unrelated content. A `scripts` field that isn't a string map (array, `null`, primitive) is now reported and left untouched instead of being coerced, and a defined non-string `sandcastle` entry goes through the explicit conflict resolution rather than being silently overwritten. `!`...`` shell expressions inside `<!-- -->` comments in prompt files are now inert — the blank template's example commands can no longer execute and crash the first run on an unborn repository.

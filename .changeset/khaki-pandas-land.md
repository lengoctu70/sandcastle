---
"@lengoctu70/sandcastle": patch
---

Keep recovery durable after code lands (#37, F013/F045). Once a run merges work into the target branch, the recovery record now persists as an explicit post-landing state — `landed-awaiting-report` or `landed-awaiting-close`, carrying the exact completion report and landed SHA — instead of being deleted before the GitHub report and issue close run. A report or close failure no longer strands a merged-but-open issue with no record: `sandcastle retry <issue>` finishes only the outstanding GitHub steps (reposting the stored report, then closing) without invoking an agent or repeating the merge, and the source branch plus recovery metadata are only removed after the report posts and the issue closes — ADR 0023's report-before-close order is preserved, so a report failure never closes the issue first. `sandcastle status` and `sandcastle discard` now describe landed-pending records honestly instead of marking them stale.

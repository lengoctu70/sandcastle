---
"@lengoctu70/sandcastle": patch
---

Queue runs and recovery guidance now match durable reality. `sandcastle run --all` checks `.sandcastle/recovery/` before dispatching each issue: an issue with a preserved recovery record is skipped — never reimplemented — and points at `sandcastle retry <issue-number>`; a corrupt record is skipped with manual file-cleanup guidance instead of a failing `retry`/`discard` loop. Queue summaries only claim recovery state is retained when a readable record was actually written, and failures that left no usable record say so plainly. `status` and `discard` now treat a failed `target..source` comparison — including a deleted or renamed target branch — as unknown rather than "0 unmerged commits", so they never call uncertain work landed, empty, or stale; a zero-commit implementation failure is described as incomplete, and `discard` warns that the unmerged count could not be determined before deleting anything.

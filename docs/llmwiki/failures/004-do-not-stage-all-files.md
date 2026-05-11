# 004. Do Not Stage All Files

## Attempted Date
Known project convention as of 2026-05-11

## Attempted Reason
Agents often use `git add -A` or `git add .` as a default commit workflow.

## Context Conditions
- Project/subsystem: git workflow
- Runtime/dependencies: repo contains screenshots, uploads, `.DS_Store`, `.omc/` state/logs, and other local artifacts
- Traffic/data scale: local dev machine with generated artifacts
- Constraints at the time: avoid accidental commits of private or generated files

## Failed Approach
Using `git add -A` or `git add .` before committing.

## Failure Mode
Local artifacts or generated files may be staged accidentally, including screenshots, upload cache, logs, or tool state.

## Root Cause
The repo has real local runtime artifacts near source files. Explicit staging is safer and is documented in `CLAUDE.md` and `.omc/wiki/house-rules-and-conventions.md`.

## Current Alternative
Stage exact intended paths only.

## Detection / Retrieval Keys
- code pattern: n/a
- AST/symbolic signature: n/a
- dependency/tool signature: `git add -A`, `git add .`
- runtime symptom: unrelated local artifacts appear in `git diff --cached --name-only`
- context condition: WOTM repo commit workflow
- avoid rule: never stage all files
- prescription: `git add <explicit-path>...` then inspect `git diff --cached --name-status`

## Agent Instructions
- Never use `git add -A` or `git add .` in this repo.
- Check `git status --short` before and after staging.
- Stage only files created or intentionally changed for the task.

## Related Decisions / Claims / Sources
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Raw provenance: `CLAUDE.md`, `.omc/wiki/house-rules-and-conventions.md`

## Revisit Conditions
Revisit only if repo artifact layout and ignore policy are redesigned enough that broad staging is safe.

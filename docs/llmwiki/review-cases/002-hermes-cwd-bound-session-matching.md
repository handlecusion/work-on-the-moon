# 002. Hermes CWD-Bound Session Matching Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `07560771995c1471337e9dfcfc7ea5163ab6564e` (`fix: bind hermes sessions by cwd`)
- date: 2026-05-24

## Change Summary
The change binds running Hermes PIDs to active Hermes DB sessions by project cwd derived from `onboard_project` tool calls. It prevents WOTM from showing the freshest unrelated Hermes session when the user opens a different project.

## Relevant Graph Context
- graph snapshot: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- graph generated: 2026-05-24T14:14:16+09:00
- graph commit: `07560771995c1471337e9dfcfc7ea5163ab6564e`
- graph counts: 51 files / 693 nodes / 6,659 edges
- changed files: `lib/hermesDb.js`, `lib/hermesSessionScanner.js`, `test/hermes-session-matching.test.js`, `package.json`
- impacted flow: live session discovery, Hermes DB transcript backend, homepage local active list, `/chat-live` attachment

## Relevant Wiki Memory
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- ARD: `docs/llmwiki/ard/002-single-user-passkey-tunnel-security-model.md`
- failure: `docs/llmwiki/failures/004-do-not-stage-all-files.md`
- central source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- central claim: `/Users/ys/Code/wiki/claims/wotm-code-graph-snapshot-counts.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: correctness / data isolation
- evidence: `pickSessionForPid` now refuses a match when any cwd signal exists but no active session cwd matches the pid cwd.
- expected comment: Preserve this refusal behavior. Falling back to recency after partial cwd resolution would reintroduce cross-project session leakage.
- suggested fix: Keep tests that assert mismatch returns `null` when `cwdMap` contains any signal, and add future cases for parent-session inheritance if regressions appear.

### Finding 2
- severity: low
- concern: parser robustness
- evidence: `extractOnboardCwd` parses both JSON-like tool args and plain-text result strings from Hermes DB message blobs.
- expected comment: This parser is intentionally narrow around `onboard_project`; avoid widening it into arbitrary path scraping because false cwd matches are worse than no match.
- suggested fix: Keep parser fixtures for escaped JSON args, plain result text, spaces in cwd, and no-marker/no-cwd inputs.

### Finding 3
- severity: low
- concern: verification
- evidence: the change depends on live Hermes state and DB content in addition to unit tests.
- expected comment: Unit tests cover matching logic, but a local `scanHermes()` smoke against the maintainer DB should be recorded for release confidence.
- suggested fix: Run `npm test`, `node --check` for changed modules, and a local `scanHermes()` smoke when the Hermes DB exists.

## Expected Non-Findings
- Do not recommend freshness-only session matching when cwd signals exist.
- Do not require a new SQLite dependency; the project intentionally shells out to macOS `/usr/bin/sqlite3`.
- Do not merge Hermes handling into the Claude JSONL scanner.
- Do not treat missing cwd as a security failure by itself; it is an unknown-project state that should avoid wrong attachment.

## Verification Plan
- `npm test`
- `node --check lib/hermesDb.js`
- `node --check lib/hermesSessionScanner.js`
- local `scanHermes()` smoke against `~/.hermes/state.db` when available
- `git diff --check`

## Feedback Loop
- This is the preferred first productization dry-run target because the bug came from real cross-project session confusion and the review needs both graph context and project-local invariants.


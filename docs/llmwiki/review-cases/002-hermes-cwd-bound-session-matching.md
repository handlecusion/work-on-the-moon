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
- concern: correctness / stale project binding
- evidence: `resolveActiveSessionCwds` orders candidate message rows by active session and parent-chain depth, then keeps the first cwd found for each active session.
- expected comment: If a single Hermes session contains multiple `onboard_project` calls at the same chain depth, the selected cwd can be stale or nondeterministic. That can make the later cwd-bound matching logic operate on the wrong project signal.
- suggested fix: Select message timestamp/id in the resolver query, order same-depth rows newest-first, and add a regression case for two `onboard_project` calls in the same active session plus the existing parent-session inheritance behavior.

### Finding 2
- severity: medium
- concern: correctness / data isolation
- evidence: `pickSessionForPid` now refuses a match when any cwd signal exists but no active session cwd matches the pid cwd.
- expected comment: Preserve this refusal behavior. Falling back to recency after partial cwd resolution would reintroduce cross-project session leakage.
- suggested fix: Keep tests that assert mismatch returns `null` when `cwdMap` contains any signal, and add future cases for parent-session inheritance if regressions appear.

### Finding 3
- severity: low
- concern: parser robustness
- evidence: `extractOnboardCwd` parses both JSON-like tool args and plain-text result strings from Hermes DB message blobs.
- expected comment: This parser is intentionally narrow around `onboard_project`; avoid widening it into arbitrary path scraping because false cwd matches are worse than no match.
- suggested fix: Keep parser fixtures for escaped JSON args, plain result text, spaces in cwd, and no-marker/no-cwd inputs.

### Finding 4
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

## Harness Output

Dry-run date: 2026-05-24

Target reviewed:

- commit `07560771995c1471337e9dfcfc7ea5163ab6564e` (`fix: bind hermes sessions by cwd`)
- dry-run executed from current WOTM HEAD `8adb8ace98afc060eea40e3a52ccf8755effc08f`; the only later project change was docs-only harness expansion

Review pipeline used:

1. Onboarding: `llmwiki onboard` reported `graph_status=fresh`, graph commit `8adb8ace98afc060eea40e3a52ccf8755effc08f`, and graph summary `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`.
2. Project-local memory: `CLAUDE.md`, `docs/llmwiki/README.md`, `docs/llmwiki/review-context-contract.md`, ARD 004 managed/live separation, ARD 002 passkey+tunnel security model, and failure 004 explicit staging rule.
3. Central wiki memory: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`, `/Users/ys/Code/wiki/wiki/projects/working-on-the-moon.md`, and `/Users/ys/Code/wiki/claims/wotm-code-graph-snapshot-counts.md`.
4. Graph evidence: changed files map to `lib/hermesDb.js` (10 functions), `lib/hermesSessionScanner.js` (20 functions), and `test/hermes-session-matching.test.js` (6 test cases plus file node). Extracted edges show `resolveActiveSessionCwds -> runQuery`, `resolveActiveSessionCwds -> extractOnboardCwd`, `enrich -> pickSessionForPid`, and `pickSessionForPid -> normalizeCwd`.
5. Static verification: `npm test`, `node --check lib/hermesDb.js`, `node --check lib/hermesSessionScanner.js`, and `git diff --check` passed.
6. Live smoke: `scanHermes()` completed against the local Hermes state DB and returned one active Hermes session bound to cwd `/Users/ys/Code/agent-safari` with backend `state_db`.

Aggregated findings:

### Finding 1
- severity: medium
- concern: correctness / stale project binding
- evidence: `lib/hermesDb.js` keeps the first cwd per active session after ordering SQL rows only by `active_id, depth`; same-depth rows from the same session are not newest-first. If a Hermes agent reused one session across projects, an older `onboard_project` row can win before `pickSessionForPid` sees the cwd map.
- expected comment: Make cwd resolution deterministic and latest-aware within the same active session. The cwd-bound matcher is safe once it receives the right map, but this resolver can feed it stale project state.
- suggested fix: Include `m.timestamp` and/or message `id` in the resolver query, order by `active_id, depth, timestamp DESC, id DESC`, and add a regression fixture for multiple onboard calls in one session.

### Finding 2
- severity: low
- concern: verification
- evidence: the live `scanHermes()` smoke proved DB/process integration does not crash, but the observed live state had only one active Hermes session and did not exercise simultaneous WOTM/other-project collision.
- expected comment: Keep the unit tests as the main regression guard, but record a two-active-Hermes smoke before claiming full field verification of the cross-project leakage fix.
- suggested fix: When practical, run two Hermes sessions in different cwd values and confirm WOTM does not display the other project's active session.

Positive checks:

- The partial cwd-signal safety branch is correct: when any cwd signal exists and no cwd matches the pid, `pickSessionForPid` returns `null` rather than falling back to recency.
- No new SQLite dependency was introduced; the project still uses macOS `/usr/bin/sqlite3`.
- Hermes DB handling remains separate from the Claude JSONL scanner.
- Managed/live separation was not weakened.

## Evaluation

- precision: high -- findings are tied to changed resolver/matcher code and WOTM-specific session-leakage risk.
- recall: medium-high -- the dry-run matched the original golden concerns and surfaced one additional accepted resolver-ordering issue.
- severity match: adjusted -- the original data-isolation concern remains medium, but the actionable medium finding moved upstream from `pickSessionForPid` to `resolveActiveSessionCwds`.
- duplicate/noise notes: no broad dependency, cross-platform, or managed/live refactor suggestions were produced.
- missed context: graph evidence did not prove resolver row ordering semantics; that finding came from source inspection plus graph-scoped symbol targeting.

## Feedback Loop
- This is the preferred first productization dry-run target because the bug came from real cross-project session confusion and the review needs both graph context and project-local invariants.
- Add a follow-up code fix or explicit acceptance decision for latest-onboard selection inside `resolveActiveSessionCwds`.
- The dry-run confirmed that project-local docs plus graph evidence can suppress wrong suggestions while still surfacing a new review-quality finding.

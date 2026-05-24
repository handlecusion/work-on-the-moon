# 002. Hermes CWD-Bound Session Matching Golden Review

## Target
- project: work-on-the-moon
- target commit: `07560771995c1471337e9dfcfc7ea5163ab6564e`
- source review case: `docs/llmwiki/review-cases/002-hermes-cwd-bound-session-matching.md`

## Expected Retrieval
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- ARD: `docs/llmwiki/ard/002-single-user-passkey-tunnel-security-model.md`
- graph: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- central source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`

## Ideal Findings

### 1. Same-Depth Onboard CWD Rows Need Newest-First Selection
- severity: medium
- concern: correctness
- evidence: `resolveActiveSessionCwds` selects the first cwd row per active session after ordering only by active session and parent-chain depth.
- expected comment: If one Hermes session has multiple `onboard_project` calls at the same depth, cwd selection can be stale or nondeterministic. Latest same-session onboard evidence should win before parent-session inheritance is considered.
- suggested fix: Order same-depth rows by message timestamp/id newest-first and add a regression fixture for multiple onboard calls in one active session.

### 2. Partial CWD Signal Must Not Fall Back To Recency
- severity: medium
- concern: correctness
- evidence: `pickSessionForPid` distinguishes "no cwd signal anywhere" from "cwd signal exists but not for this pid cwd".
- expected comment: Keep the mismatch path returning `null`; otherwise the freshest unrelated Hermes session can leak into the wrong WOTM project page.
- suggested fix: Preserve the mismatch unit test and add a regression case if parent-session or compaction behavior changes.

### 3. Onboard CWD Parser Should Stay Narrow
- severity: low
- concern: maintainability
- evidence: `extractOnboardCwd` scans only the segment around `onboard_project`.
- expected comment: Avoid general path scraping from Hermes message content because a false cwd match is more harmful than an unknown match.
- suggested fix: Keep fixtures around JSON-encoded args, plain results, spaces in cwd, and no-marker inputs.

### 4. Live DB Smoke Evidence
- severity: low
- concern: verification
- evidence: unit tests cannot fully simulate local Hermes DB/process state.
- expected comment: Record a local `scanHermes()` smoke when `~/.hermes/state.db` is present.
- suggested fix: Run the smoke after `npm test` and `node --check`.

## Expected Non-Findings
- Do not request a database library dependency.
- Do not ask to merge Hermes DB transcripts into Claude JSONL scanner logic.
- Do not flag returning `null` on mismatch as a UX regression; it is the safer behavior.

## Evaluation Notes
Good review output should identify the cross-project leakage risk as the main finding and avoid broad refactor suggestions.

## Dry-Run Result

Dry-run date: 2026-05-24

Result:

- matched expected retrieval: review-context contract, ARD 004, ARD 002, failure 004, central WOTM source/project pages, and fresh graph summary.
- matched expected non-findings: no dependency request, no Hermes/Claude scanner merge, no managed/live coupling suggestion, and no recency fallback recommendation.
- added accepted finding: latest same-session `onboard_project` evidence should win in `resolveActiveSessionCwds`.
- verification passed: `npm test`, `node --check lib/hermesDb.js`, `node --check lib/hermesSessionScanner.js`, `git diff --check`, and a local `scanHermes()` smoke.
- remaining verification gap: live smoke had one active Hermes session, so it did not exercise simultaneous WOTM/other-project collision.

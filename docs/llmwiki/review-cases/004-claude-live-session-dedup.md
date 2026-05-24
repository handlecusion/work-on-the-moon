# 004. Claude Live Session Dedup Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `a704885b45eaccb73ddbbbe67a4e6897e1e2bf7b` (`fix(live): dedup claude sessions sharing cwd`)
- date: 2026-05-18

## Change Summary
Two `claude --continue` processes in the same cwd could both fall back to the most recent JSONL and show duplicate rows for the same session. The change claims command-line session IDs first, re-resolves fallback IDs with claimed IDs excluded, and downgrades unresolved duplicates to sid-less cwd routing.

## Relevant Graph Context
- graph snapshot for current WOTM memory: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- target changed file: `lib/liveSessionScanner.js`
- affected flow: process scan -> cwd/session ID resolution -> homepage local active rows -> live attach routing

## Relevant Wiki Memory
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- ARD: `docs/llmwiki/ard/001-macos-only-local-runtime.md`
- central source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: correctness
- evidence: `deduplicateClaudeSessions` treats command-line session IDs as authoritative and re-resolves fallback entries with claimed IDs excluded.
- expected comment: Preserve this priority. If fallback entries can steal command-line IDs, the homepage can still show two rows that open the same transcript.
- suggested fix: Add fixture coverage for two same-cwd PIDs: one command-line SID, one fallback SID, and one unresolved duplicate downgraded to sid-less.

### Finding 2
- severity: low
- concern: routing behavior
- evidence: unresolved duplicate entries are downgraded to `sessionId: null` so they route via `/chat-live-cwd/`.
- expected comment: Sid-less downgrade is acceptable only if downstream cwd/agent routing can still avoid wrong attachment.
- suggested fix: Review together with agent pinning behavior for same-cwd multi-agent rows.

### Finding 3
- severity: low
- concern: test gap
- evidence: this logic is stateful and process-order sensitive.
- expected comment: A table-driven scanner fixture would be more reliable than only manual multi-process verification.
- suggested fix: Add an internal test for `deduplicateClaudeSessions` or a smoke scanner fixture if the helper is exported.

## Expected Non-Findings
- Do not recommend merging live session scanning with managed project sessions.
- Do not flag sid-less rows as inherently wrong; they are the safer fallback when no spare transcript can be identified.
- Do not add cross-platform process probing paths.

## Verification Plan
- `node --check lib/liveSessionScanner.js`
- live scanner smoke with two same-cwd Claude processes when available
- homepage local row smoke to confirm duplicates do not open the same SID
- `git diff --check`

## Feedback Loop
- This case teaches reviewers to check scanner matching order and fallback semantics, not only the final UI row.


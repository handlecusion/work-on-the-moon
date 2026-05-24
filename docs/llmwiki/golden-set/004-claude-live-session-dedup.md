# 004. Claude Live Session Dedup Golden Review

## Target
- project: work-on-the-moon
- target commit: `a704885b45eaccb73ddbbbe67a4e6897e1e2bf7b`
- source review case: `docs/llmwiki/review-cases/004-claude-live-session-dedup.md`

## Expected Retrieval
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- ARD: `docs/llmwiki/ard/001-macos-only-local-runtime.md`
- graph: `lib/liveSessionScanner.js` as the changed scanner module

## Ideal Findings

### 1. Claimed SID Priority
- severity: medium
- concern: correctness
- evidence: command-line SIDs are claimed before fallback entries are re-resolved.
- expected comment: Keep command-line SIDs authoritative so fallback scanning cannot create duplicate rows for the same transcript.
- suggested fix: Add table-driven coverage for same-cwd PIDs and claimed SID exclusion.

### 2. Sid-Less Downgrade Must Stay Compatible With Routing
- severity: low
- concern: architecture
- evidence: duplicate fallback entries can be downgraded to cwd-only rows.
- expected comment: Ensure downstream cwd routing and agent pinning handle sid-less rows without opening the wrong process.
- suggested fix: Pair this case with live cwd agent pinning smoke coverage.

### 3. Process-Order Sensitivity
- severity: low
- concern: verification
- evidence: fallback entries are sorted by `startedAt` then pid.
- expected comment: Review should ask for deterministic fixtures because the real process list is hard to reproduce.
- suggested fix: Export a narrow internal helper or add a smoke fixture that controls entry order.

## Expected Non-Findings
- Do not reject sid-less cwd routing by itself.
- Do not propose cross-platform `ps` or process probing changes.
- Do not merge managed/live scanner logic.

## Evaluation Notes
Good review output should focus on duplicate transcript attachment risk and deterministic coverage.


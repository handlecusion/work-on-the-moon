# 001. Live Session ID Validation Golden Review

## Target

- project: work-on-the-moon
- target commit: `710ac36743778a95d902700bf4d35f1180ec8969`
- dry-run date: 2026-05-11
- source review case: `docs/llmwiki/review-cases/001-live-session-id-validation.md`

## Expected Retrieval

- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- ARD: `docs/llmwiki/ard/002-single-user-passkey-tunnel-security-model.md`
- failure: `docs/llmwiki/failures/003-do-not-restart-server-for-frontend-only-edits.md`
- failure: `docs/llmwiki/failures/002-do-not-use-playwright-mcp-for-wotm-ui-verification.md`
- graph: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`

## Ideal Findings

### 1. Regex Drift Risk

- severity: low
- concern: correctness
- evidence: `public/chat-live.js` and `routes/live.js` both define live session ID acceptance rules; the fixed bug came from client/server drift.
- expected comment: Current parity is correct, but keep UUID/Hermes acceptance in a regression fixture so the client does not reject IDs accepted by the server.
- suggested fix: Add a small test/smoke fixture covering valid UUID, Hermes 6/8 hex suffix, short/long suffix, uppercase, slash, `..`, encoded slash, and whitespace.

### 2. Managed/Live Boundary Preserved

- severity: note
- concern: architecture
- evidence: Target diff touches `public/chat-live.html` and `public/chat-live.js` only.
- expected comment: Good: the fix remains scoped to the live mirror path and does not modify managed `/chat/:name` behavior.
- suggested fix: None.

### 3. UI Verification Evidence

- severity: low
- concern: verification
- evidence: Live page boot behavior is UI-visible and project policy requires `agent-browser` for UI/UX-visible changes.
- expected comment: Add `agent-browser` or actual authenticated-device verification evidence before calling the UI fix fully verified.
- suggested fix: Run agent-browser against an authenticated live route when available, or record explicit user/iPhone verification.

## Expected Non-Findings

- Do not flag path traversal if the strict regex parity checks pass.
- Do not recommend Playwright MCP; WOTM uses `agent-browser`.
- Do not recommend restarting LaunchAgent for this frontend-only diff.
- Do not suggest merging live and managed session flows.

## Dry-Run Result

The first dry-run matched this golden review: no security/blocker finding, one correctness drift risk, one cache-buster/process observation, and one verification gap.

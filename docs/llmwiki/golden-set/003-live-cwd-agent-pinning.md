# 003. Live CWD Agent Pinning Golden Review

## Target
- project: work-on-the-moon
- target commit: `7dd376f4037eecdee441b944ce9b08e0e708a4c0`
- source review case: `docs/llmwiki/review-cases/003-live-cwd-agent-pinning.md`

## Expected Retrieval
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- failure: `docs/llmwiki/failures/002-do-not-use-playwright-mcp-for-wotm-ui-verification.md`
- failure: `docs/llmwiki/failures/003-do-not-restart-server-for-frontend-only-edits.md`
- graph: live-flow hotspots `public/chat-live.js`, `public/index.js`, and `routes/live.js`

## Ideal Findings

### 1. Agent Hint Must Remain Validated
- severity: medium
- concern: correctness / boundary
- evidence: `routes/live.js` only accepts `claude`, `codex`, or `hermes` as agent hints.
- expected comment: Keep the allowlist and do not let arbitrary query strings select an agent namespace.
- suggested fix: Add or preserve tests for valid agent hints, invalid hints ignored, and no-hint fallback.

### 2. CWD-Only Compatibility Path
- severity: low
- concern: compatibility
- evidence: old clients may still resolve cwd without agent.
- expected comment: The fallback is acceptable, but new sid-less homepage links should always include the agent hint.
- suggested fix: Verify generated local row hrefs for codex/hermes include `?agent=`.

### 3. Authenticated UI Evidence
- severity: low
- concern: verification
- evidence: the bug is only fully visible in a real home-page click path.
- expected comment: Record `agent-browser` or maintainer-device evidence for same-cwd multi-agent rows.
- suggested fix: Capture the click path when authenticated state is available.

## Expected Non-Findings
- Do not call the query string a security boundary.
- Do not propose Playwright MCP.
- Do not merge live and managed flows.

## Evaluation Notes
Good review output should connect frontend href construction, live page bootstrap, websocket hello, and server resolver behavior.


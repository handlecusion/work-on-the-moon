# 006. Managed Session Quit And Zombie Cleanup Golden Review

## Target
- project: work-on-the-moon
- target commit: `8e3687a2440493aefd43f767ee72612a03385a1b`
- source review case: `docs/llmwiki/review-cases/006-managed-session-quit-and-zombie-cleanup.md`

## Expected Retrieval
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/002-single-user-passkey-tunnel-security-model.md`
- ARD: `docs/llmwiki/ard/003-no-build-step-and-small-dependency-footprint.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- failure: `docs/llmwiki/failures/002-do-not-use-playwright-mcp-for-wotm-ui-verification.md`
- graph: managed/home hotspots `public/chat.js`, `routes/chat.js`, `routes/sessions.js`, and `public/index.js`

## Ideal Findings

### 1. Destructive Route Auth And Validation
- severity: medium
- concern: security
- evidence: `DELETE /api/sessions/:name/:agent?clear=1` can clear session state.
- expected comment: Keep the route authenticated and validate both project name and agent before touching runner or project-store state.
- suggested fix: Preserve `session.requireAuth`, `NAME_RE`, and `VALID_AGENTS`; add tests when route test harness exists.

### 2. Runner Cleanup Completeness
- severity: medium
- concern: correctness
- evidence: end-session paths must abort the runner, clear busy, notify clients, delete the runner entry, and clear persisted state when requested.
- expected comment: Verify a stuck busy runner cannot remain visible after `/quit`, popover end, or DELETE clear.
- suggested fix: Add websocket/API smoke coverage for busy cleanup.

### 3. Managed Flow Scope
- severity: low
- concern: architecture
- evidence: the change is for managed chat sessions.
- expected comment: Keep this separate from live external process mirrors; live process termination needs a separate decision.
- suggested fix: Document any future live-quit behavior separately.

### 4. Agent-Browser Evidence For UI Controls
- severity: low
- concern: verification
- evidence: popover and home dismiss UI changed.
- expected comment: Capture `agent-browser` or maintainer-device evidence for the visible controls.
- suggested fix: Use the iPhone viewport and authenticated route when available.

## Expected Non-Findings
- Do not propose Playwright MCP.
- Do not request a frontend bundler.
- Do not call server restart unnecessary for the full change, because server routes changed.
- Do not propose guest/shared session-ending links.

## Evaluation Notes
Good review output should flag auth/destructive-route coverage and runner cleanup completeness, while suppressing generic UI/style comments.


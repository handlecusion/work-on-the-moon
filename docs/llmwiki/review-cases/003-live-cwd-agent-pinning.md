# 003. Live CWD Agent Pinning Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `7dd376f4037eecdee441b944ce9b08e0e708a4c0` (`fix(live): pin agent on cwd-keyed live route`)
- date: 2026-05-18

## Change Summary
When multiple agents share the same cwd and a row has no session ID yet, `/chat-live-cwd/<cwd>` used to resolve to the first cwd match, often Claude. The change carries `?agent=<claude|codex|hermes>` through the homepage link, live page bootstrap, websocket hello, and server resolver.

## Relevant Graph Context
- graph snapshot for current WOTM memory: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- target changed files: `public/index.js`, `public/chat-live.js`, `routes/live.js`
- graph hotspots: `public/chat-live.js` and `routes/live.js` are high fan-out live-flow modules
- affected flow: homepage local active list -> `/chat-live-cwd/<cwd>?agent=...` -> `/ws/live` hello -> `findLiveEntryByCwd`

## Relevant Wiki Memory
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- failure: `docs/llmwiki/failures/002-do-not-use-playwright-mcp-for-wotm-ui-verification.md`
- failure: `docs/llmwiki/failures/003-do-not-restart-server-for-frontend-only-edits.md`
- central source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: correctness
- evidence: `routes/live.js` accepts only `claude`, `codex`, or `hermes` as `msg.agent` before using it as an attachment hint.
- expected comment: Keep the agent hint as a validated routing hint, not an authorization boundary. The websocket session auth still needs to gate access.
- suggested fix: Preserve the allowlist and fallback behavior; add tests or smoke coverage for valid agents, invalid agent ignored, and older clients without agent hints.

### Finding 2
- severity: low
- concern: compatibility
- evidence: older clients may still send cwd-only hellos with no `agent`.
- expected comment: Fallback to first cwd match is acceptable for older clients, but new URLs should include the agent query for sid-less rows.
- suggested fix: Verify homepage local rows include `?agent=` when `sessionId` is absent and `cwd` is present.

### Finding 3
- severity: low
- concern: UI verification
- evidence: this is a visible navigation fix from the home page to live chat.
- expected comment: Use `agent-browser`, not Playwright MCP, to verify that clicking a codex/hermes sid-less row opens the matching agent when auth state is available.
- suggested fix: Record browser evidence or maintainer verification for the real multi-agent same-cwd state.

## Expected Non-Findings
- Do not suggest merging live and managed session routes.
- Do not treat `agent` query string as a security grant; it is only a resolver hint after authenticated websocket upgrade.
- Do not require a server restart for frontend-only portions alone, but this target also changes `routes/live.js`, so server restart is appropriate when deploying the full diff.

## Verification Plan
- `node --check public/index.js`
- `node --check public/chat-live.js`
- `node --check routes/live.js`
- live scanner/websocket smoke with two agents sharing cwd when available
- `agent-browser` home-to-live click verification when authenticated state exists
- `git diff --check`

## Feedback Loop
- This case teaches the harness to inspect URL construction, client websocket hello shape, and server resolver behavior together.


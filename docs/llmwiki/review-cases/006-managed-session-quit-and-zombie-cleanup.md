# 006. Managed Session Quit And Zombie Cleanup Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `8e3687a2440493aefd43f767ee72612a03385a1b` (`feat(chat): add /quit exit + zombie session cleanup`)
- date: 2026-05-23

## Change Summary
The change adds `/quit` and `/exit`, an end-session popover action, websocket `endSession`/`forceReset`, and `DELETE /api/sessions/:name/:agent?clear=1` so stuck managed sessions can be cleared and reopened.

## Relevant Graph Context
- graph snapshot for current WOTM memory: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- target changed files: `lib/builtinSlash.js`, `public/chat.html`, `public/chat.js`, `public/index.html`, `public/index.js`, `public/style.css`, `routes/chat.js`, `routes/sessions.js`
- graph hotspots: `public/chat.js`, `routes/chat.js`, and `public/index.js` are high-blast-radius managed/home modules
- affected flow: managed chat UI -> websocket runner state -> project store clearing -> home recent/all sessions

## Relevant Wiki Memory
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/002-single-user-passkey-tunnel-security-model.md`
- ARD: `docs/llmwiki/ard/003-no-build-step-and-small-dependency-footprint.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- failure: `docs/llmwiki/failures/002-do-not-use-playwright-mcp-for-wotm-ui-verification.md`
- failure: `docs/llmwiki/failures/003-do-not-restart-server-for-frontend-only-edits.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: security / boundary
- evidence: `routes/sessions.js` exposes a destructive DELETE path that can clear persisted managed-session state.
- expected comment: Ensure the route remains behind `session.requireAuth`, validates project name and agent, and never exposes guest/shared access.
- suggested fix: Keep `NAME_RE`, `VALID_AGENTS`, and `session.requireAuth`; add route tests if HTTP route coverage exists.

### Finding 2
- severity: medium
- concern: correctness
- evidence: websocket `endSession` aborts the runner, releases busy, broadcasts history/state, clears project store, and deletes the runner entry.
- expected comment: Verify stuck busy sessions cannot remain in the in-memory runners map after endSession/forceReset, and that other clients receive a closed/state update.
- suggested fix: Add a websocket smoke or targeted unit test for busy runner cleanup when practical.

### Finding 3
- severity: low
- concern: architecture
- evidence: the target touches managed chat and home recent-session UI, not live `/chat-live`.
- expected comment: Keep `/quit` semantics scoped to managed sessions. Do not apply it to live external process mirrors without a separate live-session decision.
- suggested fix: If live quit is added later, document how it interacts with external tmux/cmux/codex/hermes processes.

### Finding 4
- severity: low
- concern: UI verification
- evidence: visible menu and home dismiss controls changed.
- expected comment: Record `agent-browser` evidence for the popover end-session action and home recent-row dismiss button on the maintainer deployment.
- suggested fix: Use the project-required iPhone viewport when auth state is available.

## Expected Non-Findings
- Do not propose Playwright MCP.
- Do not ask to add a frontend build system for this UI change.
- Do not restart only for static UI changes, but this target includes server routes and websocket behavior, so server restart is appropriate for deployment.
- Do not conflate managed session cleanup with killing external live processes.

## Verification Plan
- `npm test`
- `node --check lib/builtinSlash.js`
- `node --check public/chat.js`
- `node --check public/index.js`
- `node --check routes/chat.js`
- `node --check routes/sessions.js`
- authenticated `agent-browser` evidence for visible UI when available
- `git diff --check`

## Feedback Loop
- This case exercises security, managed/live separation, UI verification policy, and graph hotspot awareness together.


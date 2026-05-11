# 001. Live Session ID Validation Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `710ac36743778a95d902700bf4d35f1180ec8969` (`fix(live): accept hermes timestamped session ids in client-side validation`)
- date: 2026-05-11

## Change Summary
The latest observed commit changes live-session client-side validation so timestamped Hermes session IDs are accepted. This is a seed review case for the WOTM harness because it touches the live mirror path rather than the managed chat path.

## Relevant Graph Context
- graph snapshot: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json` generated 2026-05-11T17:43:36+09:00 at WOTM commit `0b1dde7dcddcc683fe990ddc2df109d16544a8d7`
- changed files: `public/chat-live.html`, `public/chat-live.js`
- changed symbols: `public/chat-live.js` boot guard around `validSid`; HTML cache-buster references
- callers/callees: no extracted fine-grained caller for the top-level boot block; `public/chat-live.js` is a high fan-out frontend module with 197 outgoing edges and 76 function nodes
- affected modules: live mirror UI only; no `public/chat.js`, `routes/chat.js`, or managed-session files touched by the target diff
- dependency boundary notes: keep live `/chat-live/:sid` behavior separate from managed `/chat/:name`

## Relevant Wiki Memory
- ARDs: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- failure records: `docs/llmwiki/failures/003-do-not-restart-server-for-frontend-only-edits.md` if the change is frontend-only
- claims: `/Users/ys/Code/wiki/claims/wotm-single-user-passkey-security-model.md`
- source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: correctness
- evidence: session ID validation changed on the live mirror path
- expected comment: Ensure the accepted timestamped Hermes session ID pattern is limited to valid external live-session identifiers and does not accidentally reject existing Claude IDs or accept path traversal / slash-containing values.
- suggested fix: Add/confirm a validation test or manual case for existing Claude IDs, timestamped Hermes IDs, and malicious strings containing `/`, `..`, `%2f`, or whitespace.

### Finding 2
- severity: low
- concern: architecture
- evidence: live session validation belongs to `/chat-live/:sid`
- expected comment: Keep this change scoped to the live mirror flow; do not apply managed-chat assumptions or project-session history behavior here.
- suggested fix: If shared validation is introduced, name it as external-live-session ID validation rather than generic chat session validation.

## Harness Output

Dry-run date: 2026-05-11

Review pipeline used:

1. Triage: target commit `710ac36743778a95d902700bf4d35f1180ec8969`; changed files `public/chat-live.html`, `public/chat-live.js`; selected correctness, security/boundary, and architecture/process reviewers.
2. Graph context: WOTM graph snapshot generated at `0b1dde7dcddcc683fe990ddc2df109d16544a8d7` with 50 files, 651 nodes, and 6,159 edges. `public/chat-live.js` is the second-highest node-count file and has 197 outgoing edges.
3. Memory retrieved: ARD 004 live/managed separation; ARD 002 security model; failure record 003 frontend-only restart rule; failure record 002 agent-browser rule.
4. Static verification: `node --check public/chat-live.js`, `node --check routes/live.js`, and `git diff --check` passed.
5. Regex parity verification: UUID, Hermes 6-hex, Hermes 8-hex accepted; short/long suffix, uppercase, slash, `..`, encoded slash, and trailing space rejected by both client-equivalent and server regexes.

Aggregated findings:

### Finding 1
- severity: low
- concern: correctness / maintainability
- evidence: `public/chat-live.js` duplicates the same live session ID regex semantics already present in `routes/live.js` `SESSION_ID_RE`; the target bug was caused by client/server validation drift.
- expected comment: Current regex parity is correct, but this shape is drift-prone. Add a small parity fixture or shared validation source so the client does not again reject IDs that the server accepts.
- suggested fix: Add test cases for UUID, Hermes 6/8 hex suffix, short/long suffix, uppercase hex, slash, `..`, encoded slash, and whitespace. If sharing runtime code is too heavy under the no-build policy, keep a lightweight script/smoke test that checks client/server regex fixtures.

### Finding 2
- severity: info
- concern: architecture / frontend delivery
- evidence: `public/chat-live.html` bumps both `/style.css?v=20260511a` and `/static/chat-live.js?v=20260511a`, but the target code change only requires the JS cache-buster.
- expected comment: If WOTM intentionally page-versions CSS and JS together, document that convention; otherwise avoid CSS cache-buster churn on JS-only changes.
- suggested fix: Either bump only the changed JS asset or add a note to the frontend convention that live page asset versions are intentionally advanced together.

### Finding 3
- severity: low
- concern: verification process
- evidence: This is a UI-visible live-flow fix, and failure record 002 expects `agent-browser` verification for UI/UX-visible changes. The dry-run verified syntax and regex parity but did not complete a real authenticated live-page browser flow.
- expected comment: Record an `agent-browser` check or explicitly hand off authenticated iPhone/passkey verification when the route requires live auth state.
- suggested fix: For future similar changes, run `agent-browser` against the maintainer deployment when auth state is available, or record user verification for actual iPhone/passkey behavior.

Positive checks:

- No blocker/high findings.
- Security reviewer found no traversal/auth broadening issue: slash, dot, percent, whitespace, and uppercase variants are rejected; route/API/WS server validation remains stricter and authenticated.
- Managed/live boundary held: target diff does not touch managed chat files.
- No-build and dependency policies held.
- Frontend-only restart rule applied: no LaunchAgent restart needed for this target diff.

## Evaluation
- precision: high — findings are specific to target diff and retrieved WOTM docs.
- recall: medium-high — matched both ideal review findings and added process/style observations.
- severity match: acceptable — ideal medium correctness finding was downgraded to low after regex parity verification showed no current bug, only drift risk.
- duplicate/noise notes: concern reviewers duplicated the regex-drift point; aggregation collapsed it into one finding.
- missed context: no authenticated `agent-browser` live-page verification was performed during dry-run; graph did not provide function-level caller context for the top-level boot guard.

## Feedback Loop

- Keep this as golden-set seed case: the harness successfully retrieved live-vs-managed separation, frontend-only restart guidance, agent-browser verification policy, and client/server regex drift risk.
- Add a future failure record or test task if regex drift recurs.
- Improve graph query layer for top-level script boot blocks where no named function owns the changed logic.

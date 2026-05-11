# 001. Live Session ID Validation Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `710ac36743778a95d902700bf4d35f1180ec8969` (`fix(live): accept hermes timestamped session ids in client-side validation`)
- date: 2026-05-11

## Change Summary
The latest observed commit changes live-session client-side validation so timestamped Hermes session IDs are accepted. This is a seed review case for the WOTM harness because it touches the live mirror path rather than the managed chat path.

## Relevant Graph Context
- changed symbols: not yet extracted by graph cache
- callers: pending graph snapshot
- callees: pending graph snapshot
- affected modules: `public/chat-live.js` and/or live route/session validation surface, based on commit message
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
Pending first automated harness run.

## Evaluation
- precision: pending
- recall: pending
- severity match: pending
- duplicate/noise notes: pending
- missed context: pending

## Feedback Loop
Use this case to test whether the harness retrieves live-vs-managed separation and boundary validation records for frontend/live-route changes.

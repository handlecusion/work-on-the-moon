# 004. Managed and Live Session Flows Stay Separate

## Status
Accepted (2026-05-11)

## Context
WOTM has two different product flows: managed sessions where the server spawns Claude, and live sessions where the server mirrors an external Claude process by tailing JSONL and optionally forwarding input through cmux.

## Decision
Keep managed `/chat/:name` and live `/chat-live/:sid` as separate routes, UIs, and backend flows. Share only carefully factored normalization/utilities.

## Reasons
- Managed sessions own process lifecycle and project history through `routes/chat.js` and `lib/projectStore.js`.
- Live sessions observe external processes through `routes/live.js`, Claude JSONL files, and optional cmux socket forwarding.
- Combining them risks confusing auth, session IDs, input semantics, and persistence behavior.

## Rejected Alternatives
- Merge both UIs into one generic chat route now: rejected because lifecycle and input semantics differ.
- Treat live sessions as managed project sessions: rejected because live sessions are external process mirrors.

## Consequences
Reviewers should look for accidental coupling between `public/chat.js` and `public/chat-live.js`, or between `routes/chat.js` and `routes/live.js`. Shared code is allowed only when the abstraction is truly common, such as JSONL normalization.

## Agent Instructions
- Before editing either flow, read `.omc/wiki/chat-managed-session-flow.md` and `.omc/wiki/live-session-mirror-flow.md`.
- Do not move behavior across flows without naming the lifecycle difference.
- For live flow changes, verify timestamped Hermes/Claude session IDs and external JSONL path assumptions.
- For managed flow changes, verify spawned Claude process handling and project history behavior.

## Provenance
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Related files: `CLAUDE.md`, `routes/chat.js`, `routes/live.js`, `public/chat.js`, `public/chat-live.js`, `lib/projectStore.js`, `lib/hermesSessionScanner.js`, `.omc/wiki/chat-managed-session-flow.md`, `.omc/wiki/live-session-mirror-flow.md`
- Current commit at initialization: `710ac36743778a95d902700bf4d35f1180ec8969`

## Review / Supersession Conditions
Revisit if a concrete shared session abstraction is designed, tested, and shown to reduce duplication without weakening the two lifecycle models.

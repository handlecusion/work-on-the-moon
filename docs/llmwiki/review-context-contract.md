# WOTM Review Context Contract

## Status
Accepted seed contract (2026-05-24)

## Purpose
This contract defines the minimum evidence a review agent must load before reviewing non-trivial WOTM changes. It turns the project-local docs harness into a repeatable review workflow rather than an optional memory dump.

## Required Inputs
For each review, collect:

1. target commit, PR, or diff range
2. changed files and changed high-level symbols
3. current `llmwiki onboard` result for `/Users/ys/Code/working-on-the-moon`
4. graph freshness state and graph summary path
5. relevant project-local ARDs
6. relevant project-local failure records
7. relevant central wiki source/project/claim pages
8. expected verification commands
9. any authenticated UI evidence gap that needs maintainer/user verification

## Default Read Order
1. `CLAUDE.md`
2. `docs/llmwiki/README.md`
3. this file
4. relevant `docs/llmwiki/ard/*.md`
5. relevant `docs/llmwiki/failures/*.md`
6. relevant `docs/llmwiki/review-cases/*.md` and `docs/llmwiki/golden-set/*.md`
7. `/Users/ys/Code/wiki/wiki/projects/working-on-the-moon.md`
8. `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
9. `/Users/ys/Code/wiki/claims/wotm-single-user-passkey-security-model.md`
10. `/Users/ys/Code/wiki/claims/wotm-code-graph-snapshot-counts.md`

## Graph Use Rules
- Use graph evidence only when onboarding says `graph_status: fresh` for the target HEAD or when reviewing the exact graph snapshot commit recorded in the case.
- If graph evidence is stale, say so explicitly and fall back to source/docs reads. Do not imply current graph coverage.
- Graph summaries are supporting evidence. Final findings still need file/line or behavior references from the diff/source.
- Treat frontend modules such as `public/chat.js` and `public/chat-live.js` as high-blast-radius files because they are stable graph hotspots.

## Concern Routing
- security: auth/session cookies, WebAuthn/passkey, tunnel `ORIGIN`/`RP_ID`, uploads, websocket access, managed sessions using `claude --dangerously-skip-permissions`
- correctness: session ID validation, JSONL/session DB normalization, cwd/session binding, live versus managed flow semantics
- architecture: macOS-only runtime, buildless frontend, managed/live separation, route/lib/public boundaries
- verification: `npm test`, `node --check`, smoke scripts, `agent-browser` for visible UI, authenticated maintainer verification when passkey state is required
- process: explicit staging only; no `git add -A` or `git add .`

## Output Requirements
A review output should:

1. lead with concrete findings ordered by severity
2. cite changed file/line or behavior evidence
3. mention which ARDs/failure records were consulted when they shaped a finding or non-finding
4. include graph freshness and relevant graph context when used
5. list verification commands that passed, failed, or still need user/authenticated evidence
6. record expected non-findings when the harness should suppress a tempting but wrong suggestion

## Stale Or Unsupported Path
If any required evidence is missing:

- stale graph: continue, but state that graph-derived impact may be incomplete
- missing project docs: continue from source/wiki, then add a docs follow-up
- auth-only UI path: record the needed maintainer/device verification rather than pretending it was tested
- raw conversation need: do not include raw text in review artifacts; use central wiki summaries/claims instead

## Review Artifact Shape
Each review case should record:

- target
- change summary
- relevant graph context
- relevant wiki/project-local memory
- ideal findings
- expected non-findings
- verification plan
- feedback loop notes

Each golden review should record:

- expected retrieval
- ideal findings
- expected non-findings
- severity expectations
- dry-run or evaluation result


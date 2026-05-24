# WOTM LLM Wiki Project Docs

- project: work-on-the-moon (`wotm`)
- initialized: 2026-05-11
- purpose: project-local decision/failure memory for code agents and review harnesses
- central wiki source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- central wiki project page: `/Users/ys/Code/wiki/wiki/projects/working-on-the-moon.md`

## Read Order For Agents

Before non-trivial edits, read:

1. `CLAUDE.md`
2. `docs/llmwiki/README.md`
3. `docs/llmwiki/review-context-contract.md` for review-sensitive work
4. relevant `docs/llmwiki/ard/*.md`
5. relevant `docs/llmwiki/failures/*.md`
6. existing `.omc/wiki/index.md` and relevant `.omc/wiki/*.md` pages when deeper architecture context is needed

## Directory Roles

- `ard/`: architectural record decisions that agents must respect.
- `failures/`: structured failure records with retrieval keys so agents do not repeat known-bad approaches.
- `review-context-contract.md`: required context bundle for review agents.
- `review-cases/`: code review examples used to test the harness.
- `golden-set/`: ideal review outputs for evaluating precision, recall, severity match, and duplicate rate.

## Current Project Invariants

- macOS-only npm package and LaunchAgent-oriented runtime.
- Single-user passkey-protected security model; managed sessions intentionally spawn `claude --dangerously-skip-permissions`.
- No build step; vanilla browser assets in `public/`.
- Managed `/chat/:name` and Live `/chat-live/:sid` flows are separate subsystems.
- UI verification uses `agent-browser` CLI, not Playwright MCP.
- Stage files explicitly; never use `git add -A` or `git add .` in this repo.

## Review Harness Retrieval

When reviewing a change, retrieve docs by concern:

- security: passkey/WebAuthn, session cookies, tunnel/RP_ID/ORIGIN, upload boundaries, `claude --dangerously-skip-permissions` blast radius.
- correctness: managed-vs-live session separation, JSONL normalization, session ID validation, boundary validation.
- performance: JSONL tailing, process scanning, websocket fan-out, cache growth.
- architecture: macOS-only runtime, no build step, dependency footprint, route/lib/public boundaries.
- style: only non-linter conventions such as cache-buster bumps, screenshot naming, explicit staging.

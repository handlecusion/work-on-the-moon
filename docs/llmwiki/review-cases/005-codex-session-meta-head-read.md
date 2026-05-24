# 005. Codex Session Meta Head Read Review Case

## Target Change
- project: work-on-the-moon
- PR / commit / diff: commit `dd89ffeb4c551f3ff786af9c840d67a157285afa` (`refactor(codex): read session_meta head until newline, not fixed slice`)
- date: 2026-05-18

## Change Summary
Codex session metadata can exceed a fixed 16KB or 64KB head buffer because `base_instructions.text` is embedded in the first JSONL line. The change replaces fixed-slice head reading with chunked first-line reading up to a 1MB cap.

## Relevant Graph Context
- graph snapshot for current WOTM memory: `/Users/ys/Code/wiki/cache/code_graph/working-on-the-moon/summary.json`
- target changed file: `lib/codexSessionScanner.js`
- affected flow: codex PID discovery -> JSONL index build -> cwd/session binding -> homepage local active list

## Relevant Wiki Memory
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/001-macos-only-local-runtime.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- central source: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`

## Ideal Review Findings

### Finding 1
- severity: medium
- concern: correctness
- evidence: `readFirstLine` reads in chunks until newline and caps total read at `MAX_HEAD_BYTES`.
- expected comment: Add fixtures that prove large Codex first lines parse correctly and truncated/unterminated lines fail predictably.
- suggested fix: Test small head, 22KB head, >64KB head, newline exactly on chunk boundary, and no-newline over cap.

### Finding 2
- severity: low
- concern: resource bounds
- evidence: the maximum first-line read is 1MB.
- expected comment: Keep a hard cap so a malformed Codex JSONL cannot make WOTM read an unbounded file into memory.
- suggested fix: Document or test the cap behavior.

### Finding 3
- severity: low
- concern: scanner fallback semantics
- evidence: when parsing returns null, Codex entries can become sessionId-null and route by cwd.
- expected comment: Review the user-facing fallback: parser failure should not silently attach to the wrong transcript.
- suggested fix: Pair parser failures with clear null state or logging rather than guessing.

## Expected Non-Findings
- Do not recommend reading the full JSONL file.
- Do not add a build step or external parser dependency.
- Do not broaden this into Claude JSONL parsing unless a shared abstraction is proven useful.

## Verification Plan
- `node --check lib/codexSessionScanner.js`
- fixture or smoke parse for Codex JSONL heads over 64KB
- local scanner smoke when Codex sessions exist
- `git diff --check`

## Feedback Loop
- This case teaches reviewers to ask for bounded parser fixtures when a fix addresses data-shape growth rather than ordinary control flow.


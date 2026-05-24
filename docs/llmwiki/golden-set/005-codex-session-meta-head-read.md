# 005. Codex Session Meta Head Read Golden Review

## Target
- project: work-on-the-moon
- target commit: `dd89ffeb4c551f3ff786af9c840d67a157285afa`
- source review case: `docs/llmwiki/review-cases/005-codex-session-meta-head-read.md`

## Expected Retrieval
- contract: `docs/llmwiki/review-context-contract.md`
- ARD: `docs/llmwiki/ard/001-macos-only-local-runtime.md`
- ARD: `docs/llmwiki/ard/004-managed-and-live-session-flows-stay-separate.md`
- graph: `lib/codexSessionScanner.js` changed scanner module

## Ideal Findings

### 1. Large First-Line Fixture Needed
- severity: medium
- concern: correctness
- evidence: the fix exists because Codex `session_meta` first lines outgrew fixed read buffers.
- expected comment: Add regression fixtures for large first lines, chunk-boundary newline, and over-cap no-newline behavior.
- suggested fix: Unit-test `parseCodexHead` or a narrow internal reader helper with synthetic JSONL files.

### 2. Hard Cap Must Remain
- severity: low
- concern: resource bounds
- evidence: `MAX_HEAD_BYTES` bounds first-line reads to 1MB.
- expected comment: Keep this bound and ensure malformed files do not force unbounded reads.
- suggested fix: Add a no-newline-over-cap fixture.

### 3. Parser Failure Should Not Guess
- severity: low
- concern: correctness
- evidence: parser failure affects sessionId/cwd binding.
- expected comment: Null parse is safer than guessing the wrong transcript, but scanner logs or test coverage should make the failure visible.
- suggested fix: Preserve null fallback and add targeted diagnostics if failures recur.

## Expected Non-Findings
- Do not request full-file reads.
- Do not add a build step.
- Do not require a shared parser abstraction yet.

## Evaluation Notes
Good review output should focus on regression fixture coverage and resource bounds.


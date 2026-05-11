# 002. Do Not Use Playwright MCP For WOTM UI Verification

## Attempted Date
Known project convention as of 2026-05-11

## Attempted Reason
Agents often default to Playwright MCP for browser verification.

## Context Conditions
- Project/subsystem: UI/UX verification, mobile viewport screenshots
- Runtime/dependencies: real Chrome controlled by `agent-browser` CLI
- Traffic/data scale: manual maintainer deployment at `https://work.handlecusion.com`
- Constraints at the time: iPhone 14 Pro viewport checks and existing repo instructions

## Failed Approach
Using Playwright MCP instead of the project-required `agent-browser` CLI.

## Failure Mode
Verification can be slower, less aligned with the maintainer's real browser workflow, and contrary to explicit project instructions.

## Root Cause
The repo standardizes on `agent-browser` and records concrete command patterns in `CLAUDE.md` and `.omc/wiki/testing-with-agent-browser.md`.

## Current Alternative
Use `agent-browser batch/eval/console/errors` with 393×852 viewport. Save screenshots as `iphone14pro-<step>-<what>.png` in repo root.

## Detection / Retrieval Keys
- code pattern: none; review/test workflow issue
- AST/symbolic signature: n/a
- dependency/tool signature: `Playwright MCP`, `browser_navigate`, `page.goto`, `agent-browser`
- runtime symptom: UI task claims completion without agent-browser evidence
- context condition: WOTM UI/UX-visible change
- avoid rule: do not use Playwright MCP for WOTM UI verification
- prescription: run `agent-browser` CLI commands from `CLAUDE.md`

## Agent Instructions
- For visible UI changes, verify in real Chrome at iPhone 14 Pro viewport using `agent-browser`.
- If a state requires real passkey/iPhone behavior, state that it needs user verification on the actual device.

## Related Decisions / Claims / Sources
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Raw provenance: `CLAUDE.md`, `.omc/wiki/testing-with-agent-browser.md`

## Revisit Conditions
Revisit only if the maintainer replaces `agent-browser` as the canonical UI verification tool.

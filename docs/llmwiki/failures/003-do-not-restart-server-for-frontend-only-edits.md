# 003. Do Not Restart Server For Frontend-Only Edits

## Attempted Date
Known project convention as of 2026-05-11

## Attempted Reason
Agents may restart the LaunchAgent after any file change as a generic deployment habit.

## Context Conditions
- Project/subsystem: `public/*.html`, `public/*.js`, `public/*.css`
- Runtime/dependencies: Express static serving with no-store/no-cache headers
- Traffic/data scale: local maintainer deployment
- Constraints at the time: avoid unnecessary process churn while testing UI changes

## Failed Approach
Running `launchctl kickstart -k gui/$(id -u)/com.handlecusion.wotm` after frontend-only edits.

## Failure Mode
Unnecessary bounce interrupts active sessions and wastes time; it does not improve static asset serving.

## Root Cause
`express.static` reads files from disk per request and project headers disable caching. Frontend freshness is handled with cache-busting query strings.

## Current Alternative
For frontend-only changes, do not restart. Bump script query strings when needed, reload the page, and verify via `agent-browser`.

## Detection / Retrieval Keys
- code pattern: edits only under `public/`
- AST/symbolic signature: static HTML/CSS/vanilla JS changes
- dependency/tool signature: Express static middleware, cache-buster query strings
- runtime symptom: unnecessary LaunchAgent restart after UI-only patch
- context condition: no server-side files changed
- avoid rule: do not restart server for frontend-only edits
- prescription: reload browser; bump cache-busting query if clients must refresh JS

## Agent Instructions
- Restart only after server-side changes or when route/process behavior changed.
- For server-side changes, restart and verify with `lsof` plus `/healthz` or route probe.

## Related Decisions / Claims / Sources
- ARDs: `docs/llmwiki/ard/003-no-build-step-and-small-dependency-footprint.md`
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Raw provenance: `CLAUDE.md`, `.omc/wiki/deployment-and-environment.md`, `.omc/wiki/testing-with-agent-browser.md`

## Revisit Conditions
Revisit if the server begins bundling or caching frontend assets differently.

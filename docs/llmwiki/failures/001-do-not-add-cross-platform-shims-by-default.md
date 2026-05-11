# 001. Do Not Add Cross-Platform Shims By Default

## Attempted Date
Known project convention as of 2026-05-11

## Attempted Reason
Agents may try to make CLI/server code broadly portable when they see shell commands, process management, or filesystem paths.

## Context Conditions
- Project/subsystem: packaging, runtime launch, process/session discovery
- Runtime/dependencies: macOS, Node.js 20+, LaunchAgent, Claude CLI, node-pty
- Traffic/data scale: single maintainer local machine
- Constraints at the time: npm/npx simplicity and macOS-only support

## Failed Approach
Adding Linux/Windows branches, service managers, path shims, or Docker assumptions without a product decision.

## Failure Mode
The code becomes harder to verify, may not ship correctly through npm, and can imply unsupported platforms to users.

## Root Cause
Cross-platform behavior has not been designed or tested; the repository explicitly declares `os: [darwin]`.

## Current Alternative
Keep implementation macOS-specific. Put future platform ideas in roadmap or a new ARD.

## Detection / Retrieval Keys
- code pattern: `process.platform`, `win32`, `linux`, `systemd`, Dockerfile, platform-specific path branching
- AST/symbolic signature: conditionals around OS/platform behavior in runtime paths
- dependency/tool signature: launchd/LaunchAgent vs systemd/service manager changes
- runtime symptom: unverified platform branch, install behavior divergence
- context condition: WOTM package has `os: [darwin]`
- avoid rule: do not add cross-platform shims without explicit approval
- prescription: preserve macOS-only behavior; document roadmap separately

## Agent Instructions
- Flag unrequested platform broadening in review.
- Do not treat general portability as a free improvement in this repo.

## Related Decisions / Claims / Sources
- ARDs: `docs/llmwiki/ard/001-macos-only-local-runtime.md`
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Raw provenance: `package.json`, `CLAUDE.md`, `.omc/wiki/deployment-and-environment.md`

## Revisit Conditions
Revisit when Linux/Windows/Docker support becomes an explicit milestone with test hardware and packaging acceptance criteria.

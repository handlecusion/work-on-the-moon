# 001. macOS-Only Local Runtime

## Status
Accepted (2026-05-11)

## Context
`work-on-the-moon` is an npm/npx-publishable local server for running and mirroring Claude Code sessions on the maintainer's own machine. `package.json` declares `"os": ["darwin"]`; `CLAUDE.md` and `.omc/wiki/deployment-and-environment.md` both state that macOS is the supported baseline.

## Decision
Keep WOTM macOS-only until the maintainer explicitly reopens cross-platform support.

## Reasons
- The current runtime depends on macOS-oriented workflows: LaunchAgent installation, local developer machine assumptions, and iPhone/browser verification against the maintainer deployment.
- `node-pty`, shell paths, launch management, and Claude session discovery differ across platforms.
- The package should remain simple and npx-friendly before expanding support.

## Rejected Alternatives
- Add Linux/Windows shims opportunistically: rejected because unverified compatibility code increases maintenance and install-surface risk.
- Introduce Docker/headless-server support now: rejected as roadmap-level work, not current baseline.

## Consequences
Cross-platform ideas belong in roadmap docs or future ARDs, not incidental implementation changes. Reviewers should flag PRs that add platform branches without an explicit product decision.

## Agent Instructions
- Do not add Linux/Windows shims unless the user explicitly asks.
- Prefer macOS-native verification commands from `CLAUDE.md` for runtime checks.
- If a change touches packaging, confirm it remains compatible with `package.json` `os: [darwin]` and `files` allowlist.

## Provenance
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Related files: `package.json`, `CLAUDE.md`, `.omc/wiki/deployment-and-environment.md`, `.omc/wiki/house-rules-and-conventions.md`
- Current commit at initialization: `710ac36743778a95d902700bf4d35f1180ec8969`

## Review / Supersession Conditions
Revisit when the maintainer prioritizes Linux, Windows, Docker, or hosted/headless deployment as a committed product milestone.

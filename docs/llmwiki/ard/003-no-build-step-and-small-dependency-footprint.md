# 003. No Build Step and Small Dependency Footprint

## Status
Accepted (2026-05-11)

## Context
WOTM is intended to run through `npx work-on-the-moon` with minimal setup. The shipped files are controlled by `package.json` `files`; frontend assets are plain HTML/CSS/JS in `public/`.

## Decision
Keep the project buildless and dependency-light. Do not introduce webpack, Vite, TypeScript compilation, or large runtime dependencies without an explicit ARD.

## Reasons
- The npm package should stay small and predictable for `npx` users.
- A build step would complicate local-first debugging and package publishing.
- Current UI requirements are served by vanilla JS plus CDN-loaded DOMPurify, marked, and lucide.

## Rejected Alternatives
- Add frontend bundling preemptively: rejected because current pages are simple and served directly.
- Add broad utility/framework dependencies: rejected because every dependency ships to end users.

## Consequences
Frontend changes must work as static files. Dependency additions need explicit justification against install time, package size, maintenance burden, and security surface.

## Agent Instructions
- Do not add a build system without asking.
- Before adding a package, check whether the feature can be implemented with existing dependencies or small no-transitive-dep libraries.
- If changing `public/*.js`, update relevant cache-busting query strings when clients must pick up the change.
- Check `package.json` `files` before assuming a repo-only file ships to npm users.

## Provenance
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`
- Related files: `package.json`, `CLAUDE.md`, `README.md`, `.omc/wiki/deployment-and-environment.md`, `.omc/wiki/house-rules-and-conventions.md`
- Current commit at initialization: `710ac36743778a95d902700bf4d35f1180ec8969`

## Review / Supersession Conditions
Revisit if frontend complexity, offline packaging, or testability creates a concrete bottleneck that cannot be handled with the current static asset model.

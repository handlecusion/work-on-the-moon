# 002. Single-User Passkey + Tunnel Security Model

## Status
Accepted (2026-05-11)

## Context
WOTM exposes Claude Code from a personal machine to trusted devices. Managed sessions spawn `claude --dangerously-skip-permissions`, so the security boundary is not Claude tool confirmation; it is the single-user passkey gate, session cookie handling, and trusted tunnel hostname.

## Decision
Maintain WOTM as a single-owner system protected by WebAuthn/passkeys and a TLS tunnel. Do not add guest, shared, or multi-tenant access without a new security design.

## Reasons
- `claude --dangerously-skip-permissions` intentionally allows powerful file/shell tool use once inside the session.
- Passkeys and a stable `ORIGIN`/`RP_ID` provide the practical access boundary for the maintainer's trusted devices.
- Multi-user or guest modes would require authorization boundaries that do not exist today.

## Rejected Alternatives
- Guest/public links: rejected because they would expose a privileged local agent surface.
- OAuth-style multi-user accounts: rejected because authorization, workspace isolation, audit, and user separation are out of current scope.
- Weakening passkey requirements for convenience: rejected because passkeys are the core access control.

## Consequences
Security review should focus on auth/session/tunnel invariants and privileged execution paths. UX convenience features cannot bypass WebAuthn or create unauthenticated access to managed/live session controls.

## Agent Instructions
- Treat passkey + trusted tunnel as mandatory for remote access.
- Do not propose guest mode, shared links, or multi-user features unless this ARD is reopened.
- When changing auth, sessions, websocket upgrades, uploads, or input forwarding, review the `claude --dangerously-skip-permissions` blast radius.
- Preserve `ORIGIN` and `RP_ID` semantics; changing `RP_ID` invalidates existing passkeys.

## Provenance
- Source summaries: `/Users/ys/Code/wiki/sources/codebases/working-on-the-moon.md`, `/Users/ys/Code/wiki/sources/conversations/anthropic-conversation-2026-05-01-mac-mini-claude-code-web-ui.md`
- Related files: `README.md`, `CLAUDE.md`, `auth/webauthn.js`, `auth/session.js`, `routes/auth.js`, `routes/setup.js`, `.omc/wiki/auth-and-passkey-flow.md`
- Current commit at initialization: `710ac36743778a95d902700bf4d35f1180ec8969`

## Review / Supersession Conditions
Revisit only with a written multi-user threat model, workspace isolation plan, audit plan, and explicit maintainer approval.

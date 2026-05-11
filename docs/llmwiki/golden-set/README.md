# WOTM Golden Set

This directory holds manually written ideal reviews for WOTM changes.

Initial target: build 5-10 cases before generalizing the harness to another project.

Candidate cases:

1. Live session ID validation: commit `710ac36743778a95d902700bf4d35f1180ec8969`.
2. Auth/session cookie or WebAuthn changes.
3. Upload route boundary validation.
4. Managed chat stream parsing / JSONL normalization.
5. Frontend-only chat UI change requiring cache-buster and agent-browser verification.
6. LaunchAgent/install packaging change.

Each golden case should include:

- target commit/diff
- relevant ARDs/failure records
- expected findings with severity and concern
- expected false positives to suppress
- evaluation notes after harness output is compared

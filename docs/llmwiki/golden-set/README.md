# WOTM Golden Set

This directory holds manually written ideal reviews for WOTM changes.

Initial target: build 5-10 cases before generalizing the harness to another project.

Current golden cases:

1. Live session ID validation: commit `710ac36743778a95d902700bf4d35f1180ec8969`.
2. Hermes cwd-bound session matching: commit `07560771995c1471337e9dfcfc7ea5163ab6564e` (productization dry-run completed 2026-05-24).
3. Live cwd agent pinning: commit `7dd376f4037eecdee441b944ce9b08e0e708a4c0`.
4. Claude live session dedup: commit `a704885b45eaccb73ddbbbe67a4e6897e1e2bf7b`.
5. Codex session meta head read: commit `dd89ffeb4c551f3ff786af9c840d67a157285afa`.
6. Managed session quit and zombie cleanup: commit `8e3687a2440493aefd43f767ee72612a03385a1b`.

Future candidate cases:

1. Auth/session cookie or WebAuthn changes.
2. Upload route boundary validation.
3. LaunchAgent/install packaging change.
4. Public landing page / crawler surface changes.

Each golden case should include:

- target commit/diff
- relevant ARDs/failure records
- expected findings with severity and concern
- expected false positives to suppress
- evaluation notes after harness output is compared

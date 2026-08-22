# Mobile push token recovery

## Goal

Diagnose staging mobile notification failures and make stale or malformed FCM registrations self-healing: the mobile app re-registers its current token with paired desktops on launch and token rotation, registration replaces prior tokens for that device, and permanent FCM token errors evict the bad token and report that the app must be opened to re-register.

## Scope and constraints

- Trace the desktop server → relay/Firebase notification and mobile registration paths, including the staging instance's stored registration metadata and exact provider failure.
- Add server/relay coverage for replacement semantics and eviction on `messaging/invalid-argument` and `messaging/registration-token-not-registered`, plus mobile launch re-registration coverage.
- Keep the mobile change JS-only and do not bump `runtimeVersion`.
- Do not broaden into unrelated notification, pairing, or Firebase changes. Add a dated E2E-gap note because real-device FCM delivery is not available in CI.
- Revision directive (reviewer, 2026-08-22): make permanent-error eviction atomic and conditional on the device document still containing the exact token submitted to Firebase, so an in-flight rejection cannot delete a replacement registration; cover both the replacement race and unchanged-token eviction in relay tests.

## Done when

The defect's cause is evidenced, current tokens replace obsolete registrations, permanent bad-token failures conditionally remove only the rejected registration and surface a distinct no-valid-token reason, and `cargo test -p kanna-server` plus the relevant mobile/relay suites pass.

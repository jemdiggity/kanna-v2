# Updater Keychain release E2E gap (2026-08-12)

Kanna now imports the updater private signing key into an explicitly selected
macOS Keychain item, verifies that item before recording its selectors, and
reads the key only from that item when creating updater signatures.

The regular test suite cannot exercise the complete setup-to-release path. A
faithful E2E would need to create and unlock a disposable macOS Keychain, import
the long-lived updater key, invoke the real Tauri signer, and validate a signed
bundle without exposing the credential or publishing a release. CI runners do
not currently provide that isolated Keychain fixture, and using the operator's
real updater key would violate release-secret isolation.

Narrower coverage in the meantime:

- `tools/kd/tests/updater-key.test.ts` covers selector validation, exact
  service/account/Keychain lookup, safe error classification, setup round-trip
  verification, owner-only selector persistence, and failure-before-config.
- `tools/kd/tests/release-env.test.ts` covers machine-global loading, plaintext
  signing-secret rejection, preservation of notarization selectors, and the
  existing pinned-directory/race-safe writer boundary.
- `tools/kd/tests/release-tasks.test.ts` covers the CLI task loading
  `~/.kanna/.env.release.local` before updater setup.
- `tools/kd/tests/release.test.ts` covers the release helper reading Keychain
  material and passing it to Tauri through the signer child environment rather
  than argv or a private-key file.

This gap can close once the release test harness provisions a disposable
file-based Keychain and a non-production updater key on a macOS runner, with a
local signer-verification fixture and an assertion that no GitHub release or
notarization request is made.

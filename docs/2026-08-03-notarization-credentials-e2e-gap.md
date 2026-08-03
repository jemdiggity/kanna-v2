# Notarization credential Apple-network E2E gap (2026-08-03)

Kanna now selects one named notarization profile from an explicit file-based
Keychain, validates that exact pair before a release build, and forwards both
selectors into the Bazel notarization action. The canonical test suite cannot
submit a disposable credential to Apple's production notary service: Apple has
no local emulator, a valid Developer account is privileged machine state, and
submitting an artifact would create an external notarization record.

Narrower coverage proves the local wiring without publishing anything:

- `tools/kd/tests/notarization.test.ts` exercises safe selector validation,
  credential error classification, the online-validation command boundary, and
  the interactive setup/config write flow with a disposable Keychain file and
  faithful command runner.
- `tools/kd/tests/release-tasks.test.ts` proves an inaccessible profile stops
  before the ship/build/publish boundary, so no Bazel build, tag, or GitHub
  release operation begins.
- `tools/bazel/build_macos_notarized_dmg_test.py` executes the same Python entry
  point used by the Bazel action against a fake `xcrun` executable and proves
  both the profile and explicit Keychain path reach `notarytool submit`.

A canonical Apple-network E2E becomes feasible only if Apple provides a local
Notary service emulator or Kanna CI receives a dedicated, revocable Developer
credential and an approved non-release submission budget. Until then, the
release preflight's real `notarytool history` request is the read-only live
authentication check; actual notarization remains exercised only during an
authorized staging or production ship.

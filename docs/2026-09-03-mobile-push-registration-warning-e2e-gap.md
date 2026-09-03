# Desktop push-registration warning: E2E gap (2026-09-03)

Task 34047a85 added a warning row to the desktop Mobile Access panel
(`MobileAccessPanel.vue`) that appears when the signed-in account has no
registered mobile push device, fed by
`GET /v1/mobile/notifications/registration` through the
`mobile_push_registration_status` Tauri command. The route is a relay dry-run
publish, so the truthful state of the row depends on a relay that resolves
the account's `pushDevices` from Firestore.

## Why it is not E2E-testable yet

- The desktop mock E2E suite (`apps/desktop/tests/e2e/mock/preferences.test.ts`)
  runs the webview against a mock server with no relay and no signed-in account,
  so the row never renders there.
- The real desktop E2E (`apps/desktop/tests/e2e/real/mobile-pairing-ui.test.ts`)
  starts `kanna-server` but not a relay or Firebase emulators. There is no
  fixture today that signs the desktop into an emulator account and connects it
  to a local relay from a desktop E2E.

## What would make it testable

A desktop real-E2E fixture that starts the relay against the Firebase
emulators (as `services/relay/test/integration.test.ts` does), seeds a
`desktopCredentials` document for the test desktop, signs the desktop in, and
then registers or retires a `pushDevices` document to drive the row through
`registered` → `noRegisteredDevices` (reason `unregistered`) → `registered`.

## Coverage landed meanwhile

- Relay integration (`services/relay/test/integration.test.ts`): dry-run publish
  resolves a registered device without sending; a zero-target publish carries
  `noDevicesReason` (`neverRegistered`, `unregistered`); a stale unregister
  naming an older registration id is ignored.
- Relay unit (`services/relay/src/pushDevices.test.ts`,
  `mobileNotifications.test.ts`): registration-id guard, retirement records,
  reason derivation, dry run, logging without tokens.
- Server (`crates/kanna-server/src/relay.rs` tests): the probe is refused
  against a version-1 relay and resolved against a version-2 relay ack.
- Desktop component (`MobileAccessPanel.test.ts`): the warning, reason,
  instruction, and refresh action render from the status prop.
- Mobile (`mobilePush.test.ts`): cleanup/re-register ordering and failed
  re-registration retry.

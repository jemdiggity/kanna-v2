# Mobile Hybrid Reliability E2E Coverage

`pnpm --dir apps/mobile run test:e2e:hybrid` is the production-like simulator
path for signed-in cloud plus persisted trusted LAN. It starts the real Auth and
Firestore emulators, relay, daemon, and `kanna-server`; launches Metro with
`EXPO_PUBLIC_KANNA_FORCE_CLOUD=0`; persists the harness desktop as trusted; and
seeds a cloud-only task, a cloud/LAN duplicate, and a LAN-only task.

The Appium flow asserts the exact stable three-row display-id set, LAN metadata
on the duplicate, absence of the duplicate local-id row, and the visible task
list/account/toolbar shell after seeding an intentionally absent selection ID.
The component integration test proves that ID remains unresolved internally.
After the first signed-in hybrid snapshot, Appium terminates and reactivates the
same simulator app without clearing its sandbox. It then requires the exact
cloud-only, deduplicated cloud/LAN, and LAN-only rows to return and opens the
account sheet to verify that the persisted Firebase session restored directly
to the signed-in state. This also retains the trusted-LAN record and proves the
relaunch does not need another interactive sign-in.
After the stable snapshot, Appium opens the LAN-only task, updates the
cloud-only Firestore child document through the relay harness, and waits for an
E2E-only marker on the still-open detail screen to include the refreshed cloud
title. That marker is derived from the controller's accepted recent-task
collection, so it causally acknowledges mobile callback processing rather than
relying on a timing sleep. The selected LAN-only detail and stream must still be
open after that acknowledgment. Returning to the list must show the same three
display IDs, the refreshed cloud-only title, and the LAN-preferred duplicate
metadata. The flow then stops the relay and opens the duplicate by its cloud
display id, proving the selected terminal still routes over trusted LAN when
task detail mounts and its terminal loading overlay clears. It never opens an
arbitrary first row. Byte-level xterm WebView inspection remains in the
dedicated PTY smoke/relay coverage: XCUITest intermittently exposes only the
`NATIVE_APP` context after this lane deliberately stops relay, so requiring a
WebView context here would test Appium remote-debugger timing rather than route
selection.

The real hybrid lane does not currently expose a barrier that can pause only a
direct LAN `/v1/tasks/recent` probe while leaving the KSP stream and relay
desktop running. Consequently Appium proves the permanent user-facing
regression (row, selection, and stream continuity) plus the accepted route
after the replacement snapshot, but it cannot sample the route table during an
arbitrarily held in-flight probe. Making that transient assertion deterministic
would require E2E-only arm/wait/release controls around direct LAN recent-task
reads, with relay-originated requests explicitly bypassing the gate. The
deferred-probe integration in `src/appModel.cloudFallback.test.ts` provides
that narrower barrier. It drives both a Firestore callback and deferred relay
presence convergence, then asserts the established LAN route before failure and
before the complete replacement is released.

Two lifecycle branches are intentionally kept out of this Appium flow:

- Foreground recovery from injected `idle` and `error` states needs a test
  control surface that can pause both transports, synchronously observe the
  controller state, restore one transport, and trigger a React Native
  `AppState` transition in that order. Stopping the relay alone must remain
  healthy in this hybrid test, while killing the whole disposable server makes
  Bonjour/process restart timing—not foreground recovery—the dominant signal.
  A deterministic fixture would expose transport fault gates and controller
  state through an E2E-only server/app bridge. The branch-level substitutes are
  `src/state/mobileController.test.ts`, `src/appLifecycle.test.ts`, and the
  rendered wiring coverage in `src/App.component.test.tsx`.
- The OTA foreground exception requires a correctly signed update for the
  installed native runtime and an OTA endpoint whose channel pointer the test
  owns. This harness deliberately runs the dev environment, where OTA is
  disabled, so manufacturing a reload would bypass the production updater.
  A deterministic fixture would provide an isolated signed OTA channel and a
  matching simulator build. `src/appLifecycle.test.ts` covers the decision that
  a downloaded OTA reload replaces normal foreground refresh, and
  `src/App.component.test.tsx` covers the App wiring.

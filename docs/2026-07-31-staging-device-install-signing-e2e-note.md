# Staging iOS device Release install — signing E2E gap (2026-07-31)

## Behavior

`./kd mobile run --device --staging --install` must produce, from a clean
generated `apps/mobile/ios/`, a pod-integrated, signed Release build of
`build.kanna.app.staging` installed and launched on an attached iPhone. Two
regressions were introduced around the Firebase mobile push work
(`6744a565 feat: add agent mobile push notifications`) and are fixed in code:

1. **CocoaPods**: React Native Firebase's Swift pods cannot integrate as plain
   static libraries; `withKannaFirebaseMessaging` now sets the
   `ios.useFrameworks: static` Podfile property (the same property
   `expo-build-properties` sets), so a clean `expo prebuild` + `pod install`
   succeeds.
2. **Signing**: the push work added the `aps-environment` entitlement, which
   requires a provisioning profile that includes it. Expo CLI's `run:ios` only
   passes `-allowProvisioningUpdates` when the pbxproj lacks a
   `DEVELOPMENT_TEAM`, and prebuild always writes ours (`ios.appleTeamId`), so
   automatic signing could never mint the new profile. The kd install path now
   builds with `xcodebuild ... -allowProvisioningUpdates
   -allowProvisioningDeviceRegistration` and installs/launches via `devicectl`.

## Why the on-device E2E proof cannot run yet

The full chain was exercised on 2026-07-31 against the attached iPhone 15
(`00008130-001015CA1091401C`): clean prebuild and pod install pass, and
xcodebuild reaches signing, but fails with:

```
error: No Accounts: Add a new account in Accounts settings.
error: Provisioning profile "iOS Team Provisioning Profile: *" doesn't include the Push Notifications capability.
error: Provisioning profile "iOS Team Provisioning Profile: *" doesn't include the aps-environment entitlement.
```

No Apple ID is signed into Xcode on this machine and no cached profile covers
`build.kanna.app.staging` with `aps-environment` (only wildcard team profiles
exist, which can never carry push). `-allowProvisioningUpdates` therefore has
no portal session to mint the profile with. This is external machine state the
repository cannot own.

## What makes it testable

A human signs into Xcode → Settings → Accounts with an Apple ID that is a
member of team `GY3LFAA59P` (a role allowed to register App IDs and enable the
Push Notifications capability), then reruns:

```
./kd mobile run --device --staging --install
pnpm --dir apps/mobile run test:e2e:device:release-install
```

The first command mints the profile via automatic signing (registering
`build.kanna.app.staging` with Push Notifications if needed); the second is the
E2E install/launch check added for this path.

## Narrower tests added meanwhile

- `apps/mobile/src/firebaseMessagingPlugin.test.ts` — static-frameworks
  Podfile property mod (idempotent, iOS-only mods).
- `tools/kd/tests/mobile-device.test.ts` — xcodebuild/devicectl command
  builders, workspace/app product resolution, provisioning flags.
- `tools/kd/tests/tasks.test.ts` — full `--install` execution order
  (prebuild → xcodebuild → devicectl install → devicectl launch).
- `apps/mobile/e2e/helpers/release-install.test.ts` — E2E check target
  resolution and launch invocation.

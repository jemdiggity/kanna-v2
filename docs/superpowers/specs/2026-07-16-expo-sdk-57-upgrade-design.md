# Expo SDK 57 Upgrade Design

## Goal

Upgrade Kanna Mobile from Expo SDK 53 to SDK 57 through Expo's supported
53 → 54 → 55 → 56 → 57 sequence while preserving Kanna's CNG-owned native
configuration, environment identities, Firebase/relay selection, signed OTA
updates, and `kd` development workflows.

## Approach

Perform the dependency migration in place, one SDK at a time. At each step,
install the target Expo major, let `expo install --fix` select the compatible
React, React Native, Expo modules, and community native packages, then run Expo
dependency validation. Only the SDK 57 dependency state remains in the final
diff.

Do not commit generated `apps/mobile/ios` or `apps/mobile/android` directories.
After the final dependency update, run a clean SDK 57 prebuild and inspect/test
the generated iOS project. Kanna's config plugins remain the only source for
app-target identity, Bonjour, and the physical-device Metro bridge.

SDK 57.0.6 currently resolves `expo-modules-jsi` 57.0.3, whose new Date bridge
uses an unqualified Swift `abs` that is ambiguous with React Native's C++ JSI
imports under Xcode 26.2/Swift 6. Carry a pnpm patch that qualifies it as
`Swift.abs`, and remove the patch once Expo publishes the same upstream fix.
Turbo is kept at 2.10.5 or newer so repository orchestration understands pnpm
11's scalar patched-dependency lockfile representation.

### Parallel worktree build isolation

`expo-modules-jsi` writes its generated module map, SwiftPM state, nested Xcode
DerivedData, build context, and xcframework Products beside the installed
package. pnpm's experimental global virtual store resolves that package to one
physical directory for every Kanna worktree, so two overlapping native builds
can delete or replace state while the other build or CocoaPods copy phase is
using it.

Disable `enableGlobalVirtualStore` for the repository and use pnpm's default
project-local virtual store. The content-addressable store continues to
deduplicate dependency content, while every checkout gets a private physical
`expo-modules-jsi` package directory for all mutable Apple build state. Remove
the sequential root-switch cleanup from Kanna's package patch; the patch should
only retain the SDK 57 Swift compiler compatibility fix. Integration coverage
must install and prebuild two archived checkouts, overlap both simulator builds,
assert that their resolved package roots differ, and verify that each nested
Xcode response file contains only its own Pods root.

## Configuration Boundaries

- `apps/mobile/src/mobileEnvironments.json` remains the single source for dev,
  staging, and production identities, Firebase projects, relay URLs, OTA
  channels, and runtime compatibility. Bump all three runtime versions from
  `1.0.0` to `2.0.0` because SDK 57 changes the native runtime.
- `apps/mobile/app.config.ts` continues to derive Expo config entirely from the
  environment registry. SDK-specific schema/type adjustments may be made, but
  values and selection behavior must not change.
- `withKannaNativeIdentity.js` consumes CNG's generated project name and touches
  only that app target, leaving test targets alone.
- `withKannaBonjour.js` continues to generate its Swift/Objective-C bridge and
  patch the CNG-generated AppDelegate and bundle script. Its transformations
  must fail loudly if the SDK 57 template is no longer recognized instead of
  silently omitting physical-device Metro support.

## Device Launch Behavior

`./kd mobile run --device` keeps delegating build/install/launch to the local
Expo CLI through `expo run:ios`. SDK 57's CLI must contain the upstream physical
device launch path that terminates an already-running app before launching it.
Kanna tests the installed CLI source/behavioral contract, and its existing
post-Metro recovery relaunch uses the same `--terminate-existing` behavior. The
relaunch remains limited to recovery after a reported Metro failure; this does
not add another install or launch path.

No automated command may install or launch an attached physical device. The
practical launch check is limited to CLI source/contract inspection, `kd` unit
tests, simulator/prebuild/build checks, and a documented human verification.

## Verification

Run the mobile unit suite and typecheck, `expo install --check`, Expo Doctor,
Expo config resolution for all three environments, custom plugin tests, `kd`
device-flow tests, a clean iOS prebuild, and a simulator/debug iOS build where
local tooling permits. Inspect the generated app target bundle id/display name,
Info.plist Bonjour/OTA configuration, native bridge sources, and bundle script.

Remaining manual verification is a human-run `./kd mobile run --device` with an
already-running Kanna development build, confirming that Expo terminates and
relaunches it and does not remain at `Connecting to`.

## Scope

This change does not redesign the mobile UI, opt into unrelated SDK features,
change relay/Firebase/OTA protocols, or modify the temporary `kd` timeout and
payload-recovery workaround.

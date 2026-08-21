# Mobile Expo native ABI launch coverage — 2026-08-21

## Risk

Kanna Dev and Kanna Staging installed on an iPhone 15 Pro but terminated before
JavaScript startup because `ExpoImageManipulator.framework` referenced
`BaseModule.willDestroy`, which the older resolved `ExpoModulesCore.framework`
did not export. JavaScript-only tests cannot exercise this dynamic-linker
boundary.

## Automated guard

`apps/mobile/src/nativeDependencyCompatibility.test.ts` reads the installed
Expo SDK's committed `bundledNativeModules.json` compatibility matrix and
checks every direct Expo-managed dependency's resolved version. Native Expo
package declarations must also match the matrix's recommended patch line
exactly: semver alone is insufficient because `~57.0.4` accepts the crashing
`57.0.11` image-manipulator build. The guard additionally checks that the
resolved Expo Modules Core source provides `BaseModule.willDestroy`, the exact
symbol the image-manipulator framework imports. A frozen pnpm install plus this
test deterministically rejects the package/lock combination that produced the
ABI skew. `expo install --check` remains a second diagnostic against Expo's
current compatibility service.

Stable automated physical-device startup coverage is not currently available:
the repository's device E2E lane requires an attached, trusted, provisioned
iPhone and a reachable Mac/phone network, which hosted CI cannot guarantee.
The narrower guard validates dependency selection before CNG, while the
canonical `./kd mobile run --device --install` paths build the generated Pods
and frameworks and provide the manual native-startup check.

Physical verification exposed a separate host-toolchain mismatch. Expo SDK 57
requires Xcode 26.4 or newer. The failed compiler commands invoked
`/Applications/Xcode.app` with `iPhoneOS26.2.sdk`; there was no `DEVELOPER_DIR`,
alternate toolchain, or `kd` pin. That same application path now reports Xcode
26.6, showing that it was upgraded in place. The attempted Core/JSI patches and
forced source-build configuration were removed; verification uses Expo's
published SDK 57 artifacts unpatched under the supported compiler.

## Manual device verification

Target: Jerome's iPhone 15, iPhone 15 Pro (`iPhone16,1`), iOS 26.6.1,
UDID `00008130-001015CA1091401C`.

- `KANNA_IOS_DEVICE_UDID=00008130-001015CA1091401C ./kd mobile run
  --device --install` completed the signed Release build for Kanna Dev
  (`build.kanna.app.dev`). Before installation, the phone dropped off
  CoreDevice; `kd` reported that the device identifier could not be found.
- Inspection of that exact signed app shows `ExpoImageManipulator` imports
  `ExpoModulesCore.BaseModule.willDestroy()` and its packaged
  `ExpoModulesCore` exports the matching dispatch thunk. `codesign --verify
  --deep --strict` also succeeds.
- A subsequent canonical Staging attempt was correctly refused before build
  because the requested iPhone 15 Pro remained unavailable. The installed
  desktop context used for staging verification is Kanna Staging on local port
  48121, desktop id `desktop-21b320e8-a5ad-4fae-9d87-1db14090f0a9`.

After Xcode 26.6 (Swift 6.3.3) was selected and licensed, both canonical
unpatched builds completed on 2026-08-21:

- `KANNA_IOS_DEVICE_UDID=00008130-001015CA1091401C ./kd mobile run --device
  --install` reported `BUILD SUCCEEDED`, installed, and launched
  `build.kanna.app.dev`.
- The corresponding `--staging --install` command reported `BUILD SUCCEEDED`,
  installed, and launched `build.kanna.app.staging`.
- At 18:56 JST, CoreDevice process snapshots 15 seconds apart contained both
  Kanna Dev PID 18596 and Kanna Staging PID 18631. The device's system crash-log
  domain contained only retired Kanna reports from 12:13 JST or earlier, with
  no new dyld, signal 6, Dev, or Staging crash report after these launches.

This manual result proves both generated identities survive native startup with
the aligned dependency graph. The automated package-matrix and symbol-provider
guard remains the repeatable regression coverage when no physical iPhone is
available.

# Mobile native "About this build" version — device E2E note

Non-archive iOS builds (dev/staging via `./kd mobile run --device`,
`./kd dev up --mobile`, `./kd mobile up`) used to embed
`CFBundleShortVersionString` `0.0.0`: `apps/mobile/app.config.ts` only set the
Expo `version` when `KANNA_APP_VERSION` was present (production archives), so
Expo fell back to the private-workspace placeholder version `0.0.0` in
`apps/mobile/package.json`, and "About this build" reported `0.0.0 (1)`.

`app.config.ts` now defaults the native version from the repository `VERSION`
file — the same release source `tools/kd/src/runtime/mobile-archive.ts` reads —
with an explicit `KANNA_APP_VERSION` still taking precedence, preserving the
production archive's `--version`/default semantics. Because this changes the
native config output (`CFBundleShortVersionString`) of every rebuilt binary,
`runtimeVersion` was bumped to `2.1.4` in every environment per AGENTS.md.

## Verification status

Automated coverage added:

- `apps/mobile/src/mobileAppConfig.test.ts` — VERSION fallback, explicit
  `KANNA_APP_VERSION` precedence, blank-override fallback, walk-up file
  resolution, and loud failure on an empty `VERSION`.
- `tools/kd/src/runtime/mobile-archive.test.ts` — production archive default
  version comes from `VERSION`, and explicit `--version` still wins.
- `tools/kd/tests/mobile-device.test.ts` — device build env intentionally does
  not set `KANNA_APP_VERSION`.
- `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts` — the About-this-build
  journey now fails on a placeholder `0.0.0 (n)` or malformed Native value, so
  any device/simulator smoke run asserts the real native version.

After rebasing onto the mobile signing/install fix, a clean canonical run was
performed against Jerome's connected iPhone 15:

```sh
rm -rf apps/mobile/ios
KANNA_IOS_DEVICE_UDID=00008130-001015CA1091401C \
  ./kd mobile run --device --staging --install
```

Expo prebuild, CocoaPods installation, the Release build, signing, and device
installation all succeeded. The installed app is `Kanna Staging`, bundle ID
`build.kanna.app.staging`, version `0.0.68`, build `1`. The exact built
artifact also reports runtime `2.1.4`, OTA channel `staging`, and the staging
manifest URL.

The command exited nonzero only at its final launch step because iOS reported
the device as locked (`FBSOpenApplicationErrorDomain` code 7). A subsequent
`test:e2e:device:release-install` attempt and a direct `devicectl` launch were
denied for the same reason. Consequently the installed binary and its embedded
metadata are verified, but the rendered About-this-build journey was not
observed on device. The runtime hop (expo-application native values →
`BuildIdentity` → panel) remains covered by
`apps/mobile/src/lib/updates/buildIdentity.test.ts`, and the existing device
smoke journey (`assertBuildInfoJourney`) rejects placeholder native versions.

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

No build was installed on a device. The clean canonical
`./kd mobile run --device --staging --install` run failed at `pod install`
(see below). A second run with a temporary, local-only static-frameworks patch
(not part of this change) got past pods: its prebuild generated
`ios/KannaStaging/Info.plist` with `CFBundleShortVersionString` `0.0.68`
(repository `VERSION`) and `CFBundleVersion` `1` — verifying only the
config → generated-Info.plist hop — and then failed at Release code signing,
so nothing reached the iPhone and the rendered About row was never observed.
The runtime hop (expo-application native values → `BuildIdentity` → panel) is
covered by `apps/mobile/src/lib/updates/buildIdentity.test.ts`.

## Why the full on-device E2E could not run yet

The canonical clean staging device build currently fails on `main` for reasons
unrelated to the version source, introduced with the Firebase messaging
dependency (commit `6744a565`):

1. `pod install` rejects the Firebase Swift static pods — nothing sets
   `ios.useFrameworks: "static"` (or modular headers) for the generated
   Podfile, which upstream expects `expo-build-properties` to provide.
2. After fixing 1 locally, Release signing fails because the
   `aps-environment` push entitlement is not registered in the local team
   provisioning profile for `build.kanna.app.staging`.

Once those follow-ups land, the existing device smoke journey
(`assertBuildInfoJourney`) asserts the non-`0.0.0` native version on device
with no further work.

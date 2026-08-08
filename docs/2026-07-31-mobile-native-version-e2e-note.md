# Mobile native "About this build" version — device E2E note

Non-archive iOS builds (dev/staging via `./kd mobile run --device`,
`./kd dev up --mobile`, `./kd mobile up`) used to embed
`CFBundleShortVersionString` `0.0.0`: `apps/mobile/app.config.ts` only set the
Expo `version` when `KANNA_APP_VERSION` was present (production archives), so
Expo fell back to the private-workspace placeholder version `0.0.0` in
`apps/mobile/package.json`, and "About this build" reported `0.0.0 (1)`.

`app.config.ts` now resolves an explicit `KANNA_APP_VERSION` first, then the
mobile-owned `apps/mobile/VERSION`, and finally the root desktop `VERSION` as a
compatibility fallback. `tools/kd/src/runtime/mobile-archive.ts` uses the same
precedence for its explicit `--version` and checked-in defaults. An empty or
malformed mobile file fails loudly rather than invisibly coupling the build
back to the desktop version. Dev builds therefore have a deterministic
non-placeholder fallback without inheriting every desktop release bump.

Staging is different: its active release series may be ahead of production
`VERSION`. Before any physical staging build, kd downloads the authoritative
`desktop-staging/latest-staging.json` channel pointer and converts a version
such as `0.1.0-staging.2` to the native marketing version `0.1.0`. It fails
closed before prebuild when the channel is unavailable or malformed rather
than guessing from local tags. An explicit `KANNA_APP_VERSION` bypasses that
lookup. The native runtime remains `2.1.4` in every environment.

## Verification status

Automated coverage added:

- `apps/mobile/src/mobileAppConfig.test.ts` — explicit environment override,
  mobile VERSION, and root fallback precedence; walk-up file resolution; and
  loud path-specific failures for empty or malformed mobile versions.
- `tools/kd/src/runtime/mobile-archive.test.ts` — the same three-level archive
  precedence and path-specific empty/malformed mobile VERSION failures.
- `tools/kd/tests/release.test.ts` — active staging channel resolution,
  prerelease-suffix removal, invalid-manifest rejection, and network failure.
- `tools/kd/tests/tasks.test.ts` — resolved staging versions reach dev-client
  and Release prebuild/build environments, while explicit overrides bypass
  channel resolution.
- `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts` — the About-this-build
  journey fails on a placeholder or malformed Native value and can assert an
  exact expected native version/build.

After rebasing onto the mobile signing/install fix, a clean canonical run was
performed against Jerome's connected iPhone 15:

```sh
rm -rf apps/mobile/ios
KANNA_IOS_DEVICE_UDID=00008130-001015CA1091401C \
  ./kd mobile run --device --staging --install
```

The active channel was `0.1.0-staging.2`. Expo prebuild, CocoaPods installation,
the Release build, signing, device installation, and launch all succeeded. The
installed app and exact built artifact report `Kanna Staging`, bundle ID
`build.kanna.app.staging`, native version `0.1.0` build `1`, runtime `2.1.4`,
OTA channel `staging`, and the staging manifest URL. The independent
`test:e2e:device:release-install` launch check also passed.

The rendered About-this-build journey could not be observed automatically in
this run. CoreDevice could inspect and launch the paired iPhone, but the Appium
XCUITest transport reported no accessible real devices and rejected the exact
UDID before session creation. The committed journey now supports the required
exact assertion (`0.1.0 (1)`, runtime `2.1.4`, staging identity/channel,
`Embedded bundle`) once the phone is visible to XCUITest. The underlying
expo-application native-values → `BuildIdentity` → panel hop remains covered by
`apps/mobile/src/lib/updates/buildIdentity.test.ts`.

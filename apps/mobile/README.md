# Kanna Mobile

## Production QA

Before TestFlight external testing or App Store submission, run the production
mobile QA gate in [docs/testing/mobile-production-qa-gate.md](../../docs/testing/mobile-production-qa-gate.md).

## OTA Runtime Version

`apps/mobile/src/mobileEnvironments.json` is the source of truth for the mobile
OTA `runtimeVersion`. Staging and production builds use that value in the Expo
Updates request header and only accept OTA bundles with the same runtime.

Bump `runtimeVersion` whenever a change touches native code, native config, the
Expo SDK, native dependencies, or `plugins/withKannaNativeIdentity.js`. JS-only
changes keep the same `runtimeVersion` and are OTA-deliverable.

The current Expo SDK 57 native runtime uses `runtimeVersion` `2.1.4`. OTA
updates built for an earlier runtime are not compatible; install a native build
with the matching runtime before publishing or applying an update.

Development builds (`KANNA_APP_ENV=dev`) do not configure OTA updates; they run
from Metro/dev-client.

## About This Build

Open **More → About this build** in the mobile app to inspect the installed
native application version and build number, OTA runtime version, app
environment and channel, and the JavaScript source currently running. The row
stays collapsed until pressed so repository commands remain the primary More
screen content.

A full UUID under **Running source** identifies a downloaded Expo OTA update;
tap it to copy the exact update ID. **Embedded bundle** means the app is running
the JavaScript packaged in the installed native binary. **Development bundle
(Metro)** means a dev-client session is loading JavaScript from Metro rather
than Expo Updates.

Physical staging builds started with `./kd mobile run --device --staging`
resolve the active `desktop-staging/latest-staging.json` release pointer and
embed its marketing version after removing the `-staging.N` suffix. The build
fails before prebuild if that authoritative pointer is unavailable or invalid;
it does not substitute a checked-in version or a possibly stale local tag. An
explicit `KANNA_APP_VERSION` still takes precedence. Dev builds use the
checked-in `apps/mobile/VERSION` as their deterministic fallback, with the root
desktop `VERSION` retained only for compatibility when the mobile file is
absent.

## Production iOS Archive

Use the repo-native wrapper for App Store Connect builds:

```bash
./kd mobile archive --production --build-number <next-app-store-build-number>
```

The command runs Expo CNG locally with `KANNA_APP_ENV=prod`, keeps the generated
`apps/mobile/ios/` directory uncommitted, archives the generated Xcode workspace,
and exports an IPA under `.build/mobile/ios-production/`. It uses the production
bundle id `build.kanna.app`, display name `Kanna`, and Apple team
`EA4J68749Z` from `app.config.ts` and `mobileEnvironments.json`. Expo SDK 57
generates the production workspace and scheme as `Kanna`; the dev and staging
workspaces are `KannaDev` and `KannaStaging` respectively.

By default, the App Store marketing version comes from `apps/mobile/VERSION`.
Pass `--version <version>` for an explicit one-build override. If the mobile
file is absent, the root desktop `VERSION` remains a compatibility fallback;
an empty or malformed mobile file fails instead of silently falling back.
Always pass a monotonically increasing `--build-number`; this becomes
`CFBundleVersion`.

To upload after export, configure Transporter API-key credentials locally and
run:

```bash
APP_STORE_CONNECT_API_KEY_ID=<key-id> \
APP_STORE_CONNECT_API_ISSUER_ID=<issuer-id> \
./kd mobile archive --production --build-number <next-build-number> --upload
```

Transporter expects the matching private key at
`~/.appstoreconnect/private_keys/AuthKey_<key-id>.p8`. Use `--dry-run` to print
the full prebuild/archive/export/upload plan without contacting Apple.

Apple requires App Store Connect uploads to be built with Xcode 26 or later
using an iOS 26 SDK or later as of April 28, 2026:
https://developer.apple.com/news/upcoming-requirements/

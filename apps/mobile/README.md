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

Development builds (`KANNA_APP_ENV=dev`) do not configure OTA updates; they run
from Metro/dev-client.

## Production iOS Archive

Use the repo-native wrapper for App Store Connect builds:

```bash
./kd mobile archive --production --build-number <next-app-store-build-number>
```

The command runs Expo CNG locally with `KANNA_APP_ENV=prod`, keeps the generated
`apps/mobile/ios/` directory uncommitted, archives the generated Xcode workspace,
and exports an IPA under `.build/mobile/ios-production/`. It uses the production
bundle id `build.kanna.app`, display name `Kanna`, and Apple team
`GY3LFAA59P` from `app.config.ts` and `mobileEnvironments.json`.

By default, the App Store marketing version comes from the repo `VERSION` file.
Pass `--version <version>` only if the mobile App Store version intentionally
diverges from the desktop release version. Always pass a monotonically
increasing `--build-number`; this becomes `CFBundleVersion`.

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

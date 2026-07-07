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

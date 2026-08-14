# Staging mobile marketing version — physical-device E2E gap

`./kd mobile run --device --staging --install` now defaults the native
marketing version to `apps/mobile/VERSION`, independently of the active desktop
staging RC. Automated tests cover the cross-boundary contract up to the device:

- the kd executor preserves the staging native identity and bundled Release
  build/install/launch commands while leaving `KANNA_APP_VERSION` unset;
- the same executor makes no GitHub or desktop release-status call to select a
  version, even when its runner could report a different desktop RC;
- `apps/mobile/app.config.ts` resolves the unset value to
  `apps/mobile/VERSION` for staging and production, and an explicit
  `KANNA_APP_VERSION` still wins;
- the existing Appium About-this-build journey supports an exact native-version
  assertion and also checks runtime version, environment, OTA channel, and
  bundled-source state.

The final displayed `CFBundleShortVersionString` cannot be proven without
building, signing, installing, and driving a physical iPhone. This task
explicitly prohibits installing to a phone, so that mutation was not performed.
A human can close the gap by running the canonical staging install against an
active desktop RC whose version differs from `apps/mobile/VERSION`, then run:

```sh
KANNA_APP_ENV=staging \
KANNA_E2E_EXPECTED_NATIVE_VERSION="$(tr -d '[:space:]' < apps/mobile/VERSION) (1)" \
KANNA_E2E_EXPECTED_RUNNING_SOURCE="Embedded bundle" \
pnpm --dir apps/mobile run test:e2e:device:smoke
```

The expected result is the mobile-owned version, staging bundle id
`build.kanna.app.staging`, runtime `2.1.4`, staging Firebase/relay/OTA settings,
valid staging signing, and `Embedded bundle` for the Release install.

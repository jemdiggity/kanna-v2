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
active desktop RC whose version differs from `apps/mobile/VERSION`. Before
running the device smoke, use `kanna-cli info` to obtain that staging
instance's authoritative LAN API endpoint, and provision or select a live PTY
task from that same instance whose terminal snapshot contains a known sentinel.
Export the endpoint as `KANNA_E2E_DESKTOP_SERVER_URL`, the task and sentinel as
`KANNA_E2E_PTY_TASK_ID` and `KANNA_E2E_PTY_SENTINEL`, and an unused local
Appium port as `KANNA_APPIUM_PORT`. Set `KANNA_IOS_DEVICE_UDID` (or
`KANNA_IOS_PHYSICAL_DEVICE_NAME`) when more than one physical iPhone is visible.

After installing the Appium XCUITest driver and confirming that the phone is
connected, unlocked, and already has the staging Release build installed, run:

```sh
: "${KANNA_APPIUM_PORT:?set an unused local Appium port}" \
  "${KANNA_E2E_DESKTOP_SERVER_URL:?set the authoritative staging LAN API endpoint}" \
  "${KANNA_E2E_PTY_TASK_ID:?set a live PTY task id from that staging instance}" \
  "${KANNA_E2E_PTY_SENTINEL:?set text visible in that task's terminal snapshot}"

KANNA_APP_ENV=staging \
KANNA_E2E_EXPECTED_NATIVE_VERSION="$(tr -d '[:space:]' < apps/mobile/VERSION) (1)" \
KANNA_E2E_EXPECTED_RUNNING_SOURCE="Embedded bundle" \
pnpm --dir apps/mobile run test:e2e:device:smoke
```

The smoke first validates and opens that exact PTY fixture, then continues to
the profile's About-this-build journey and its native-version assertion. Thus
all four required variables above must remain exported for the entire run; the
build-info assertion is not a standalone path in the current device runner.

The expected result is the mobile-owned version, staging bundle id
`build.kanna.app.staging`, runtime `2.1.4`, staging Firebase/relay/OTA settings,
valid staging signing, and `Embedded bundle` for the Release install.

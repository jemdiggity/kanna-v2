# Mobile Production QA Gate

This gate is required before sending a Kanna mobile production build to
TestFlight external testing and before submitting that build to App Store
review. It does not upload to TestFlight or App Store Connect, and it does not
install, launch, or run Appium against a physical iPhone.

## Automated Gate

Run this from the repo root:

```bash
./kd mobile qa --production
```

The command validates `apps/mobile/src/mobileEnvironments.json` production
identity, then runs:

```bash
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile run test
pnpm --dir apps/mobile run test:e2e:preflight
pnpm --dir apps/mobile run test:e2e:smoke
```

The simulator checks use `KANNA_APP_ENV=prod` and default
`KANNA_E2E_DESKTOP_SERVER_URL` to the installed production desktop server at
`http://127.0.0.1:48120`. Start the installed desktop app first. If you need to
target another desktop server, set `KANNA_E2E_DESKTOP_SERVER_URL` before
running the gate. The simulator checks also require the existing Appium
XCUITest setup and a simulator app installed with the production bundle id
`build.kanna.app`; the preflight step fails early when those are missing.

For releases that touch OTA, relay, Firebase production config, update signing,
or `runtimeVersion`, run the OTA-inclusive gate:

```bash
./kd mobile qa --production --ota
```

That adds the existing read-only production OTA checks:

```bash
./kd mobile ota status --production
./kd mobile ota doctor --production
```

These require Google Cloud credentials for `kanna-build`. They read production
cloud and relay state but do not publish, roll back, or mutate devices.

## Before TestFlight External Testing

1. Build the production iOS candidate through the normal Expo/Xcode production
   release path.
2. Run `./kd mobile qa --production`.
3. If the release changes OTA, relay, Firebase production config, update
   signing, or `runtimeVersion`, run `./kd mobile qa --production --ota`.
4. Human-only physical-device check on the TestFlight build:
   - Install the candidate from TestFlight on an iPhone.
   - Confirm Settings -> Privacy & Security -> Local Network -> Kanna is on.
   - Open Kanna, sign in to a production account, and confirm the profile state.
   - Confirm the app reaches the production relay or installed production
     desktop server.
   - Open the task list, open a task, verify terminal output streams, send input,
     and navigate back to the task list.
   - If OTA is expected, verify the app applies the production OTA and reports
     the expected runtime/channel in the app update UI.

External TestFlight can proceed only after the automated gate passes and the
human physical-device check has no release-blocking issues.

## Before App Store Submission

1. Confirm the App Store candidate is the same build that passed external
   TestFlight, or rerun the full gate for the rebuilt candidate.
2. Run `./kd mobile qa --production --ota` when any OTA, relay, production
   Firebase, signing, or runtime compatibility state is part of the release.
   Otherwise rerun `./kd mobile qa --production`.
3. Repeat the human-only physical-device check on the exact TestFlight build
   selected for App Store submission.
4. Confirm App Store metadata, privacy declarations, screenshots, and release
   notes match the submitted build.
5. Do not submit if production OTA doctor fails, the physical-device check fails,
   or the candidate build differs from the checked build.

## Manual-Only Boundary

Agents may run the repo-side gate and read-only OTA checks. Agents must not
upload builds, submit to App Store Connect, install or launch attached physical
devices, or run physical-device Appium unless a human explicitly asks for that
specific action.

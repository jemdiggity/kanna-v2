# Mobile dev-preview WebView E2E gap (2026-09-03)

The remaining cross-boundary gap is a physical iPhone loading cleartext HTTP
from the ephemeral raw-IP origin through WKWebView, including a Vite HMR
WebSocket after iOS Local Network permission is granted. The simulator shares
the Mac's network namespace and cannot prove the physical-device
ATS/local-network path. Close this gap with a device-lab fixture task running a
loopback Vite server on a claimed port, then drive Preview through
`./kd mobile run --device` and assert an HMR DOM update after a source edit.

Automated coverage now proves paired authorization; fresh one-time entry paths
for WebView and Safari on one listener; HTTP and WebSocket forwarding; refusal
of uncookied, undeclared-port, closed-task, and released-port requests; modal
teardown; route gating; port switching; WebView error handling; and retry.

Simulator visual verification was attempted through the documented stack.
`./kd dev up --mobile` successfully started the worktree desktop/server and
Metro. The dev-client install command then failed in the native build:

```text
$ KANNA_APP_ENV=dev pnpm --dir apps/mobile ios -- -d 88883097-9882-450B-A3A0-CCD0F49D27A5 --no-bundler
expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h:61:26:
error: 'RuntimeScheduler' cannot be annotated with either
SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED because it is not returning
a SWIFT_SHARED_REFERENCE type
CommandError: Failed to build iOS project. "xcodebuild" exited with error code 65.
```

With the pinned XCUITest driver installed in a task-local Appium home, the smoke
lane consequently stopped at its install precondition:

```text
$ APPIUM_HOME="$PWD/.tmp/appium-home" \
  KANNA_E2E_DESKTOP_SERVER_URL=http://127.0.0.1:48126 \
  KANNA_MOBILE_PORT=8098 KANNA_APPIUM_PORT=4729 \
  KANNA_IOS_SIMULATOR_NAME='iPhone XR' \
  pnpm --dir apps/mobile run test:e2e:smoke
Bundle build.kanna.app.dev is not installed on simulator iPhone XR.
Install it with: pnpm --dir apps/mobile ios -d "iPhone XR" --no-bundler
```

Because no app binary was produced, the Preview states could not be opened and
no simulator screenshots were created. This build failure is verification
infrastructure evidence; it does not change the physical-device product gap
defined above.

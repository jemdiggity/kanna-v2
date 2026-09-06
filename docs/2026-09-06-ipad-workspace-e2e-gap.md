# iPad workspace relay E2E gap (2026-09-06)

The tablet workspace scenario is present in
`apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`. On a wide iPad it asserts
the persistent sidebar and initial empty workspace, switches between two real
fixture tasks, and then continues through the existing terminal composer input
flow on the selected task.

The canonical run on an iPad Pro 11-inch (M5), iOS 26.5, did not reach Appium:

```text
KANNA_IOS_SIMULATOR_NAME='iPad Pro 11-inch (M5)' ./kd test remote-e2e --dev --mobile-relay
timed out waiting for http://127.0.0.1:52831/v1/status (403 Forbidden)
```

The fixture `kanna-server` started successfully, but the remote E2E harness's
HTTP readiness probe does not send the local-control credential now required
at the browser-originated LAN boundary. The harness shut down its fixture
daemon, relay, and Firebase emulators after the timeout. This failure happens
before mobile pairing or tablet selection/input can run, so it is not a product
failure and is not claimed as an E2E pass.

The gap closes when the remote harness supplies its fixture server's local
control credential on the `/v1/status` readiness request (or uses an equivalent
authorized local-process probe). Until then, narrower coverage consists of:

- `RootNavigator.component.test.tsx`, which opens a task from the wide sidebar
  and verifies the existing task-open/terminal-resize controller path receives
  the workspace pane dimensions.
- `RootNavigator.terminalInput.integration.test.tsx`, which verifies terminal
  input continues through the existing selected-task subscription path.
- `tabletWorkspaceLayout.test.ts`, which covers the wide/narrow breakpoint and
  bounded sidebar geometry.
- The retained Appium relay scenario described above, ready to exercise the
  real selection/input wiring once fixture readiness succeeds.

The real dev app was separately built, installed, launched, rotated, and
inspected through `./kd mobile run --simulator` on that iPad simulator. That
manual simulator verification covers the wide empty workspace and the compact
portrait fallback, but cannot substitute for the blocked paired-data E2E flow.

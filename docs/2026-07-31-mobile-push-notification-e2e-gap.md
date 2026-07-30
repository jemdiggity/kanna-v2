# Mobile push notification device E2E gap

The agent-to-phone notification path now has automated coverage on both sides
of its external boundary:

- `kanna-server` drives the real local HTTP endpoint through its relay loop and
  asserts the capability-gated WebSocket publish and delivery acknowledgment.
- `services/relay` drives authenticated push registration and unregistration
  through the HTTP routes, and drives desktop-secret WebSocket publication
  through notification parsing and the Firestore device lookup. Unit coverage
  asserts that registered devices receive the typed, versioned Firebase Cloud
  Messaging payload and that invalid tokens are retired.
- `apps/mobile` asserts authenticated token registration, token refresh,
  sign-out cleanup, unknown-payload tolerance, and task-tap identity
  resolution.

A test cannot prove the final FCM → APNs → installed-app hop without an Apple
push environment. That test needs a signed native staging build for
`build.kanna.app.staging` installed on an APNs-capable device or simulator, an
APNs authentication key uploaded to the `kanna-staging` Firebase project, and
the device signed into a seeded Kanna account. The reusable device scenario
should:

1. grant notification permission and assert the FCM token is registered under
   the signed-in user's `pushDevices` collection;
2. call `kanna_notify_mobile` through the local server;
3. background or terminate the app and assert the system notification appears;
4. tap a notification carrying `task_id` and assert the matching task opens;
5. send an unknown payload version and assert the older/newer app remains
   usable.

The current simulator E2E harness does not provision Firebase APNs credentials
or expose a reliable system-notification assertion, so it cannot exercise that
last hop yet.

The dev native identity is intentionally excluded from push registration:
`build.kanna.app.dev` has no matching Firebase Apple app or
`GoogleService-Info.plist` in the repository. Its existing config points at the
production plist for `build.kanna.app`, which is not a safe native messaging
identity. Staging and production have matching plists with GCM enabled.

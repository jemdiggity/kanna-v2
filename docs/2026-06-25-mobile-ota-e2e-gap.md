# Mobile OTA E2E Gap

The client-side OTA integration is covered by unit tests for:

- Expo config generation for dev, staging, and production.
- `checkAndFetchUpdate()` states with `expo-updates` mocked.
- Foreground throttle behavior.
- Dev/simulator smoke contract that `Updates.isEnabled === false` is inert.

A true on-device OTA apply test cannot run in CI until the server task publishes
a signed staging bundle and a native staging build embeds the matching public
certificate. Full E2E needs:

- `kd mobile ota publish --staging` producing a signed manifest and assets.
- A staging dev/TestFlight build pointed at channel `staging`.
- An Appium/device flow that launches the older build, waits for the update
  prompt, taps restart, and verifies the new JS bundle after reload.

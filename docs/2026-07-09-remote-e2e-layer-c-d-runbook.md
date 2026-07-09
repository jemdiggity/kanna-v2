# Remote E2E Layer C/D Runbook

## Automatable Dev Lanes

Layer B stays the default lightweight remote-loop lane:

```bash
./kd test remote-e2e
```

Layer C drives the real mobile UI in an iOS simulator through the local relay, Firebase emulators, local relay, worktree `kanna-server`, and real daemon-backed scripted task:

```bash
./kd test remote-e2e --mobile-relay
```

Equivalent direct command:

```bash
pnpm --dir apps/mobile run test:e2e:relay
```

The Layer C runner starts `tests/remote-e2e`'s harness, seeds Buffy emulator Firestore with the relay desktop/task snapshot the mobile UI expects, forces `EXPO_PUBLIC_KANNA_FORCE_CLOUD=1`, points `EXPO_PUBLIC_KANNA_RELAY_URL` at the local relay, and does not seed a LAN-trusted desktop. The intended full path is: UI signs in, shows the relay-backed desktop, lists the seeded task, opens the task, renders streamed terminal output, sends input, and the harness asserts the scripted PTY received that input.

Layer D drives the desktop pairing UI in the debug WebDriver build:

```bash
./kd test remote-e2e --desktop-pairing
```

Equivalent direct command:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/mobile-pairing-ui.test.ts
```

The desktop runner starts Firebase emulators, the local relay, and a debug app instance. The test opens Preferences -> Developer, starts pairing, asserts the six-character pairing code surface, checks `mobile_server_status`, and uses a Buffy-authenticated phone-side relay socket to confirm the desktop is registered online.

## Physical iPhone Staging Lane

This lane is human-gated. Agents must not install, launch, or run physical-device Appium automation.

1. Provision the committed staging Buffy identity and relay device token from a human shell with `kanna-staging` credentials:

   ```bash
   gcloud auth application-default login
   pnpm --dir services/firebase-functions exec node scripts/provision-staging-buffy-user.mjs
   ```

2. Select the attached iPhone with one of:

   ```bash
   export KANNA_IOS_DEVICE_UDID=<device-udid>
   export KANNA_IOS_PHYSICAL_DEVICE_NAME="Jerome's iPhone 15"
   ```

3. Run the staging physical-device preflight:

   ```bash
   ./kd mobile doctor --device --staging
   ```

4. Launch the staging dev build against installed Kanna Staging desktop/server:

   ```bash
   KANNA_E2E_DEVICE_TOKEN=staging-buffy-device-token ./kd mobile run --device --staging
   ```

5. On the iPhone, grant the one-time Local Network permission:

   Settings -> Privacy & Security -> Local Network -> Kanna Staging = ON

6. Human verification checklist:
   - The printed Metro URL is reachable from the iPhone network.
   - The app signs in as `upvote.sieve.7t@icloud.com` / `password123`.
   - The staging relay-backed desktop appears online.
   - Tasks list, task detail terminal streaming, and task input work over staging relay.

## Troubleshooting Map

`No script URL provided`: Metro is down, the app launched against the wrong port, or the staging build did not bake `RCT_METRO_PORT=<KANNA_MOBILE_PORT>` during `expo run:ios`.

`Could not connect to development server`: Metro is down, the iPhone cannot reach the printed LAN URL, or iOS Local Network permission is off.

Desktop not online in the mobile UI: ensure `/Applications/Kanna Staging.app` is running, `KANNA_E2E_DEVICE_TOKEN=staging-buffy-device-token` was supplied when starting the staging lane, and the staging Buffy device document exists.

## Current Automation Gaps

Physical-device staging is intentionally not automated because it requires a human-attached iPhone, Apple signing state, iOS Local Network permission, and manual staging credential ownership. It becomes suitable for unattended automation only when CI owns a dedicated physical device pool with stable signing, network permissions, and staging secrets.

Layer C currently runs as an explicit simulator lane rather than default PR CI because it requires an installed iOS simulator app, Appium/XCUITest, and Metro. The narrower default CI-safe coverage remains Layer A relay protocol plus Layer B remote-loop harness.

Local verification on July 9, 2026 showed the new Layer C lane can boot the local relay harness, authenticate the mobile app through the relay, seed cloud task snapshots, open the seeded task, and trigger relay tunnel attachment. The remaining blocker is Appium/XCUITest visibility of the React Native top-bar account control and terminal WebView context on this simulator: repeated runs either failed to expose `mobile.account-button` from a clean app state or, after reaching task detail, reported only the `NATIVE_APP` context with no `WEBVIEW` context for terminal inspection. Making this fully green requires stabilizing the simulator accessibility tree and WebView debugging context discovery. The narrower automated coverage added here is the runnable relay-mode Appium lane plus the existing protocol/harness checks that prove relay task creation, streaming, and input at the transport layer.

Layer D uses Tauri WebDriver on the debug desktop app. It is explicit because it starts a full desktop instance, Firebase emulators, and relay, and it depends on the macOS debug WebDriver port.

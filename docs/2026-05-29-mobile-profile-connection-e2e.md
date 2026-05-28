# Mobile Profile Connection E2E Coverage

This branch adds an Appium smoke path for the mobile account/profile sheet:

- launch the mobile app through the existing smoke runner
- open the profile drawer from the app top bar
- verify the connection status card, local network connect control, and email sign-in controls are reachable from the app shell

The smoke spec is wired into `apps/mobile/e2e/run.ts` alongside the existing list/detail/back smoke.

It also adds a dedicated disconnected profile mode:

```bash
pnpm --dir apps/mobile run test:e2e:profile-disconnected
pnpm --dir apps/mobile run test:e2e:device:profile-disconnected
```

That mode starts a tiny local `/v1/status` fixture returning `state: "stopped"`, launches the real mobile shell through Appium, opens the profile drawer, and verifies the drawer reports `Not connected` while keeping the local-connect and email sign-in controls reachable.

## Auth Bootstrap Gap

The current mobile E2E harness cannot exercise a hermetic end-to-end Firebase email sign-in and relay/cloud bootstrap path yet.

The blocker is that `apps/mobile/e2e/run.ts` only provisions Appium, Metro, the installed iOS app, and the desktop LAN mobile server. It does not start or seed Firebase Auth/Firestore emulators, does not inject an E2E Firebase app config into Metro, and does not provide a local relay/desktop-cloud fixture that can answer signed-in cloud transport requests. Without those pieces, an Appium sign-in would either hit production Firebase/relay services or require private credentials, which is not suitable for repeatable CI or local smoke coverage.

To make the signed-in cloud bootstrap path testable end to end, the harness needs:

- Firebase Auth and Firestore emulator startup for mobile E2E
- a seeded test user and task index data
- Expo public Firebase emulator env passed through Metro
- a relay or remote transport fixture reachable by the app after auth
- Appium helpers for entering the seeded email/password and waiting for the post-auth bootstrap state

Until then, the branch keeps unit coverage for email sign-in rebootstrap and production cloud versus loopback LAN fallback, and adds the Appium smoke coverage for the cross-component account/profile entry point and connection controls.

## Local E2E Verification Blocker

The branch-level Appium execution could not be completed in this shell:

```bash
pnpm --dir apps/mobile run test:e2e:device:preflight
```

failed before device setup because `EXPO_PUBLIC_KANNA_SERVER_URL` was not set. Retrying the new disconnected profile mode with a dummy desktop URL:

```bash
EXPO_PUBLIC_KANNA_SERVER_URL=http://127.0.0.1:48120 pnpm --dir apps/mobile run test:e2e:device:profile-disconnected
```

failed because the Appium XCUITest driver is not installed at `~/.appium`. The harness reports the setup command:

```bash
pnpm --dir apps/mobile run test:e2e:appium:install-xcuitest
```

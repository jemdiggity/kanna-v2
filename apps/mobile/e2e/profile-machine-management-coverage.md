# Mobile Profile Machine-Management E2E Coverage

`pnpm --dir apps/mobile run test:e2e:profile-disconnected` is the
simulator-safe machine-management journey. Despite the historical command
name, it now starts the real hybrid harness: Firebase Auth and Firestore
emulators, relay, daemon, `kanna-server`, its Bonjour advertisement, and a dev
Metro environment with cloud forcing disabled.

The Appium flow begins signed out and exercises these contracts in order:

- creates a real server pairing session, enters its code through the React
  Native sheet, claims it over discovered Bonjour HTTP, and observes persisted
  manual trust; the server advertises its stable desktop ID as the Bonjour
  instance name, while the Machines UI must render the distinct human-readable
  `/v1/status.desktopName`;
- removes that manual-only row through the confirmation UI;
- submits a wrong six-character code, verifies recovery copy and usable code
  input, expires a new real server session through a loopback/debug-only
  harness control, and verifies the expired-session recovery state;
- creates another real server session and injects its versioned QR payload as
  the simulator's scanned value, then claims it through the same
  `pairMachineByPayload`/Bonjour/server endpoint used by the camera callback;
- leaves the Machines screen for Recent immediately after that claim and
  requires the paired machine's LAN task row within a budget tighter than the
  generic screen timeout — the claim itself must load the machine's work,
  rather than the lists filling only when an unrelated discovery tick or the
  later relaunch happens to re-bootstrap;
- terminates and reactivates the app to prove the trusted machine and its
  human-readable server name survive AsyncStorage reload plus a fresh Bonjour
  inventory refresh;
- signs into the Auth emulator and requires one row for the desktop with both
  Account and Paired origins;
- requires LAN metadata for the account/LAN duplicate, disables only direct
  LAN HTTP while leaving tunneled relay dispatch alive, relaunches, requires
  cloud metadata, and opens the task terminal through relay;
- removes the manual origin and requires the single account row to remain.

The server's E2E mobile controls are debug-build-only, require the existing
`KANNA_E2E_TEST_SQL=1` harness gate, accept only direct loopback requests, and
cannot be invoked through relay. The LAN control is middleware-level so the
same running `kanna-server` keeps its authenticated relay connection while
direct simulator HTTP returns 503.

The in-flight progress panel (`mobile.machine-pairing.progress`) is asserted in
`apps/mobile/src/components/MachinePairingSheet.test.tsx` rather than here:
whether a spinner is still on screen when Appium looks is a race against how
fast the harness's local machine answers, so an E2E assertion on it would be
flaky in exactly the case it is meant to protect. What the journey pins is the
outcome the panel is covering for — that the tasks arrive from the claim.

Physical camera optics remain human-only, as required by the design. Appium
and the iOS simulator cannot feed a deterministic QR image into the
`expo-camera` capture device. Automating that last optical boundary would need
either a native test camera provider in the dev build or a physical-device
camera fixture, and project policy forbids agent automation from launching
physical-device Appium. The simulator deep link substitutes only for the
camera frame: parsing, identity filtering, Bonjour discovery, HTTP claim,
server pairing state, mobile persistence, and UI inventory all remain real.

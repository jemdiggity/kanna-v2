# Mobile dev-preview WebView E2E gap (2026-09-03)

Kanna's automated LAN coverage now proves that a paired task-preview request mints an isolated listener, exchanges the one-time enter secret for a cookie, proxies an absolute-path request and a WebSocket upgrade to the declared loopback port, rejects an uncookied request, and closes the listener on explicit revocation. Mobile transport tests prove that the preview URL uses the already validated desktop LAN host and does not carry the pairing credential. Component tests cover the constrained WebView posture and retry state.

The implementation worktree could not complete the required visual simulator
check. The exact requested command fails before build or installation:

```text
$ ./kd mobile run
mobile run requires --device
```

`./kd mobile run --help` exposes only
`kd mobile run --device [--build dev|staging] ...` and describes that command
as targeting a physical iOS device. `xcrun simctl list devices available`
reports multiple installed simulators, but this checkout has no supported `kd`
command that builds and installs the dev client into one. Before review, add or
use a supported `kd` simulator install workflow and visually verify the
task-screen Preview affordance, fullscreen WebView, refresh, retry, multi-port
selection, Safari handoff, no-port state, and proxy-error state. No screenshots
were produced because the canonical command never launched an app.

The remaining cross-boundary gap is a physical iPhone loading cleartext HTTP from the ephemeral raw-IP origin through WKWebView, including a Vite HMR WebSocket after iOS Local Network permission is granted. The simulator shares the Mac's network namespace and cannot prove the physical-device ATS/local-network path. Close this gap by adding a device-lab fixture task with a loopback Vite server on a claimed port, then driving Preview through `./kd mobile run --device` and asserting an HMR DOM update after a source edit.

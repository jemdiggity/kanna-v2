# Physical iOS Bonjour pairing E2E gap (2026-08-21)

Task `4525867a` now has a macOS multi-process E2E that launches three real
`kanna-server` processes, observes their distinct identities and ports through
the host `dns-sd` resolver, follows one discovered port through a real pairing
session and claim, and verifies record withdrawal and same-identity port
replacement. Mobile component tests cover camera failure latching and recovery.

The remaining unautomated boundary is Apple's physical-device path: Local
Network permission, `NetServiceBrowser`, camera frames from a continuously
visible desktop QR, Wi-Fi multicast delivery to an attached iPhone 15, and the
device's HTTP connection back to the Mac. The repository has no stable harness
that can grant/reset iOS Local Network and Camera permissions, aim a physical
camera at a changing QR, or assert the native browse callbacks. Simulator
automation would not cover Wi-Fi multicast and previously masked address bugs
because its loopback is the Mac.

## Attached iPhone 15 manual verification

1. Start Production, installed Staging, Dev, and at least one additional
   worktree server. Record each instance with `kanna_info`, including
   `desktop.id`, `environment`, and advertised LAN port.
2. On the Mac, run `dns-sd -Z _kanna-mobile._tcp local` and confirm every
   recorded desktop id has exactly one SRV record on its own port and a matching
   `desktopId` TXT value.
3. On the iPhone 15, grant Camera and Local Network access. Open **Add a
   machine**, scan each environment's current QR, and confirm the claimed
   machine identity matches the QR's desktop rather than another Kanna instance.
4. Display a QR for a stopped or undiscoverable server continuously. Confirm
   one claim attempt produces a stable error with no progress/error flashing.
   Tap **Retry scan** after restoring that server and confirm pairing succeeds.
5. Repeat with the six-character manual code to confirm code entry remains
   usable independently of camera retry state.
6. Quit one server and confirm its record disappears from `dns-sd`; restart the
   same identity on a different reserved port and confirm only the new SRV port
   is present and the iPhone can pair again.

Automation becomes complete when the device lab can control those two iOS
permissions, feed or aim camera QR input, and expose native Bonjour callbacks
and HTTP results to the test runner while the Mac launches multiple signed and
development app instances.

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

## 2026-08-24 follow-up (task `c4253f4a`)

The owner's corrected history is that QR pairing worked against staging before
it failed in dev. The old macOS advertisement used `mdns_sd` raw multicast
sockets; concurrent Kanna processes competed for multicast packets, which task
`4525867a` fixed on 2026-08-21 by moving macOS to system
`DNSServiceRegister`. That implementation change exposed a separate packaged
app defect: the signed bundle declared `_kanna-xfer._tcp` but not
`_kanna-mobile._tcp`. Unified `mDNSResponder` logs identify the installed
staging `kanna-server` PID and explicitly report that
`build.kanna.staging`'s `Info.plist(NSBonjourServices)` does not allow the
mobile service. The QR path then parses successfully but finds no matching
Bonjour identity, so no claim request fires and the sheet displays **No
matching machine was found**.

This is not attributed to a recent macOS update. The host's macOS 26.2 was
installed on 2026-02-12; Kanna switched advertisement APIs on 2026-08-21.
Apple's [local-network privacy guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
also documents that command-line tools and their children are automatically
allowed on macOS. On this same macOS 26.2
host, a bare `kd` dev build successfully registered and was externally resolved
at its exact identity and port, while packaged staging was rejected for its
missing declaration. Task `c4253f4a` adds that declaration and guards it with a
bundle-policy test.

The task also replaces new 119-byte JSON pairing payloads with the 58-character
`KANNA1:<DESKTOP-ID-UPPERCASED>:<CODE>` form while preserving legacy JSON parsing
on mobile. Every emitted character is in QR's alphanumeric-mode alphabet; the
observed QR therefore drops from version 7 (45×45 modules) to version 3 (29×29),
keeps error correction M, and is displayed at 185px instead of 120px. Its real
multi-process E2E decodes the server's exact compact `pairingPayload` and claims
through the endpoint discovered via Bonjour.

The booted iOS Simulator rendered and exercised scanner-ready, in-flight,
visible failure, and successful paired-machine states. That verifies the sheet
and LAN claim wiring but not physical camera frames, Wi-Fi multicast, or the
iPhone's Local Network privacy state, so the attached-device pass below still
gates merge.

The other remaining system boundary is forcibly restarting or disrupting the
host `mDNSResponder` while an unprivileged test is running. Automating that
would require privileged mutation of a shared macOS service and could disrupt
unrelated Kanna instances and network discovery on the developer machine. The
supervisor's initial-failure recovery and terminal DNS-SD socket-event handling
are therefore covered with deterministic injected attempts/event tests; the
real multi-process E2E continues to cover publication and cleanup through the
live system responder.

## Attached iPhone 15 manual verification

1. Install and launch a staging desktop build containing task `c4253f4a` so
   macOS reads the updated `Info.plist`; an already-installed build cannot
   validate this fix.
2. Start Production, installed Staging, Dev, and at least one additional
   worktree server. Record each instance with `kanna_info`, including
   `desktop.id`, `environment`, and advertised LAN port.
3. On the Mac, run `dns-sd -Z _kanna-mobile._tcp local` and confirm every
   recorded desktop id has exactly one SRV record on its own port and a matching
   `desktopId` TXT value.
4. On the iPhone 15, grant Camera and Local Network access. Open **Add a
   machine**, scan each environment's current QR, and confirm the claimed
   machine identity matches the QR's desktop rather than another Kanna instance.
5. Display a QR for a stopped or undiscoverable server continuously. Confirm
   one claim attempt produces a stable error with no progress/error flashing.
   Tap **Retry scan** after restoring that server and confirm pairing succeeds.
6. Repeat with the six-character manual code to confirm code entry remains
   usable independently of camera retry state.
7. Quit one server and confirm its record disappears from `dns-sd`; restart the
   same identity on a different reserved port and confirm only the new SRV port
   is present and the iPhone can pair again.

Automation becomes complete when the device lab can control those two iOS
permissions, feed or aim camera QR input, and expose native Bonjour callbacks
and HTTP results to the test runner while the Mac launches multiple signed and
development app instances.

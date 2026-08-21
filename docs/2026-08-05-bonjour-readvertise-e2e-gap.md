# Bonjour re-advertisement E2E gap (2026-08-05)

> Superseded for macOS publication on 2026-08-21 by
> `crates/kanna-server/tests/bonjour_multi_process.rs`. That test uses three
> real server processes and the host `dns-sd` resolver to cover concurrent
> publication, cleanup, and restart/port replacement. Physical iOS browsing
> remains tracked in
> `docs/2026-08-21-physical-ios-bonjour-pairing-e2e-gap.md`.

The mobile discovery path crosses `kanna-server`, multicast DNS, the host's
network interfaces, Apple's mDNS responder/cache on another device, and the
mobile `/v1/status` trust probe. The repository's automated test environment
cannot currently mutate an isolated macOS LAN interface or provide a second
physical host that observes `_kanna-mobile._tcp.local.`. A same-process mDNS
browse would depend on multicast loopback and would not prove that a phone can
resolve and reach the advertised address.

The `mdns-sd` dependency has test-only interface up/down hooks, but those hooks
are compiled only for that dependency's own unit tests and are not available to
`kanna-server`. An automated E2E test becomes practical when the macOS test
harness can create and remove an address on an isolated interface and expose a
second-host resolver, or when a packaged test sidecar can force a live
registration drop while an external resolver observes recovery.

Narrower Rust tests in `crates/kanna-server/src/bonjour.rs` cover the behavior
that can be deterministic here:

- loopback, unspecified, and link-local addresses remain excluded;
- a refresh replaces the old explicit address set with the newly enumerated
  routable address set;
- a refresh republishes a silently removed record through the still-healthy
  daemon; and
- a failed re-registration creates a replacement daemon and publishes the
  service through it.

Manual two-host acceptance remains required:

1. On a second host, run `dns-sd -B _kanna-mobile._tcp local` and confirm the
   desktop id appears.
2. Run `dns-sd -L <desktop-id> _kanna-mobile._tcp local` and confirm the result
   contains the current server port and only addresses currently owned by the
   desktop.
3. Request `http://<resolved-address>:<port>/v1/status` and confirm it returns
   the same desktop id.
4. Change the desktop's routable address (for example by switching networks or
   renewing its lease) without restarting `kanna-server`, then repeat steps
   1-3 and confirm the new address is published.
5. Force or observe a lost mDNS registration without restarting
   `kanna-server`, wait at least one 60-second health-refresh interval, and
   repeat steps 1-3.

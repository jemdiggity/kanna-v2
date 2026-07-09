# Remote E2E

`./kd test remote-e2e` runs the local relay, Firebase emulators, a harness-booted
`kanna-server`, and an isolated daemon.

Layer E LAN specs use the same harness server as the relay specs and connect to
the configured `lan_host`/`lan_port` from the generated `server.toml`.
Bonjour/mDNS discovery is not asserted in this headless lane because CI needs a
deterministic browser for `_kanna-mobile._tcp` plus stable loopback multicast
behavior across macOS and Linux runners. Until that exists, the LAN E2E fallback
is to assert the configured LAN endpoint directly while keeping native Bonjour
coverage in focused mobile discovery tests.

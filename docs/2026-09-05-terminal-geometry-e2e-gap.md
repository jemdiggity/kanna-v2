# Terminal geometry E2E gap — 2026-09-05

Updated 2026-09-05: the assigned iPhone 17 Pro simulator lane is no longer a
gap. With the worktree stack running from `./kd dev up --mobile`, the real
development build launched on simulator
`C48044E2-D11B-4A50-993D-D571CA8462E7`, paired through the Mac's generated code,
opened a real PTY task, rendered the authoritative source grid with overflow,
and exercised phone takeover and release. Screenshots are in
`docs/task-screenshots/12f567e9-screenshots/`.

The real desktop companion lane now runs two isolated desktop instances on this
Mac, each with its own identity, database, daemon, and reserved ports. It covers
the authenticated KSP/control path, wide owner plus narrow follower, viewport
changes, takeover/release, typed repaint output, disconnect/reconnect, and
snapshot/live-tail ordering. It asserts the actual PTY winsize and both xterm
renderers' source-grid/cursor state; the corresponding owner/follower and
takeover/reconnect screenshots are saved above. The local two-window lane in
`pty-session.test.ts` covers the same controller/follower policy without the
remote transport.

Remaining gaps are a physical two-machine LAN/relay journey and physical-device
mobile plus legacy mixed-version matrices. The existing LAN emulator scenarios
remain blocked by the emulator rejecting the generated canonical desktop
credentials during reconnect; the narrower authenticated relay lane above and
the daemon/server/KSP integration coverage remain runnable here.

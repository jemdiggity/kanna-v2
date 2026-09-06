# Terminal geometry E2E gap — 2026-09-05

Updated 2026-09-05: the assigned iPhone 17 Pro simulator lane is no longer a
gap. With the worktree stack running from `./kd dev up --mobile`, the real
development build launched on simulator
`C48044E2-D11B-4A50-993D-D571CA8462E7`, paired through the Mac's generated code,
opened a real PTY task, rendered the authoritative source grid with overflow,
and exercised phone takeover and release. Screenshots are in
`docs/task-screenshots/12f567e9-screenshots/`.

The only remaining gap is a true two-machine desktop-remote-follower journey:
this single Mac can run the owning desktop and the phone simulator, but cannot
provide a second independent desktop owner/viewer identity for the relay/LAN
remote-view path. The narrower real coverage is the wide desktop owner task
selection plus phone attachment, and the automated desktop CloudTerminalView,
KSP/server, daemon, stream-client, and mobile controller tests. A second
desktop identity and relay/LAN fixture are required to close this gap.

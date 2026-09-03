# Mobile dead-session recovery E2E gap

2026-09-03. Written with task `ac0be7a9`.

## What is not covered end to end

The repository does not currently have a harness that can keep a real
`kanna-server` and mobile relay connection alive, kill and replace the desktop
daemon underneath a running provider PTY, then select that task in the native
mobile app. The remote E2E fixture mocks the desktop boundary, while the
desktop WebDriver harness cannot drive the native mobile client. Therefore no
single automated test proves the complete daemon crash -> relay -> native task
selection -> replacement terminal sequence yet.

## Narrower coverage landed meanwhile

- Dependency task `a08c6fab` drives the real resume HTTP route and fake daemon
  protocol from an unmodified `running` run, proves daemon absence, and covers
  provider resume/fallback provenance. Its desktop tests prove attach recovery
  invokes that server operation instead of locally spawning a replacement.
- Mobile transport tests cover the resume action over both LAN and relay
  owner routing and preserve structured missing-session errors. Controller and
  rendered-state tests cover automatic recovery and the restarting state.
  Controller tests specifically prove refresh-independent terminal recovery
  without a cloud subscription, the bounded timeout and re-selection retry,
  structured-agent automatic reattachment, and exact server failure text.

## What would close the gap

Extend `tests/remote-e2e` with a controllable real daemon/server desktop
fixture and a native mobile driver. The fixture must be able to kill only the
daemon after a stage run starts, retain the server and relay connection, and
assert that selecting the task creates one replacement run and reaches a live
terminal without a desktop selection.

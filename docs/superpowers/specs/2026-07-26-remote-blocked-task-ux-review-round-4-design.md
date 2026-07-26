# Remote Blocked Task UX Review Round 4 Design

## Goal

Close the fourth review round without weakening the existing remote blocker,
terminal, cache, or daemon-handoff behavior.

## Architecture

### Remote blocker journey and localization

The development E2E surface will expose a cloud-snapshot injection method from
`useAppCloudWorkspace`. The method writes the same `DesktopCloudSnapshot` ref
used by the production Firestore subscription and increments the same
authoritative generation. A mock WebDriver test can therefore exercise the real
workspace projection, Sidebar, MainPanel, keyboard guard, remote owner action,
and toast wiring without depending on Firebase credentials.

`projectWorkspaceBlockers` will project raw blocker metadata only. An unresolved
owner blocker carries its shortened owner task id as fallback metadata, not an
English label. Vue rendering helpers will choose the best available title and
use `tasks.taskId` or `tasks.untitled` locale keys. English, Japanese, and Korean
tests will prove both fallback paths.

### Daemon lag recovery and handoff

A failed lag-recovery snapshot will leave the subscriber marked lagged and
drained, but it will not notify the already-ready biased select branch again.
The existing status interval and later output/status activity provide bounded
retries. A paused-time regression will prove persistent snapshot failure does
not create an immediate retry loop.

`StreamControl` will gain a quiesce/resume handshake. During handoff the old
daemon takes the lifecycle write guard, requests every active PTY reader to
quiesce, waits until each reader confirms it is no longer reading, and only then
captures the final headless snapshot and clones the PTY fd. If transfer or ACK
fails, it resumes the old readers before releasing the lifecycle guard. If ACK
succeeds, it stops the already-quiesced readers and the adopting daemon starts
new readers after the handoff connection closes. Output written by the child
after the snapshot remains in the PTY kernel buffer and is consumed by the new
reader. A debug-only fault-injection barrier will cause a child to emit bytes in
the snapshot-to-ACK window and verify those bytes survive.

Handoff-in-progress errors on ordinary client commands will carry no new error
code because those commands do not negotiate a schema version. The stable
message remains actionable, while a previous-schema decode test proves that the
wire payload uses only the prior vocabulary.

### kd cache reclamation

Each resolver invocation creates a root-level lease containing the PID of the
shell process that will `exec` the resolved kd entrypoint. A live lease fences
that identity from pruning throughout command execution. Stale leases are
removed on later resolver runs.

Reclamation runs after the requested installation is available and leased. It
removes unfenced installations older than the age limit, then removes the oldest
remaining unfenced entries until both count and total-byte limits are met.
Installation locks and the current identity are also fences. Last-use marker
files live beside, rather than inside, immutable installation directories.
Defaults are conservative and injectable in tests.

### LAN terminal subscriptions and peer snapshots

Every frontend LAN subscription owns a unique observer lease id. Observe and
unobserve commands carry it through Tauri and the sidecar. Runtime observer
slots retain the lease, and closed leases leave a tombstone: an unobserve that
arrives before its observe prevents that observe from installing later, while
an old lease can never remove a replacement lease. Frontend completion handlers
also check the current lease before emitting ready or error events.

LAN snapshot enumeration will isolate trust/capability, transport, malformed
response, and protocol errors per peer. Compatible snapshots and structured
peer issues return together. The desktop maps compatible snapshots normally,
logs each issue, and emits a throttled warning for upgrade/re-pair issues. A
mixed trusted-v1/trusted-v2 requester test proves the v2 peer remains visible.

## Verification

Each change begins with a focused failing regression. Final verification covers
the new WebDriver mock journey, frontend workspace/component/service tests,
task-transfer protocol/runtime/control tests, daemon unit and handoff tests, kd
cache tests, desktop build/typecheck, and the repository's canonical practical
JavaScript suite.

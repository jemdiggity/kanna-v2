# Mobile Visual Companion Stream Design

## Goal

Make an active agent visual companion available inside the Kanna mobile app over
both LAN and cloud connections. A mobile user should see the same current HTML
screen that the agent exposes through the Superpowers brainstorming companion,
select an option, and have that selection appear in the companion session's
`state/events` file for the agent to read.

This is a document-and-event feature, not a general web-preview feature. Kanna
will carry bounded HTML snapshots and structured selection events through the
existing Kanna Stream Protocol (KSP) connection. It will not proxy HTTP, expose
a public URL, or deploy agent output to a cloud hosting service.

## Context

The previous relay-backed preview design treated an agent example as an
arbitrary live website. Supporting Safari, root-relative assets, application
cookies, uploads, streaming responses, and WebSockets required a public HTTPS
gateway plus a multiplexed HTTP/WebSocket tunnel. That architecture was valid
for arbitrary web applications but disproportionate to the visual companion's
actual contract:

- the newest HTML screen in a session directory;
- a small frame and interaction helper;
- structured click events returned to the agent.

KSP already carries task-addressed terminal and themed-agent streams over the
same localhost, LAN, and relay transports. The relay forwards tunnel WebSocket
frames transparently, so it does not need companion-specific behavior.

## Product Decisions

- Visual companions open inside Kanna mobile, not Safari.
- The first version supports active Superpowers brainstorming sessions stored
  under the current task workspace's `.superpowers/brainstorm/` directory.
- Mobile receives live document snapshots and sends selection events through a
  KSP companion stream.
- Kanna automatically discovers the active session. The agent does not need to
  call a Kanna publishing tool or deploy anything.
- The owning desktop must be online. Kanna does not upload companion documents
  to Firestore, object storage, or another durable cloud service.
- The desktop browser companion continues to work unchanged alongside mobile.
- Only the current task workspace is visible. A stage transition, task close,
  or stopped companion naturally removes access to the old session.
- Companion-local assets are excluded initially. Screens may use inline assets,
  data URIs, or public HTTPS images.

## Architecture

```text
Agent writes HTML                     Mobile opens task
       |                                     |
       v                                     v
.superpowers/brainstorm/...       KSP attach(kind=companion)
       |                                     |
       v                                     v
Kanna Server companion source <-> existing KSP WebSocket
                                           |
                                  transparent relay tunnel
                                           |
                                           v
                                  mobile companion WebView
                                           |
                                  KSP companion_event
                                           |
                                           v
                              session state/events JSONL
```

The implementation has three focused boundaries:

1. **Filesystem companion source** discovers and safely reads the current
   workspace's active companion document and appends validated events.
2. **KSP companion attachment** converts source state into reconnectable task
   stream frames. It is transport-neutral; the relay remains a byte-forwarding
   tunnel.
3. **Mobile companion view** renders a constrained document and returns only
   bounded interaction events.

The wire protocol is provider-neutral even though the first source adapter is
for the Superpowers directory convention. A future explicit publish tool can
feed the same KSP stream without changing mobile or relay behavior.

## Companion Source and Lifecycle

### Discovery

While at least one client is attached to a task's companion stream, Kanna
Server inspects the task's current worktree every 500 milliseconds. It looks
only below:

```text
<current-worktree>/.superpowers/brainstorm/<session>/
```

A session is active when its `state/server-info` marker exists and its
`state/server-stopped` marker does not. Among active sessions, Kanna selects the
one whose newest content HTML file has the latest modification time. The
newest regular `.html` file in that session's `content/` directory is the
current screen.

Discovery runs only for attached tasks and performs filesystem work away from
the async runtime's latency-sensitive path. It sends nothing when the selected
session and document digest are unchanged.

### Document identity

Each snapshot includes:

- `session_id`: the validated session directory name;
- `revision`: an opaque digest of the exact document bytes;
- `document_kind`: `fragment` or `full_document`, using the companion's current
  doctype/`html` detection rule;
- `html`: the UTF-8 source document.

The digest lets the server reject an event for a screen that has already been
replaced. It is an identity value, not a credential.

### Workspace lifecycle

The source resolves the task's current worktree on every scan rather than
persisting a companion-to-worktree record. Consequently:

- a stage workspace transition selects only sessions in the new worktree;
- revision resume in the same workspace keeps the companion available;
- task close or worktree removal yields an unavailable companion;
- stopping the companion removes `server-info` and makes it unavailable;
- Kanna Server restart requires no descriptor recovery or replay database.

When the source changes from active to unavailable, the attached client
receives one unavailable frame and clears the companion action. When a session
appears later, the same attachment receives its first snapshot without the
user reopening the task.

### Event sink

A valid mobile selection is appended as one JSON line to the active session's
`state/events` file. The event preserves the existing companion fields:

```json
{
  "type": "click",
  "choice": "a",
  "text": "Option A - Single column",
  "id": null,
  "timestamp": 1784268000000,
  "event_id": "opaque-client-event-id"
}
```

Before appending, Kanna verifies that the task still resolves to the same
workspace, the session is still active, and its current document revision
matches the event. Events are never automatically retried. A failed send stays
visible in the mobile UI so the user can tap again without silently creating
duplicates.

The existing companion server remains responsible for clearing `state/events`
when the agent creates a new screen, matching desktop behavior.

## KSP Protocol

Add `companion` to the generated `StreamKind` source of truth. The existing
`attach` and `detach` client frames then apply without a parallel subscription
protocol.

Add these task-addressed frames conceptually:

```text
client -> server
  companion_event(task_id, session_id, revision, event)

server -> client
  companion_snapshot(task_id, session_id, revision, document_kind, html)
  companion_unavailable(task_id)
  companion_event_result(task_id, event_id, accepted, code?, message?)
  companion_error(task_id, code, message)
```

Companion failures remain on companion-specific frames so they cannot put a
terminal or themed-agent attachment into an error state. They use stable codes such as
`companion_too_large`, `companion_invalid_document`,
`companion_stale_revision`, and `companion_event_failed`.

Every event receives exactly one `companion_event_result`. A successful result
is sent only after the JSONL append completes. A rejected result echoes the
client's `event_id` with a stable code and sanitized message, allowing mobile to
show accurate delivered/failed state without guessing from WebSocket delivery.

On attachment, Kanna Server immediately sends the current snapshot or an
unavailable frame. On reconnect, `StreamClient` reattaches exactly as it does
for terminal streams, and the server sends a fresh authoritative snapshot. No
companion journal or sequence resume is needed because the state is a single
latest-value document.

The companion attachment has bounded queues and latest-value semantics. If
screens change faster than the client can receive them, intermediate snapshots
may be discarded; the newest complete snapshot must be retained. Companion
filesystem work and large-document serialization must not block terminal input
or output processing.

No relay message, registry, route, deployment configuration, DNS record, or TLS
certificate changes are required. The current relay tunnel forwards the new
JSON KSP frames without inspecting them.

## Mobile Experience

The task screen attaches to the companion stream while it is visible. Before a
snapshot exists, companion UI is absent. The first snapshot presents a
`Visual companion ready` action without automatically covering the terminal.

Opening the action presents a full-screen in-app companion with:

- the current visual document;
- a close/back control that returns to the same task terminal;
- automatic replacement when a newer snapshot arrives;
- immediate local selection styling;
- a sending/failure indication for the event returning to the agent.

If the user closes the companion and a new revision arrives, the action shows
an unread indicator. A session becoming unavailable closes the content into a
small ended state rather than leaving stale controls active.

Fragments are wrapped in a Kanna-owned mobile frame implementing the companion
layout classes and selection behavior. Full documents retain their body but
receive Kanna's content policy and event bridge. Both forms capture
`data-choice` interactions using the companion's single-select and multiselect
semantics. The bridge sends structured events to React Native; it never exposes
a general native invocation function to document JavaScript.

The mobile transport adds `observeTaskCompanion` beside terminal and agent
observation. LAN connections use direct KSP and cloud connections use the
existing authenticated relay tunnel. Hybrid task routing resolves the owning
desktop and local task id through the same route mapping used by terminal
attachments.

## Security and Resource Bounds

Companion files are untrusted agent output handled through the current task's
workspace boundary.

- Directory traversal uses descriptor-relative, no-follow operations derived
  from the hardened task-file implementation.
- Session directories, content files, state markers, and the event target must
  be regular entries beneath the current worktree. Symlinks and path escapes
  are rejected.
- Documents must be valid UTF-8 HTML and no larger than 1 MiB. The attachment
  keeps at most one pending latest snapshot per task.
- Event objects are limited to 8 KiB serialized. `choice` and element `id` are
  limited to 256 UTF-8 bytes, visible `text` to 4 KiB, and `event_id` to 128
  bytes. The server accepts at most 30 events per task/session in a rolling
  ten-second window.
- Companion HTML and events are not written to Kanna logs, Firestore, relay
  metadata, analytics, or cloud storage.
- The relay authenticates the mobile tunnel using the existing Firebase
  identity flow; KSP continues to enforce its current authentication mode.

The WebView receives no Kanna token, task data, filesystem URL, cookie, or
general native API. It disables file access, universal file access, shared and
third-party cookies, popups, downloads, and multiple windows. Navigation is
limited to the in-memory document.

Kanna injects a restrictive content security policy:

- inline styles and scripts are allowed for visual mockups and interaction;
- images may use `data:` or HTTPS sources;
- network connections, WebSockets, forms, frames, objects, and navigation are
  blocked;
- external scripts and companion-local `/files/` resources are unsupported.

Agent-controlled inline script can manipulate only the isolated companion DOM
and submit bounded companion events. No sensitive Kanna value is placed in
that DOM, so allowing inline behavior does not grant access to the app session.

## Failure Behavior

- **Desktop or relay offline:** existing KSP reconnection behavior remains in
  control; mobile shows the companion as reconnecting and reattaches when the
  route returns.
- **No active session:** the server sends `companion_unavailable`; no action is
  shown.
- **Session stops while open:** mobile shows that the companion ended and
  disables selection.
- **Oversized, invalid, or unsafe file:** mobile shows a concise task-scoped
  error suggesting that the agent simplify or recreate the screen. Local paths
  and document contents are not included in the error.
- **New screen races with a selection:** the server rejects the stale revision,
  sends the authoritative newest snapshot, and does not append the old event.
- **Event append fails:** the current selection remains visible with a retry
  message; the app does not claim that the agent received it.
- **Slow client:** intermediate revisions are coalesced. Terminal and agent
  streams remain usable.

## Verification

### Protocol and server tests

- Generated Rust and TypeScript protocol types round-trip the companion stream
  kind, snapshots, unavailable state, and events.
- Stream-client tests cover attach, detach, reconnect/reattach, snapshot
  replacement, unavailable state, event sending, and task-scoped errors.
- Filesystem tests cover active-session discovery, newest-screen selection,
  multiple sessions, stopped sessions, workspace replacement, invalid UTF-8,
  size limits, symlink/path attacks, event append, and stale revisions.
- KSP tests prove that attach receives an immediate current value, changes are
  coalesced, detach stops local scanning, and companion work cannot starve
  terminal frames.

### Mobile tests

- Transport tests cover LAN, remote, and hybrid owner routing.
- Document-builder tests cover fragments, full documents, content policy,
  selection semantics, and bridge validation.
- Component tests cover readiness, open/close, live replacement, unread
  revision indication, unavailable state, successful event acknowledgement,
  and failures.
- WebView navigation and native-bridge tests prove that documents cannot invoke
  unrelated app behavior or navigate to local/arbitrary pages.

### End-to-end tests

Extend the existing mobile relay harness with a real fixture task workspace and
companion session. Through the ordinary authenticated relay tunnel, verify:

1. the mobile app receives and opens the current visual screen;
2. writing a newer HTML file replaces it;
3. tapping a real `data-choice` element appends the expected JSONL event;
4. stopping the session removes the active companion;
5. reconnecting restores the newest screen.

No relay-specific companion implementation should appear in this test. Its
purpose is to prove that the existing transparent tunnel carries the new KSP
frames. Physical-iPhone verification remains a human post-merge step.

## Non-Goals

- Arbitrary local websites, dev servers, APIs, SSE, or WebSocket applications.
- Safari/default-browser access or public/team share links.
- Cloud persistence or offline companion viewing.
- Agent-triggered deployments to Vercel, Cloudflare Pages, GitHub Pages, or
  another hosting provider.
- Rewriting arbitrary HTML/CSS resource graphs or proxying `/files/` assets.
- A new relay tunnel protocol, wildcard DNS, browser tickets, or session
  cookies.
- Companion history, multiple simultaneous companion tabs, or cross-workspace
  retention.

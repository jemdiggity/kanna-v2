# Remote Desktop Visual Companion Design

## Goal

Make visual companions produced by tasks on another paired Kanna desktop behave
like local companions. The user watches the remote agent terminal, clicks the
agent's ordinary `http://localhost:<port>` companion link, and sees the
interactive companion in the viewing Mac's normal browser. The user should not
need to know whether the task is local, reachable over LAN, or reachable through
the cloud relay.

This extends the companion feature already used by Kanna mobile. The wire
contract, document and event model, security validation, lifecycle state, and
tests should be shared. Desktop adds a browser adapter; it does not add a
separate companion product or a public preview service.

## Product Decisions

- Desktop-to-desktop companions work over both paired LAN and authenticated
  relay routes.
- A remote companion opens only after the user clicks its link in the terminal.
  Kanna does not open a browser automatically.
- The companion opens in the ordinary OS browser, not a Kanna modal, tab, or
  WebView. It has no remote badge or remote-specific chrome.
- The viewing Mac serves a loopback mirror of the active companion. Documents
  and assets are not published to Firestore, object storage, or a public URL.
- The mirror supports the local companion's browser contract: `GET /`, direct
  regular-file assets under `/files/<name>`, a live-reload WebSocket, and
  structured selection events.
- Companion-local assets are in scope. An otherwise valid companion may still
  render with a missing asset if that individual asset is unavailable.
- The transparent behavior is guaranteed for terminal-link activation. Copying
  a remote `localhost` URL and pasting it manually into another browser is not
  an initial requirement.
- An opened companion remains active when the user selects another task in
  Kanna. Multiple browser companions may remain open concurrently and are
  isolated by owner desktop, task, and companion session.
- This is a semantic mirror of the bounded visual-companion contract, not a
  general HTTP, WebSocket, localhost, or TCP tunnel.

## Existing Foundation

Kanna Server already:

- discovers active Superpowers sessions beneath the current task workspace's
  `.superpowers/brainstorm/` directory;
- reads the newest HTML document using hardened descriptor-relative,
  no-follow traversal;
- streams task-addressed companion snapshots over KSP;
- coalesces companion revisions independently from latency-sensitive terminal
  frames;
- validates revision-bound companion events and appends them to
  `state/events`; and
- carries the same KSP frames transparently through the authenticated relay.

Kanna mobile already:

- attaches companion streams over LAN and relay;
- models available, unavailable, reconnecting, and error states;
- builds fragment and full-document browser content;
- validates structured click events;
- handles event acknowledgements and stale revisions; and
- renders the result through a constrained React Native WebView.

Desktop remote tasks currently expose only a terminal. Cloud terminals already
use `StreamClient` through the relay. LAN remote terminals use the paired
`kanna-task-transfer` sidecar and its terminal observer protocol. The desktop
remote terminal does not currently load the ordinary xterm web-link addon.

## Architecture

```text
Owner Mac                                  Viewing Mac

agent companion session
  content/*.html
  content/<asset>
  state/server-info
  state/events
        |
        v
Kanna Server companion source
  validates workspace, origin,
  document, assets, revisions
        |
        | shared companion model
        | KSP over relay, or paired LAN peer stream
        v
desktop remote-task client
        |
        +--> terminal link resolver --> OS browser opener
        |
        v
Tauri loopback companion bridge <----> ordinary local browser
  GET /                                  rendered companion
  GET /files/<name>                      live reload
  WebSocket reload/events                user selections
        |
        v
shared event client --> owner revision check --> state/events
```

The implementation has six focused boundaries:

1. **Shared Rust companion source** extends the existing hardened server source
   with a validated loopback origin and bounded regular-file assets, and is
   consumed by Kanna Server and the paired LAN sidecar.
2. **Shared TypeScript companion core** contains platform-neutral snapshot state,
   document framing, event parsing and validation, lifecycle transitions, and
   their tests.
3. **Remote-task companion transport** exposes the same observer interface for
   relay and paired LAN tasks.
4. **Desktop loopback bridge** serves one or more active companion mirrors to
   ordinary browsers and reports browser events back to the desktop frontend.
5. **Terminal link resolver** maps only a clicked link whose normalized origin
   matches the active remote companion.

## Shared Mobile and Desktop Core

Create a focused workspace package, `@kanna/visual-companion`. Move
platform-neutral behavior out of the mobile app:

- companion snapshot, asset, lifecycle, and event-result state;
- the lifecycle reducer for connecting, available, reconnecting, unavailable,
  and error transitions;
- UTF-8 byte-bound helpers and strict companion-event parsing;
- event-id generation and revision association;
- fragment frame styles and document assembly primitives;
- selection semantics for single-select and multiselect content; and
- sanitized status and error mapping.

The package must not import React Native, Vue, Tauri, or a server runtime. Its
document builder accepts a small delivery-adapter configuration:

- mobile emits validated events through `window.ReactNativeWebView`;
- desktop emits validated events through the loopback bridge WebSocket.

Mobile retains its existing full-screen modal, WebView security configuration,
navigation policy, and React Native adapter. Desktop owns link interception,
OS browser opening, loopback HTTP/WebSocket serving, and Tauri lifecycle.

`@kanna/stream-client` remains the shared KSP attachment implementation. The
Rust `kanna-agent-protocol` crate remains the wire source of truth and generated
TypeScript protocol files must be regenerated rather than edited.

Extract the filesystem source and event sink from
`crates/kanna-server/src/visual_companion.rs` into a focused
`kanna-visual-companion` Rust crate. The crate owns secure session discovery,
origin parsing, document and asset bundles, event validation, and revision-bound
event append. It accepts an explicit database/workspace resolver boundary and
contains no HTTP, KSP, relay, Tauri, or task-transfer code. Kanna Server and the
paired LAN runtime both call this crate, preventing the LAN path from
reimplementing security-sensitive traversal.

## Companion Source Metadata and Assets

### Source origin

An active session's `state/server-info` is parsed through the same no-follow
workspace traversal used for its document. A usable origin must:

- use `http`;
- have a host of `localhost`, `127.0.0.1`, or `[::1]`;
- contain an explicit port in the range `1..=65535`;
- contain no username, password, query, or fragment; and
- normalize to an origin, independent of a trailing slash.

Invalid origin metadata does not expose the companion to desktop link
translation. Mobile document streaming may continue because it does not depend
on the source URL.

The companion snapshot gains an optional `source_origin`. It is optional so
older sources and mobile-only documents remain valid.

### Assets

Assets mirror the local server's `/files/<name>` behavior:

- only regular files directly within the active session's `content/` directory
  are eligible;
- the requested asset is addressed by its basename; subdirectories, absolute
  paths, dot components, NULs, and symlinks are rejected;
- HTML screen files are not duplicated as assets;
- each asset records name, MIME type, digest, and base64 bytes; and
- unknown extensions use `application/octet-stream`.

Resource bounds are:

- at most 32 assets per revision;
- at most 4 MiB per asset;
- at most 16 MiB of unencoded asset bytes per revision; and
- at most one pending latest bundle per attached task.

An oversized or unsafe individual asset is omitted and returns 404 from the
mirror. The document remains available. The bundle digest covers the document
revision plus the ordered asset names and digests, so a document and its assets
replace atomically. Asset bytes are coalesced with the latest companion value
and must use the companion outbound path rather than the terminal frame queue.

The KSP `companion_snapshot` adds `source_origin` and `assets`. Mobile ignores
assets during its first extraction pass and retains its current policy of
inline, `data:`, and public HTTPS resources. Desktop consumes them.

## Relay and LAN Transport

Refactor the desktop service name and interface from terminal-specific wording
to a remote-task client. It exposes:

- terminal observation, input, and resize;
- companion observation and event sending; and
- the existing task actions.

The relay implementation continues to reuse one `StreamClient` per owner
desktop. It calls the existing KSP companion attachment methods, including
connection changes and event results.

Paired LAN currently has a separate `kanna-task-transfer` protocol. Extend that
protocol with companion observe, unobserve, and event requests plus a
companion-event sidecar notification. The LAN payload embeds the same
`kanna-agent-protocol` companion frame structures rather than declaring a
second document or event schema. The owner-side peer runtime calls the shared
`kanna-visual-companion` Rust crate used by Kanna Server. The sidecar remains
responsible for peer trust and connection ownership.

Both implementations adapt to the same TypeScript observer interface, so the
bridge and link resolver do not branch on transport.

## Desktop Loopback Bridge

The bridge runs inside the Tauri Rust process so an ordinary external browser
can reach it after the Vue view changes or unmounts. It uses vendored Rust
dependencies and requires no machine-installed runtime or library.

An app-level bridge manager is keyed by:

```text
owner desktop id + owner task id + companion session id
```

Each entry stores only:

- current document kind and HTML;
- current revision and bundle digest;
- current bounded asset map;
- current connection and error state;
- browser connection count; and
- a sender for validated browser events.

The manager binds `127.0.0.1` on an ephemeral port, but advertises a
cryptographically random host-only `<token>.localhost:<port>` origin. The
initial entry URL contains a separate random 128-bit capability query value. A
valid entry response exchanges that value once for an HttpOnly,
SameSite=Strict, host-only session cookie and redirects to the clean root URL.
The random localhost hostname is the cookie-isolation boundary: cookies do not
honor ports, so a cookie scoped to plain `127.0.0.1` or `localhost` could leak
to unrelated local services. RFC localhost names resolve only to loopback, and
the bridge rejects any request whose `Host` is not the exact advertised
hostname and port. Root-relative `/files/*` references and the same-origin
WebSocket then work without putting a capability into companion HTML.
WebSocket upgrades validate the exact `Host`, cookie, and advertised loopback
`Origin`. The shared browser adapter also presents the session and revision of
the document it rendered. Each connection is bound to that identity before it
can receive an available status or send an event.

The bridge exposes only:

- `GET /` for the current shared-core-rendered document or a lifecycle page;
- `GET /files/<basename>` for the current revision's asset map; and
- a same-origin, document-identity-bound WebSocket for reload notices,
  lifecycle status, and bounded browser events.

It does not expose arbitrary paths, upstream URLs, filesystem reads, Tauri
commands, task APIs, or Kanna credentials.

When a newer bundle arrives, the manager swaps document and assets under one
lock, then publishes the new identity and one reload notice. Browser reload
always observes the complete new bundle. A connection whose rendered identity
does not match gets only a reload and cannot interact. Event admission
revalidates the connection-bound identity, and event delivery includes that
session id, revision, and event id rather than relabeling the event from current
state. The bridge marks the browser event pending until the transport produces
its event result.

Lifecycle mutation broadcasts carry no captured status payload. They are only
wakeups: the WebSocket handler re-reads the authoritative lifecycle and
connection-bound document identity under the entry lock immediately before
forming each outbound status or reload. Consequently, if concurrent owner calls
commit state A and then state B but publish their wakeups in the opposite order,
neither wakeup can resurrect A. Bundle identity changes use a separate watch
that is prioritized over lifecycle wakeups, so a stale document receives reload
rather than a status for the replacement bundle.

An opened bridge entry is not owned by the selected Vue component. It remains
alive while at least one browser WebSocket is connected. After the companion is
unavailable and no browser is connected, it closes immediately. After the task
is no longer selected and no browser is connected, it closes after a
30-second grace period anchored to the first deselection. Repeated unselected
status updates and browser reconnects do not renew that deadline. A browser
connection suspends removal only while connected; if it outlives the deadline,
the entry closes immediately when the final browser disconnects. Reselecting
cancels the anchor, and the next deselection starts a fresh grace period. All
listeners close when Kanna exits.

## Terminal Link Resolution

The remote terminal loads xterm's web-link addon and routes activations through
a resolver before the OS opener.

For each click:

1. Parse and normalize the link origin.
2. Compare it with the current remote task's active `source_origin`.
3. If it is not an exact match, use ordinary browser handling unchanged.
4. If it matches, ask the bridge manager to activate or reuse the corresponding
   entry.
5. Open the returned loopback entry URL through Tauri's existing opener.

The original path and query are not forwarded. The Superpowers companion
contract opens at `/`; assets are loaded from that document. Restricting the
match to the exact active origin prevents Kanna from becoming a general
localhost translator.

The desktop starts companion observation alongside terminal observation, so
the snapshot should normally exist before the agent's printed link is clicked.
If discovery is still pending, Kanna suppresses the unusable remote URL and
shows a short "Visual companion is still starting; try again" toast. It does not
open the remote `localhost` URL.

## Browser Behavior

The shared desktop document adapter preserves the local companion behavior:

- fragments receive the shared companion frame and styles;
- full documents retain their content and receive the event/reload helper;
- clicks on `data-choice` elements apply the same single-select or multiselect
  styling;
- the indicator reports selection, sending, delivered, reconnecting, or failed
  state; and
- a new revision reloads the page.

No remote label appears. The browser URL is loopback, just like a local
companion. Agent-controlled HTML receives no Kanna token, task metadata,
worktree path, filesystem URL, or native invocation bridge.

## Failure Behavior

- **Clicked before discovery:** do not open the remote URL; show the starting
  toast.
- **LAN or relay disconnect:** retain the last complete document, show
  reconnecting in the companion indicator, reject new selection delivery
  locally, and attach authoritatively after reconnection.
- **New revision races with a selection:** the owner rejects the stale
  revision, the bridge keeps the failure visible, and the newest bundle reloads.
  Events are never retried automatically.
- **Event append fails:** display a failed state in the browser indicator with
  an explicit retry affordance that creates a new event id.
- **Companion ends or workspace changes:** replace the browser content with an
  ended page and disable interaction.
- **Invalid or oversized document:** show a sanitized task-scoped error page;
  never include paths or document content.
- **Invalid, missing, or oversized asset:** return 404 for that asset without
  ending an otherwise valid document.
- **Slow viewer:** coalesce intermediate bundles and retain only the newest
  complete value. Terminal input and output remain responsive.
- **Kanna exits:** close every loopback listener and browser WebSocket.

## Security and Privacy

Companion content is untrusted agent output.

- Workspace reads remain descriptor-relative and no-follow.
- Source origin validation permits only explicit loopback HTTP origins.
- Browser listeners bind only to `127.0.0.1`, advertise a random host-only
  `<token>.localhost` origin, use an independent unguessable entry capability,
  exchange it for an HttpOnly same-site host-only cookie, and validate exact
  HTTP `Host` and WebSocket `Origin`.
- Companion documents never contain bridge capabilities or Kanna credentials.
- Browser events use the existing 8 KiB object limit, 256-byte choice/id
  limits, 4 KiB text limit, 128-byte event-id limit, and the owner-side
  per-connection/task/session rate limit.
- Documents, assets, selections, and capabilities are excluded from logs,
  analytics, Firestore, and durable cloud storage.
- Each bridge entry is scoped to one owner desktop, task, session, and revision.
- The feature cannot request arbitrary remote ports or paths and cannot carry
  arbitrary TCP streams.

## Testing

### Shared package

- Fragment and full-document assembly for mobile and desktop adapters.
- Single-select and multiselect behavior.
- Strict browser-event parsing, UTF-8 bounds, and event IDs.
- Lifecycle reducer transitions for attach, reconnect, replacement,
  unavailable, error, event result, and retry.
- Mobile parity tests moved from the app continue to pass against the shared
  implementation.

### Protocol and owner source

- Generated Rust and TypeScript types cover source origin and assets.
- Origin parsing accepts the supported loopback spellings and rejects
  credentials, non-loopback hosts, unsupported schemes, malformed ports,
  queries, and fragments.
- Asset discovery covers MIME types, deterministic ordering, digests, bounds,
  missing files, symlinks, path attacks, and replacement.
- KSP proves bundle coalescing cannot starve terminal frames.

### LAN and relay

- Relay tests cover companion attach, bundle delivery, connection changes, and
  event acknowledgements through the existing tunnel.
- Task-transfer protocol and runtime tests cover trusted peer observation,
  bundle delivery, unobserve, selection delivery, stale revision, and
  disconnect cleanup.
- Both adapters pass a shared remote-task companion contract suite.

### Desktop bridge and UI

- Rust bridge tests cover entry capability exchange, cookies, Origin checks,
  root documents, assets, 404s, WebSocket reloads and events, atomic bundle
  replacement, multiple isolated sessions, grace cleanup, and app shutdown.
- Terminal tests prove exact companion-origin translation, ordinary web-link
  behavior, starting-state suppression, and OS opener calls.
- Switching selected tasks does not close a browser-connected companion.

### End to end

Add a remote-desktop journey using the scripted companion fixture:

1. select a remote task and receive its real terminal output;
2. click the printed localhost link;
3. verify the external browser loads the loopback mirror;
4. load a `/files/*` asset;
5. publish a newer screen and observe reload;
6. click a real choice and verify the owner event file;
7. interrupt and restore the route, then verify authoritative recovery; and
8. stop the companion and verify the ended page.

Run the existing mobile relay visual-companion journey unchanged after the
shared extraction.

## Non-Goals

- Automatic browser opening when a companion appears.
- A Kanna desktop modal, embedded WebView, or companion tab.
- Manual paste support for the remote machine's original localhost URL.
- Arbitrary local dev servers, APIs, SSE, or WebSocket applications.
- General TCP or HTTP port forwarding.
- Public or team share links.
- Cloud persistence or offline companion viewing.
- Companion history or cross-workspace retention.
- Changing the local Superpowers companion server or the agent's printed URL.

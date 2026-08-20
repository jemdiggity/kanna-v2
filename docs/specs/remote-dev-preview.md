# Remote Dev-Server Preview — Architecture Spec

Status: architect consultation verdict (task `48b324bd`, 2026-08-21). Analysis
and design only — implementation is sliced at the end and meant to be spawned
as tasks. Owner feature request (verbatim): *"if the user is developing a
webapp on kanna via our mobile app, and doing it remotely, there's no easy way
for them to view their dev server to preview their app."* Owner ruling
(2026-08-21, carried from the billing work): everything through the relay is
entitlement-gated — **cloud access paid, LAN free**.

## Verified current state (2026-08-21)

Confirmed by source inspection in this worktree. Corrections to the
consultation prompt are marked ⚠️.

### Ports — Kanna knows the task's ports, and nothing else does

- `.kanna/config.json` `ports` is a map of **env-var name → base port**
  (`.kanna/config.schema.json:34`; this repo declares 11, e.g.
  `KANNA_DEV_PORT: 1420`). At task spawn, `claim_task_ports`
  (`crates/kanna-server/src/task_creator/environment.rs:11-58`) claims free
  ports **starting at base + 1** (the base is left for the human's own
  `kd dev up`), atomically via the `task_port` table (`port` is the PRIMARY
  KEY; `crates/kanna-server/src/db/mod.rs:737-743`), denormalized to
  `pipeline_item.port_env` (JSON) and `pipeline_item.port_offset` (actually
  the *first port*, not an offset). Claims are released on task close
  (`db/pipeline_items.rs:947`). `reserved_port_offsets: [0, 1]` exists because
  Vite's HMR websocket lives at `KANNA_DEV_PORT + 1`.
- The claimed values reach the task session **only as env vars named by the
  config's own keys** (`environment.rs:123`); there is no `reserved_port*`
  env var. The task's `setup` commands and agent shell both see them.
- ⚠️ "kd starts dev servers on those assigned ports": `kd dev up` starts *this
  repo's own* dev stack for the human at the base ports. A **task's** dev
  server is started by the task's own setup/agent using the env vars; Kanna
  never starts or supervises it.
- ⚠️ "kd inventory knows spawned processes since #1141": the process inventory
  (`tools/kd/src/runtime/process-inventory.ts`) records **pids, labels, and
  kernel spawn identities only — no ports, no command lines**, by design
  ("Cleanup never discovers targets from process names, arguments, or working
  directories", `docs/dev/dev-workflow.md`). The only port→pid mapping
  anywhere is `kd`'s `lsof` probe (`tools/kd/src/runtime/port-status.ts`),
  driven by the known port names, not wired to tasks. **A dev-server liveness
  signal must be a probe, not an inventory read.**
- ⚠️ `port_env` / `port_offset` are on **no mobile-facing surface**: not in
  `mobile_api::TaskDetail` (`crates/kanna-server/src/mobile_api.rs:140-233`),
  not in the TS `TaskDetail` (`apps/mobile/src/lib/api/types.ts:290-316`), not
  in any KSP frame. Exposing the task→port mapping to the phone is net-new
  protocol surface.

### Bind addresses — the dev server is loopback-only; kanna-server is not

- The desktop dev server binds **127.0.0.1 only**: `apps/desktop/vite.config.ts`
  sets `host: host || false` and nothing in `kd` sets `TAURI_DEV_HOST`. A
  task's Vite (and, by default, most users' webapp dev servers) is unreachable
  from the LAN. This is the single biggest constraint: **even the LAN case
  needs a desktop-side forward — surfacing a bare URL cannot work.**
- `kanna-server` binds `lan_host` (default `0.0.0.0`) : `lan_port` (48120)
  (`crates/kanna-server/src/config.rs:64-68`, `http_api/router.rs:559-570`) and
  advertises `_kanna-mobile._tcp` over Bonjour with a `desktopId` TXT record
  (`crates/kanna-server/src/bonjour.rs`). The phone resolves host+port from
  the Bonjour record, validates it by probing `GET /v1/status` and matching
  `desktopId` (`apps/mobile/src/lib/discovery/trustedBonjour.ts:70-76`), and
  caches the validated base URL per desktop.

### Relay — two tunnel service classes, phone-initiated, entitlement-gated

- The relay (`services/relay`, one Node process behind Caddy on one e2-micro;
  Caddy does `reverse_proxy relay:8080` with **no path routing**) splices
  opaque tunnels between authenticated peers. Service classes are exactly
  `"ksp" | "task-transfer"` (`services/relay/src/router.ts:28`). Only a
  **phone-authenticated socket may send `tunnel_request`**; desktops can only
  accept (`router.ts:651-687`; documented as a deliberate invariant in
  `crates/kanna-server/src/cloud_transfer_proxy.rs:1-11`). The desktop
  receives `tunnel_establish` on its control socket and dials back a second
  WebSocket with `tunnel_id` (`crates/kanna-server/src/relay.rs:614-688`).
- `crates/kanna-server/src/task_transfer_tunnel.rs` is an existing generic
  **raw TCP-over-relay splice** (`TcpStream::connect(127.0.0.1:port)` ↔
  binary WS frames, 64 KiB reads) — the direct precedent for bridging a local
  HTTP server through the relay. `cloud_transfer_proxy.rs` is the precedent
  for kanna-server binding dynamic listeners with connection caps
  (`DEFAULT_MAX_PROXY_CONNECTIONS = 16`).
- The relay already serves plain HTTP routes via an if-chain in
  `index.ts:127-276`; the OTA handler (`ota.ts`) is the pattern — and also
  the cautionary tale: it buffers whole assets in RAM, which
  `docs/specs/relay-scaling.md` names the Stage-2 "shared fate" failure.
- Entitlement enforcement is **landed and flag-gated**
  (`KANNA_RELAY_ENTITLEMENT_ENFORCEMENT`, default off; PR #1152):
  `services/relay/src/entitlement.ts` reads
  `users/{uid}/entitlements/cloud_access` (60 s TTL cache), gates tunnels and
  push on the `cloud_relay` capability and publication on `cloud_task_index`,
  refuses with code **4402 "entitlement required"** — on a phone
  `tunnel_request` as `{type:"response", id, error, code:4402}`
  (`index.ts:733-742`), on a tunnel socket as `close(4402)`. ⚠️ Not quite
  "everything": phone→desktop `invoke` routing is deliberately still served
  unentitled (`remote_task_control` is read by nothing), and a Firestore
  error fails open. Preview rides the tunnel-shaped, gated sites.
- Byte odometer (PR #1146): classes
  `["tunnel","taskTransfer","terminalEvent","control"]`
  (`byteAccounting.ts:35`), attributed per connection/uid/service. Caps:
  `maxPayload` 16 MiB decompressed; per-tunnel buffered-bytes caps (ksp
  64 MiB, task-transfer 1 MiB) with pause/resume watermarks; **no global
  buffer budget yet** (the scaling spec's Stage-1 hardening item).

### Mobile — WebViews exist, but none loads a URL today

- `react-native-webview` 13.16.1 is embedded at four sites (terminal, visual
  companion, diff, file preview) — **all render inline HTML with
  `originWhitelist` locked to `about:blank`**; the visual companion
  additionally sets `onShouldStartLoadWithRequest` to refuse everything,
  `allowFileAccess={false}`, `mixedContentMode="never"`
  (`apps/mobile/src/screens/VisualCompanionModal.tsx:158-181`). Loading a
  real origin is a new security posture, confined to one new component.
- The phone has **no local HTTP server, no proxy machinery, no in-app
  browser**; `Linking.openURL` is used twice. Adding a loopback server would
  be new native surface (→ `runtimeVersion` bump); everything in this spec is
  deliberately JS-only on the phone (OTA-deliverable).
- Transport routing: per-task LAN-vs-cloud decision is `routeForTask`
  (`apps/mobile/src/lib/sources/cloudLanClient.ts:865-915`); LAN REST carries
  `X-Kanna-Device-Id/Secret` from QR pairing; the relay path multiplexes
  `invoke` on the control socket and opens `service:"ksp"` tunnels for
  streams. The task screen's floating `composerActions` row already hosts a
  conditional "Visual companion ready" pill (`TaskScreen.tsx:888-921`) — the
  natural home for a Preview affordance.
- iOS ATS: the app declares `NSLocalNetworkUsageDescription` + Bonjour
  services and **no ATS exceptions** — LAN HTTP works today because ATS
  exempts raw IP addresses and `.local` hosts (this is how the existing LAN
  API connection already runs over `http://`). WKWebView page loads follow
  the same carve-out; verify on device in the first mobile slice before
  relying on it (checkpoint, not an assumption).

## Goal and non-goals

**Goal**: from the task screen on the phone, open the task's running dev
server in an in-app browser view — on the LAN directly against the desktop,
remotely through the relay — with live reload (HMR) working, without exposing
the dev server to anyone but the phone's user.

**Non-goals**: previewing arbitrary undeclared ports; a general-purpose
port-forwarding product; public/shareable preview links to third parties;
proxying HTTPS dev servers (loopback dev servers are plain HTTP; TLS
upstreams are out of scope); Android (no Android channel is in scope
anywhere; if one ships, LAN cleartext needs a network-security-config entry);
rewriting response bodies to fix absolute URLs (never rewrite bodies).

## Design overview

Both paths converge on one new desktop component; the phone renders a URL in
a WebView either way.

```
LAN:    WebView ─ http://<validated-lan-host>:<ephemeral>/ ──────────────┐
                                                                         ▼
                                                          kanna-server preview
                                                          session + forwarder ──► 127.0.0.1:<claimed port>
                                                                         ▲          (task's dev server)
Remote: WebView ─ https://p-<token>.relay.kanna.build/ ─► relay preview  │
                  (wildcard preview origin)               origin ─ tunnel┘
                                                          service "preview"
```

- **One preview session per (task, port)**: minted by kanna-server, holding
  an unguessable token, a cookie secret, an expiry, and either a LAN listener
  or a relay tunnel. Sessions are **in-memory only** — a desktop restart
  revokes everything, which is the correct failure mode.
- **One forwarder**: an HTTP/1.1-aware proxy in kanna-server (hyper client to
  `127.0.0.1:<port>`) shared by both paths. The relay stays as dumb as
  possible; all HTTP awareness that must exist lives on the desktop, where
  CPU is free.
- The dev server is **never** re-bound to the LAN. The forwarder is the only
  way in, and it answers only requests carrying a valid session cookie.

## The preview session and forwarder (kanna-server)

### Session lifecycle

- `POST /v1/tasks/{task_id}/preview` — **opens LAN sessions only**
  (paired-device or loopback auth — the same auth the rest of the task API
  uses) with body `{ portName?: string }`. Remote sessions are never opened
  over REST: the phone opens them exclusively with `preview_request` on its
  relay control socket, and the desktop's `preview_establish` handler runs
  the same validation, probe, and minting (steps 1–3 below) before dialing
  back the tunnel — with refusals surfaced as `preview_refuse` control
  messages instead of REST 409s (see "Wire design" under Remote path). The
  server:
  1. Refuses unless the task is open and has claimed ports; resolves
     `portName` against the task's `task_port` claims (default: the first
     port). **Only claimed ports are ever eligible** — the request names a
     port by its env name, never by number.
  2. Probes `127.0.0.1:<port>` with a TCP connect. Not listening →
     `409 { ports: [{name, port, listening}] }` and no session; the client
     renders "dev server isn't running" with retry. (The kd process
     inventory cannot answer this — see Verified state.)
  3. Mints the session: a 128-bit random **enter secret** (the `t=` query
     parameter) and an independent 128-bit **cookie value**, sliding idle
     timeout (default 30 min), hard cap (default 12 h). Both credentials are
     desktop-owned on every path: only the desktop's forwarder ever stores or
     validates them (see "Wire design" for what the relay holds instead).
  4. Binds an OS-assigned ephemeral TCP listener on `lan_host` (the
     `cloud_transfer_proxy` pattern) and returns
     `{ port: <ephemeral>, enterPath: "/__kanna_preview__/enter?t=<enterSecret>",
        ports: [...] }`. The phone composes the URL from its already
     validated Bonjour host for that desktop — the server never guesses its
     own LAN IP.
- `DELETE /v1/tasks/{task_id}/preview` closes the task's preview session of
  either kind: for a LAN session it closes the ephemeral listener; for a
  remote session it closes the tunnel, which is the relay-side revocation
  signal (see the cleanup rules under Remote path). Reachable like the rest
  of the task API — LAN REST directly, or the relay `invoke` path. Sessions
  are also revoked on: task close, stage transition (workspace teardown —
  the same hook that kills the daemon session), idle/hard expiry, and
  desktop restart (in-memory). Revocation closes the LAN listener / relay
  tunnel; in-flight responses are aborted.
- `mobile_api::TaskDetail` gains `ports: [{name, port}] | null` (serialized
  from `pipeline_item.port_env`) so the phone can show the affordance without
  a second request. Field absence = old desktop = hide the affordance (this
  is the version-skew gate).

### Enter flow — token once, cookie thereafter

The first navigation hits
`http(s)://<origin>/__kanna_preview__/enter?t=<enterSecret>`; the forwarder
validates the enter secret, sets an `HttpOnly; SameSite=Lax; Path=/` session
cookie (the cookie value, not the enter secret; `Secure` on the relay path),
and 302s to `/`. Every subsequent request — absolute-path assets, XHR, and the HMR
WebSocket handshake, all of which carry cookies — must present the cookie or
gets `404`. This solves the absolute-path problem without body rewriting:
**each preview session is its own origin** (a distinct LAN port, or a
distinct relay subdomain), so `/assets/app.js` and `/@vite/client` resolve
correctly at the origin root.

The `/__kanna_preview__/` prefix is reserved by the forwarder and shadows any
identical route in the previewed app (vanishingly unlikely; documented
residual).

### Forwarding rules

- HTTP/1.1 reverse proxy via hyper to `127.0.0.1:<port>`, streaming bodies
  both ways (no buffering of full bodies), request body cap 8 MiB (matching
  the task-input attachment cap precedent).
- **Host is rewritten to `localhost:<port>`** so dev-server host checking
  (Vite `server.allowedHosts`, which would reject a relay hostname) passes;
  token+cookie auth replaces the DNS-rebinding protection this bypasses.
  `Origin` on upgrade requests is rewritten the same way for the HMR
  handshake. `Location` response headers pointing at the upstream origin are
  rewritten back to relative. Bodies are never rewritten — an app that
  emits absolute `http://localhost:…` URLs in HTML will misrender; that is a
  documented limitation, not a bug to chase with rewriting.
- Hop-by-hop headers stripped; `X-Forwarded-*` and any inbound
  proxy/`CONNECT` semantics refused (see Security).
- `Upgrade: websocket` → forwarder performs the upstream handshake and then
  splices raw bytes (hyper upgrade), which is what makes Vite/Metro HMR work
  unmodified.
- Per-session caps: max 64 concurrent streams, max 16 concurrent LAN TCP
  connections (the `cloud_transfer_proxy` numbers), per-session buffered
  bytes bounded (below).

## Q1 — LAN path (ship first)

Phone on the same network, desktop paired via QR:

1. Task detail shows `ports` → Preview pill appears.
2. Tap → `POST /v1/tasks/{id}/preview {portName?}` over the validated
   LAN base URL → `{port, enterPath}`.
3. WebView (or "Open in Safari" share) loads
   `http://<validated-host>:<ephemeral-port>/__kanna_preview__/enter?t=…`.
4. Everything, including HMR WS, flows phone → ephemeral listener →
   forwarder → `127.0.0.1:<claimed port>`.

**Why not just re-bind the dev server to the LAN** (e.g. set
`TAURI_DEV_HOST`/`--host` for tasks): a LAN-exposed Vite serves `/@fs/`
source reads, HMR, and module transforms to *anyone on the network*, with no
auth — coffee-shop Wi-Fi turns that into source disclosure and, historically,
RCE-class dev-server CVEs. It also only works for servers Kanna configures,
not for whatever the user's webapp scaffold binds. Rejected. The
token-gated forwarder exposes exactly one authenticated path to exactly one
loopback port, and works for any dev server.

**LAN risks that remain**: the traffic is cleartext HTTP on the local
network (same trust level as the existing LAN API, which also runs over
`http://`); anyone who captures the enter URL within its TTL can view the
preview. Both are accepted for LAN per the "LAN free, LAN local" posture and
bounded by expiry/revocation. ATS: raw-IP cleartext is exempt (verified
posture of the existing LAN transport; re-verify in-WebView on device during
the mobile slice).

**Entitlement**: none. LAN preview is free, per the owner's ruling.

## Q2 — Remote path (through the relay)

### Alternatives considered

**(b) Phone-side proxy over the ksp connection — rejected.** React Native has
no local HTTP server; adding one is a native module (`runtimeVersion` bump,
binary-only ship), a new listening socket on the phone (its own attack
surface), and WKWebView still needs a real origin to resolve absolute paths
against. A service-worker shim inside the WebView cannot intercept the
initial navigation or WebSocket connections. Every constraint fights the
platform.

**(a′) Relay as per-connection raw TCP splice — rejected.** The elegant
"relay stays a blind splicer" shape (hijack each inbound preview connection,
splice it to a per-connection tunnel) breaks behind Caddy: Caddy pools and
**reuses upstream connections across different clients**, so a spliced
connection cannot be assumed to carry one session's requests. Defeating that
(per-request upstream connections) multiplies tunnel establishment by Vite's
hundreds of module requests. Also unable to rewrite `Host` without parsing
anyway.

**(a) Relay-side preview origin over a multiplexed preview tunnel —
recommended.** The relay terminates HTTP (it already does, for OTA) but
never interprets preview payloads beyond framing them; one persistent tunnel
per preview session carries all requests.

### Wire design

New tunnel service class `"preview"` (third variant of `TunnelService` in
`services/relay/src/router.ts:28` and
`crates/kanna-server/src/relay_client.rs:13-19`; advertised in `auth_ok`
`capabilities.tunnelServices` for feature detection).

Session open — mirrors `tunnel_request`, preserving the phone-initiates
invariant. Credential ownership is split once and never shared: the **relay
owns the host token** (routing only — it maps a `p-<hostToken>` label to a
spliced tunnel and nothing else), and the **desktop owns the enter secret and
the session cookie value** (authentication — only the desktop's forwarder
stores or validates them; the relay carries the enter path once as an opaque
string and treats every later cookie as ordinary request bytes).

1. Phone → relay control socket:
   `{type:"preview_request", id, desktopId, taskId, portName?}`.
2. Relay checks entitlement (`cloud_relay`, same 4402 refusal shape as
   `tunnel_request`; enforcement-flag semantics identical), registers a
   pending preview keyed by a freshly minted `tunnelId` — the same
   `PendingTunnel` machinery and 10 s expiry that `tunnel_request` uses — and
   sends the desktop control socket:
   `{type:"preview_establish", tunnelId, taskId, portName?}`.
3. The desktop validates the task and resolves the port **against its own
   `task_port` claims** (the relay never sees or trusts a port number) and
   probes it.
   - **Refusal** goes on the control socket:
     `{type:"preview_refuse", tunnelId,
     code:"not_listening"|"unknown_task"|"no_ports"|"session_limit",
     ports?:[{name, port, listening}]}`. The relay clears the pending entry
     and forwards `{type:"response", id, error, code, body:{ports}}` to the
     phone (`not_listening` → the phone's "not running" state). No tunnel is
     dialed, no session or secrets ever exist.
   - **Success**: the desktop mints the session (enter secret, cookie value,
     expiries) and dials back the standard tunnel socket
     (`{type:"auth", desktop_id, desktop_secret, tunnel_id}`) with
     `service:"preview"`.
4. **Acceptance rides the tunnel it describes.** The first frame the desktop
   sends on the freshly authenticated tunnel is
   `preview_accept {enterPath:"/__kanna_preview__/enter?t=<enterSecret>",
   expiresAt}` — which binds the session's credentials to exactly this
   `tunnelId`, whose ownership the dial-back auth (desktop secret +
   `tunnel_id`) has already proven. The relay does not answer the phone
   before this frame arrives; any other first frame closes the tunnel as a
   protocol error.
5. Relay mints the 128-bit host token, binds `hostToken → tunnel`, and
   answers the phone: `{type:"response", id,
   body:{url:"https://p-<hostToken>.<preview-domain>" + enterPath,
   expiresAt}}`. The relay keeps the enter path only long enough to compose
   this response; the phone is the only party that ever holds the complete
   URL. (The relay is necessarily inside the remote path's trust boundary
   regardless — it terminates TLS for every preview request and sees the
   cookie in transit — so this split is about *state authority*, not hiding
   bytes from the relay: the desktop alone decides what the secrets are and
   whether a presented one is valid.)
6. WebView loads the URL. Caddy routes the wildcard host to the relay; the
   relay resolves the `p-<hostToken>` label to the tunnel and forwards
   framed requests; the desktop end validates the enter secret / cookie and
   feeds requests through the same forwarder as LAN. A valid host token
   paired with the wrong enter secret or cookie routes to the right tunnel
   and is then refused by the desktop's forwarder (404) — routing and
   authentication fail independently, and neither can substitute for the
   other.

Pending state and failure cleanup, on every side:

- **Pending timeout** — the desktop neither refuses nor completes
  (never dials back, or dials back but never sends `preview_accept`) within
  the 10 s pending expiry: the relay deletes the pending entry, closes a
  half-attached tunnel socket if one arrived, and answers the phone with the
  existing tunnel-timeout error. A dial-back for an expired or unknown
  `tunnelId` gets the existing 4404 "Tunnel not found" close, upon which the
  desktop destroys the session and its secrets.
- **Phone disconnect** before the response: the pending entry is dropped
  with the phone's other pending state; a tunnel completing afterwards is
  closed, and tunnel close is the desktop's signal to destroy the session.
- **Desktop control-socket disconnect**: all pending previews addressed to
  that desktop fail to the phone immediately, same as pending invokes.
- **Tunnel death** at any later point: the relay unbinds the host token (the
  hostname stops resolving → 502 to the WebView) and aborts in-flight
  streams; the desktop destroys the session and secrets. Tokens never
  outlive their tunnel, and there is no re-attach — reopening is a fresh
  `preview_request` minting fresh credentials.
- **Desktop-side revocation** (task close, stage transition, expiry,
  explicit `DELETE`): the desktop closes the tunnel; that close *is* the
  revocation signal the relay needs — no separate control message exists.

Tunnel framing (JSON control + binary chunks, chunk size 64 KiB — well under
the 16 MiB `maxPayload`):

```
desktop → relay  preview_accept {enterPath, expiresAt}   (first frame, exactly once)
relay → desktop  preview_req   {stream, method, path, headers}
both directions  preview_body  {stream} + chunk        (binary, interleaved)
                 preview_end   {stream, trailers?}
desktop → relay  preview_res   {stream, status, headers}
relay → desktop  preview_ws    {stream, path, headers}  (upgrade request)
desktop → relay  preview_ws_ok {stream, status, headers}
both directions  preview_ws_data {stream} + raw ws bytes
both directions  preview_abort {stream, reason}
```

The relay maps each inbound HTTP request (Node `request` event) or upgrade
(Node `upgrade` event — it never completes the WS handshake itself, it
forwards the handshake and then relays bytes) to a stream id; it streams
bodies chunk-by-chunk without assembling them (the OTA full-buffer mistake is
explicitly not repeated). Backpressure: per-stream pause via the existing
`bufferedAmount` watermark machinery, with **preview-tunnel caps far below
ksp's**: 8 MiB max buffered per tunnel (high 4 / low 2 MiB), 64 concurrent
streams, over-cap → 1013 close, exactly the existing `failTunnelPair`
semantics.

### Origin model — why a wildcard subdomain

A path-prefixed origin (`https://relay…/preview/<token>/…`) breaks the first
absolute path the app requests (`/assets/x.js` escapes the prefix); fixing
that means rewriting bodies — never. A single shared preview hostname breaks
differently: WKWebView shares one cookie store, so two simultaneous previews
on one origin fight over the routing cookie, share an HTTP cache, and are
same-origin to each other (a compromised dependency in preview A could read
preview B). **Per-session subdomains give browser-enforced isolation for
free**: `https://p-<token>.<preview-domain>/`, token routed by `Host`.

Cost: a wildcard DNS record and a wildcard certificate for the preview
domain (Caddy DNS-01 with a Cloud DNS token — new relay-VM provisioning
surface; **owner decision** below). The token appears in DNS queries and SNI,
so a passive network observer can learn an active hostname — which is why the
hostname token alone is not sufficient: the enter URL carries the separate
desktop-minted enter secret, and requests without the resulting cookie get
404 from the desktop's forwarder. A DNS observer learns that a preview
exists, not how to view it.

Dev/E2E environments run the same code without wildcard TLS: the local relay
serves preview by `Host` header over plain HTTP and tests construct the Host
themselves.

### Streaming, HMR, correctness

- WS/HMR: carried as `preview_ws*` streams end-to-end; Vite and Metro HMR
  work unmodified (verified in E2E by a WS echo through the full path).
- Streaming responses (SSE, large bundles — Metro serves a 5–30 MB bundle as
  one response): chunked frames, never assembled in relay RAM.
- Cookies: the previewed app's own cookies flow through untouched, scoped by
  the browser to the per-session origin — they cannot leak across sessions
  or to `relay.kanna.build` proper.
- Relative-path correctness comes from origin-per-session; `base href`
  tricks are unnecessary and not attempted.

## Q3 — Security model (non-negotiable invariants)

1. **Only declared ports.** The forwarder connects exclusively to
   `127.0.0.1:<port>` where `<port>` is one of *this task's* `task_port`
   claims, resolved desktop-side by env name. The relay never carries a port
   number. No request can name a host or port.
2. **Never an open proxy.** Absolute-URI request targets and `CONNECT` are
   refused at the relay preview origin and at the forwarder; inbound
   `X-Forwarded-*`/`Forwarded` headers are stripped; the upstream is
   loopback-only by construction.
3. **Only paired desktops / the account's own desktops.** LAN sessions are
   minted only through paired-device-authenticated API calls; relay sessions
   ride the existing uid↔desktopId scoping (`connections` map keyed by uid) —
   a phone can only preview tasks on desktops its Firebase account owns.
4. **Ephemeral unguessable credentials, two factors on the remote path,
   each with exactly one owner.** Routing: the relay-minted 128-bit host
   token, bound to one tunnel (on LAN the ephemeral port fills this role).
   Authentication: the desktop-minted 128-bit enter secret and `HttpOnly`
   session cookie, stored and validated only by the desktop's forwarder —
   the relay never checks a credential, so a host token presented with the
   wrong enter secret or cookie routes and is then refused desktop-side.
   Sliding 30 min idle, 12 h hard cap. Revoked on: task close, stage
   transition/workspace teardown, explicit close, expiry, tunnel death
   (tokens never outlive their tunnel), desktop restart (sessions are
   in-memory only, deliberately).
5. **Entitlement-gated on the relay path.** `preview_request` and the
   preview origin enforce `cloud_relay` with the landed 4402 semantics behind
   the same enforcement flag; LAN is ungated (owner ruling). Tokens for
   revoked-entitlement sessions die with their tunnels (tunnel refusal on
   re-establish uses the existing `close(4402)`).
6. **What a malicious page in the WebView can reach.** The preview WebView
   gets **no `ReactNativeWebView` bridge** (no injected JS, no `onMessage`),
   `setSupportMultipleWindows={false}`, and navigation locked to the preview
   origin via `onShouldStartLoadWithRequest` (external links hand off to the
   system browser). Same-origin: only its own session. The desktop's
   privileged surfaces: kanna-server's LAN API requires device-secret
   headers the page never has; the preview origin shares no cookies with the
   relay origin or other sessions (distinct subdomains) and no origin with
   kanna-server (distinct port). Residual: page JS can attempt `fetch` to
   other LAN IPs from the phone — inherent to rendering any web content in
   any browser, identical to the user opening their app in Safari; not
   expanded by this design.
7. **Memory/bandwidth bounded; preview bytes are their own traffic class.**
   Add `"preview"` to `RELAY_BYTE_CLASSES`; tunnel attribution already
   carries `tunnelService`, so the odometer rolls preview bytes up per uid
   distinctly. Caps: 8 MiB per-tunnel buffer (vs ksp's 64 MiB), 64 streams,
   8 MiB request bodies, 2 concurrent preview sessions per uid (multi-task
   preview is a tap away from re-opening), the global tunnel-buffer budget
   from the scaling spec's Stage-1 hardening as a co-requisite.

## Q4 — UX

- **Affordance**: a "Preview" pill in the task screen's `composerActions`
  row, exactly the visual-companion pill pattern (conditional, with the same
  styling), shown when `TaskDetail.ports` is non-empty. Also an entry in the
  `+` action sheet (`taskActionMenu.ts`) for discoverability.
- **Opening**: tap → route via `routeForTask` — LAN if validated
  (`POST /v1/tasks/{id}/preview` over the LAN base URL), else relay
  (`preview_request` on the relay control socket; never REST)
  → session open → fullscreen `TaskPreviewModal` (sibling of
  `VisualCompanionModal`) hosting the WebView, with an address-less chrome:
  title = task title + port name, refresh button, "Open in browser" share
  (hands the enter URL to Safari — works on both paths), close.
- **Dev server not running**: the open call returns the per-port probe
  result; the modal shows "Nothing is listening on `KANNA_DEV_PORT` (1421)"
  with a Retry button. No background polling — probe on open and on retry
  only (the repo's no-polling conviction).
- **Multi-port tasks**: default to the first port; when more than one port is
  declared, the pill's long-press (and the not-running state) lists ports by
  env name; switching ports is a new session.
- **Refresh/HMR**: HMR flows through the WS path automatically — the normal
  loop is save-on-desktop → live update on the phone with no interaction.
  The refresh button and pull-to-refresh do a WebView `reload()` (full
  cold load through the proxy). Session expiry mid-view → enter-URL re-issue
  happens transparently on next open; the WebView shows the standard error
  page → user taps refresh → phone re-opens the session first if dead.

## Q5 — Capacity and cost

Traffic shape (per active preview): a cold Vite dev load is 100–500 requests
/ 2–20 MB (unbundled ESM); a Metro bundle is one 5–30 MB streamed response;
HMR updates are KB-scale WS frames; a pull-to-refresh repeats a cold load
minus WebView cache hits. Call it **tens of MB per active preview hour,
worst case** — comparable to a couple of OTA fetches, but streamed in 64 KiB
chunks with an 8 MiB tunnel buffer cap instead of OTA's full-asset RAM
buffering, so the RAM cliff profile is strictly better than the existing OTA
path.

Against the scaling spec: at Stage 1 (~10 users, ≤2 concurrent previews
realistically) this is noise on the e2-micro — the binding constraint is RAM
cliffs, and preview's caps (8 MiB × 2 sessions/uid) add at most tens of MiB
bounded, unlike the unbudgeted 64 MiB ksp tunnels that already exist. At
Stage 2 the e2-medium resize absorbs it. Preview egress lands in the
`preview` odometer class, so the "$1/user post-lever" claim gets re-measured
with real numbers rather than assumed.

**Verdict: safe to ship now — it does not need to wait for the Stage-2
OTA/CDN split** — provided the two Stage-1 hardening items ship with or
before the remote slice: the **global tunnel-buffer budget** (preview adds
tunnels; the budget stops them stacking with ksp's) and the metrics endpoint
so preview buffer stats are visible. Entitlement gating means preview load
scales with *paying* users only.

## Compatibility and version skew

- Phone changes are JS-only (WebView is already a dependency) →
  OTA-deliverable, no `runtimeVersion` bump. The relay and desktop deploy
  independently; feature detection is layered: phone shows the affordance
  only when `TaskDetail.ports` exists (new desktop), uses the relay path only
  when `auth_ok` advertises `"preview"` in `tunnelServices` (new relay), and
  an old desktop receiving `preview_establish` ignores it → the relay's
  existing 10 s pending-tunnel timeout answers the phone with an error → the
  phone shows "desktop needs an update". No frame is repurposed; all new
  message types are additive.
- The storage layer is untouched (sessions in-memory; `ports` on TaskDetail
  reads existing columns). No migration.

## Q6 — Implementation slices

Ordered; each is one spawnable task with its boundary and required coverage.
E2E lands in the existing harnesses: `tests/remote-e2e/` (full stack:
emulators + local relay + kanna-server + daemon) and
`services/relay/test/integration.test.ts` (Layer A).

**P0 — Desktop preview sessions + LAN path (kanna-server only).**
Boundary: `crates/kanna-server` — preview session manager, forwarder (hyper
loopback client, Host/Origin/Location rewrites, WS upgrade splice, caps),
ephemeral LAN listener, enter/cookie flow, the LAN-only `POST` and the
either-kind `DELETE` on `/v1/tasks/{id}/preview`, probe, revocation hooks on
close/stage-transition,
`ports` on `mobile_api::TaskDetail`. No relay, no mobile.
E2E (`tests/remote-e2e/`, LAN layer): fixture task with a claimed port and a
fixture HTTP+WS server on it → open preview via paired-device auth → enter
URL sets cookie → `/` and an absolute-path asset fetch succeed → WS echo
round-trips → uncookied request 404s → undeclared-port request refused →
task close kills the listener mid-session. Integration: forwarder rewrite
rules and open-proxy refusals as Rust tests.

**P1 — Mobile LAN preview UX.**
Boundary: `apps/mobile` — Preview pill + action-sheet entry,
`TaskPreviewModal` (locked-down WebView posture from Q3.6), not-running and
retry states, multi-port list, browser share. JS-only; OTA-deliverable.
E2E: extend the remote-e2e mobile-equivalent client to drive session open +
enter-URL fetch through the LAN transport. Real WKWebView rendering and the
ATS cleartext-to-IP verification are device-gated (the existing Layer C/D
posture) → land `docs/<date>-mobile-preview-webview-e2e-gap.md` naming
exactly that gap and the harness coverage that runs now.

**P2 — Remote path (relay + desktop tunnel + mobile routing).**
Boundary: `services/relay` — `"preview"` service class, the
`preview_request` / `preview_establish` / `preview_refuse` control messages
with the 4402 gate and the `PendingTunnel`-based pending lifecycle
(timeout, phone-disconnect, desktop-disconnect cleanup), `preview_accept`
handling and host-token binding, wildcard-host routing, HTTP↔frame gateway
with streaming and the preview caps, `"preview"` odometer class;
`crates/kanna-server` — `preview_establish` handler, session/credential
minting, tunnel dial-back with `preview_accept` as first frame, framing over
the existing forwarder, session teardown on tunnel close/4404; `apps/mobile`
— relay routing in the preview controller. Includes the dev-mode plain-HTTP
Host-routing path for tests.
E2E: Layer A (`services/relay/test/integration.test.ts`) — 4402 refusal on
unentitled `preview_request`; framed request/response; WS splice;
stalled-reader cap → 1013; byte-class attribution; pending-entry cleanup on
timeout and on either peer's disconnect, including 4404 on a late dial-back.
`tests/remote-e2e/` cloud flow — this is asynchronous phone↔relay↔desktop
coordination, so isolated tests cannot prove the wiring; the full stack must
cover: **successful credential binding** (the URL the phone receives is the
relay's host token composed with the desktop's `enterPath`, proven by
enter → cookie → absolute-path asset fetch → WS echo through the tunnel);
**typed refusal** (`preview_refuse: not_listening` reaching the phone as its
"not running" state); **timeout/disconnect cleanup** (a desktop that never
dials back → phone gets the timeout error and the relay holds no residual
pending/token state; desktop control-socket drop mid-establish → immediate
phone error); **wrong-credential rejection** (a valid host token paired with
the wrong enter secret or wrong/absent cookie → desktop-side 404, session
unaffected; a dead tunnel's host token → 502); plus entitlement-flag-on
refusal rendering the phone's neutral state. Wildcard TLS itself is not
automatable locally → dated e2e-gap note for the DNS/cert leg, verified
against staging at deploy.

**P3 — Hardening (co-requisite for P2 rollout, separable task).**
Global tunnel-buffer budget (scaling spec Stage-1 item, now including
preview tunnels), preview stats in `/health`, per-uid session caps, staging
soak with odometer readout.

P0 and P1 ship LAN preview alone — a complete free-tier feature. P2 is
gated on the owner decisions below.

## Owner decisions

1. **Preview domain + wildcard DNS/TLS** (P2 blocker): approve
   `*.p.relay.kanna.build` (or similar) wildcard record and Caddy DNS-01
   credentials on the relay VM — new provisioning surface in
   `services/relay/deploy/`. Alternative (rejected above): single shared
   preview origin, weaker isolation.
2. **LAN preview is free** — per the standing ruling; recorded here that the
   LAN slice ships ungated. Confirm no per-feature flag is wanted.
3. **Remote preview rides `cloud_relay`** (default, recommended — enforcement
   stays capability-based and source-agnostic) vs a distinct entitlement
   capability for future pricing. Default needs no billing-side change.
4. **Ship-now timing** (Q5 verdict): remote preview does not wait for the
   Stage-2 OTA/CDN split, with the global tunnel budget as co-requisite.
   Confirm, since it commits e2-micro headroom.
5. **Dev servers stay loopback-bound** — this design never exposes them on
   the LAN. Recorded as the deliberate posture (rejecting the
   `TAURI_DEV_HOST`-style alternative).
6. **Accepted residuals**: token-in-hostname DNS/SNI observability (mitigated
   by the cookie second factor), cleartext LAN transport (parity with the
   existing LAN API), absolute-URL-in-body misrenders (no body rewriting).

## Scope / exclusions

This consultation designs; it changes no product code. Excluded, decided
deliberately: phone-side proxy servers, body rewriting, HTTPS upstreams,
Android network-security config, shareable third-party preview links,
preview of non-task (main-checkout) dev servers, HTTP/2 to the upstream, and
any relay-architecture change beyond one additive service class — the
sharding/roster design in `docs/specs/relay-scaling.md` is unaffected (a
preview tunnel meets its desktop on the desktop's shard exactly like ksp).
Not repo-resolvable: the wildcard DNS/TLS provisioning and the owner
decisions above.

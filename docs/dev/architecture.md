# Architecture

Kanna is a set of cooperating processes centered on the desktop app. This page
describes each component, the boundaries between them, and where the code
lives.

## System overview

```
                       ┌────────────────────────────────────────────┐
                       │            Desktop app (Tauri v2)          │
                       │  Vue 3 + Pinia frontend  ⇄  Rust backend   │
                       └───────┬───────────────────────────┬────────┘
                               │ Unix socket (NDJSON)      │ spawns/owns
                               ▼                           ▼
                     ┌──────────────────┐ commands ┌──────────────────┐
   agent CLIs        │   kanna-daemon   │◀─────────│   kanna-server   │──── SQLite
  (claude, codex,◀───│  PTY sessions,   │          │  HTTP + KSP WS   │
   copilot, …)       │  fd handoff      │─────────▶│  LAN API :48120  │
                     └──────────────────┘  events  └───▲──────────┬───┘
                                                       │          │ persistent
                                                   LAN │          │ outbound WSS
                                                       │          ▼
                                        ┌──────────────┴───┐   ┌────────────────┐
                                        │    Mobile app    │──▶│ relay service  │
                                        │  Expo / RN (iOS) │   │ (GCE VM+Caddy, │
                                        └──────────┬───────┘   │  wss://…)      │
                                              auth │           └───────┬────────┘
                                                   ▼                   ▼
                                         Firebase (Auth, Firestore, Functions, GCS)
                                                   ▲
                                                   │ Stripe checkout/webhook → entitlements
                                        ┌──────────┴───────┐
                                        │  Account portal  │  apps/web-portal (Firebase Hosting)
                                        └──────────────────┘
```

Connections are client-initiated. The mobile app reaches `kanna-server`
directly over the LAN when it can (discovered, trusted desktops on the same
network) and through the relay when remote — the connection mode switches at
runtime, in every environment. It also talks to Firebase Auth directly to
sign in. The relay never dials the
desktop: `kanna-server` maintains a persistent outbound WebSocket to the relay
(reconnect loop with ping/pong keepalive in `crates/kanna-server/src/relay.rs`),
and the relay bridges remote clients onto that connection. Between the daemon
and `kanna-server`, commands flow server→daemon while events flow
daemon→server — the server issues a `Subscribe` command and then consumes the
daemon's event stream (`crates/kanna-server/src/terminal_watcher.rs`).

Agent-facing control surfaces (`kanna-cli`, `kanna-mcp`) talk to the same
`kanna-server` HTTP API rather than to the daemon or the DB directly.

## Components

### Desktop app — `apps/desktop/`

Tauri v2. The Vue 3 frontend (`src/`) renders the task sidebar, xterm.js
terminals, diff viewer, and modals; state lives in a single Pinia store
(`src/stores/kanna.ts`). The Rust backend (`src-tauri/`) exposes Tauri commands
(`src-tauri/src/commands/` — agent, daemon, git, fs, shell) and hosts the app
core (`src-tauri/src/lib.rs`): the daemon event bridge with auto-reconnect, the
reattach coordinator, daemon spawning, and macOS integrations. A browser mock
layer (`tauri-mock.ts` and friends) lets the frontend run in a plain browser
without Tauri.

There is deliberately no prose inventory of components, composables, stores, or
Tauri commands — the tree is the inventory, and a written copy goes stale.
Read `src/components/`, `src/composables/`, `src/stores/kanna.ts`, and
`src-tauri/src/commands/` directly.

### PTY daemon — `crates/daemon/`

A standalone process that owns every agent and shell PTY session, independent
of the app lifecycle, so sessions survive app restarts and upgrades. Raw libc
PTYs, line-delimited JSON over a Unix socket, and `SCM_RIGHTS` fd transfer for
seamless handoff from an old daemon to a new one. While detached, output is
interpreted into a per-session headless terminal that is authoritative for
reattach snapshots. Agent lifecycle hook events (`HookEvent`) flow through the
daemon and are forwarded to subscribers.

The full contract — invariants, startup/handoff sequence, session lifecycle —
is specified in [`crates/daemon/SPEC.md`](../../crates/daemon/SPEC.md). Read it
before touching daemon code.

### Local API server — `crates/kanna-server/`

The desktop-side service boundary for every non-desktop consumer (mobile app,
`kanna-cli`, `kanna-mcp`). Serves a versioned HTTP + WebSocket API on the LAN
(default `127.0.0.1:48120`), including `/v1/stream`, a multiplexed KSP
(Kanna Stream Protocol) WebSocket carrying terminal, agent, and task frames.

`kanna-server` **owns SQLite**: all schema definitions and migrations live in
`crates/kanna-server/src/db/mod.rs`, and server startup completes legacy
file relocation before opening the DB. The desktop frontend's `stores/db.ts` is
only a compatibility facade. It also subscribes to daemon events server-side —
task completion notification is a server/daemon concern, never a frontend one.

Boundary and route surface: [`docs/kanna-server-boundary.md`](../kanna-server-boundary.md).

### Agent control surfaces — `crates/kanna-cli/`, `crates/kanna-mcp/`, `crates/kanna-tool-catalog/`

Agents running inside task worktrees manage tasks through these:

- `kanna-mcp` — MCP server exposing `kanna_*` tools (create/get/list/search
  tasks, send input, complete stages, …) backed by the `kanna-server` API.
- `kanna-cli` — the shell fallback for the same operations
  (`kanna-cli stage-complete`, `kanna-cli task send-input`, `kanna-cli tool call …`).
- `kanna-tool-catalog` — the single declarative source of truth for the tool
  surface, shared by both. Tools are described as HTTP method/path/params
  manifests; `kanna-mcp` hot-reloads override catalogs and emits
  `tools/list_changed`.

Never read or write SQLite directly for orchestration — go through these.

### Agent protocol and SDK — `crates/kanna-agent-protocol/`, `crates/claude-agent-sdk/`

`kanna-agent-protocol` is the Rust source of truth for agent provider
definitions (`providers.rs` generates the `"claude"` / `"copilot"` / `"codex"`
/ `"opencode"` / `"antigravity"` registry) and for KSP frame types, from which
the TypeScript package `packages/agent-protocol` is generated.
`claude-agent-sdk` wraps the Claude CLI for headless (SDK-mode) sessions:
NDJSON streaming over stdin/stdout, permission callbacks, and the bidirectional
control protocol (interrupt, set model/permission mode, `CanUseTool`).

### Mobile app — `apps/mobile/` + `packages/stream-client/`

Expo / React Native iOS app, a first-class client. It has two data paths:

- **Desktop data** comes from `kanna-server` — plain `/v1/…` HTTP over the LAN
  when a trusted desktop is reachable, or `invoke` frames and KSP tunnels
  through the relay when remote. The two are raced per read (cloud read plus
  an optional 1 s LAN read), and every task is routed to its owning desktop
  (`ownerDesktopId`). While the app is foregrounded it keeps **one persistent
  authenticated relay control socket** (bounded-backoff reconnect, paused in
  the background) reused for desktop-presence refreshes and control invokes;
  per-desktop terminal/agent/task-summary streams ride separate KSP tunnels.
- **Cloud resting data** comes from Firebase directly: Auth for sign-in, and
  the Firestore cloud task index (`users/{uid}/desktops/{id}/tasks`) that
  `kanna-server` publishes through the relay. Live task-card snippets stream
  over a desktop-wide KSP `task_summary` subscription and overlay the resting
  Firestore rows; on disconnect the overlay falls back to the resting values.

Machines are merged from three sources — account desktops (Firestore),
manually QR/code-paired desktops (a LAN pairing claim carrying its own device
credential, independent of the account), and live LAN discovery. Task pins and
Activity dismissals are deliberately phone-local (AsyncStorage), never
published to the desktop.

`@kanna/stream-client` is the shared KSP WebSocket client (auth handshake,
per-task attachments with seq-resume, request/response correlation, reconnect)
used by both the mobile app and, increasingly, the desktop frontend. Native
identity (bundle id, display name) is keyed by `KANNA_APP_ENV`; OTA
compatibility is keyed by `runtimeVersion` in
`apps/mobile/src/mobileEnvironments.json` — see [Release](release.md#mobile-ota).
The user-facing surface is described in
[Product Behavior](product-behavior.md#mobile-app).

### Cloud services — `services/`, `apps/web-portal/`

- `services/relay/` — Node 22 / TypeScript WebSocket relay connecting remote
  mobile clients to a user's desktop `kanna-server`
  (`wss://relay.kanna.build` / `wss://relay-staging.kanna.build`). Each
  environment runs **one GCE e2-micro VM** behind Caddy TLS via docker
  compose; `./kd cloud deploy --relay` builds the image with Cloud Build,
  pushes to Artifact Registry, and the VM pulls it — the full runbook is
  [`docs/relay-vm-operations.md`](../relay-vm-operations.md), and the growth
  plan is [`docs/specs/relay-scaling.md`](../specs/relay-scaling.md). What
  moves over it:
  - The desktop side of each bridge is the persistent outbound connection
    described above. Over the control socket the relay forwards client
    invokes (HTTP-over-relay, including `/v1/task-events` long polls under a
    separate long-poll permit budget), mobile push notifications, and cloud
    task snapshot publication.
  - **Tunnels** carry the streaming protocols; exactly two tunnel service
    classes exist — `ksp` (the Kanna Stream Protocol, including raw terminal
    bytes) and `task-transfer` — each with its own backpressure watermarks.
  - It also serves mobile OTA manifests/assets from GCS (`/ota/manifest`,
    `/ota/assets`).
  - Operations surface: a per-connection **byte odometer** (application bytes
    per uid/desktop/message class: `tunnel`, `taskTransfer`, `terminalEvent`,
    `control`), exposed at `GET /stats` and a live `/dashboard`, read via
    `./kd relay stats` with the operator token from Secret Manager
    (`kanna-relay-stats-token`). `permessage-deflate` is negotiated per client
    (the mobile leg; the desktop's tokio-tungstenite client connects plain).
    Abuse bounds: `maxPayload` is 16 MiB, applied by `ws` to the
    **decompressed** frame size (which is what keeps compression safe
    pre-auth), derived as 2× the largest enforced legitimate frame — the
    8 MiB task-input body — and overridable per VM with
    `KANNA_RELAY_MAX_PAYLOAD_BYTES`; pre-auth per-IP admission caps bound
    unauthenticated connections and upgrade rate. Successful
    desktop-credential validations and
    entitlement reads are each cached for 60 s; a new desktop-credential
    connection always re-reads Firestore (so a revoked desktop cannot
    reconnect), while entitlement resolution at authentication may be served
    from the entitlement cache.
  - **Entitlement enforcement** exists behind `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT`,
    off in every environment until the billing flag day: when on, an
    unentitled session still authenticates but is refused tunnels,
    publication, and invokes with code 4402; a Firestore outage fails open.
    LAN is permanently unaffected.
  - A remote dev-server **preview** path over the relay is specified but not
    yet built — see [`docs/specs/remote-dev-preview.md`](../specs/remote-dev-preview.md).
- `apps/web-portal/` — the Vue 3 account portal (sign-in, email verification,
  subscribe via Stripe Checkout, entitlement status), deployed as the
  `account` Firebase Hosting target (`{project}-account` sites, mapped for all
  three projects in `.firebaserc` and guarded by a kd test). It is part of the
  default `./kd cloud deploy` payload.
- `services/firebase-functions/`, `firestore.rules`, `firebase.json` — Firebase
  Auth, Firestore (device pairing/auth records, the cloud task index, billing),
  and functions. Projects: `kanna-build` (production), `kanna-staging`
  (staging), `kanna-local` (emulators). Exactly two functions are deployed —
  the billing backend (`createCheckoutSession`, `stripeWebhook`). The webhook
  is the only writer of the `users/{uid}/billing/stripe` source doc and never
  writes the entitlement doc directly: a shared reducer derives the single
  `users/{uid}/entitlements/cloud_access` record from every source
  (stripe / app_store / comp) in the same transaction
  (`docs/specs/accounts-and-billing.md`). Comp/grandfather grants are seeded
  by `services/firebase-functions/scripts/grant-comp-access.mjs`
  (`docs/comp-access-runbook.md`).

Deploy only via `./kd cloud deploy` (with `--staging` or `--production`),
never the Firebase CLI directly; function deploys additionally require
`--functions`, so reviving them stays a deliberate act.

### Supporting crates and packages

| Path | Purpose |
|---|---|
| `crates/runtime-defaults/` | Shared constants: bundle ids, DB name, relay URLs, Firebase project ids, ports |
| `crates/task-transfer/` | Peer-to-peer desktop protocol (mDNS discovery via `_kanna-xfer._tcp`, crypto, peer registry): task transfer plus peer task snapshots and observing/sending input to peer sessions |
| `crates/tauri-plugin-delta-updater/` | Self-updater plugin (stub) |
| `packages/core/` | Shared TS business logic: workflow types/tags, repo config, custom tasks, GitHub/Slack/Discord clients |
| `packages/db/` | TS mirror of the SQLite schema plus a query layer over the `DbHandle` interface |
| `packages/terminal-recovery/` | Rust terminal snapshot/session-mirror service (staged at runtime via `scripts/stage-terminal-recovery-runtime.sh`) |
| `tools/kd/` | The `kd` development CLI and the `kd-mcp` server (task registry in `src/tasks/registry.ts`) |
| `tools/bazel/`, `BUILD.bazel`, `MODULE.bazel` | Bazel release build graph (see [Release](release.md)) |
| `tests/` | Cross-cutting suites: CLI contract, PTY test util, remote E2E, TUI fidelity |

Direct LAN terminal observation is duplex from task-transfer protocol v4: once
the authenticated observation stream is live, ordered input and resize controls
travel back over that same socket. Protocol v5 adds explicit producer-declared
submission and control semantics. Terminal input fails closed across a v4/v5
rolling upgrade because v4 cannot preserve those fields; current peers retain
read-only observation of protocol-v3 and older peers, but reject terminal input
there for the same reason.

## Core data flow

Task creation and terminal streaming, end to end:

1. User creates a task (⇧⌘N) → the frontend store calls `createDesktopTask`
   against the `kanna-server` HTTP API (`apps/desktop/src/stores/taskItemActions.ts`
   → `services/desktopServerClient`). **`kanna-server` owns creation**
   (`crates/kanna-server/src/task_creator/`): it writes the DB row, creates
   the worktree at `{repo}/.kanna-worktrees/task-{uuid}` on branch
   `task-{id}`, and runs the repo-config `setup` commands.
2. `kanna-server` then asks the daemon to `SpawnAgent` — the daemon forks the
   agent CLI in a PTY and starts the single per-session reader feeding the
   headless terminal.
3. Frontend `AttachSnapshot` hydrates xterm.js from the headless terminal, then
   streams live output; typed input goes back through `send_input` → PTY.
4. The daemon emits terminal-state events; `kanna-server`'s terminal watcher
   persists them as the task's `runtimeState` and derives the
   `activity`/read-state effects (a stopped, unviewed task shows `unread`).
   The user reviews the diff (⌘D) and advances the workflow (⌘S).
5. Stage transitions fork a fresh workspace (new branch + worktree cut from
   the task's **latest committed tip**, resolved across all of the task's
   workspace branches — see `crates/kanna-server/src/task_creator/work_tip.rs`)
   and respawn the session for the next stage's agent; only committed work
   crosses stage boundaries.

Workflow semantics are split across three places: task/workflow/workspace/post
definitions and close behavior are in [`AGENTS.md`](../../AGENTS.md) under
"Core concepts"; the stage-advance contract is under its "Common Pitfalls";
and the user-facing task flows, close steps, shortcuts, and the **revision
contracts** — provider-neutral session resume, the default budget of 5
agent-requested rounds (`0` = unlimited), exhausted-agent parking vs. the
human reset, and the committed task spec at `docs/task-specs/<task-id>.md`
that later stages review against — are in
[Product Behavior](product-behavior.md).

### Beyond the desktop: events, inputs, and the cloud path

The contracts below are specified in
[`docs/kanna-server-boundary.md`](../kanna-server-boundary.md); this is the map.

- **Task event feed.** Events are appended by the same DB calls that change
  the state they describe, inside the caller's transaction where there is one
  — the log stays consistent with `pipeline_item`/`stage_run` by construction
  rather than by call sites remembering to publish (not every task-state
  write emits an event; pinning, for example, does not).
  `GET /v1/task-events` is a cursor-based long poll over `task_event.seq`;
  16 event kinds exist today, covering task lifecycle, runs and stage
  changes, input delivery/blocking, awaiting-input and activity edges, merge
  signaling, teardown failures, and transfer finalization
  (`crates/kanna-server/src/db/task_events.rs`). Two of those kinds carry
  the agent-supervision contract and must not be conflated:
  - `task.awaiting_input` is a **positive** signal — the daemon matched
    prompt chrome the agent CLI actually rendered (`Waiting`). It is never
    inferred from a session merely going quiet.
  - `task.activity_changed` is the provider-neutral **settled** display
    transition, debounced server-side (`activity_event_debounce_seconds`,
    default 20 s): every activity direction emits once after the new value
    has held, for every provider, with no waiting-prompt placeholder
    required; a flicker inside the window emits nothing. The payload carries
    `previousActivity`, `activity`, the authoritative `runtimeState`, and
    `latestRunFinishedWithoutCompletion` — the parked-awaiting-advance
    signature — so a manager acts on the shared server verdict instead of
    running its own polling or debounce loop. It does not prove a question
    was asked; `task.awaiting_input` remains the question signal. (This
    server-side debounce is task `6b9fb72a` / PR #1164, which replaced the
    earlier `task.idle_sustained` design — no such event exists.)

  Cross-machine consumption is
  the **`ks1.` aggregated cursor**: when the caller is account-authorized and
  relay routing is up, the local server fans the wait out to sibling desktops
  as relay invokes, stamps every event with `machineId`, keeps one opaque
  native cursor per machine (no fabricated global order), and reports
  unreachable peers as `machineErrors` with `stale: true`. `kanna-mcp` keeps
  its own older `km1.` client-side fan-in for explicit multi-machine task-id
  sets. A task manager consumes the feed by looping `kanna_wait_events` with
  the returned cursor. The mobile app does **not** use
  this feed — its cross-machine view is the Firestore task index plus KSP
  task-summary streams.
- **Task input pipeline.** `POST /v1/tasks/{id}/input` (and the server's own
  completion notifications) write into the live PTY through the daemon. A
  success now means *submitted* — the daemon acknowledges only after the
  message bytes and the delayed Enter both landed. Deliveries the daemon
  accepts are appended to the durable `task_input` ledger with source
  (`operator`/`manager`/`notify`/`unspecified`), stage, and run. A human draft
  in the composer holds delivery (409 `input_held_by_draft`) — but only a
  draft with typed bytes: the daemon keeps a **composer attestation** ledger
  (`typed` / `not-typed` / `unknown`), task detail reports
  `composer: { text, attestation }`, and the task-logs tail labels the
  composer line instead of presenting it as session output.
- **Completion notify.** `kanna-server` subscribes to daemon terminal-state
  events directly (never through the desktop frontend) and delivers
  `TASK <child-id> DONE [success|failure|closed]: <title>` to the notify
  target — a closed three-word vocabulary derived from the completion trigger
  plus the terminating `stage_run`, never from the daemon `Exit` alone.
- **Cloud task publication.** `kanna-server` polls its own task snapshot
  every 500 ms, fingerprints the envelope, and publishes changes through the
  relay to Firestore (`users/{uid}/desktops/{id}/tasks`) under a
  session-generation/sequence fence. Publication is **diff-aware** end to
  end: an unchanged snapshot sends nothing, and the relay reconciles against
  a per-session index so a converged publish costs zero Firestore reads and
  writes. Continuously changing output snippets are kept off this path
  entirely — they stream over KSP `task_summary` frames while Firestore holds
  only the **resting** snippet, refreshed at boundaries: task close, a
  `working` → `idle`/`unread` transition, or a changed `transition_revision`
  (`crates/kanna-server/src/cloud_task_publisher.rs`).

## Source-of-truth boundaries

Worth internalizing — most architectural mistakes violate one of these:

- **SQLite schema/migrations** → `crates/kanna-server/src/db/mod.rs` only.
- **Agent provider registry** → generated from
  `crates/kanna-agent-protocol/src/providers.rs`.
- **Task-tool surface** (MCP + CLI) → `crates/kanna-tool-catalog`.
- **KSP frame types** → Rust in `kanna-agent-protocol`, generated into
  `packages/agent-protocol`.
- **Shared environment constants** → `crates/runtime-defaults`.
- **Built-in agent/workflow definitions** → `.kanna/` files bundled as Tauri
  resources, never TypeScript string constants.
- **Packaged app version** → the root `VERSION` file.
- **Completion notification** → server/daemon boundary, never the desktop
  frontend event bridge.

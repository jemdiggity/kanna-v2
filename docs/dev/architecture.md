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
                                        ┌──────────────┴───┐   ┌───────────────┐
                                        │    Mobile app    │──▶│ relay service │
                                        │  Expo / RN (iOS) │   │ (Cloud Run,   │
                                        └──────────┬───────┘   │  wss://…)     │
                                              auth │           └───────┬───────┘
                                                   ▼                   ▼
                                         Firebase (Auth, Firestore, Functions, GCS)
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

Expo / React Native iOS app. It talks only to `kanna-server` — directly over
the LAN when the desktop is reachable, or through the relay when remote.
`@kanna/stream-client`
is the shared KSP WebSocket client (auth handshake, per-task attachments with
seq-resume, request/response correlation, reconnect) used by both the mobile
app and, increasingly, the desktop frontend. Native identity (bundle id,
display name) is keyed by `KANNA_APP_ENV`; OTA compatibility is keyed by
`runtimeVersion` in `apps/mobile/src/mobileEnvironments.json` — see
[Release](release.md#mobile-ota).

### Cloud services — `services/`

- `services/relay/` — Bun/TypeScript WebSocket relay (deployed to Cloud Run,
  `wss://relay.kanna.build` / `wss://relay-staging.kanna.build`) connecting
  remote mobile clients to a user's desktop `kanna-server`. The desktop side of
  each bridge is the persistent outbound connection described above; over it
  the relay forwards client invokes and tunnel requests, and `kanna-server`
  publishes cloud task snapshots. The relay also serves mobile OTA
  manifests/assets from GCS.
- `services/firebase-functions/`, `firestore.rules`, `firebase.json` — Firebase
  Auth, Firestore (device pairing/auth records), and functions. Projects:
  `kanna-build` (production), `kanna-staging` (staging), `kanna-local`
  (emulators). The deployed functions are the billing backend
  (`createCheckoutSession`, `stripeWebhook`); the Stripe webhook writes only
  `users/{uid}/billing/stripe`, and a shared reducer derives the single
  `users/{uid}/entitlements/cloud_access` record from every source
  (`docs/specs/accounts-and-billing.md`).

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

1. User creates a task (⇧⌘N) → worktree at `{repo}/.kanna-worktrees/task-{uuid}`,
   branch `task-{id}`, DB row, repo-config `setup` commands run.
2. App asks the daemon to `Spawn` — the daemon forks the agent CLI in a PTY and
   starts the single per-session reader feeding the headless terminal.
3. Frontend `AttachSnapshot` hydrates xterm.js from the headless terminal, then
   streams live output; typed input goes back through `send_input` → PTY.
4. Agent finishes → hook/idle detection marks the task `unread`; the user
   reviews the diff (⌘D) and advances the workflow (⌘S).
5. Stage transitions fork a fresh workspace (new branch + worktree from the
   committed tip) and respawn the session for the next stage's agent; only
   committed work crosses stage boundaries.

Workflow semantics are split across three places: task/workflow/workspace/post
definitions and close behavior are in [`AGENTS.md`](../../AGENTS.md) under
"Core concepts"; the stage-advance, revision-budget, and revision-resume
contracts are under its "Common Pitfalls"; and the user-facing task flows,
close steps, and shortcuts are in
[Product Behavior](product-behavior.md).

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

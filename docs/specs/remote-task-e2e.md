# Spec: Remote Task Interaction E2E Testing (v2)

Status: active (v2 — resurrected 2026-07-09; v1 harness, flows 7–10, Layer A,
kd wiring, and CI are landed on main)
Owner: cloud / e2e
Scope: end-to-end coverage of **remote task interaction** across the mobile
app, the cloud relay, the **LAN transport**, and the desktop, in both **dev**
and **staging** environments.

## 1. Motivation

Kanna's remote access has two transports that must both work and agree:

```
                    ┌── cloud path ──────────────────────────────┐
mobile / remote client                                            │
   │  Firebase id_token (phone) / desktop_id+desktop_secret or   │
   │  device_token (desktop)                                     ▼
   ├─► relay (wss://relay-*.kanna.build | ws://127.0.0.1:<port> dev)
   │       routes invoke/observe/response/event/tunnel by userId+desktopId
   │                                                             │
   └── LAN path ── HTTP + WS direct to kanna-server LAN API ─────┤
                   (Bonjour-advertised, /v1/*,                   ▼
                    /v1/tasks/{id}/terminal WS)      kanna-server (desktop, Rust)
                                                          │  Unix socket
                                                       daemon ──► agent PTY task
```

This loop crosses every system boundary Kanna has. Per `CLAUDE.md`, behavior
that crosses component or system boundaries must have E2E coverage.

### Landed (v1, on main)

- **Remote-loop harness** `tests/remote-e2e/` — boots Firebase emulators +
  local relay + real worktree `kanna-server` + real daemon + a
  mobile-equivalent relay client wrapping
  `apps/mobile/src/lib/transports/relayClient.ts`. Per-run isolation
  (ports/DB/daemon dir). API: `startRemoteHarness(opts)` →
  `{ client, desktopId, paths, ports, stop() }`.
- **Smoke** — real emulator auth as Buffy + relay `GET /v1/status` round-trip.
  No `SKIP_AUTH`.
- **Flows 7–10** (`terminal-flow.e2e.test.ts`) — observe_session
  snapshot→output→exit + unobserve; remote input to the PTY; completion-notify
  once-only guard; invoke + observation recovery across relay reconnect.
- **Layer A** (`services/relay/test/integration.test.ts`) — real
  emulator-backed auth (device_token, desktop_id+desktop_secret, id_token,
  reject-bad-creds), multi-desktop and multi-user routing isolation, tunnel
  pairing/splicing, terminal-event observer routing, offline drops, event
  ordering, disconnect cleanup + reconnect resume, auth timeout.
- **kd wiring** — `kd test remote-e2e [--dev|--staging]`, `kd doctor
  --remote`, `kd dev up --remote`; staging-relay active-desktop verification
  helpers in `tools/kd`.
- **CI** — `.github/workflows/remote-e2e.yml` (Layer A + Layer B dev).
- **E2E SQL route** — `KANNA_E2E_TEST_SQL=1`, loopback-only route in
  `kanna-server` for DB assertions from tests (with 404/403 regression
  coverage).

### Remaining (v2 scope)

1. Flows 1–3 (cloud pairing, auth matrix, discovery/presence) over the full
   stack.
2. Flows 4–6 (listing, creation, task actions) over the relay — against the
   **current stage-graph semantics** (durable task ids, `task-{id}-{n}`
   workspace forking, `complete-stage` auto-advance, `request-revision`
   children, close snapshots WIP and removes worktrees but keeps branches).
3. **LAN transport parity** — the same interaction loop over the LAN API
   (new Layer E), plus LAN↔relay `connectionMode` semantics.
4. Staging headless smoke (currently an intentional throw in
   `tests/remote-e2e/src/run.ts`).
5. Layer C (mobile Appium over the relay) and Layer D (desktop pairing UI).

## 2. Environments

| Env | Firebase | Relay | Desktop server | Identity | Automation |
|-----|----------|-------|----------------|----------|------------|
| **dev** | emulators (auth/firestore/functions), emulator-seed | local relay from `services/relay` on a harness port | worktree `kanna-server`, generated `server.toml` | emulator Buffy (`upvote.sieve.7t@icloud.com` / `password123`, uid `Bax9TJvOWm5bbl0Aq4nXg3XmkTCu`) | full, headless, CI |
| **staging** | `kanna-staging` | `wss://relay-staging.kanna.build` | worktree `kanna-server` with `KANNA_CLOUD_ENV=staging` | staging Buffy + `KANNA_E2E_DEVICE_TOKEN=staging-buffy-device-token` (provisioned via `provision-staging-buffy-user.mjs`) | headless smoke automatable when creds present; full mobile-UI run human-gated on a physical iPhone |

Reuse existing config surfaces only: `server.toml` (`relay_url`,
`desktop_id`, `desktop_secret`, `device_token`, `lan_host`/`lan_port`,
`pairing_store_path`, emulator overrides), `.kanna/config.json` ports,
`mobileEnvironments.json`. No parallel config systems.

## 3. Flows

Status key: ✅ landed · ⬜ v2 scope.

1. ⬜ **Cloud pairing** — desktop calls `createPairingCode` (functions
   emulator) → `pairingCode`/`desktopId`/`desktopSecret`/`desktopClaimToken`
   issued and `pairingCodes/{id}` + `pendingDesktops/{desktopId}` written;
   phone claims the code; desktop appears under `users/{uid}/desktops`;
   desktop persists `DesktopIdentity` and re-authenticates to the relay with
   `desktop_id`+`desktop_secret` (`create_cloud_pairing_session` path in
   `crates/kanna-server/src/pairing.rs`).
2. ⬜ **Auth matrix (full stack)** — desktop via `device_token` AND via
   `desktop_id`+`desktop_secret`; phone via Firebase `id_token`; bad/revoked
   creds rejected — asserted through the running kanna-server↔relay stack
   (Layer A already covers relay-only).
3. ⬜ **Discovery/presence** — phone lists desktops (`GET /v1/desktops` and
   the relay desktops listing) and observes `online`/`connectionMode`
   (`lan`/`internet`/`both`) flip as kanna-server connects/disconnects.
4. ⬜ **Task listing** — `GET /v1/repos`, `/v1/repos/{id}/tasks`,
   `/v1/tasks/recent`, `/v1/tasks/search?query=` over the relay return the
   desktop's real seeded DB data.
5. ⬜ **Task creation** — `POST /v1/tasks` over the relay creates worktree +
   `pipeline_item` + prepared spawn; visible in subsequent listings.
6. ⬜ **Task actions** — over the relay: `advance-stage` (Spawn-new-workspace
   vs Continue), `complete-stage` (`success` auto-advances / `failure`
   retains), `request-revision` (creates child task, failure recorded on
   source), `run-merge-agent`, `close` (WIP snapshot, worktrees removed,
   branches kept, `closed_at` set). Assert DB truth via the E2E SQL route.
7. ✅ **Terminal streaming** (relay observe_session).
8. ✅ **Remote input**.
9. ✅ **Completion notify** (once-only, remote observer sees session_exit).
10. ✅ **Resilience** (relay reconnect: invokes + active observation recover).
11. ⬜ **LAN transport loop** — the `lanTransport.ts` path against the
    kanna-server LAN API directly: `GET /v1/desktops`
    (`connectionMode: "local"`), local pairing session
    (`POST /v1/pairing/sessions` → code + LAN host/port + expiry), listings,
    terminal streaming over `GET /v1/tasks/{id}/terminal` (WS:
    ready→output→exit), input. Parity: the same task observed over LAN and
    relay yields consistent state.

## 4. Test architecture (layers)

- **A — Relay protocol** (`services/relay/test/`): ✅ landed; extend only
  when the protocol changes.
- **B — Remote-loop harness** (`tests/remote-e2e/`): ✅ harness landed; v2
  adds flow specs 1–6 as new `*.e2e.test.ts` files against
  `startRemoteHarness()`. Keep harness edits minimal and additive — several
  tasks build on it concurrently.
- **C — Mobile Appium over relay** (`apps/mobile/e2e/`): ⬜ drive the real
  mobile UI through the relay transport (not LAN) against the Layer B dev
  stack: pair → list → open task → observe streaming → send input. Simulator
  automated; physical device human-gated.
- **D — Desktop pairing UI** (`apps/desktop/tests/e2e/`): ⬜ WebDriver test
  driving the pairing UI; desktop registers with the local relay and reports
  paired/online.
- **E — LAN transport** (in `tests/remote-e2e/`, LAN client instead of relay
  client): ⬜ flow 11. Bonjour/mDNS discovery is asserted only if it can be
  made deterministic headless; otherwise document the gap and assert from the
  advertised host/port config directly.

## 5. Staging strategy

- **Headless smoke (automatable)**: replace the intentional gate in
  `tests/remote-e2e/src/run.ts` — relay client + worktree `kanna-server`
  pointed at staging, Buffy auth via `KANNA_E2E_DEVICE_TOKEN`; assert auth +
  one invoke round-trip + one observe round-trip. Skip cleanly with a clear
  message when creds are absent. Reuse the staging-relay verification
  helpers already in `tools/kd`.
- **Human-gated**: full mobile-UI staging run on a physical iPhone via
  `./kd mobile run --device --staging` with a reproducible runbook (Local
  Network permission, symptom→cause map). Never physical-device Appium from
  automation.

## 6. kd + CI

All entry points stay on the canonical `kd` surface: `kd test remote-e2e
[--dev|--staging]`, `kd doctor --remote [--staging]`, `kd dev up --remote`.
New flow specs join the existing `remote-e2e.yml` CI lane; Layer C simulator
runs where macOS CI allows, else nightly; staging smoke runs on a schedule
with secrets, never per-PR.

## 7. Acceptance criteria (v2)

- Flows 1–6 and 11 green under `kd test remote-e2e` in dev.
- Task-action assertions match the stage-graph model (durable ids,
  `task-{id}-{n}` workspaces, auto-advance, revision children, close
  semantics) — not the legacy one-task-per-stage model.
- LAN and relay paths assert consistent task state for the same desktop.
- Staging smoke passes with creds, skips cleanly without; physical-device
  runbook documented.
- No `SKIP_AUTH` in auth assertions; fallbacks documented as fallbacks.

## 8. Work breakdown (v2 — codex, PTY mode, parallel)

All tasks can start immediately (the harness is on main). Harness edits must
be additive to minimize cross-task conflicts; merges are sequenced by review.

1. **Cloud pairing + auth matrix + discovery** — flows 1–3 (Layer B).
2. **Listing + creation + task actions** — flows 4–6 (Layer B, stage-graph
   semantics, E2E SQL assertions).
3. **LAN transport loop + parity** — flow 11 (Layer E).
4. **Staging headless smoke + doctor** — §5 automatable half.
5. **Mobile Appium over relay + desktop pairing UI + physical runbook** —
   Layers C + D + §5 human-gated half.

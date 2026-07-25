# Spec: Remote Task Interaction E2E Testing (v2)

Status: implemented (v2 — dev flows 1–11 and Layers A–E are landed; staging
headless smoke is implemented and credential-gated; physical-device checks
remain human-gated)
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

### Landed (v2)

1. Flows 1–3 (cloud credential publication, auth matrix, and
   discovery/presence) are covered by
   `cloud-pairing-auth-discovery.e2e.test.ts`.
2. Flows 4–6 (listing, creation, and task actions) are covered by
   `task-listing-actions.e2e.test.ts` against the current stage-graph
   semantics.
3. Flow 11 and LAN↔relay task-state parity are covered by
   `lan-layer.e2e.test.ts`.
4. Staging headless smoke is implemented in
   `staging-smoke.e2e.test.ts`; the runner selects it for `--staging` and
   skips cleanly when credentials are absent.
5. Layer C and Layer D have optional `--mobile-relay` and
   `--desktop-pairing` runner entry points. Physical-device execution
   remains human-gated.

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

Status key: ✅ landed.

1. ✅ **Cloud credential provisioning** — the `createPairingCode` Cloud
   Function bootstrap is retired and must not be redeployed (see
   `docs/2026-06-12-relay-desktop-credential-bootstrap.md`; Kanna deploys no
   Cloud Functions). The current flow: desktop persists
   `desktop_id`+`desktop_secret` in `desktop-identity.json`/`server.toml`;
   the signed-in desktop credential bootstrap upserts the SHA-256
   `desktopSecretHash` onto `desktopCredentials/{desktopId}` per `firestore.rules` (the
   plain secret never enters Firestore); the relay verifies the presented
   secret against the hash (timing-safe). E2E: provision the doc the way the
   bootstrap does (as signed-in Buffy), assert relay auth succeeds with the
   right secret and rejects a wrong secret and a `revokedAt` doc. Pairing
   codes grant LAN/local trust rather than cloud credentials; an authenticated
   relay client may request their creation through `create_pairing_session`.
2. ✅ **Auth matrix (full stack)** — desktop via `device_token` AND via
   `desktop_id`+`desktop_secret`; phone via Firebase `id_token`; bad/revoked
   creds rejected — asserted through the running kanna-server↔relay stack
   (Layer A already covers relay-only).
3. ✅ **Discovery/presence** — phone lists desktops through
   `GET /v1/desktops`, verifies `connectionMode: "both"` while LAN and
   relay are available, and observes the relay's active-desktop listing remove
   and restore the desktop as kanna-server disconnects and reconnects.
4. ✅ **Task listing** — `GET /v1/repos`, `/v1/repos/{id}/tasks`,
   `/v1/tasks/recent`, `/v1/tasks/search?query=` over the relay return the
   desktop's real seeded DB data.
5. ✅ **Task creation** — `POST /v1/tasks` over the relay creates worktree +
   `pipeline_item` + prepared spawn; visible in subsequent listings.
6. ✅ **Task actions** — over the relay: `advance-stage` (forks the next
   stage's workspace and branch), `complete-stage` (`success` auto-advances
   / `failure` retains), `request-revision` (records the current run as
   failed and transitions the same durable task to the target stage with
   feedback and a new workspace), `run-merge-agent`, `close` (WIP snapshot,
   worktrees removed, branches kept, `closed_at` set). Assert DB truth via
   the E2E SQL route.
7. ✅ **Terminal streaming** (relay observe_session).
8. ✅ **Remote input**.
9. ✅ **Completion notify** (once-only, remote observer sees session_exit).
10. ✅ **Resilience** (relay reconnect: invokes + active observation recover).
11. ✅ **LAN transport loop** — the `lanTransport.ts` path against the
    kanna-server LAN API directly: `GET /v1/desktops`
    (`connectionMode: "both"` when LAN and relay are both available),
    local pairing session
    (`POST /v1/pairing/sessions` → code + LAN host/port + expiry), listings,
    terminal streaming over `GET /v1/tasks/{id}/terminal` (WS:
    ready→output→exit), input. Parity: the same task observed over LAN and
    relay yields consistent state.
12. ⏳ **Desktop remote terminal file links** — the desktop
    `CloudTerminalView` linkifies file paths in a remote task's agent
    terminal, verifies and fetches them through
    `GET /v1/tasks/{id}/files/content` (relay tunnel) or the transfer
    sidecar's `read_task_file` peer request (LAN), and previews the fetched
    content. The **remaining gap is the transport leg only**: no harness can
    yet serve the file from a genuine second desktop, because the desktop
    WebDriver harness runs a single desktop instance and the Layer B harness
    drives a mobile-equivalent client rather than the desktop webview. Closing
    it needs the desktop-under-test to see a relay- or LAN-visible task owned
    by a second stack (Layer B exposing its desktop to a WebDriver desktop, or
    a two-desktop LAN pairing harness). Everything downstream of the fetch is
    covered:
    - `mock/terminal-file-links.test.ts` drives the real app: a remote
      `file-link-activate` payload renders its `remoteContent` for a path that
      exists in no local worktree, with no `read_text_file` invoke and no
      Open-in-IDE action.
    - `FilePreviewModal.test.ts` pins the same contract at component level
      (remote snapshot rendered, local read never issued, Open-in-IDE hidden,
      Open-in-IDE still present for local previews).
    - `remoteTerminalFileLinks.test.ts` covers link detection, cmd+click
      activation, in-flight read sharing, and retry after a missing file or a
      failed transport.
    - `desktopRelayTerminal.test.ts` / `desktopLanTerminal.test.ts` cover the
      transport clients, the two-peer transfer runtime integration test
      (`trusted_peer_read_task_file_fetches_from_owner_kanna_server`) covers
      the LAN peer fetch, and the kanna-server task-file route auth tests
      cover access (loopback desktop allowed, unauthenticated tunnel denied).

## 4. Test architecture (layers)

- **A — Relay protocol** (`services/relay/test/`): ✅ landed; extend only
  when the protocol changes.
- **B — Remote-loop harness** (`tests/remote-e2e/`): ✅ landed; the dev
  runner executes flows 1–11 as focused `*.e2e.test.ts` files against
  `startRemoteHarness()`.
- **C — Mobile Appium over relay** (`apps/mobile/e2e/`): ✅ optional
  `--mobile-relay` runner lane drives the real mobile UI through the relay
  transport (not LAN) against the Layer B dev stack. Physical-device
  execution remains human-gated.
- **D — Desktop pairing UI** (`apps/desktop/tests/e2e/`): ✅ optional
  `--desktop-pairing` runner lane delegates to the desktop WebDriver runner,
  which starts its own isolated Firebase emulator and relay stack.
- **E — LAN transport** (in `tests/remote-e2e/`, LAN client instead of relay
  client): ✅ flow 11 covers the configured host/port path and LAN↔relay
  parity. Bonjour/mDNS discovery remains outside the deterministic headless
  assertion surface.

## 5. Staging strategy

- **Headless smoke (automatable)**: `tests/remote-e2e/src/run.ts --staging`
  checks for the required staging Buffy credentials in the environment,
  skips cleanly with a clear message when they are absent, and otherwise runs
  `staging-smoke.e2e.test.ts` against the staging relay with a worktree
  `kanna-server`. The smoke asserts authenticated status invocation and
  terminal observation.
- **Human-gated**: full mobile-UI staging run on a physical iPhone via
  `./kd mobile run --device --staging` with a reproducible runbook (Local
  Network permission, symptom→cause map). Never physical-device Appium from
  automation.

## 6. kd + CI

All entry points stay on the canonical `kd` surface: `kd test remote-e2e
[--dev|--staging]`, `kd doctor --remote [--staging]`, `kd dev up --remote`.
The path-filtered pull-request workflow runs dev Layer A and Layer B. The
staging smoke runs on the scheduled and manually dispatched workflow when
credentials are available. Layer C and Layer D remain optional runner lanes,
not normal pull-request CI; physical-device execution remains human-gated.

## 7. Acceptance criteria (v2)

- Flows 1–6 and 11 green under `kd test remote-e2e` in dev.
- Task-action assertions match the stage-graph model (durable ids,
  `task-{id}-{n}` workspaces, auto-advance, same-task revision runs, close
  semantics) — not the legacy one-task-per-stage model.
- LAN and relay paths assert consistent task state for the same desktop.
- Staging smoke passes with creds, skips cleanly without; physical-device
  runbook documented.
- No `SKIP_AUTH` in auth assertions; fallbacks documented as fallbacks.

## 8. Delivered work breakdown (v2)

1. ✅ **Cloud pairing + auth matrix + discovery** — flows 1–3 (Layer B).
2. ✅ **Listing + creation + task actions** — flows 4–6 (Layer B, stage-graph
   semantics, E2E SQL assertions).
3. ✅ **LAN transport loop + parity** — flow 11 (Layer E).
4. ✅ **Staging headless smoke + doctor** — §5 automatable half.
5. ✅ **Mobile Appium over relay + desktop pairing UI + physical runbook** —
   Layers C + D plus the §5 human-gated physical-device runbook.

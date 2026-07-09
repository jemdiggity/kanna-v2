# Remote Task Interaction E2E Testing

## Motivation

Kanna's remote task loop crosses every major runtime boundary: mobile or remote client, relay, desktop `kanna-server`, local daemon, and the agent PTY task. Unit tests cover pieces of this path, but regressions can still hide in authentication, routing, config propagation, HTTP invoke translation, terminal streaming, input delivery, and reconnect behavior. The remote loop needs layered E2E coverage that is reliable in local development and CI, with a clear path to staging and human-gated physical device checks.

## Goals

- Prove the remote task loop end to end with real relay authentication, real desktop server routing, and real daemon-backed task IO.
- Reuse the production mobile relay client instead of reimplementing relay protocol messages in tests.
- Reuse kd's Firebase emulator, seed, port, and workspace isolation machinery.
- Keep the harness headless, deterministic, and suitable for CI.
- Define stable Layer A through Layer D test responsibilities so follow-up tasks can build on a shared foundation.
- Support dev and staging selection from canonical kd commands.

## Non-Goals

- Do not replace unit tests for relay, server, daemon, or mobile transport internals.
- Do not require production Firebase, production relay, or a physical device for PR CI.
- Do not fake the relay boundary in Layer B.
- Do not make physical iPhone Appium runs part of unattended agent automation.

## Environment Matrix

| Environment | Firebase | Relay | Desktop Server | Daemon | Mobile Client | Purpose |
|---|---|---|---|---|---|---|
| Dev | Local emulators seeded from `services/firebase/emulator-seed/` | Local `services/relay` with real auth | Worktree-built `kanna-server` with generated `server.toml` | Isolated real daemon | Node wrapper around `apps/mobile/src/lib/transports/relayClient.ts` | CI and local headless Layer B |
| Staging | `kanna-staging` | `wss://relay-staging.kanna.build` | Worktree desktop/server configured for staging | Isolated real daemon | Mobile dev build or Node relay client | Headless smoke plus human-gated device runbook |
| Production | Production Firebase | Production relay | Installed `/Applications/Kanna.app` server | Production daemon | Installed mobile app | Manual release validation only |

## Remote Loop

The canonical loop is:

```text
mobile/remote client -> relay -> kanna-server (desktop) -> daemon -> agent PTY task
```

Layer B must exercise that loop through real process boundaries. A fake daemon is acceptable only when a deterministic real PTY task cannot be made reliable for a specific assertion. Any fake daemon use must be documented as a temporary fallback, not the intended steady state.

## Flows

### 1. Pairing

Desktop creates a pairing session through `POST /v1/pairing/sessions`. The mobile side claims the pairing code through Firebase-backed cloud functions. The desktop receives or stores credentials that let the relay associate the desktop with the authenticated user and `desktopId`.

Assertions:

- Pairing sessions expire.
- Pairing codes are not accepted twice.
- Desktop identity and display name survive server restart.
- Invalid claims do not create trusted desktop credentials.

### 2. Auth

Phone/mobile clients authenticate to the relay with a Firebase ID token. Desktop servers authenticate with either a legacy `device_token` or `desktop_id` plus `desktop_secret`. Relay routing is keyed by `userId + desktopId`.

Assertions:

- Buffy emulator credentials produce a valid ID token.
- `SKIP_AUTH` is not used in Layer B.
- The relay rejects invalid phone tokens, device tokens, and desktop secrets.
- A desktop cannot receive invokes for another user's route.

### 3. Discovery

The remote client discovers available desktops and sees online/offline status based on relay/server presence and desktop registry data.

Assertions:

- A connected desktop appears with its configured name and `desktopId`.
- Offline desktops are visible where product behavior requires it, but actions fail clearly.
- Multiple desktops under one user route independently.

### 4. Listing

The remote client lists repos and tasks through relay HTTP invokes to `kanna-server`.

Assertions:

- `GET /v1/status` returns the desktop identity.
- `GET /v1/repos`, `GET /v1/repos/{id}/tasks`, `GET /v1/tasks/recent`, and `GET /v1/tasks/search` preserve server response shape.
- Closed tasks remain hidden from normal active lists.

### 5. Creation

The remote client creates a task through `POST /v1/tasks`. The desktop server creates the DB records, worktree, daemon session, and agent PTY task.

Assertions:

- Created tasks are visible in remote lists.
- Worktree and terminal session records point at isolated harness paths.
- A deterministic scripted PTY task can be used for stable CI.

### 6. Actions

Remote actions flow through `/v1/tasks/{id}/actions/*`.

Assertions:

- Close, advance stage, complete stage, request revision, and merge/PR action routes return expected success or failure.
- Invalid task IDs return 404-like errors through the relay response shape.
- Action side effects are visible in subsequent task detail/list responses.

### 7. Streaming

Terminal streaming uses daemon observe/attach behavior through `kanna-server` and relay events or KSP relay tunnel messages.

Assertions:

- Initial terminal snapshot arrives before live output.
- Live output is base64-preserved and not UTF-8 redecoded across chunk boundaries.
- Session exit is delivered exactly once per observer.
- Re-observing after a disconnect resumes from the correct state.

### 8. Input

Remote task input flows from the client through relay and `kanna-server` to daemon `Input`.

Assertions:

- Input sent through `/v1/tasks/{id}/input` reaches the PTY.
- Newline handling matches `kanna-cli task send-input`.
- Input after session exit returns a clear error.

### 9. Completion Notify

Task completion notifications propagate from daemon/server state to remote clients.

Assertions:

- Successful scripted task exit updates task activity or completion state.
- Failed scripted task exit is distinguishable from success.
- Follow-up tasks that depend on `notify_task_id` can observe notification state.

### 10. Resilience

The remote loop survives expected restarts and transient network loss.

Assertions:

- Relay reconnect does not duplicate observers.
- Desktop server restart re-registers the route.
- Daemon restart preserves recoverable PTY state where daemon recovery supports it.
- Mobile relay token refresh handles auth rejection without silent data loss.

## Layered Test Architecture

### Layer A: Relay Protocol

Scope: `services/relay`.

Layer A tests the relay protocol directly with WebSocket clients. It may use local Firebase emulators and targeted protocol clients. It must cover authentication, routing, multi-desktop isolation, tunnel establishment, and error responses.

Existing entry point:

```bash
pnpm --dir services/relay test
```

### Layer B: Remote-Loop Harness

Scope: `tests/remote-e2e`.

Layer B starts one isolated process tree:

- Firebase emulators with the Kanna emulator seed.
- Local relay built from `services/relay`.
- Worktree-built `kanna-server` with generated `server.toml`.
- Isolated real daemon.
- Mobile-equivalent Node client wrapping `apps/mobile/src/lib/transports/relayClient.ts`.

Programmatic API:

```ts
const harness = await startRemoteHarness();
try {
  const status = await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "GET",
    path: "/v1/status",
    body: null
  });
} finally {
  await harness.stop();
}
```

Canonical command:

```bash
./kd test remote-e2e
```

### Layer C: Mobile Appium Over Relay

Scope: `apps/mobile/e2e`.

Layer C runs the real mobile app UI against the relay-backed desktop loop. CI may run simulator smoke tests. Physical iPhone runs are human-gated after merge or before release.

### Layer D: Desktop Pairing UI

Scope: desktop UI and Tauri commands.

Layer D verifies the user-facing pairing flow, status display, and preference surfaces. It should not duplicate Layer B transport assertions.

## Staging Strategy

Staging has two lanes:

- Automatable headless smoke: use staging Firebase/relay credentials with the Node mobile-equivalent client and a worktree desktop server.
- Human-gated physical device runbook: use `./kd mobile run --device --staging` for Metro/dev-client checks, or `./kd mobile run --device --staging --install` to install the bundled staging Release app without Metro/hot loading, after staging Buffy data has been provisioned by a human with staging credentials.

The committed staging Buffy identity is:

- Email: `upvote.sieve.7t@icloud.com`
- Password: `password123`
- UID: `Bax9TJvOWm5bbl0Aq4nXg3XmkTCu`
- Device token: `staging-buffy-device-token`

Agents must not run physical-device Appium or install/launch attached devices automatically.

## kd Integration

Canonical commands:

```bash
./kd test remote-e2e
./kd test remote-e2e --mobile-relay
./kd test remote-e2e --desktop-pairing
./kd test remote-e2e --dev
./kd test remote-e2e --staging
./kd dev up --remote
./kd doctor --remote
./kd doctor --remote --staging
```

`./kd dev up --remote` composes the existing emulator path and local relay with the desktop dev stack for manual poking. `./kd test remote-e2e` runs Layer B. `./kd doctor --remote` checks local prerequisites, emulator port availability/reachability, relay port availability, relay buildability, server buildability, and staging credential presence when `--staging` is supplied.

`./kd test remote-e2e --mobile-relay` runs Layer C against an iOS simulator and the local relay-backed harness. `./kd test remote-e2e --desktop-pairing` runs Layer D against the debug desktop WebDriver build. These lanes are explicit because they require simulator/Appium or desktop WebDriver infrastructure.

Where `kd-mcp` mirrors kd tasks, it must expose matching tools for remote E2E and remote doctor checks.

## CI Lanes

PR CI must run:

- Layer A relay protocol tests.
- Layer B dev smoke tests.

These lanes are required for PRs touching:

- `services/relay/**`
- `crates/kanna-server/**`
- `services/firebase-functions/**`
- `apps/mobile/src/lib/**`
- `tests/remote-e2e/**`

Layer C and staging physical-device checks are not required for normal PR CI.

## Acceptance Criteria

- `docs/specs/remote-task-e2e.md` is the canonical spec for tasks 2-6.
- `tests/remote-e2e` exposes `startRemoteHarness(opts)` returning `{ client, desktopId, stop() }`.
- The Layer B smoke authenticates through real Firebase emulator auth as Buffy and invokes `GET /v1/status` through the relay without `SKIP_AUTH`.
- The harness uses per-run isolated ports, SQLite DB, daemon dir, and generated server config.
- The harness starts a real daemon. Any fake daemon use is explicitly documented as a temporary fallback.
- `kd test remote-e2e`, `kd dev up --remote`, and `kd doctor --remote` are the canonical command surfaces.
- `kd-mcp` exposes matching remote E2E tools where the kd surface is mirrored.
- CI runs Layer A and Layer B dev lanes for relevant path changes.

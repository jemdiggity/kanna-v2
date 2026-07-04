# Desktop → kanna-server Migration Plan

Status: proposed (scoping doc, no implementation yet)
Related: [kanna-server-boundary.md](kanna-server-boundary.md)

## Problem

The desktop frontend is a hybrid client. Stage transitions go through
kanna-server (`POST /v1/tasks/{id}/actions/advance-stage|rerun-stage`,
`apps/desktop/src/stores/pipeline.ts`), but every other read and write still
goes directly to SQLite via `tauri-plugin-sql`. kanna-server writes the same
`kanna-v2.db` through rusqlite. That leaves:

- **Two independent writers** on the same rows, coordinated only by WAL +
  `busy_timeout`. Read-modify-write sequences race (the frontend writes
  `activity`/`closed_at`/ports while the server mutates `stage`/`branch`
  during transitions). The `SQLITE_IOERR_SHORT_READ` checkpoint workaround in
  `apps/desktop/src/stores/db.ts:69-77` is scar tissue from this design.
- **Duplicated lifecycle logic** in two languages: task close
  (`stores/init.ts` vs `http_api/task_actions.rs::close_task`), blocker cycle
  detection (`packages/db/src/queries.ts::hasCircularDependency` vs
  `crates/kanna-server/src/db/blockers.rs` DFS), port claiming, unblock
  sweeps. Every rule must be fixed twice; nothing forces the copies to agree.
- **Inverted schema ownership**: the TS frontend owns `runMigrations()`, but
  the Rust server hard-codes SQL against that schema, so the server can only
  run after a matching-version frontend has migrated the DB.

Target end state: the desktop frontend is a kanna-server client like mobile,
kanna-cli, and kanna-mcp. One writer (kanna-server) owns task/repo state and
the schema. The frontend holds no SQLite connection.

## What already exists (leverage, don't rebuild)

- REST surface (`crates/kanna-server/src/http_api/router.rs`): create task,
  get/patch task, recent/search, repo list/add, repo tasks, input, logs,
  block/unblock, advance/rerun/complete-stage, request-revision, set-parent,
  close, run-merge-agent, signal-agent.
- KSP WebSocket (`crates/kanna-agent-protocol/src/frames.rs`): auth with a
  localhost-no-credential mode, per-task agent/terminal attach with seq-based
  replay, `StatusChanged`/`SessionExit`, and a `Request`/`Response` frame that
  mirrors the REST API — a single socket can carry all client traffic.
- TypeScript type generation: protocol types already derive `ts-rs`
  (`feature = "typescript"`), and `packages/stream-client` +
  `composables/desktopStreamClient.ts` already speak KSP from the desktop.
- The server already owns the full task/pipeline engine
  (`crates/kanna-server/src/task_creator/`) including ports, spawn env,
  prompts, and the completion-notify boundary.

## Gap inventory

Frontend direct-DB operations mapped to their server-side status:

| Frontend operation (today) | Server endpoint | Gap |
|---|---|---|
| Task create (`stores/taskItemActions.ts` — `insertPipelineItem` + `insertWorktree` + manual rollback) | `POST /v1/tasks` | Parity audit only: template/custom-task fields, dormant tasks, notify wiring |
| Task close (`stores/init.ts:194`, `taskCloseActions.ts` port reassignment) | `POST …/actions/close` | Parity audit: dependent-unblock sweep, port release, selection side effects stay client-side |
| Activity transitions (`updatePipelineItemActivity`, ~8 call sites) | none (`PATCH` only accepts `displayName`) | New. Model as intent, not raw column write: `POST …/actions/mark-read`; `working`/`unread` should be derived server-side from daemon events (server already handles the notify path) |
| Blocker add (`taskBlockedActions.ts`) | `POST …/actions/block` / `unblock` | Swap; delete TS cycle check after confirming server DFS parity |
| Set parent (`taskParentActions.ts`) | `POST …/actions/set-parent` | Swap |
| Rename (`display_name`) | `PATCH /v1/tasks/{id}` | Swap |
| Repo add (`taskRepoActions.ts`) | `POST /v1/repos` | Swap |
| Repo remote metadata (`services/repoRemoteUrl.ts`) | none | New: `PATCH /v1/repos/{id}` |
| Settings get/set (`setSetting`, ~7 call sites) | none | New: `GET/PUT /v1/settings/{key}` (or batch) |
| Operator events (`insertOperatorEvent`) | none | New: `POST /v1/operator-events` (fire-and-forget, batched) |
| Analytics aggregation (SQL in `packages/db`) | none | New: `GET /v1/analytics/...` or a read-only query endpoint |
| Ports (`stores/ports.ts` raw SQL) | server has internal `db/ports.rs` | Delete frontend path; ports become server-internal |
| Agent session id updates (`updateAgentSessionId`) | none | Should move server/daemon-side with session ownership |
| Task transfer raw SQL (`useAppTaskTransfer.ts`, `useAppCloudWorkspace.ts`) | none | Fold into transfer sidecar/server APIs |
| Snapshot reads (`stores/queries.ts::reloadSnapshot` — repos + items + blockers) | partial (`/v1/repos`, `/v1/repos/{id}/tasks`, `GET /v1/tasks/{id}`) | New: `GET /v1/snapshot` returning everything the UI hydrates from, in one payload |
| Change notification (pipeline socket nudge + polling) | KSP has terminal/agent/status frames only | New: data-model delta frames (see Phase 1) |
| Schema migrations (`stores/db.ts::runMigrations`) | server asserts WAL, no migrations | Move migration runner to kanna-server boot |

## Phases

Ordered to shrink the two-writer window fastest and keep every phase
independently shippable. Each phase cuts over and deletes the old path in the
same change — no long-lived dual-write modes.

### Phase 0 — Make kanna-server load-bearing (prerequisite)

The server can't be the UI's spine while it's a lazily-booted, LAN-exposed
sidecar whose relay code can take down the process.

1. **Always-on + supervised**: desktop spawns kanna-server during Tauri setup
   (it already does via `MobileServerManager.start()`); add restart-on-crash
   supervision and a readiness signal the frontend can await. Remove the
   lazy `ensure_mobile_server` retry loops from `pipeline.ts` once readiness
   is guaranteed.
2. **Listener split**: localhost listener for the desktop UI (KSP
   `Auth { credential: None }` is already specified for this), separate from
   the LAN/relay surface. Desktop-critical operations must not depend on the
   `0.0.0.0` listener.
3. **Crash isolation**: relay/Bonjour/mobile subsystems run in supervised
   tasks that cannot poison the HTTP/KSP core (panic containment, restart
   backoff — the event-bridge reconnect pattern already exists desktop-side).
4. **Generated TS client**: extend the existing ts-rs export to REST
   request/response types; one typed client module in
   `apps/desktop/src/services/` (grow `desktopStreamClient.ts` rather than a
   parallel stack).

Exit criteria: server up before first frontend data access; kill -9 on the
server recovers without user-visible breakage beyond a reconnect blip.

### Phase 1 — Reads: snapshot + deltas

1. `GET /v1/snapshot` (repos, pipeline items, blockers, worktree paths,
   settings the UI needs) — one request replaces
   `reloadSnapshot()`'s table reads.
2. New KSP server frames for data-model changes. Start coarse:
   `StateChanged { scope: tasks|repos|blockers|settings }` published by the
   server after each of its own writes — the frontend re-fetches the
   snapshot on receipt, which is exactly today's nudge-and-reload semantics
   but transactional with the write. Fine-grained per-row deltas are a later
   optimization, not a prerequisite.
3. Frontend: `reloadSnapshot()` fetches over HTTP; subscribe to
   `StateChanged`; the `pipeline_stage_complete` Unix-socket → Tauri event
   path and DB polling intervals become redundant and are removed.

Note: direct DB writes from the frontend still exist in this phase and won't
self-publish `StateChanged`; the frontend already reloads after its own
writes today, so behavior is unchanged until Phase 2 removes those writes.

Exit criteria: no `db.select` in the snapshot path; UI updates on server
writes without polling.

### Phase 2 — Race-prone writes: close, activity, blockers, create

The writes that overlap server-owned rows move first.

1. **Close** → `POST …/actions/close`. Parity audit against
   `taskCloseActions.ts` first (port release, dependent unblock, undo
   support); anything missing gets added server-side. Selection/undo UX
   state stays in the frontend.
2. **Activity** → server-derived. `working`/`unread` come from daemon events
   the server already observes; the only client intent is
   `POST …/actions/mark-read`. Delete `updatePipelineItemActivity` call
   sites.
3. **Blockers** → `block`/`unblock` endpoints; delete the TS DFS after
   adding a server-side test proving cycle-rejection parity.
4. **Create** → `POST /v1/tasks` after a field-parity audit (templates,
   custom tasks, dormant, notify_task_id); delete the TS insert+rollback
   path in `taskItemActions.ts`.

Exit criteria: no frontend writes to `pipeline_item`, `task_blocker`,
`worktree`, or port tables. The two-writer overlap on server-mutated rows is
gone.

### Phase 3 — Long tail

- Settings API + migrate `useAppPreferences`/init/selection call sites.
- Operator events + analytics read endpoints; delete SQL aggregation from
  the frontend bundle.
- `PATCH /v1/repos/{id}` for remote metadata; repo hide/show if still
  frontend-written.
- Agent session id bookkeeping moves into the server's session ownership.
- Task-transfer raw SQL folds into the transfer/server surface.

Exit criteria: zero `@kanna/db` imports and zero raw `db.execute`/`db.select`
in `apps/desktop/src` outside `stores/db.ts` itself.

### Phase 4 — Schema ownership + connection removal

1. Port `runMigrations()` to a rusqlite migration runner in kanna-server
   boot (same SQL, versioned). Server refuses to serve until migrated.
2. Frontend stops loading `tauri-plugin-sql` entirely; delete `stores/db.ts`
   DB setup, the plugin registration, and the WAL-checkpoint workaround.
3. `useBackup` moves server-side (single writer can checkpoint + copy
   safely) or calls a `POST /v1/backup` endpoint.
4. Browser dev mode: the frontend can now run against a real kanna-server
   instead of the tauri-mock DB layer; shrink `tauri-mock.ts` accordingly.

Exit criteria: exactly one process opens the DB for task/repo state.
`kanna-server` starts before any consumer and owns the schema version.

## Explicit non-goals

- **Terminal/PTY data path**: stays frontend ↔ daemon (Tauri commands +
  event bridge). Routing PTY bytes through HTTP/KSP locally would add
  latency for no benefit. Revisit only if the daemon boundary moves.
- **Fine-grained delta protocol**: coarse `StateChanged` + snapshot re-fetch
  is the contract; per-row patches are an optimization with its own bug
  class (ordering, missed deltas) — do not build until snapshot re-fetch is
  measurably too slow.
- **Multi-desktop / remote desktop UI**: the localhost listener assumption
  holds for this plan.

## Risks

| Risk | Mitigation |
|---|---|
| Server on the startup critical path slows app launch | Readiness probe + UI renders last-known snapshot from memory while awaiting; server boot is milliseconds once always-on (no lazy spawn) |
| Relay/mobile crash takes down the UI data plane | Phase 0.3 isolation is a hard prerequisite, not nice-to-have |
| Parity bugs during write cutover (close/create side effects differ) | Per-operation parity audit + server-side tests asserting the TS behavior before deleting it; cut one operation per PR |
| Version skew: old server binary vs new schema during upgrade | Phase 4 makes the server the migrator; until then, keep the existing "frontend migrates first" ordering and don't add server-side schema assumptions mid-plan |
| Worktree dev instances: each needs its own server on its own port | Already handled by `KANNA_MOBILE_SERVER_PORT` allocation + per-worktree lockfiles; verify in Phase 0 E2E |
| Frontend offline against a dead server | Supervision + reconnect (Phase 0); the KSP client already has reconnect/replay semantics via `from_seq` |

## Testing strategy

Per the repo's E2E expectation, every phase crossing the frontend↔server
boundary adds E2E coverage:

- Phase 0: kill/restart kanna-server mid-session E2E — UI reconnects, no
  data loss; startup-ordering test (frontend blocks on readiness).
- Phase 1: server-side write (via `/v1` from a second client) appears in the
  UI without polling — asserts the `StateChanged` → snapshot loop.
- Phase 2: close/create/block through the UI land in the DB with identical
  rows to the pre-migration TS path (golden-row comparison in a mock E2E);
  concurrent advance-stage + close no longer produces the stale-write race.
- Phase 4: fresh-profile boot where kanna-server migrates a v0 DB; frontend
  bundle contains no `tauri-plugin-sql` import (static assertion test).

Existing contract tests (`tests/cli-contract/`) and kanna-server HTTP tests
(`crates/kanna-server/src/http_api/tests/`) extend to the new endpoints.

## Sizing (rough)

- Phase 0: ~1–2 weeks (supervision + listener split are the substance).
- Phase 1: ~1 week (snapshot endpoint is mostly existing queries; frames are
  additive).
- Phase 2: ~2 weeks (parity audits dominate; one operation per PR).
- Phase 3: ~1–2 weeks, parallelizable per feature.
- Phase 4: ~1 week plus a release-cycle of soak before deleting the old
  migration path.

Phases 0–1 carry no user-visible behavior change and can ship immediately.
Phase 2 is where the race-class bugs actually die.

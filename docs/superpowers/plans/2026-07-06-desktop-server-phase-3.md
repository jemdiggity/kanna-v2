# Desktop Server Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the remaining non-Phase-2 desktop frontend SQLite writes and analytics reads behind kanna-server endpoints.

**Architecture:** kanna-server owns settings, operator events, repo metadata, analytics, and provider session bookkeeping through focused `/v1` routes. The desktop frontend uses `apps/desktop/src/services/desktopServerClient.ts` and local protocol types instead of importing `@kanna/db` for these paths. Phase-2 task write files remain untouched.

**Tech Stack:** Rust axum/rusqlite for server endpoints, Vue/Pinia TypeScript for desktop client migration, Vitest/E2E tests, cargo clippy/fmt and pnpm checks.

---

### Task 1: Settings Endpoint And Client Migration

**Files:**
- Modify: `crates/kanna-server/src/db/settings.rs`
- Create: `crates/kanna-server/src/http_api/settings.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/windowWorkspace.ts`
- Modify: `apps/desktop/src/composables/useAppPreferences.ts`

- [ ] Add failing HTTP route tests for `GET /v1/settings/{key}` and `PUT /v1/settings/{key}`.
- [ ] Implement `Db::set_setting`, `get_setting` response handling, and state-change publication.
- [ ] Add typed desktop client helpers and migrate settings call sites.
- [ ] Run targeted Rust and TypeScript tests, then commit `feat: move desktop settings writes to server`.

### Task 2: Operator Events Endpoint And Client Migration

**Files:**
- Create: `crates/kanna-server/src/http_api/operator_events.rs`
- Modify: `crates/kanna-server/src/db/settings.rs` or a focused db module for event insertion
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/composables/useOperatorEvents.ts`

- [ ] Add failing HTTP route test for batched `POST /v1/operator-events`.
- [ ] Implement event insertion server-side.
- [ ] Migrate fire-and-forget frontend call sites to the typed client.
- [ ] Run targeted tests, then commit `feat: move operator events to server`.

### Task 3: Analytics Endpoint And Frontend Read Migration

**Files:**
- Create: `crates/kanna-server/src/db/analytics.rs`
- Create: `crates/kanna-server/src/http_api/analytics.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/composables/useAnalytics.ts`
- Add E2E coverage under `apps/desktop/tests/e2e/mock/`

- [ ] Add failing HTTP route test proving task buckets, average state times, and operator metrics are returned for a repo.
- [ ] Implement server aggregation using SQLite reads and Rust aggregation logic.
- [ ] Migrate `useAnalytics` to fetch the server payload and remove frontend SQL reads.
- [ ] Add E2E coverage that analytics renders from the server-backed path.
- [ ] Run targeted tests, then commit `feat: serve desktop analytics from kanna-server`.

### Task 4: Repo Metadata Patch And Hide/Show Migration

**Files:**
- Modify: `crates/kanna-server/src/db/repos.rs`
- Modify: `crates/kanna-server/src/http_api/repos.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/services/repoRemoteUrl.ts`
- Modify repo hide/show call sites outside Phase-2-owned files if present.

- [ ] Add failing HTTP route tests for `PATCH /v1/repos/{id}` remote metadata and hidden state.
- [ ] Implement server patch with repo state-change publication.
- [ ] Migrate repo metadata and hide/show frontend writes.
- [ ] Run targeted tests, then commit `feat: patch repo metadata through server`.

### Task 5: Session Bookkeeping And Transfer Raw SQL

**Files:**
- Modify: server session/task route modules as needed.
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/composables/useAppTaskTransfer.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`

- [ ] Add failing route or unit tests for provider session id persistence and transfer helper reads/writes.
- [ ] Implement server-owned endpoints or reuse existing sidecar/server API surfaces.
- [ ] Migrate frontend call sites away from `db.execute` and `db.select`.
- [ ] Run targeted tests, then commit `feat: move session and transfer bookkeeping to server`.

### Task 6: Frontend Type Boundary And Final Verification

**Files:**
- Create: `apps/desktop/src/types/kanna.ts`
- Modify: all `apps/desktop/src` non-Phase-2 imports that currently import `@kanna/db`.
- Leave Phase-2-owned `taskCloseActions.ts`, `taskBlockedActions.ts`, and `taskItemActions.ts` unchanged.

- [ ] Add local desktop protocol/schema-adapter types matching server snapshot responses.
- [ ] Replace `@kanna/db` imports outside allowed files and `stores/db.ts`.
- [ ] Static-check for `@kanna/db`, `db.execute`, and `db.select` outside allowed paths.
- [ ] Run `cargo fmt --all`, `cargo clippy`, `pnpm exec tsc --noEmit`, and `pnpm test`.
- [ ] Request code review, address important findings, and record Kanna stage completion.

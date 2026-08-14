# Mobile Mentioned Files Review Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the reviewed async blocking-boundary defect, reconcile the committed terminal and E2E documentation with the implemented mentioned-files flow, and verify the complete revision.

**Architecture:** Keep authentication and Axum extraction on the async handler, then move the SQLite open and complete mention-resolution service call into the shared labeled blocking boundary. Preserve `open_db` and `map_task_file_error` so every existing HTTP status and message remains unchanged. Treat the terminal implementation and relay journey as the source of truth for the two documentation corrections.

**Tech Stack:** Rust, Axum, Tokio, rusqlite, Vue/React Native TypeScript, Vitest, Appium, Markdown.

---

### Task 1: Protect the async task-file route

**Files:**
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `crates/kanna-server/src/http_api/task_files.rs`

- [x] **Step 1: Write the failing responsiveness regression**

Add a `#[tokio::test(flavor = "current_thread")]` route test with an explicit started/release hook around the synchronous resolver, start an authenticated `resolve-mentions` request, and require a Tokio scheduler probe to complete within 100 milliseconds while the resolver is held.

- [x] **Step 2: Run the regression test and confirm RED**

Run:

```bash
cargo test -p kanna-server task_file_resolver_route_stays_responsive_during_blocking_resolution -- --nocapture
```

Expected: the responsiveness assertion fails because the current handler walks the workspace on the current-thread runtime.

- [x] **Step 3: Move synchronous resolution behind the shared boundary**

Keep `require_authenticated_task_file_access(access)?` before the boundary, then move `open_db(&state)` and `crate::task_files::resolve_task_file_mentions(...)` into:

```rust
super::blocking::run_handler_blocking("task file mention resolution", move || {
    let db = open_db(&state)?;
    crate::task_files::resolve_task_file_mentions(&db, &task_id, request.mentions)
        .map(Json)
        .map_err(map_task_file_error)
})
.await
```

- [x] **Step 4: Run the regression and task-file route tests and confirm GREEN**

Run:

```bash
cargo test -p kanna-server task_file
```

Expected: the current-thread regression and existing authentication/status-mapping tests pass.

### Task 2: Reconcile committed behavior documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-mobile-mentioned-files-menu-design.md`
- Modify: `apps/mobile/e2e/file-preview-coverage.md`

- [x] **Step 1: Correct the terminal scanning policy**

Document that initial reconstruction scans the active alternate buffer first when present and then the bounded normal tail, while incremental writes scan a bounded 200-row normal redraw window when scrollback length is unchanged and scan the bounded alternate buffer for alternate-screen redraws. Update the testing bullets to require alternate-buffer mention capture and bounded normal-row rewrite coverage.

- [x] **Step 2: Replace the obsolete E2E journey description**

Describe the real relay path: terminal output populates mention history, Appium opens `+ -> Mentioned Files`, the owner resolves unique bare and ambiguous basenames, native inspection metadata proves canonical content and initial-line wiring, and preview-WebView layout/highlighting assertions run only when Appium exposes a `WEBVIEW_*` context.

- [x] **Step 3: Attempt the canonical relay lane and record the exact outcome**

Run:

```bash
./kd dev up --mobile --emulators
pnpm --dir apps/mobile run test:e2e:relay
```

If it cannot run, replace the historical blocker with the current command, failing boundary, required environment/tooling, and narrower deterministic tests retained.

### Task 3: Focused and repository verification

**Files:**
- Verify only.

- [x] **Step 1: Run focused mobile tests**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx src/screens/TaskMentionedFiles.test.tsx src/screens/TaskScreen.test.tsx e2e/specs/relay/relay-task-flow.test.ts
pnpm --dir apps/mobile typecheck
```

- [x] **Step 2: Run required repository suites**

```bash
pnpm test
(cd crates/daemon && cargo test -- --test-threads=1)
cargo test -p kanna-server
```

- [x] **Step 3: Inspect the diff and complete the Kanna stage**

Confirm only intended files changed, summarize fresh verification evidence, and call `kanna_complete_stage` with `status: success`. Do not commit, push, create a pull request, or advance the stage manually; Kanna's workflow post owns the commit.

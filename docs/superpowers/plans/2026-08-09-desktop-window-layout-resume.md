# Desktop Window Layout Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and restore the position and size of every durable Kanna desktop window.

**Architecture:** Extend the existing atomic `window_workspace_v1` per-window snapshot with optional physical-pixel geometry. The frontend observes native Tauri move/resize events and restores safe bounds, while `kanna-server` remains the serialized persistence boundary.

**Tech Stack:** Vue 3 Composition API, TypeScript, Tauri v2 window APIs, Rust/Axum/Serde, Vitest, WebDriver E2E

---

## File structure

- Modify `apps/desktop/src/windowWorkspace.ts` — geometry model, normalization, monitor fallback, native capture, restoration, and controller APIs.
- Modify `apps/desktop/src/windowWorkspace.test.ts` — pure legacy/normalization/mutation tests.
- Modify `apps/desktop/src/windowWorkspace.tauri.test.ts` — mocked Tauri restoration and debounced persistence tests.
- Modify `apps/desktop/src/services/desktopServerClient.ts` — typed `updateGeometry` request.
- Modify `crates/kanna-server/src/http_api/window_workspace.rs` — persisted geometry and atomic mutation.
- Modify `apps/desktop/src/composables/useAppLifecycle.ts` — start and dispose native geometry observation with the window lifecycle.
- Modify `apps/desktop/src/App.test.ts` — lifecycle mock and cleanup assertions.
- Modify `apps/desktop/tests/e2e/mock/new-window.test.ts` — real Tauri/server geometry persistence and window recreation coverage.

### Task 1: Extend the workspace persistence contract

**Files:**
- Modify: `apps/desktop/src/windowWorkspace.ts`
- Modify: `apps/desktop/src/windowWorkspace.test.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `crates/kanna-server/src/http_api/window_workspace.rs`

- [ ] **Step 1: Write failing TypeScript mutation and legacy parsing tests**

Add tests asserting that a legacy row without `geometry` parses as `geometry: null`, valid integer geometry survives normalization, invalid/undersized geometry becomes `null`, and `applyWindowWorkspaceMutation` applies `updateGeometry` only to an existing window.

```ts
expect(applyWindowWorkspaceMutation(snapshot, {
  operation: "updateGeometry",
  windowId: "main",
  geometry: { x: 120, y: 90, width: 980, height: 720 },
}).windows[0]?.geometry).toEqual({ x: 120, y: 90, width: 980, height: 720 });
```

- [ ] **Step 2: Run the TypeScript test and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/windowWorkspace.test.ts`

Expected: FAIL because `geometry` and `updateGeometry` are not modeled.

- [ ] **Step 3: Write failing Rust server tests**

Add `updating_window_geometry_is_atomic_and_does_not_recreate_missing_windows`, constructing an `updateGeometry` request and asserting that only the matching row changes. Extend existing test fixtures with `geometry: None`.

- [ ] **Step 4: Run the Rust test and verify RED**

Run: `cargo test -p kanna-server window_workspace::tests`

Expected: FAIL because the Rust geometry field and mutation payload do not exist.

- [ ] **Step 5: Implement the shared persistence contract**

Define this TypeScript shape and add it to `WorkspaceWindowState` and `DesktopWorkspaceWindowState`:

```ts
export interface WorkspaceWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

Add the client mutation:

```ts
| {
    operation: "updateGeometry";
    windowId: string;
    geometry: WorkspaceWindowGeometry;
  }
```

Mirror it in Rust with `x: i32`, `y: i32`, `width: u32`, `height: u32`, an optional row field using `#[serde(default)]`, and optional request geometry. Validate the mutation shape, update only an existing row, and normalize widths/heights below `800 × 600` to `None`.

- [ ] **Step 6: Run both focused suites and verify GREEN**

Run: `pnpm --dir apps/desktop exec vitest run src/windowWorkspace.test.ts`

Run: `cargo test -p kanna-server window_workspace::tests`

Expected: both commands exit 0.

### Task 2: Restore safe native bounds and observe changes

**Files:**
- Modify: `apps/desktop/src/windowWorkspace.ts`
- Modify: `apps/desktop/src/windowWorkspace.tauri.test.ts`

- [ ] **Step 1: Write failing pure monitor fallback tests**

Cover a rectangle intersecting an existing monitor unchanged and a fully off-screen rectangle moved into the primary work area with its size preserved or clamped.

```ts
expect(resolveRestorableWindowGeometry(saved, monitors)).toEqual(saved);
expect(resolveRestorableWindowGeometry(offscreen, monitors)).toEqual({
  x: 0,
  y: 25,
  width: 980,
  height: 720,
});
```

- [ ] **Step 2: Run the Tauri workspace tests and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/windowWorkspace.tauri.test.ts`

Expected: FAIL because restoration/capture APIs are absent.

- [ ] **Step 3: Write failing Tauri-facing restoration and debounce tests**

Extend the mocked current window with `setPosition`, `setSize`, `outerPosition`, `outerSize`, `onMoved`, and `onResized`. Assert:

- `restoreCurrentWindowGeometry()` applies `PhysicalSize` then `PhysicalPosition` for the saved `main` row.
- Restored secondary windows receive their geometry before becoming visible.
- `startGeometryTracking()` coalesces move/resize bursts into one `updateGeometry` mutation and its disposer removes both native listeners and clears the timer.

- [ ] **Step 4: Implement restoration and tracking**

Add controller methods:

```ts
restoreCurrentWindowGeometry(): Promise<void>;
startGeometryTracking(): Promise<() => void>;
```

Use `availableMonitors`, `primaryMonitor`, `getCurrentWindow`, `PhysicalPosition`, and `PhysicalSize`. Create secondary windows hidden, apply physical geometry after `tauri://created`, then show and focus them. Debounce move/resize capture for 150 ms and submit one queued `updateGeometry` mutation after reading outer position and outer size together.

- [ ] **Step 5: Run Tauri and pure tests and verify GREEN**

Run: `pnpm --dir apps/desktop exec vitest run src/windowWorkspace.test.ts src/windowWorkspace.tauri.test.ts`

Expected: both files pass.

### Task 3: Attach geometry ownership to app lifecycle

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add controller mocks for `restoreCurrentWindowGeometry` and `startGeometryTracking`. Assert main startup restores before mount-dependent initialization, tracking begins only after `initialize`, and unmount calls the returned disposer.

- [ ] **Step 2: Run the app tests and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/App.test.ts`

Expected: FAIL because lifecycle wiring is absent.

- [ ] **Step 3: Wire restoration and cleanup**

In `main.ts`, await `windowWorkspace.restoreCurrentWindowGeometry()` before mounting the root component so the primary window does not visibly settle at default bounds. In `useAppLifecycle`, await `startGeometryTracking()` immediately after successful workspace initialization and store its disposer in `appUnlisteners`.

- [ ] **Step 4: Run app tests and verify GREEN**

Run: `pnpm --dir apps/desktop exec vitest run src/App.test.ts`

Expected: PASS.

### Task 4: Prove the real multi-window wiring

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/new-window.test.ts`

- [ ] **Step 1: Add the real Tauri/server E2E case**

Open a secondary window, set distinct bounds through WebDriver, poll `window_workspace_v1` until its stable window ID contains matching geometry, destroy the native secondary without removing membership, call the main controller's `restoreAdditionalWindows`, and assert the recreated window returns within the existing 16-pixel tolerance.

- [ ] **Step 2: Run the E2E target**

Run: `pnpm --dir apps/desktop test:e2e -- mock/new-window.test.ts`

Expected: PASS against a `./kd dev up --db <test-db>` worktree instance. If the environment cannot launch WebDriver, retain the test and report the environmental limitation rather than weakening coverage.

### Task 5: Full verification

- [ ] **Step 1: Format Rust**

Run: `cargo fmt --all`

- [ ] **Step 2: Run focused regression suites**

Run: `pnpm --dir apps/desktop exec vitest run src/windowWorkspace.test.ts src/windowWorkspace.tauri.test.ts src/App.test.ts`

Run: `cargo test -p kanna-server window_workspace::tests`

- [ ] **Step 3: Run required static checks**

Run: `pnpm exec tsc --noEmit`

Run: `cargo clippy -p kanna-server --all-targets`

- [ ] **Step 4: Inspect final diff**

Run: `git diff --check && git status --short && git diff --stat HEAD~1`

Expected: no whitespace errors, only scoped files changed, and all checks exit 0.

## Self-review

- Spec coverage: persistence, legacy fallback, per-window restore, unavailable-monitor handling, lifecycle cleanup, and real multi-window wiring are each assigned above.
- Placeholder scan: no deferred implementation markers remain.
- Type consistency: `WorkspaceWindowGeometry`, `geometry`, `updateGeometry`, `restoreCurrentWindowGeometry`, and `startGeometryTracking` use the same names throughout.

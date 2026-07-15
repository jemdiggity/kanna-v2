# Mobile-Created Terminal Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start PTY agent tasks created from mobile at a minimum `80x48` grid while allowing larger mobile viewports to request larger initial dimensions.

**Architecture:** Measure the mobile app's task-detail content area before creation and convert it to a grid with a pure geometry helper. Send the resulting optional dimensions through the existing create-task transports, and let kanna-server apply them only to the initial interactive PTY spawn while retaining `80x24` as the compatibility default.

**Tech Stack:** React Native, TypeScript, Vitest, Rust, Serde, Cargo tests

**Stage constraint:** Do not commit during this implementation stage; Kanna's later pipeline stage owns commits.

---

### Task 1: Add a Pure Mobile Terminal Geometry Helper

**Files:**
- Create: `apps/mobile/src/mobileTerminalGeometry.ts`
- Create: `apps/mobile/src/mobileTerminalGeometry.test.ts`

- [ ] **Step 1: Write the failing geometry tests**

Create `apps/mobile/src/mobileTerminalGeometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_TERMINAL_GEOMETRY,
  resolveMobileTerminalGeometry
} from "./mobileTerminalGeometry";

describe("resolveMobileTerminalGeometry", () => {
  it("uses 80x48 for a phone-sized task detail surface", () => {
    expect(resolveMobileTerminalGeometry({ width: 390, height: 844 })).toEqual({
      cols: 80,
      rows: 48
    });
  });

  it("expands the grid for an iPad-sized task detail surface", () => {
    expect(resolveMobileTerminalGeometry({ width: 1024, height: 1366 })).toEqual({
      cols: 128,
      rows: 72
    });
  });

  it("floors fractional cells instead of overflowing the viewport", () => {
    expect(resolveMobileTerminalGeometry({ width: 799.9, height: 1000.9 })).toEqual({
      cols: 99,
      rows: 51
    });
  });

  it.each([
    null,
    { width: 0, height: 844 },
    { width: 390, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 844 }
  ])("falls back to 80x48 for an unusable layout: %o", (layout) => {
    expect(resolveMobileTerminalGeometry(layout)).toEqual(
      DEFAULT_MOBILE_TERMINAL_GEOMETRY
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test mobileTerminalGeometry -- --runInBand
```

Expected: FAIL because `./mobileTerminalGeometry` does not exist.

- [ ] **Step 3: Implement the minimal geometry helper**

Create `apps/mobile/src/mobileTerminalGeometry.ts`:

```ts
export interface MobileTerminalGeometry {
  cols: number;
  rows: number;
}

export interface MobileTerminalViewport {
  width: number;
  height: number;
}

export const DEFAULT_MOBILE_TERMINAL_GEOMETRY: MobileTerminalGeometry = {
  cols: 80,
  rows: 48
};

const ESTIMATED_CELL_WIDTH = 8;
const ESTIMATED_CELL_HEIGHT = 17;
const FULLSCREEN_COMPOSER_INSET = 132;

export function resolveMobileTerminalGeometry(
  viewport: MobileTerminalViewport | null | undefined
): MobileTerminalGeometry {
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { ...DEFAULT_MOBILE_TERMINAL_GEOMETRY };
  }

  return {
    cols: Math.max(
      DEFAULT_MOBILE_TERMINAL_GEOMETRY.cols,
      Math.floor(viewport.width / ESTIMATED_CELL_WIDTH)
    ),
    rows: Math.max(
      DEFAULT_MOBILE_TERMINAL_GEOMETRY.rows,
      Math.floor(
        (viewport.height - FULLSCREEN_COMPOSER_INSET) / ESTIMATED_CELL_HEIGHT
      )
    )
  };
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test mobileTerminalGeometry -- --runInBand
```

Expected: 7 parameterized/individual tests PASS.

### Task 2: Send Measured Geometry with Mobile Task Creation

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts`

- [ ] **Step 1: Write failing controller and transport contract tests**

Extend `apps/mobile/src/state/mobileController.test.ts` so the existing exact create assertion passes an explicit grid and expects the new request fields:

```ts
await controller.createTask({ cols: 104, rows: 72 });

expect(client.createTask).toHaveBeenCalledWith({
  repoId: "repo-2",
  prompt: "Ship mobile shell",
  desktopId: "desktop-2",
  agentProvider: "codex",
  agentType: "pty",
  terminalCols: 104,
  terminalRows: 72
});
```

Add a second assertion using `await controller.createTask()` and expect `terminalCols: 80` plus `terminalRows: 48` to prove the fallback.

In `apps/mobile/src/lib/transports/lanTransport.test.ts`, include `terminalCols: 80` and `terminalRows: 48` in the `transport.createTask` input and expected JSON body.

In the targeted-created-task test in `apps/mobile/src/lib/transports/remoteTransport.test.ts`, include the same fields in the input and expected `invokeDesktop` body:

```ts
const created = await transport.createTask({
  repoId: "repo-1",
  prompt: "Ship it",
  desktopId: "desktop-created-here",
  agentProvider: "codex",
  terminalCols: 80,
  terminalRows: 48
});

expect(invokeDesktop).toHaveBeenCalledWith({
  desktopId: "desktop-created-here",
  method: "POST",
  path: "/v1/tasks",
  body: {
    repoId: "repo-1",
    prompt: "Ship it",
    agentProvider: "codex",
    terminalCols: 80,
    terminalRows: 48
  }
});
```

- [ ] **Step 2: Run focused contract tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test mobileController lanTransport remoteTransport -- --runInBand
```

Expected: FAIL because `MobileController.createTask` does not accept geometry and `CreateTaskRequest` has no terminal fields.

- [ ] **Step 3: Extend the mobile request and controller contract**

Add to `CreateTaskRequest` in `apps/mobile/src/lib/api/types.ts`:

```ts
terminalCols?: number;
terminalRows?: number;
```

Import the geometry type/default in `apps/mobile/src/state/mobileController.ts`, change the controller interface to:

```ts
createTask(terminalGeometry?: MobileTerminalGeometry): Promise<void>;
```

At the start of the successful create path, resolve the supplied grid:

```ts
const { cols, rows } =
  terminalGeometry ?? DEFAULT_MOBILE_TERMINAL_GEOMETRY;
```

Then include the pair in the existing client request:

```ts
const created = await client.createTask({
  repoId: state.selectedRepoId,
  prompt: state.composerPrompt.trim(),
  desktopId: composerDesktopId,
  agentProvider: state.composerAgentProvider,
  agentType: "pty",
  terminalCols: cols,
  terminalRows: rows
});
```

Update the other exact create-request expectations in `mobileController.test.ts` to include the fallback `80x48` fields.

- [ ] **Step 4: Write the failing App layout-wiring test**

In `apps/mobile/src/App.component.test.tsx`, add a recursive helper that finds an element with a named prop:

```ts
function renderedElementWithProp(
  node: unknown,
  prop: string
): React.ReactElement<Record<string, unknown>> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<Record<string, unknown> & { children?: unknown }>;
  if (typeof element.props[prop] === "function") return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = renderedElementWithProp(child, prop);
    if (match) return match;
  }
  return null;
}
```

Add the test:

```ts
it("creates tasks with geometry derived from the measured task-detail surface", () => {
  const { controller } = createModel("connected");
  const tree = renderApp();
  const shell = renderedElementWithProp(tree, "onLayout");
  const composer = renderedElementByType(tree, "CreateTaskComposer");

  expect(shell).not.toBeNull();
  expect(composer).not.toBeNull();

  (shell?.props.onLayout as (event: unknown) => void)({
    nativeEvent: {
      layout: { width: 1024, height: 1366, x: 0, y: 0 }
    }
  });
  (composer?.props.onSubmit as () => void)();

  expect(controller.createTask).toHaveBeenCalledWith({ cols: 128, rows: 72 });
});
```

- [ ] **Step 5: Run the App test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test App.component -- --runInBand
```

Expected: FAIL because the shell has no layout handler and submit calls `createTask()` without dimensions.

- [ ] **Step 6: Wire shell measurement into App task creation**

In `apps/mobile/src/App.tsx`, import `type LayoutChangeEvent` and the geometry helper, then retain the latest outer shell size:

```ts
const taskDetailViewportRef = useRef<{ width: number; height: number } | null>(null);
```

Add this handler to the main shell `View`:

```tsx
onLayout={(event: LayoutChangeEvent) => {
  const { width, height } = event.nativeEvent.layout;
  taskDetailViewportRef.current = { width, height };
}}
```

Change composer submission to:

```tsx
onSubmit={() => {
  void controller.createTask(
    resolveMobileTerminalGeometry(taskDetailViewportRef.current)
  );
}}
```

- [ ] **Step 7: Run mobile contract tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test mobileTerminalGeometry App.component mobileController lanTransport remoteTransport -- --runInBand
```

Expected: all selected tests PASS.

- [ ] **Step 8: Run mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

### Task 3: Apply Optional Geometry to Initial Server PTY Spawns

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/merge.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: every kanna-server test `CreateTaskRequest` literal reported by the Rust compiler, adding the compatibility defaults

- [ ] **Step 1: Write failing JSON-contract and task-preparation tests**

Extend `create_task_request_uses_agent_type_camel_case` in `mobile_api.rs` with:

```rust
"terminalCols": 104,
"terminalRows": 72,
```

and assertions:

```rust
assert_eq!(request.terminal_cols, Some(104));
assert_eq!(request.terminal_rows, Some(72));
```

Include the camel-case fields in the serialized JSON expectation.

Add to `task_creator/tests/core.rs`:

```rust
#[test]
fn prepare_task_uses_requested_initial_terminal_geometry() {
    let repo_root = init_git_repo("requested-terminal-geometry");
    let config = test_config("requested-terminal-geometry");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the mobile terminal grid".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
            terminal_cols: Some(104),
            terminal_rows: Some(72),
        },
    )
    .unwrap();

    assert!(matches!(
        prepared.session,
        PreparedSessionSpawn::Pty { cols: 104, rows: 72, .. }
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn requested_initial_terminal_geometry_requires_a_positive_pair() {
    assert_eq!(resolve_initial_terminal_geometry(Some(80), Some(48)), Some((80, 48)));
    assert_eq!(resolve_initial_terminal_geometry(Some(320), Some(256)), Some((320, 256)));
    assert_eq!(resolve_initial_terminal_geometry(Some(80), None), None);
    assert_eq!(resolve_initial_terminal_geometry(None, Some(48)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(0), Some(48)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(80), Some(0)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(321), Some(256)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(320), Some(257)), None);
}
```

Strengthen the existing `prepare_task_defaults_to_pty_session_for_claude_and_codex`
test to match `PreparedSessionSpawn::Pty { cols: 80, rows: 24, .. }`
instead of matching any PTY dimensions. This is the direct compatibility assertion for
callers that omit the new request fields.

Extend `prepare_task_for_api_creates_worktree_without_cargo_config` with
`terminal_cols: Some(104)` and `terminal_rows: Some(72)`, then retain an explicit
`PreparedSessionSpawn::Agent { .. }` assertion. This proves the request fields do not
alter headless agent sessions.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
cargo test -p kanna-server requested_initial_terminal_geometry
cargo test -p kanna-server create_task_request_uses_agent_type_camel_case
```

Expected: compilation FAIL because the request and task-preparation types do not yet carry terminal geometry.

- [ ] **Step 3: Extend the server create-task request**

Add to `CreateTaskRequest` in `crates/kanna-server/src/mobile_api.rs`:

```rust
pub terminal_cols: Option<u16>,
pub terminal_rows: Option<u16>,
```

Add `terminal_cols: None` and `terminal_rows: None` to existing Rust `CreateTaskRequest` literals. The serialization contract should now emit `terminalCols` and `terminalRows` because the struct already uses `#[serde(rename_all = "camelCase")]`.

- [ ] **Step 4: Carry a validated pair through task preparation**

Add to `TaskCreationRequest` in `task_creator/types.rs`:

```rust
pub(super) initial_terminal_geometry: Option<(u16, u16)>,
```

Add the same private field to `ResolvedTaskSpawn` in `task_creator/mod.rs`:

```rust
initial_terminal_geometry: Option<(u16, u16)>,
```

Add this focused resolver in `task_creator/mod.rs`:

```rust
const MAX_INITIAL_TERMINAL_COLS: u16 = 320;
const MAX_INITIAL_TERMINAL_ROWS: u16 = 256;

fn resolve_initial_terminal_geometry(
    cols: Option<u16>,
    rows: Option<u16>,
) -> Option<(u16, u16)> {
    match (cols, rows) {
        (Some(cols), Some(rows))
            if cols > 0
                && rows > 0
                && cols <= MAX_INITIAL_TERMINAL_COLS
                && rows <= MAX_INITIAL_TERMINAL_ROWS =>
        {
            Some((cols, rows))
        }
        _ => None,
    }
}
```

Document that the upper bound caps the daemon headless terminal's 10,000-row
scrollback budget at roughly 63 MiB. Add a preparation test proving an
oversized pair falls back to `80x24`; do not clamp oversized values.

In `prepare_task_for_api`, set:

```rust
initial_terminal_geometry: resolve_initial_terminal_geometry(
    request.terminal_cols,
    request.terminal_rows,
),
```

Set `initial_terminal_geometry: None` in the singleton, integration, and merge `TaskCreationRequest` constructors.

Move the value into `ResolvedTaskSpawn` in `resolve_task_spawn`:

```rust
initial_terminal_geometry: request.initial_terminal_geometry,
```

- [ ] **Step 5: Apply the pair only to the newly prepared PTY session**

Make the session mutable in `prepare_new_task_session`, then update only the PTY variant:

```rust
let (mut session, provider_session_id) = build_prepared_session(/* existing arguments */)?;
if let (
    Some((requested_cols, requested_rows)),
    PreparedSessionSpawn::Pty { cols, rows, .. },
) = (resolved.initial_terminal_geometry, &mut session)
{
    *cols = requested_cols;
    *rows = requested_rows;
}
```

Do not change the `80x24` defaults inside `build_prepared_session`; those remain the default for desktop, CLI, stage transitions, teardown, and incomplete, invalid, or oversized create requests. `PreparedSessionSpawn::Agent` remains untouched.

- [ ] **Step 6: Format and run focused Rust tests**

Run:

```bash
cargo fmt --all
cargo fmt --all -- --check
cargo test -p kanna-server requested_initial_terminal_geometry
cargo test -p kanna-server create_task_request_uses_agent_type_camel_case
```

Expected: formatting check and all selected tests PASS.

- [ ] **Step 7: Run the full kanna-server test suite**

Run:

```bash
cargo test -p kanna-server
```

Expected: all kanna-server tests PASS.

### Task 4: Cross-Layer Verification and Diff Review

**Files:**
- Verify all files changed by Tasks 1-3
- Verify: `docs/superpowers/specs/2026-07-15-mobile-created-terminal-geometry-design.md`

- [ ] **Step 1: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand
```

Expected: all mobile tests PASS.

- [ ] **Step 2: Run mobile typecheck again after integration**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run repository Rust verification**

Run:

```bash
./kd test rust
```

Expected: all repository Rust checks and tests PASS.

- [ ] **Step 4: Review the final patch**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- apps/mobile/src crates/kanna-server/src docs/superpowers
```

Expected: no whitespace errors; only the approved mobile geometry, request plumbing, server spawn, tests, spec, and plan are changed.

- [ ] **Step 5: Confirm requirements line by line**

Verify from test output and the diff:

```text
[ ] Phone-sized create requests use 80x48.
[ ] iPad-sized create requests expand beyond 80x48.
[ ] Geometry is carried through LAN and remote routing.
[ ] Kanna-server applies geometry only to initial PTY sessions.
[ ] Missing, partial, and zero geometry retain 80x24.
[ ] Geometry above 320x256 retains 80x24 without being clamped.
[ ] Mobile WebView still renders snapshot geometry and sends no resize.
[ ] No commit, push, or PR was created.
```

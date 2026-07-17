# Mobile Tasks Newest-First Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile app's repo-scoped Tasks tab display tasks by creation time, newest first, without changing Recent or search ordering.

**Architecture:** Preserve the creation timestamp already present in Firestore and SQLite through the shared optional `TaskSummary.createdAt` field. Sort a copied list only at the `TasksScreen` presentation boundary, after repo filtering, so LAN, relay, and merged sources behave consistently while Recent keeps its source-defined activity ordering.

**Tech Stack:** TypeScript, React Native, Vitest, Rust, Axum/Serde, SQLite

---

## File map

- `apps/mobile/src/lib/api/types.ts`: shared mobile task-summary contract.
- `apps/mobile/src/lib/firebase/taskIndex.ts`: Firestore task parsing and cloud-to-mobile summary mapping.
- `apps/mobile/src/lib/firebase/taskIndex.test.ts`: cloud parsing and mapping regression coverage.
- `crates/kanna-server/src/mobile_api.rs`: SQLite-backed LAN task summary contract and mapping.
- `crates/kanna-server/src/http_api/tests/core_routes.rs`: HTTP serialization contract coverage.
- `apps/mobile/src/screens/TasksScreen.tsx`: repo filtering and Tasks-only presentation ordering.
- `apps/mobile/src/screens/TasksScreen.test.tsx`: Tasks/Recent ordering behavior and immutability coverage.

### Task 1: Preserve Firestore creation time in mobile summaries

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts:95-110`
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts:14-40,242-275,309-335`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts:56-78,190-260`

- [ ] **Step 1: Write the failing cloud mapping test**

Add `createdAt` to `validTask`, require it in the direct mapping expectation, and add a one-shot Firestore read assertion using a SQLite timestamp:

```diff
 function validTask(
   overrides: Record<string, unknown> = {},
 ): Record<string, unknown> {
   return {
     cloudTaskId: "cloud-task-1",
     localRepoId: "local-repo-1",
     ownerDesktopId: "desktop-1",
     ownerLocalTaskId: "task-1",
     title: "Fix mobile cloud",
     promptSnippet: "Fix mobile cloud",
     waitingPromptSnippet: null,
     displayName: null,
     stage: "in progress",
     status: "active",
     repo: { cloudRepoId: "cloud-repo-1", name: "kanna" },
+    createdAt: "2026-05-14T00:00:00.000Z",
     updatedAt: "2026-05-14T00:01:00.000Z",
     closedAt: null,
     ...overrides,
   };
 }
@@
         blockedByTaskIds: [],
         createdAt: "2026-05-14T00:00:00.000Z",
         updatedAt: "2026-05-14T00:01:00.000Z",
         closedAt: null,
       }),
     ).toEqual({
       id: "cloud-task-1",
       repoId: "repo-1",
       repoName: "kanna",
       title: "Short renamed cloud task",
       prompt:
         "Canonical prompt first line\nDetailed cloud requirements stay distinct from the rename.\nCLOUD_PROMPT_END_SENTINEL",
       stage: "in progress",
+      createdAt: "2026-05-14T00:00:00.000Z",
       waitingPromptSnippet: "Ready for review",
       agentProvider: "claude",
       agentType: "agent",
       activity: "working",
       ownerDesktopId: "desktop-1",
       ownerLocalRepoId: "local-repo-1",
       ownerLocalTaskId: "task-1",
       ownerOnline: false,
     });
```

In the existing `lists tasks from desktop task subcollections` test, seed `createdAt: "2026-05-14 00:00:00"` and assert:

```ts
expect(tasks[0]).toMatchObject({
  createdAt: "2026-05-14T00:00:00.000Z",
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts
```

Expected: FAIL because mapped summaries do not contain `createdAt`.

- [ ] **Step 3: Implement the shared and cloud contracts**

Add the optional field to `TaskSummary`:

```diff
 export interface TaskSummary {
   id: string;
   repoId: string;
   repoName?: string | null;
   title: string;
   prompt?: string | null;
   stage: string | null;
+  createdAt?: string | null;
   waitingPromptSnippet?: string | null;
   agentProvider?: string | null;
   agentType?: "pty" | "agent" | null;
   ownerDesktopId?: string;
   ownerLocalRepoId?: string;
   ownerLocalTaskId?: string;
   ownerOnline?: boolean;
   activity?: TaskActivity | null;
 }
```

Require normalized creation time in parsed Firestore snapshots and preserve it in summaries:

```diff
 export interface CloudTaskSnapshot {
   cloudTaskId?: string;
   localRepoId?: string;
   ownerDesktopId: string;
   ownerLocalTaskId: string;
   title: string;
   promptSnippet?: string | null;
   waitingPromptSnippet?: string | null;
   displayName?: string | null;
   stage: string;
   activity?: string | null;
   status?: string;
   repo: { cloudRepoId: string; name: string };
   agent?: { provider?: string | null; type?: string | null } | null;
+  createdAt: string;
   updatedAt: string;
   closedAt?: string | null;
 }
@@
+  const createdAt = normalizeCloudTimestamp(value.createdAt);
+  if (!createdAt) {
+    throw new Error("cloud task document createdAt must be a timestamp");
+  }
   const updatedAt = normalizeCloudTimestamp(value.updatedAt);
   if (!updatedAt) {
     throw new Error("cloud task document updatedAt must be a timestamp");
   }
@@
     agent: parseCloudTaskAgent(value.agent),
+    createdAt,
     updatedAt,
@@
     prompt: snapshot.promptSnippet ?? undefined,
     stage: snapshot.stage,
+    createdAt: snapshot.createdAt,
     waitingPromptSnippet: snapshot.waitingPromptSnippet ?? undefined,
```

Add `createdAt` to the existing `legacySnapshot` fixture so its typed mapping calls continue to represent valid Firestore documents.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the cloud contract change**

```bash
git add apps/mobile/src/lib/api/types.ts apps/mobile/src/lib/firebase/taskIndex.ts apps/mobile/src/lib/firebase/taskIndex.test.ts
git commit -m "feat(mobile): preserve cloud task creation time"
```

### Task 2: Expose SQLite creation time through the LAN task API

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs:52-66,372-395`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs:1266-1313`

- [ ] **Step 1: Write the failing HTTP serialization assertion**

Extend `list_repo_tasks_route_returns_repo_scoped_tasks` after decoding the JSON response:

```rust
assert_eq!(json[0]["createdAt"], "2026-04-17 07:00:00");
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run:

```bash
cargo test -p kanna-server list_repo_tasks_route_returns_repo_scoped_tasks -- --exact
```

Expected: FAIL because `createdAt` is absent from the serialized task summary.

- [ ] **Step 3: Map the existing database field into the API summary**

Add the optional field and populate it without changing database ordering:

```diff
 pub struct TaskSummary {
     pub id: String,
     pub repo_id: String,
     pub title: String,
     pub prompt: Option<String>,
     pub stage: Option<String>,
+    pub created_at: Option<String>,
     pub activity: Option<String>,
     pub snippet: Option<String>,
     pub waiting_prompt_snippet: Option<String>,
     pub agent_type: Option<String>,
 }
@@
         title,
         prompt,
         stage: item.stage,
+        created_at: item.created_at,
         activity: item.activity,
```

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run:

```bash
cargo test -p kanna-server list_repo_tasks_route_returns_repo_scoped_tasks -- --exact
```

Expected: PASS.

- [ ] **Step 5: Commit the LAN contract change**

```bash
git add crates/kanna-server/src/mobile_api.rs crates/kanna-server/src/http_api/tests/core_routes.rs
git commit -m "feat(server): expose task creation time to mobile"
```

### Task 3: Sort only the mobile Tasks tab newest first

**Files:**
- Modify: `apps/mobile/src/screens/TasksScreen.tsx:16-34`
- Test: `apps/mobile/src/screens/TasksScreen.test.tsx:50-125`

- [ ] **Step 1: Write the failing Tasks-screen ordering test**

Add this test and strengthen the Recent test with timestamps whose creation order conflicts with source order:

```ts
it("orders repo tasks by creation time newest first without mutating input", () => {
  if (!TasksScreen || !TaskList) throw new Error("TasksScreen was not loaded");
  const tasks = [
    {
      id: "task-old",
      repoId: "repo-a",
      title: "Old task",
      stage: "in progress",
      createdAt: "2026-07-15 08:00:00"
    },
    {
      id: "task-new",
      repoId: "repo-a",
      title: "New task",
      stage: "in progress",
      createdAt: "2026-07-17T08:00:00.000Z"
    },
    {
      id: "task-undated",
      repoId: "repo-a",
      title: "Undated task",
      stage: "in progress"
    }
  ];

  const tree = TasksScreen({
    heading: "Tasks",
    repos: [{ id: "repo-a", name: "Repo A" }],
    selectedRepoId: "repo-a",
    tasks,
    onOpenTask: vi.fn(),
    onSelectRepo: vi.fn()
  }) as ElementNode;

  expect(
    (findElement(tree, TaskList)?.props?.tasks as typeof tasks).map(({ id }) => id)
  ).toEqual(["task-new", "task-old", "task-undated"]);
  expect(tasks.map(({ id }) => id)).toEqual([
    "task-old",
    "task-new",
    "task-undated"
  ]);
});
```

In `keeps Recent pan-repo...`, give `task-a` a newer `createdAt` than `task-b` while leaving the source array as `[task-a, task-b]`, and continue asserting exact equality with `tasks`.

- [ ] **Step 2: Run the focused component test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TasksScreen.test.tsx
```

Expected: FAIL with the actual order `task-old`, `task-new`, `task-undated`.

- [ ] **Step 3: Implement a Tasks-only stable sort**

Add helpers that understand both SQLite and ISO timestamp strings:

```ts
const sqliteTimestampPattern =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function taskCreationTimestamp(task: TaskSummary): number | null {
  const value = task.createdAt?.trim();
  if (!value) return null;
  const normalized = sqliteTimestampPattern.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function sortTasksNewestFirst(tasks: readonly TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((left, right) => {
    const leftTimestamp = taskCreationTimestamp(left);
    const rightTimestamp = taskCreationTimestamp(right);
    if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
    if (rightTimestamp === null) return -1;
    return rightTimestamp - leftTimestamp;
  });
}
```

Then keep Recent untouched and sort only repo-scoped tasks:

```ts
const filteredTasks = !isRecentView && selectedRepoId
  ? tasks.filter((task) => task.repoId === selectedRepoId)
  : tasks;
const visibleTasks = isRecentView
  ? filteredTasks
  : sortTasksNewestFirst(filteredTasks);

<TaskList
  emptyLabel="No tasks yet."
  tasks={visibleTasks}
  testID={MOBILE_E2E_IDS.tasksScreen}
  onOpenTask={onOpenTask}
/>
```

- [ ] **Step 4: Run the focused component test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TasksScreen.test.tsx
```

Expected: PASS, including the existing Recent source-order assertion.

- [ ] **Step 5: Commit the Tasks-screen behavior**

```bash
git add apps/mobile/src/screens/TasksScreen.tsx apps/mobile/src/screens/TasksScreen.test.tsx
git commit -m "fix(mobile): order tasks newest first"
```

### Task 4: Cover newest-first ordering across the cloud/Appium boundary

**Files:**
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Test: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Test: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/run.ts`

- [ ] **Step 1: Write the failing relay journey-contract test**

Add a test that supplies task-row elements in source order `[older, newer]`, invokes `verifyTasksTabNewestFirst`, and expects the helper to click the Tasks tab and reject the reversed native order until the production journey helper exists.

- [ ] **Step 2: Run the focused journey-contract test and verify RED**

```bash
pnpm --dir apps/mobile test -- e2e/specs/relay/relay-task-flow.test.ts
```

Expected: FAIL because `verifyTasksTabNewestFirst` is not exported.

- [ ] **Step 3: Add deterministic relay fixtures and the native-order assertion**

Publish two same-repo cloud tasks through the relay harness with distinct `createdAt` values and opposing `updatedAt` values. Expose their source and expected visual ID orders from `MobileRelayHarness`. In the relay journey, select `selectors.tasksTab`, wait for both task rows, read each row's native `name`, filter to the fixture IDs, and require `[newer, older]`.

- [ ] **Step 4: Run focused relay tests and verify GREEN**

```bash
pnpm --dir apps/mobile test -- e2e/helpers/relay-harness.test.ts e2e/specs/relay/relay-task-flow.test.ts
```

Expected: PASS.

### Task 5: Verify the integrated change

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run focused mobile tests together**

```bash
pnpm --dir apps/mobile test -- src/screens/TasksScreen.test.tsx src/lib/firebase/taskIndex.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run mobile typechecking**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the Kanna server library tests**

```bash
cargo test -p kanna-server
```

Expected: PASS.

- [ ] **Step 4: Run the repository-wide JavaScript/TypeScript suite**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Run daemon tests serially**

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: PASS.

- [ ] **Step 6: Run repository diff checks**

```bash
git diff --check HEAD~3
git status --short
```

Expected: no whitespace errors; only intentional tracked changes or generated local artifacts are reported.

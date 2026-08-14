# Global Activity Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Shift+Cmd+U` and `Shift+Cmd+R` select the oldest eligible unread/read task across all visible repositories while preserving the current-repository behavior of `Cmd+U` and `Cmd+R`.

**Architecture:** Keep activity candidate selection in `useAppTaskNavigation`, but give its read and unread-with-fallback helpers an explicit `currentRepo | allRepos` scope. Reuse the existing all-visible-repositories projection and `selectSidebarItem` cross-repository path, then rename the Shift actions and localized labels to reflect global-oldest semantics. Keep one workspace presentation-slot history ledger in the selection store, but apply Back/Forward targets through `useAppTaskNavigation` so local and remote owners share the same repository-aware path and selection-intent fence.

**Tech Stack:** Vue 3, TypeScript, Pinia-compatible app store projections, Vitest, Vue Test Utils, vue-i18n JSON locales.

---

## Working Constraints

- Work only in the current Kanna worktree and branch.
- Use `pnpm` for every test and build command.
- Follow red-green-refactor: each production change follows a focused failing test run.
- Do not commit during this stage; Kanna's later workflow stage owns the commit.
- Do not remove `selectTaskByActivity`'s generic `"newest"` mode. It is harmless, independently tested utility behavior and is outside this shortcut change.

## File Map

- `apps/desktop/src/composables/useAppTaskNavigation.ts` — choose current-repository or all-repositories candidates, apply the existing eligibility filters, and select the oldest task.
- `apps/desktop/src/composables/useAppKeyboardActions.ts` — bind each keyboard action to the correct navigation scope.
- `apps/desktop/src/composables/useKeyboardShortcuts.ts` — define the final global action names, keys, and shortcut-label keys.
- `apps/desktop/src/App.test.ts` — integration coverage for local scope, global scope, cross-repository selection, eligibility filters, and unread-to-read fallback.
- `apps/desktop/src/composables/useKeyboardShortcuts.test.ts` — registry and dispatch coverage for the renamed Shift actions.
- `apps/desktop/src/components/__tests__/KeyboardShortcutsModal.test.ts` — displayed label-key coverage for the two Shift shortcuts.
- `apps/desktop/src/i18n/locales/en.json` — English labels.
- `apps/desktop/src/i18n/locales/ja.json` — Japanese labels.
- `apps/desktop/src/i18n/locales/ko.json` — Korean labels.
- `docs/specs/native-review.md` — remove the stale claim that the U/R Shift pairs mean the opposite direction.
- `apps/desktop/src/stores/selection.ts` — expose identity-agnostic history ledger operations and selection record opt-out.
- `apps/desktop/src/stores/kanna.ts` / `apps/desktop/src/stores/state.ts` — publish the ledger boundary and remove the local-only history applier.
- `apps/desktop/src/composables/useAppTaskNavigation.test.ts` / `apps/desktop/src/composables/useAppKeyboardActions.test.ts` / `apps/desktop/src/stores/selection.test.ts` — cover remote history, intent cancellation, and keyboard delegation.
- `apps/desktop/tests/e2e/mock/keyboard-shortcuts.test.ts` — keep the active end-to-end contract aligned with local-unshifted/global-shifted semantics.

### Task 1: Change the Shift Actions from Current-Repo Newest to Global Oldest

**Files:**
- Modify: `apps/desktop/src/App.test.ts:446-450`
- Modify: `apps/desktop/src/App.test.ts:682-715`
- Modify: `apps/desktop/src/App.test.ts:2373-2435`
- Modify: `apps/desktop/src/App.test.ts:2767-3015`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts:90-98`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts:271-298`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts:75-80`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts:250-258`

- [x] **Step 1: Retain the unshifted current-repository assertions and remove obsolete newest-within-current-repository assertions**

In `apps/desktop/src/App.test.ts`, rename the existing combined cases so they cover only the unshifted actions and delete each second `goToNewestRead()` / `goToNewestUnread()` invocation and its newest-task expectation. The resulting assertion shape must be:

```ts
capturedKeyboardActions?.goToOldestRead();
expect(store.selectItem).toHaveBeenCalledWith("read-oldest");
```

for read cases, and:

```ts
capturedKeyboardActions?.goToOldestUnread();
expect(store.selectItem).toHaveBeenCalledWith("unread-oldest");
```

for unread cases. Apply this to the existing absolute-order, pinned, blocked-read, teardown, and unread-fallback cases. Keep the existing test named `keeps unread task shortcuts scoped to the selected repo before falling back to read tasks` and `keeps read task shortcuts scoped to the selected repo` unchanged; they are the local-scope regression coverage.

- [x] **Step 2: Add failing global-oldest behavior tests using the current internal Shift action names**

First, make the existing sidebar stub expose a controllable search query so the global candidate test proves that the all-repositories path continues to honor sidebar filtering:

```ts
const sidebarSearchQuery = ref("");

const SidebarWithRepoStub = defineComponent({
  name: "Sidebar",
  emits: ["new-task"],
  setup(_, { expose }) {
    expose({ searchQuery: sidebarSearchQuery });
  },
  template: '<button data-testid="open-new-task" @click="$emit(\'new-task\', \'repo-1\')">open</button>',
});
```

Reset it in `beforeEach` with:

```ts
sidebarSearchQuery.value = "";
```

Then add the following cases near the existing activity-shortcut tests. The first red/green cycle deliberately calls `goToNewestUnread` and `goToNewestRead`; Task 2 renames those internal actions after their new behavior is proven.

```ts
it("uses the shifted unread action to select the oldest unread task across visible repos", async () => {
  store.repos = [
    { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
    { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
  ];
  store.selectedRepoId = "repo-1";
  store.selectedItemId = "current";
  sidebarSearchQuery.value = "target";
  store.sortedItemsAllRepos = [
    { id: "hidden-oldest", repo_id: "repo-hidden", prompt: "target hidden", activity: "unread", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "filtered-out-oldest", repo_id: "repo-2", prompt: "unrelated", activity: "unread", created_at: "2026-03-31T00:30:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "pinned-oldest", repo_id: "repo-2", prompt: "target pinned", activity: "unread", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 1, stage: "in progress" },
    { id: "tearing-down", repo_id: "repo-2", prompt: "target teardown", activity: "unread", created_at: "2026-03-31T02:00:00.000Z", tags: "[]", pinned: 0, stage: "pr", teardown_started_at: "2026-07-15T00:00:00.000Z" },
    { id: "global-oldest", repo_id: "repo-2", prompt: "target global oldest", activity: "unread", created_at: "2026-03-31T03:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "local-newer", repo_id: "repo-1", prompt: "target local newer", activity: "unread", created_at: "2026-03-31T04:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
  ];

  await mountApp(SidebarWithRepoStub);
  await capturedKeyboardActions?.goToNewestUnread();
  await flushPromises();

  expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
  expect(store.selectItem).toHaveBeenCalledWith("global-oldest", { previousItemId: "current" });
});

it("uses the shifted unread action to fall back to the oldest read task across visible repos", async () => {
  store.repos = [
    { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
    { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
  ];
  store.selectedRepoId = "repo-1";
  store.selectedItemId = "current";
  store.sortedItemsAllRepos = [
    { id: "blocked-oldest", repo_id: "repo-2", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "global-read-oldest", repo_id: "repo-2", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "local-read-newer", repo_id: "repo-1", activity: "idle", created_at: "2026-03-31T02:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
  ];
  store.taskBlockers = [{ blocked_item_id: "blocked-oldest", blocker_item_id: "missing-blocker" }];

  await mountApp(SidebarWithRepoStub);
  await capturedKeyboardActions?.goToNewestUnread();
  await flushPromises();

  expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
  expect(store.selectItem).toHaveBeenCalledWith("global-read-oldest", { previousItemId: "current" });
});

it("uses the shifted read action to select the oldest read task across visible repos", async () => {
  store.repos = [
    { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
    { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
  ];
  store.selectedRepoId = "repo-1";
  store.selectedItemId = "current";
  store.sortedItemsAllRepos = [
    { id: "global-read-oldest", repo_id: "repo-2", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "working-older", repo_id: "repo-2", activity: "working", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
    { id: "local-read-newer", repo_id: "repo-1", activity: "idle", created_at: "2026-03-31T02:00:00.000Z", tags: "[]", pinned: 0, stage: "in progress" },
  ];

  await mountApp(SidebarWithRepoStub);
  await capturedKeyboardActions?.goToNewestRead();
  await flushPromises();

  expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
  expect(store.selectItem).toHaveBeenCalledWith("global-read-oldest", { previousItemId: "current" });
});
```

- [x] **Step 3: Run the focused App tests and verify the new expectations fail for the right reason**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/App.test.ts
```

Expected: FAIL in the three new cases. The current implementation searches the current repository and uses `"newest"`, so it must not select `global-oldest` / `global-read-oldest` in `repo-2`.

- [x] **Step 4: Add an explicit activity-shortcut scope and reuse it for unread fallback**

In `apps/desktop/src/composables/useAppTaskNavigation.ts`, add the scope type beside the candidate helpers:

```ts
type ActivityShortcutScope = "currentRepo" | "allRepos";
```

Replace the two activity selection functions with:

```ts
function activityShortcutItems(scope: ActivityShortcutScope): SidebarTaskItem[] {
  return scope === "allRepos"
    ? visibleSidebarItemsAllRepos()
    : visibleSidebarItemsForCurrentRepo();
}

async function selectReadTask(scope: ActivityShortcutScope) {
  const target = selectTaskByActivity(
    activityShortcutItems(scope).filter((item) =>
      isActivityShortcutCandidate(item)
      && isUnpinnedActivityShortcutCandidate(item)
      && !isBlocked(item.task_id)
    ),
    "oldest",
    "idle",
  );
  if (target) await selectSidebarItem(target);
}

async function selectUnreadTaskWithReadFallback(scope: ActivityShortcutScope) {
  const target = selectTaskByActivity(
    activityShortcutItems(scope).filter((item) =>
      isActivityShortcutCandidate(item)
      && isUnpinnedActivityShortcutCandidate(item)
    ),
    "oldest",
    "unread",
  );
  if (target) {
    await selectSidebarItem(target);
    return;
  }
  await selectReadTask(scope);
}
```

This keeps hidden repositories out because `visibleSidebarItemsAllRepos()` iterates `sidebarRepos`, preserves the sidebar search query because both projections use `visibleSidebarItemsForRepo()`, and keeps all eligibility rules shared.

- [x] **Step 5: Update the navigation callback types and temporarily wire the legacy Shift action names to global scope**

In `apps/desktop/src/composables/useAppKeyboardActions.ts`, change the option types to:

```ts
selectUnreadTaskWithReadFallback: (scope: "currentRepo" | "allRepos") => Promise<void>;
selectReadTask: (scope: "currentRepo" | "allRepos") => Promise<void>;
```

Then change the four action bindings to:

```ts
goToOldestUnread: () => selectUnreadTaskWithReadFallback("currentRepo"),
goToNewestUnread: () => selectUnreadTaskWithReadFallback("allRepos"),
goToOldestRead: () => selectReadTask("currentRepo"),
goToNewestRead: () => selectReadTask("allRepos"),
```

- [x] **Step 6: Run the focused App tests and verify green**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/App.test.ts
```

Expected: PASS with no failed App tests. Do not commit; proceed to the naming cycle.

### Task 2: Rename the Shift Actions and Labels to Global-Oldest Semantics

**Files:**
- Modify: `apps/desktop/src/App.test.ts` (the three new Shift-action cases)
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.test.ts:68-79`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.test.ts:191-237`
- Modify: `apps/desktop/src/components/__tests__/KeyboardShortcutsModal.test.ts:40-55`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:39-47`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:112-115`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts:250-258`
- Modify: `apps/desktop/src/i18n/locales/en.json:96-99`
- Modify: `apps/desktop/src/i18n/locales/ja.json:96-99`
- Modify: `apps/desktop/src/i18n/locales/ko.json:96-99`
- Modify: `docs/specs/native-review.md:120-123`

- [x] **Step 1: Change tests to require the final action names and label keys**

In the three global cases from Task 1, replace:

```ts
goToNewestUnread
goToNewestRead
```

with:

```ts
goToOldestUnreadAllRepos
goToOldestReadAllRepos
```

In `apps/desktop/src/composables/useKeyboardShortcuts.test.ts`, change the move-around label-key expectations to:

```ts
expect(groupMap["shortcuts.groupMoveAround"]).toEqual([
  "shortcuts.previousTask",
  "shortcuts.nextTask",
  "shortcuts.previousRepo",
  "shortcuts.nextRepo",
  "shortcuts.goBack",
  "shortcuts.goForward",
  "shortcuts.oldestUnread",
  "shortcuts.oldestUnreadAllRepos",
  "shortcuts.oldestRead",
  "shortcuts.oldestReadAllRepos",
]);
```

Change the `actionNames` tail to:

```ts
"goToOldestUnread",
"goToOldestUnreadAllRepos",
"goToOldestRead",
"goToOldestReadAllRepos",
```

Add this registry/dispatch test inside `describe("useKeyboardShortcuts", ...)`:

```ts
it.each([
  { key: "U", action: "goToOldestUnreadAllRepos" as const, labelKey: "shortcuts.oldestUnreadAllRepos" },
  { key: "R", action: "goToOldestReadAllRepos" as const, labelKey: "shortcuts.oldestReadAllRepos" },
])("maps Shift+Command+$key to $action", ({ key, action, labelKey }) => {
  expect(shortcuts.find((shortcut) => shortcut.action === action)).toMatchObject({
    key: [key, key.toLowerCase()],
    meta: true,
    shift: true,
    labelKey,
  });

  const actions = buildActions();
  const wrapper = mountShortcutHarness(actions, () => "main");
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }));

  expect(actions[action]).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
```

In `apps/desktop/src/components/__tests__/KeyboardShortcutsModal.test.ts`, add the displayed Shift labels alongside the existing row-10 read assertion:

```ts
expect(entryAt("2", "9")).toBe("shortcuts.oldestUnreadAllRepos⇧⌘U");
expect(entryAt("2", "11")).toBe("shortcuts.oldestReadAllRepos⇧⌘R");
```

- [x] **Step 2: Run the registry, modal, and App tests and verify red**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/App.test.ts \
  src/composables/useKeyboardShortcuts.test.ts \
  src/components/__tests__/KeyboardShortcutsModal.test.ts
```

Expected: FAIL because the final `*AllRepos` actions and label keys do not exist yet. The Task 1 behavior tests should fail only at the renamed action boundary, not because of task ordering.

- [x] **Step 3: Rename the shortcut action union and registry entries**

In `apps/desktop/src/composables/useKeyboardShortcuts.ts`, replace the two newest action names in `ActionName` with:

```ts
| "goToOldestUnreadAllRepos"
| "goToOldestReadAllRepos";
```

Keep the local definitions and replace the Shift definitions with:

```ts
{ action: "goToOldestUnread", labelKey: "shortcuts.oldestUnread", groupKey: "shortcuts.groupMoveAround", key: "u", meta: true, display: "⌘U", context: ["main"] },
{ action: "goToOldestUnreadAllRepos", labelKey: "shortcuts.oldestUnreadAllRepos", groupKey: "shortcuts.groupMoveAround", key: ["U", "u"], meta: true, shift: true, display: "⇧⌘U", context: ["main"] },
{ action: "goToOldestRead", labelKey: "shortcuts.oldestRead", groupKey: "shortcuts.groupMoveAround", key: "r", meta: true, display: "⌘R", context: ["main"] },
{ action: "goToOldestReadAllRepos", labelKey: "shortcuts.oldestReadAllRepos", groupKey: "shortcuts.groupMoveAround", key: ["R", "r"], meta: true, shift: true, display: "⇧⌘R", context: ["main"] },
```

- [x] **Step 4: Rename the keyboard action bindings without changing the proven scope behavior**

In `apps/desktop/src/composables/useAppKeyboardActions.ts`, replace the temporary Task 1 bindings with:

```ts
goToOldestUnread: () => selectUnreadTaskWithReadFallback("currentRepo"),
goToOldestUnreadAllRepos: () => selectUnreadTaskWithReadFallback("allRepos"),
goToOldestRead: () => selectReadTask("currentRepo"),
goToOldestReadAllRepos: () => selectReadTask("allRepos"),
```

- [x] **Step 5: Replace the obsolete newest locale keys with explicit all-repositories labels**

Use these exact entries:

`apps/desktop/src/i18n/locales/en.json`:

```json
"oldestUnread": "Oldest Unread Task",
"oldestUnreadAllRepos": "Oldest Unread Task Across Repos",
"oldestRead": "Oldest Read Task",
"oldestReadAllRepos": "Oldest Read Task Across Repos"
```

`apps/desktop/src/i18n/locales/ja.json`:

```json
"oldestUnread": "最も古い未読タスク",
"oldestUnreadAllRepos": "全リポジトリで最も古い未読タスク",
"oldestRead": "最も古い既読タスク",
"oldestReadAllRepos": "全リポジトリで最も古い既読タスク"
```

`apps/desktop/src/i18n/locales/ko.json`:

```json
"oldestUnread": "가장 오래된 읽지 않은 작업",
"oldestUnreadAllRepos": "모든 저장소에서 가장 오래된 읽지 않은 작업",
"oldestRead": "가장 오래된 읽은 작업",
"oldestReadAllRepos": "모든 저장소에서 가장 오래된 읽은 작업"
```

- [x] **Step 6: Remove the stale opposite-direction shortcut analogy from the native-review spec**

In `docs/specs/native-review.md`, replace the `Shift+Cmd+S` bullet opening with:

```md
- **`⇧⌘S` request changes** — the shifted counterpart to `⌘S`: send the
  task back down. Opens the summary composer with the pending comments
  listed; `⌘Enter` sends.
```

This keeps the review shortcut's meaning accurate without claiming that the U/R Shift pairs still select the opposite direction.

- [x] **Step 7: Run the focused tests and verify green**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/App.test.ts \
  src/composables/useKeyboardShortcuts.test.ts \
  src/components/__tests__/KeyboardShortcutsModal.test.ts
```

Expected: PASS with all three files green and no unhandled errors.

### Task 3: Refactor Check and Full Verification

**Files:**
- Review: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Review: `apps/desktop/src/composables/useAppKeyboardActions.ts`
- Review: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Review: `apps/desktop/src/App.test.ts`
- Review: `apps/desktop/src/composables/useKeyboardShortcuts.test.ts`
- Review: `apps/desktop/src/components/__tests__/KeyboardShortcutsModal.test.ts`
- Review: `apps/desktop/src/i18n/locales/en.json`
- Review: `apps/desktop/src/i18n/locales/ja.json`
- Review: `apps/desktop/src/i18n/locales/ko.json`
- Review: `docs/specs/native-review.md`

- [x] **Step 1: Confirm obsolete shortcut names and labels are gone from active desktop code and docs**

Run:

```bash
rg -n "goToNewestUnread|goToNewestRead|shortcuts\.newestUnread|shortcuts\.newestRead|\"newestUnread\"|\"newestRead\"" \
  apps/desktop/src docs/specs/native-review.md
```

Expected: no output and exit code 1 from `rg` because no active references remain.

- [x] **Step 2: Re-run the focused regression suite from a clean command invocation**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/App.test.ts \
  src/composables/useKeyboardShortcuts.test.ts \
  src/components/__tests__/KeyboardShortcutsModal.test.ts \
  src/utils/selectTaskByActivity.test.ts
```

Expected: PASS. The utility suite confirms oldest remains based on `created_at` and working tasks remain separate from idle/read tasks.

- [x] **Step 3: Run the desktop typecheck and production frontend build**

Run:

```bash
pnpm --dir apps/desktop run build
```

Expected: exit code 0 from `vue-tsc --noEmit && vite build`.

- [x] **Step 4: Run the repository's canonical JavaScript test command**

Run:

```bash
pnpm test
```

Expected: exit code 0 with no failed test suites.

- [x] **Step 5: Inspect the final diff and whitespace**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: `git diff --check` exits 0; status lists only the approved design/plan and implementation files; no unrelated files appear. Leave all changes uncommitted for the Kanna workflow.

### Task 4: Final-Review Remediation

- [x] Reproduce the cloud-target history gap and stale E2E expectations.
- [x] Make the shared history ledger accept local and remote presentation-slot IDs.
- [x] Route Back/Forward through the workspace-aware selection path and selection-intent fence.
- [x] Add focused coverage for remote Back/Forward, circular-record suppression, keyboard delegation, and pending-selection cancellation.
- [x] Guard external-refresh focus restoration against a newer repo or presentation-slot selection.
- [x] Update and run the active mock E2E keyboard shortcut contract.
- [x] Route sidebar row clicks through the atomic repo/item selection path and suppress stale repo-only persistence.
- [x] Repeat the full unit suite, production frontend build, diff audit, and final code review.

The keyboard shortcut E2E run passes every shortcut-contract scenario (18 of 19 tests in the file). Its one remaining failure is the pre-existing, unrelated cloud-only projection refresh scenario.

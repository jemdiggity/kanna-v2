# Empty Unpin Drop Zone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag a pinned task below the pin divider to unpin it when the repository has no unpinned stage lists.

**Architecture:** `Sidebar.vue` will keep one empty, connected `vuedraggable` receiver mounted only for the all-pinned layout. Existing drag tracking will determine when that receiver receives an active CSS class, and the existing `onUnpinnedChange` handler will remain the sole mutation path.

**Tech Stack:** Vue 3 Composition API, TypeScript, `vuedraggable`/SortableJS, Vitest, Vue Test Utils, happy-dom.

---

## File Structure

- Modify `apps/desktop/src/components/Sidebar.vue`: derive the relevant pinned-drag state, render the empty connected receiver, and style its collapsed and active states.
- Modify `apps/desktop/src/components/__tests__/Sidebar.test.ts`: reproduce the all-pinned layout and verify receiver registration, drag visibility, event routing, and cleanup.

### Task 1: Add the all-pinned unpin receiver

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:447-535`
- Modify: `apps/desktop/src/components/Sidebar.vue:736-760`
- Modify: `apps/desktop/src/components/Sidebar.vue:1384-1405`
- Test: `apps/desktop/src/components/__tests__/Sidebar.test.ts:281-367`

- [ ] **Step 1: Write the failing regression test**

Add this test after `emits slot ids for selection and durable ids for ready mutations`:

```ts
it("shows a connected unpin receiver only while dragging in an all-pinned repository", async () => {
  const tasks = [
    item("task-1", {
      display_name: "First pinned task",
      pinned: 1,
      pin_order: 0,
    }),
    item("task-2", {
      display_name: "Second pinned task",
      pinned: 1,
      pin_order: 1,
      created_at: "2026-01-01T00:00:05.000Z",
    }),
  ];
  const wrapper = mountSidebar(tasks, null);
  const vm = wrapper.vm as {
    onTaskDragStart(evt: { item?: HTMLElement }): void;
    onTaskDragEnd(evt: { originalEvent?: Event }): void;
  };

  expect(wrapper.findAll(".type-zone")).toHaveLength(1);
  expect(wrapper.get(".empty-unpin-zone").classes()).not.toContain("empty-unpin-zone-active");

  const dragged = document.createElement("div");
  dragged.dataset.taskId = "task-1";
  vm.onTaskDragStart({ item: dragged });
  await nextTick();

  expect(wrapper.get(".empty-unpin-zone").classes()).toContain("empty-unpin-zone-active");

  wrapper.findComponent(".empty-unpin-zone").vm.$emit("change", {
    added: { element: tasks[0]!, newIndex: 0 },
  });
  await nextTick();

  expect(wrapper.emitted("unpin-item")).toEqual([["task-1"]]);
  expect(wrapper.emitted("reorder-pinned")).toEqual([[repo.id, ["task-2"]]]);

  vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup") });
  await nextTick();

  expect(wrapper.get(".empty-unpin-zone").classes()).not.toContain("empty-unpin-zone-active");
});
```

The existing plain blocked-task `.type-zone` is the one expected by the first assertion. The new receiver has its own class so the test proves a connected component exists instead of mistaking the plain container for a Sortable receiver.

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/components/__tests__/Sidebar.test.ts
```

Expected: FAIL in the new test because `.empty-unpin-zone` does not exist.

- [ ] **Step 3: Add the pinned-drag state helper**

Immediately after the existing drag-state refs, add a stable empty model and a repository-scoped helper:

```ts
const draggedTaskId = ref<string | null>(null);
const dropParentId = ref<string | null>(null);
const suppressParentDrop = ref(false);
const emptyTaskSlots: SidebarTaskItem[] = [];

function isPinnedTaskDragForRepo(repoId: string): boolean {
  const dragged = readyTaskByDurableId(draggedTaskId.value);
  return dragged?.repo_id === repoId && Boolean(dragged.pinned);
}
```

This reuses the durable-id lookup and limits the visual receiver to the repository that owns the dragged pinned task.

- [ ] **Step 4: Render the connected empty receiver**

Insert this immediately after the pin divider and before dynamic stage sections:

```vue
<draggable
  v-if="sortedPinned(repo.id).length > 0 && groupedByStage(repo.id).length === 0"
  :model-value="emptyTaskSlots"
  :group="{ name: `repo-${repo.id}` }"
  item-key="slot_id"
  :animation="150"
  :sort="false"
  :disabled="isSearchActive()"
  :move="canMoveTask"
  :force-fallback="true"
  ghost-class="sortable-ghost"
  chosen-class="sortable-chosen"
  fallback-class="sortable-fallback"
  class="empty-unpin-zone"
  :class="{ 'empty-unpin-zone-active': isPinnedTaskDragForRepo(repo.id) }"
  @change="(evt) => onUnpinnedChange(repo.id, evt)"
  @start="onTaskDragStart"
  @end="onTaskDragEnd"
>
  <template #item="{ element }">
    <div class="task-subtree" :data-task-id="element.task_id"></div>
  </template>
</draggable>
```

The receiver remains mounted before drag start so SortableJS can register it. It uses an empty `model-value` because authoritative task state continues to come from `taskSlots` after the emitted mutation refreshes the store.

- [ ] **Step 5: Style the receiver to appear only during a relevant drag**

Add these rules after `.pin-divider-line`:

```css
.empty-unpin-zone {
  min-height: 0;
  margin: 0 6px;
  overflow: hidden;
  border: 0 dashed transparent;
  border-radius: 4px;
  transition: min-height 120ms ease, border-width 120ms ease, background-color 120ms ease;
}

.empty-unpin-zone-active {
  min-height: 28px;
  border-width: 1px;
  border-color: var(--kn-border-strong);
  background: var(--kn-bg-hover);
}
```

The idle receiver consumes no vertical space. During a pinned drag, the active state provides a 28-pixel dashed target without a persistent label.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/components/__tests__/Sidebar.test.ts
```

Expected: PASS with all `Sidebar.test.ts` tests green and no Vue warnings.

- [ ] **Step 7: Run type checking and the desktop unit suite**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
pnpm --dir apps/desktop test
```

Expected: both commands exit 0; Vitest reports zero failed tests.

- [ ] **Step 8: Review the diff and commit the implementation**

Run:

```bash
git diff --check
git diff -- apps/desktop/src/components/Sidebar.vue apps/desktop/src/components/__tests__/Sidebar.test.ts
git add apps/desktop/src/components/Sidebar.vue apps/desktop/src/components/__tests__/Sidebar.test.ts
git commit -m "fix(desktop): allow dragging all-pinned tasks to unpin"
```

Expected: `git diff --check` produces no output, the diff contains only the receiver and its regression test, and the commit succeeds.

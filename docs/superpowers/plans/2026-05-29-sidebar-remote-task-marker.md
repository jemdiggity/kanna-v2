# Sidebar Remote Task Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a leading `< ` marker for non-local workspace tasks in the sidebar while preserving existing ordering and task styling.

**Architecture:** `App.vue` already receives `WorkspaceTask.owner.kind` from `buildWorkspace()`, so it should derive sidebar presentation metadata there before flattening tasks for `Sidebar.vue`. `Sidebar.vue` should treat the marker as display-only metadata and render it through the same title path for pinned, stage, and blocked rows.

**Tech Stack:** Vue 3 single-file components, Pinia-backed workspace state, Vitest with Vue Test Utils, TypeScript.

---

## File Structure

- Modify `apps/desktop/src/App.vue`: add a `remote_task` boolean to each computed sidebar item based on `task.owner.kind !== "local"`.
- Modify `apps/desktop/src/components/Sidebar.vue`: accept pipeline items with optional `remote_task`, render a muted monospace `< ` marker before remote task titles, and expose a discoverable label via `title`.
- Modify `apps/desktop/src/components/__tests__/Sidebar.test.ts`: add focused component tests that prove local and remote tasks render differently.

## Task 1: Pass Remote Ownership Metadata Into Sidebar Items

**Files:**
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Write the intended shape in the plan before editing production code**

The sidebar item computed value in `apps/desktop/src/App.vue` should become:

```ts
const sidebarItems = computed(() => workspace.value.tasks.map((task) => ({
  ...task.item,
  id: task.item.id,
  repo_id: task.repoKey,
  remote_task: task.owner.kind !== "local",
})));
```

- [ ] **Step 2: Implement the metadata pass-through**

Change the existing `sidebarItems` computed block in `apps/desktop/src/App.vue` from:

```ts
const sidebarItems = computed(() => workspace.value.tasks.map((task) => ({
  ...task.item,
  id: task.item.id,
  repo_id: task.repoKey,
})));
```

to:

```ts
const sidebarItems = computed(() => workspace.value.tasks.map((task) => ({
  ...task.item,
  id: task.item.id,
  repo_id: task.repoKey,
  remote_task: task.owner.kind !== "local",
})));
```

- [ ] **Step 3: Defer verification to Task 2**

This task only surfaces existing workspace ownership metadata. The user-visible behavior is verified by the component test added in Task 2.

## Task 2: Render And Test The Leading Remote Marker

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/__tests__/Sidebar.test.ts`

- [ ] **Step 1: Write the failing component test**

Add this test near the existing title-prefix tests in `apps/desktop/src/components/__tests__/Sidebar.test.ts`:

```ts
it("marks remote tasks with a leading angle marker and leaves local tasks unmarked", () => {
  const wrapper = mountSidebar([
    item("task-remote", {
      display_name: "LAN visible task",
      created_at: "2026-01-01T11:00:00.000Z",
      remote_task: true,
    } as Partial<PipelineItem>),
    item("task-local", {
      display_name: "Local cleanup",
      created_at: "2026-01-01T10:00:00.000Z",
    }),
  ], null);

  const titles = wrapper.findAll(".pipeline-item .item-title");
  expect(titles).toHaveLength(2);
  expect(titles[0]?.text()).toBe("< LAN visible task");
  expect(titles[0]?.attributes("title")).toBe("Remote task");
  expect(titles[0]?.find(".remote-task-marker").exists()).toBe(true);
  expect(titles[1]?.text()).toBe("Local cleanup");
  expect(titles[1]?.attributes("title")).toBeUndefined();
  expect(titles[1]?.find(".remote-task-marker").exists()).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts --testNamePattern "marks remote tasks"
```

Expected result:

```text
FAIL  src/components/__tests__/Sidebar.test.ts
AssertionError: expected 'LAN visible task' to be '< LAN visible task'
```

- [ ] **Step 3: Update `Sidebar.vue` types and helper**

In `apps/desktop/src/components/Sidebar.vue`, after the `const store = useKannaStore();` line, add:

```ts
type SidebarPipelineItem = PipelineItem & {
  remote_task?: boolean;
};
```

Then change the props type from:

```ts
  pipelineItems: PipelineItem[];
```

to:

```ts
  pipelineItems: SidebarPipelineItem[];
```

Change the `DraggableChange` call sites and helpers that currently mention `PipelineItem` to use `SidebarPipelineItem`:

```ts
function matchesSearch(item: SidebarPipelineItem): boolean {
```

```ts
function sortedPinned(repoId: string): SidebarPipelineItem[] {
```

```ts
function sortedBlocked(repoId: string): SidebarPipelineItem[] {
```

```ts
interface StageGroup {
  stageName: string;
  items: SidebarPipelineItem[];
}
```

```ts
function itemsForRepo(repoId: string): SidebarPipelineItem[] {
```

```ts
function itemTitle(item: SidebarPipelineItem): string {
```

```ts
function startRename(item: SidebarPipelineItem) {
```

```ts
function handleSelectItem(item: SidebarPipelineItem) {
```

```ts
function onPinnedChange(repoId: string, evt: DraggableChange<SidebarPipelineItem>) {
```

```ts
function onUnpinnedChange(repoId: string, evt: DraggableChange<SidebarPipelineItem>) {
```

Add this helper after `itemTitle`:

```ts
function isRemoteTask(item: SidebarPipelineItem): boolean {
  return item.remote_task === true;
}
```

- [ ] **Step 4: Render the marker in all three task-row locations**

Replace each task title interpolation that currently looks like:

```vue
>{{ itemTitle(element) }}</span>
```

with this marker-aware content:

```vue
  :title="isRemoteTask(element) ? 'Remote task' : undefined"
>
  <span v-if="isRemoteTask(element)" class="remote-task-marker" aria-label="Remote task">&lt; </span>{{ itemTitle(element) }}</span>
```

Apply the same change to:

- the pinned draggable item title
- the grouped stage draggable item title
- the blocked item title

Keep the existing inline style bindings on each `.item-title` span unchanged.

- [ ] **Step 5: Add marker CSS**

In the `<style scoped>` section of `apps/desktop/src/components/Sidebar.vue`, after the `.item-title` rule, add:

```css
.remote-task-marker {
  color: #7fb7e6;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}
```

- [ ] **Step 6: Run the focused test to verify it passes**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts --testNamePattern "marks remote tasks"
```

Expected result:

```text
PASS  src/components/__tests__/Sidebar.test.ts
```

- [ ] **Step 7: Run the full sidebar component test file**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts
```

Expected result:

```text
PASS  src/components/__tests__/Sidebar.test.ts
```

- [ ] **Step 8: Commit the implementation**

Run:

```bash
git add apps/desktop/src/App.vue apps/desktop/src/components/Sidebar.vue apps/desktop/src/components/__tests__/Sidebar.test.ts
git commit -m "feat: mark remote tasks in sidebar"
```

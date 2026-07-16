# Mobile Expanded Task Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the durable task ID beneath the expanded mobile task prompt and let users copy both values through native text selection.

**Architecture:** Keep the change local to `TaskScreen`, where both the resolved full prompt/title and `task.id` are already available. Extend the expanded scroll content with a small identity section, opt the prompt and ID text into React Native selection, and include the ID in the expanded accessibility label without changing the collapsed header or adding a clipboard dependency.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Vitest

---

## File structure

- Modify `apps/mobile/src/screens/TaskScreen.test.tsx` to specify expanded task identity, selection, collapsed-state, and accessibility behavior.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` to render and style the task ID and enable native selection.
- Keep `apps/mobile/src/e2eTestIds.ts`, API types, dependencies, native projects, and OTA runtime configuration unchanged.

### Task 1: Add selectable expanded task identity

**Files:**
- Test: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`

- [x] **Step 1: Write the failing expanded identity test**

Add this test beside the existing `expands to the bounded scrollable canonical prompt through its end` test:

```tsx
it("shows the complete task ID only in the expanded identity panel", () => {
  const taskId = "019f6c9d6ed40000000120e4307b4591";
  const prompt = "Canonical full prompt";
  let tree = renderTaskScreen({ taskId, prompt });

  expect(findByTypeAndText(tree, "Text", "Task ID")).toBeNull();
  expect(findByTypeAndText(tree, "Text", taskId)).toBeNull();

  pressByTestId(tree, "mobile.task-title-button");
  tree = renderTaskScreen({ taskId, prompt });

  expect(findByTypeAndText(tree, "Text", "Task ID")).not.toBeNull();
  expect(findByTypeAndText(tree, "Text", taskId)?.props).toMatchObject({
    accessible: false,
    children: taskId
  });
  expect(findByTestId(tree, "mobile.task-title-button")?.props).toMatchObject({
    accessibilityLabel: `in progress: ${prompt}. Task ID: ${taskId}`,
    accessibilityState: { expanded: true }
  });
});
```

- [x] **Step 2: Write the failing native selection test**

Add a second focused test:

```tsx
it("makes the expanded prompt and task ID selectable", () => {
  const taskId = "task-selectable";
  const prompt = "Select all or part of this prompt";
  let tree = renderTaskScreen({ taskId, prompt });

  pressByTestId(tree, "mobile.task-title-button");
  tree = renderTaskScreen({ taskId, prompt });

  expect(findByTestId(tree, "mobile.task-expanded-prompt")?.props).toMatchObject({
    accessible: false,
    selectable: true
  });
  expect(findByTypeAndText(tree, "Text", taskId)?.props).toMatchObject({
    accessible: false,
    selectable: true
  });
});
```

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx
```

Expected: the new identity test fails because `Task ID` and `task.id` are absent, and the selection test fails because the prompt does not expose `selectable: true`.

- [x] **Step 4: Implement the minimal expanded identity UI**

In `TaskScreen.tsx`, change the title chip's accessibility label so the ID is present only when expanded:

```tsx
accessibilityLabel={`${model.stageLabel}: ${
  isTitleExpanded
    ? `${expandedPrompt}. Task ID: ${task.id}`
    : model.title
}`}
```

Inside the existing expanded `ScrollView`, make the prompt selectable and append the identity section:

```tsx
<Text
  accessible={false}
  selectable
  style={styles.prompt}
  testID={MOBILE_E2E_IDS.taskExpandedPrompt}
>
  {expandedPrompt}
</Text>
<View accessible={false} style={styles.taskIdentity}>
  <Text accessible={false} style={styles.taskIdLabel}>
    Task ID
  </Text>
  <Text accessible={false} selectable style={styles.taskId}>
    {task.id}
  </Text>
</View>
```

Register a no-op long-press handler only while expanded. React Native Pressability uses the presence of this handler to suppress the normal `onPress` after a long release, which keeps selected text mounted:

```tsx
onLongPress={isTitleExpanded ? preserveExpandedTextSelection : undefined}
```

Add focused styles after `prompt`:

```tsx
taskIdentity: {
  borderTopColor: "#22304D",
  borderTopWidth: 1,
  gap: 4,
  marginTop: 8,
  paddingTop: 8
},
taskIdLabel: {
  color: "#7FA7D9",
  fontSize: 10,
  fontWeight: "700",
  letterSpacing: 0.8,
  textTransform: "uppercase"
},
taskId: {
  color: "#9BB0CC",
  fontSize: 11,
  lineHeight: 16
},
```

Update the two existing expanded-state accessibility-label assertions so they preserve their current fixtures and include the default or explicit task ID:

```tsx
accessibilityLabel: `in progress: ${prompt}. Task ID: task-1`
```

and:

```tsx
accessibilityLabel: `in progress: ${prompt}. Task ID: ${taskId}`
```

- [x] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx
```

Expected: all `TaskScreen` tests pass with no failures.

- [x] **Step 6: Check the complete diff against the approved scope**

Run:

```bash
git diff -- apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx
```

Confirm the collapsed header is unchanged, no clipboard dependency is introduced, and the ID is rendered only inside the existing expanded scroll region.

### Task 2: Verify the mobile change

**Files:**
- Review: `apps/mobile/src/screens/TaskScreen.tsx`
- Review: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Review: `docs/superpowers/specs/2026-07-17-mobile-expanded-task-identity-design.md`
- Review: `docs/superpowers/plans/2026-07-17-mobile-expanded-task-identity.md`

- [x] **Step 1: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: TypeScript exits successfully with no diagnostics.

- [x] **Step 2: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: exit code 0 with no output.

- [x] **Step 3: Review the final worktree state without committing**

Run:

```bash
git status --short
git diff --stat
```

Expected: only the `TaskScreen` implementation/test and this task's design/plan documents are changed. Do not commit: this Kanna task's later pipeline stage owns committing.

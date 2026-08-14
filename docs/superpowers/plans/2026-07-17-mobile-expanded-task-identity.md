# Mobile Expanded Task Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the durable task ID beneath the expanded mobile task prompt and let users copy both values through native text selection.

**Architecture:** Keep the change local to `TaskScreen`, where both the resolved full prompt/title and `task.id` are already available. Extend the expanded scroll content with a small identity section, opt the prompt and ID text into React Native selection, and include the ID in the expanded accessibility label without changing the collapsed header or adding a clipboard dependency.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Vitest

---

## File structure

- Modify `apps/mobile/src/screens/TaskScreen.test.tsx` to specify expanded task identity, selection, collapsed-state, and accessibility behavior.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` to render and style the task ID and enable native selection.
- Modify `apps/mobile/src/e2eTestIds.ts` and `apps/mobile/e2e/helpers/selectors.ts` to expose the expanded task ID to Appium.
- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts` first to specify the native copy journey.
- Modify `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts` to long-press the ID, invoke iOS Copy, verify the clipboard, preserve the expanded panel, and retain both collapse paths.
- Modify `apps/mobile/e2e/terminal-streaming-coverage.md` and the task design to record the real-Appium guarantee and the system-menu locale boundary.
- Keep API types, dependencies, native projects, and OTA runtime configuration unchanged.

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

Expected: only the `TaskScreen` implementation/test and this task's design/plan documents are changed. Do not commit: this Kanna task's later workflow stage owns committing.

### Task 3: Prove native task-ID copy in Appium

**Files:**
- Test: `apps/mobile/e2e/helpers/selectors.test.ts`
- Test: `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Modify: `apps/mobile/e2e/terminal-streaming-coverage.md`
- Modify: `docs/superpowers/specs/2026-07-17-mobile-expanded-task-identity-design.md`

- [x] **Step 1: Write failing selector and journey contract tests**

Require `selectors.taskExpandedTaskId` to resolve to
`~mobile.task-expanded-task-id`. Extend the fake prompt-expansion journey with a
task-ID element, native `longPress({ duration: 1500 })`, a Copy menu action, and
clipboard access. Assert the exact fixture ID is read, the prompt and ID still
exist after long press, the ordinary title tap collapses and re-expands the
panel, and the outside layer performs the final collapse.

The selector contract is:

```ts
expect(selectorHelpers.selectors.taskExpandedTaskId).toBe(
  "~mobile.task-expanded-task-id"
);
```

The journey contract must expose protocol-shaped methods rather than a
test-only production hook:

```ts
const ui = {
  getExpandedTaskId: vi.fn(async () => expandedTaskId),
  getCopyMenuItem: vi.fn(async () => copyMenuItem),
  getClipboard: vi.fn(async () =>
    Buffer.from(clipboard, "utf8").toString("base64")
  ),
  setClipboard: vi.fn(async (encodedClipboard: string) => {
    clipboard = Buffer.from(encodedClipboard, "base64").toString("utf8");
  })
};

expect(expandedTaskId.longPress).toHaveBeenCalledWith({ duration: 1500 });
expect(copyMenuItem.click).toHaveBeenCalledTimes(1);
expect(await expandedPrompt.isExisting()).toBe(false);
expect(await expandedTaskId.isExisting()).toBe(false);
```

- [x] **Step 2: Run the focused contracts and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/list-detail-back.test.ts e2e/helpers/selectors.test.ts
```

Expected: FAIL because `taskExpandedTaskId` and the native-copy UI methods do
not exist and the current journey never long-presses or reads the clipboard.

- [x] **Step 3: Add the stable task-ID selector**

Add `taskExpandedTaskId: "mobile.task-expanded-task-id"` to
`MOBILE_E2E_IDS`, apply it to the selectable ID `Text`, and export the matching
Appium selector.

```tsx
<Text
  accessible={false}
  selectable
  style={styles.taskId}
  testID={MOBILE_E2E_IDS.taskExpandedTaskId}
>
  {task.id}
</Text>
```

```ts
taskExpandedTaskId: `~${MOBILE_E2E_IDS.taskExpandedTaskId}`,
```

- [x] **Step 4: Implement the strict native-copy journey**

Extend `SmokeElement` with `longPress`, extend the UI adapter with an English
iOS Copy-menu lookup and clipboard read, and return `taskId` from
`assertPtyTerminalFixtureAvailable`. After expansion, assert the full ID text,
long-press it for 1500 ms, require and click the system Copy action, decode the
base64 clipboard, and require an exact ID match. Recheck both expanded elements,
then exercise ordinary header collapse/re-expansion before the existing outside
dismissal.

Use these interface additions and native adapters:

```ts
interface SmokeElement {
  longPress?(options: { duration: number }): Promise<unknown>;
}

interface TaskPromptExpansionUi {
  getClipboard(): Promise<string>;
  getCopyMenuItem(): Promise<SmokeElement>;
  getExpandedTaskId(): Promise<SmokeElement>;
  setClipboard(content: string): Promise<unknown>;
}

async getExpandedTaskId() {
  return driver.$(selectors.taskExpandedTaskId);
},
async getCopyMenuItem() {
  return driver.$("~Copy");
},
async getClipboard() {
  return driver.getClipboard("plaintext");
},
async setClipboard(content) {
  return driver.setClipboard(content, "plaintext");
},
```

The gesture and clipboard assertion are:

```ts
const expandedTaskId = await ui.getExpandedTaskId();
if ((await smokeElementText(expandedTaskId)) !== fixture.taskId) {
  throw new Error(`Expected complete expanded task ID ${fixture.taskId}`);
}
if (!expandedTaskId.longPress) {
  throw new Error("Appium element does not expose native longPress");
}
const originalClipboard = await ui.getClipboard();
const sentinel = Buffer.from(
  `kanna-e2e-before-native-copy:${fixture.taskId}`,
  "utf8"
).toString("base64");
await ui.setClipboard(sentinel);

try {
  await expandedTaskId.longPress({ duration: 1500 });

  await ui.waitUntil(
    async () => {
      const copyMenuItem = await ui.getCopyMenuItem();
      return (
        (await copyMenuItem.isExisting()) &&
        (copyMenuItem.isDisplayed ? await copyMenuItem.isDisplayed() : true)
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected the native iOS Copy action after long-pressing the task ID"
    }
  );

  const copyMenuItem = await ui.getCopyMenuItem();
  await copyMenuItem.click();

  await ui.waitUntil(
    async () =>
      Buffer.from(await ui.getClipboard(), "base64").toString("utf8") ===
      fixture.taskId,
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected native Copy to place complete task ID ${fixture.taskId} on the clipboard`
    }
  );
} finally {
  await ui.setClipboard(originalClipboard);
}
```

- [x] **Step 5: Run the focused contracts and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/list-detail-back.test.ts e2e/helpers/selectors.test.ts
```

Expected: PASS with the fake journey proving every gesture and clipboard step.

- [x] **Step 6: Document the harness boundary**

Update the terminal coverage note and task design to state that the real smoke
performs an XCUITest long press, invokes the system Copy item, and reads the
WebDriverAgent clipboard. Record that the system edit menu is locale- and
iOS-owned, the harness currently targets English `Copy`, and deterministic
non-English coverage requires a fixed simulator locale or a locale-independent
edit-menu command.

- [x] **Step 7: Run complete revision verification**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx e2e/specs/smoke/list-detail-back.test.ts e2e/helpers/selectors.test.ts
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile run test:e2e:smoke
git diff --check
```

Expected: unit/contract tests and typecheck pass. The Appium smoke either passes
with a provisioned `KANNA_E2E_PTY_TASK_ID` fixture or stops at the documented
fixture precondition; report its exact result rather than claiming native-copy
coverage from contract tests alone.

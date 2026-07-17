# Mobile Reply Composer Height Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile reply composer shrink back to one line after clearing or sending, and dismiss its keyboard after successful submission so interaction returns to the terminal.

**Architecture:** Keep the composer-size policy beside its existing TextInput policy, then make `TaskScreen` explicitly own the rendered input height from native content-size events. Reset height from the same draft-clear paths that send replies, and dismiss the native keyboard only after a successful submission; do not remount the input or add a terminal WebView focus protocol.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Vitest, pnpm

---

### Task 1: Define the reply composer height policy

**Files:**
- Modify: `apps/mobile/src/screens/taskComposerInput.ts`
- Test: `apps/mobile/src/screens/taskComposerInput.test.ts`

- [ ] **Step 1: Write the failing height-policy tests**

Extend `taskComposerInput.test.ts` with imports and cases that document the fixed bounds:

```ts
import {
  clampTaskComposerHeight,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS
} from "./taskComposerInput";

it.each([
  [24, 40],
  [72, 72],
  [160, 120],
  [Number.POSITIVE_INFINITY, 40]
])("clamps native content height %s to %s", (contentHeight, expected) => {
  expect(clampTaskComposerHeight(contentHeight)).toBe(expected);
});

it("exports the input's existing layout bounds", () => {
  expect(TASK_COMPOSER_MIN_HEIGHT).toBe(40);
  expect(TASK_COMPOSER_MAX_HEIGHT).toBe(120);
});
```

- [ ] **Step 2: Run the focused policy test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts
```

Expected: FAIL because the height constants and `clampTaskComposerHeight` are not exported yet.

- [ ] **Step 3: Implement the minimal height policy**

Add the shared bounds and clamp beside `TASK_COMPOSER_TEXT_INPUT_PROPS`:

```ts
export const TASK_COMPOSER_MIN_HEIGHT = 40;
export const TASK_COMPOSER_MAX_HEIGHT = 120;

export function clampTaskComposerHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) {
    return TASK_COMPOSER_MIN_HEIGHT;
  }

  return Math.min(
    TASK_COMPOSER_MAX_HEIGHT,
    Math.max(TASK_COMPOSER_MIN_HEIGHT, contentHeight)
  );
}
```

- [ ] **Step 4: Run the focused policy test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts
```

Expected: PASS with the existing keyboard-return contract and the new height-policy cases green.

- [ ] **Step 5: Commit the height policy**

```bash
git add apps/mobile/src/screens/taskComposerInput.ts apps/mobile/src/screens/taskComposerInput.test.ts
git commit -m "test(mobile): define reply composer height bounds"
```

### Task 2: Reset height and hand focus back after submission

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Test: `apps/mobile/src/screens/TaskScreen.test.tsx`

- [ ] **Step 1: Write failing component regression tests**

Expose a reusable keyboard mock in the existing `componentMocks` harness:

```ts
keyboardDismiss: vi.fn(),
```

Wire `Keyboard.dismiss` to it and reset it in `beforeEach`:

```ts
Keyboard: {
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  dismiss: componentMocks.keyboardDismiss
},
```

```ts
componentMocks.keyboardDismiss.mockReset();
```

Add a regression that expands the native content size, sends, rerenders, and verifies both reset and focus handoff:

```ts
it("shrinks an expanded composer and dismisses its keyboard after Send", () => {
  let tree = renderTaskScreen({
    agentType: "agent",
    draftInput: "First line.\nSecond line."
  });
  let input = findByTestId(tree, "mobile.task-input");

  (input?.props?.onContentSizeChange as (event: unknown) => void)({
    nativeEvent: { contentSize: { height: 82, width: 240 } }
  });
  tree = renderTaskScreen({
    agentType: "agent",
    draftInput: "First line.\nSecond line."
  });
  input = findByTestId(tree, "mobile.task-input");
  expect(styleEntries(input)).toContainEqual({ height: 82 });

  pressByTestId(tree, "mobile.task-send-button");
  tree = renderTaskScreen({ agentType: "agent" });

  expect(styleEntries(findByTestId(tree, "mobile.task-input"))).toContainEqual({
    height: 40
  });
  expect(componentMocks.keyboardDismiss).toHaveBeenCalledOnce();
});
```

Add a second regression that expands, deletes the draft, rerenders, and verifies height resets without sending or dismissing:

```ts
it("shrinks an expanded composer when its draft is deleted", () => {
  let tree = renderTaskScreen({ draftInput: "First line.\nSecond line." });
  let input = findByTestId(tree, "mobile.task-input");
  (input?.props?.onContentSizeChange as (event: unknown) => void)({
    nativeEvent: { contentSize: { height: 82, width: 240 } }
  });
  tree = renderTaskScreen({ draftInput: "First line.\nSecond line." });
  input = findByTestId(tree, "mobile.task-input");

  (input?.props?.onChangeText as (value: string) => void)("");
  tree = renderTaskScreen();

  expect(styleEntries(findByTestId(tree, "mobile.task-input"))).toContainEqual({
    height: 40
  });
  expect(componentMocks.onSendInput).not.toHaveBeenCalled();
  expect(componentMocks.keyboardDismiss).not.toHaveBeenCalled();
});
```

Extend the existing empty-send and quick-reply assertions so empty sends do not dismiss and successful quick replies do.

- [ ] **Step 2: Run the task-screen test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx
```

Expected: FAIL because the input has no `onContentSizeChange` handler or controlled height and successful submission does not dismiss the keyboard.

- [ ] **Step 3: Implement controlled height and successful-send dismissal**

Add the native event type to the existing `react-native` import, then import the
composer policy:

```ts
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEvent,
  useWindowDimensions,
  View
} from "react-native";
import {
  clampTaskComposerHeight,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS
} from "./taskComposerInput";
```

Add height state immediately after the draft state:

```ts
const [composerInputHeight, setComposerInputHeight] = useState(
  TASK_COMPOSER_MIN_HEIGHT
);
```

Reset height whenever the draft becomes empty and in the shared clear path:

```ts
const updateDraftInput = (nextDraftInput: string) => {
  composerSnapshotRef.current.draftInput = nextDraftInput;
  if (!nextDraftInput) {
    setComposerInputHeight(TASK_COMPOSER_MIN_HEIGHT);
  }
  setDraftInput(nextDraftInput);
};
const clearDraftInput = () => {
  composerSnapshotRef.current.draftInput = "";
  setComposerInputHeight(TASK_COMPOSER_MIN_HEIGHT);
  setDraftInput("");
};
```

Dismiss only after the task accepted a non-empty enabled submission:

```ts
snapshot.onSendInput(nextInput);
clearDraftInput();
Keyboard.dismiss();
```

Handle native growth while guarding against a late stale event after clearing:

```ts
const updateComposerInputHeight = (
  event: TextInputContentSizeChangeEvent
) => {
  setComposerInputHeight(
    composerSnapshotRef.current.draftInput
      ? clampTaskComposerHeight(event.nativeEvent.contentSize.height)
      : TASK_COMPOSER_MIN_HEIGHT
  );
};
```

Wire the handler and height into `TextInput`, and replace duplicated style literals with the shared bounds:

```tsx
onContentSizeChange={updateComposerInputHeight}
style={[
  styles.inputField,
  { height: composerInputHeight },
  isComposerDisabled ? styles.inputFieldDisabled : null
]}
```

```ts
maxHeight: TASK_COMPOSER_MAX_HEIGHT,
minHeight: TASK_COMPOSER_MIN_HEIGHT,
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/taskComposerInput.test.ts src/screens/TaskScreen.test.tsx
```

Expected: PASS, including normal Send, quick reply, empty submission, manual deletion, bounds, and return-key behavior.

- [ ] **Step 5: Run mobile verification**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
```

Expected: both commands exit 0 with no new failures.

- [ ] **Step 6: Commit the regression fix**

```bash
git add apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx
git commit -m "fix(mobile): reset reply composer after send"
```

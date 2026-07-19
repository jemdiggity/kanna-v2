# Mobile Drag Quick Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile native quick-reply action sheet with a hold-drag-release reply rail and add a device-local editor for one to five global replies.

**Architecture:** Keep reply rules and persistence in pure, testable modules. A responder-backed Send control owns gesture recognition and visual selection but returns only reply IDs; `TaskScreen` retains current-task validation and submission. `App` owns hydrated global preferences and passes them through navigation while a dedicated account-sheet editor saves atomically.

**Tech Stack:** React Native 0.86, React 19, TypeScript, AsyncStorage, Vitest, react-test-renderer, WebdriverIO/Appium

---

## File Structure

- Modify `apps/mobile/src/screens/taskQuickReplies.ts` — reply model, defaults, validation, immutable list operations, and message composition.
- Modify `apps/mobile/src/screens/taskQuickReplies.test.ts` — domain behavior.
- Create `apps/mobile/src/state/taskQuickReplyPreferences.ts` — versioned AsyncStorage repository.
- Create `apps/mobile/src/state/taskQuickReplyPreferences.test.ts` — persistence normalization and failure behavior.
- Create `apps/mobile/src/screens/taskQuickReplyGesture.ts` — shared rail dimensions and pure displacement-to-selection geometry.
- Create `apps/mobile/src/screens/taskQuickReplyGesture.test.ts` — card boundary and cancellation coverage.
- Create `apps/mobile/src/screens/QuickReplySendControl.tsx` — responder lifecycle, animated rail, and accessible modal picker.
- Create `apps/mobile/src/screens/QuickReplySendControl.test.tsx` — touch, cancellation, disabled, and accessibility behavior.
- Delete `apps/mobile/src/screens/taskQuickReplyMenu.ts` and `apps/mobile/src/screens/taskQuickReplyMenu.test.ts` — superseded native menu.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` and `TaskScreen.test.tsx` — current-snapshot selection and existing submission path.
- Create `apps/mobile/src/components/QuickReplyEditorModal.tsx` and `.test.tsx` — transactional editor UI.
- Modify `apps/mobile/src/components/AccountSheet.tsx` and `.test.tsx` — Quick Replies entry point.
- Modify `apps/mobile/src/App.tsx` and `App.component.test.tsx` — preference hydration, save, modal ownership, and failure-safe defaults.
- Modify `apps/mobile/src/navigation/RootNavigator.tsx`, `RootNavigator.component.test.tsx`, and `RootNavigator.integration.test.tsx` — pass global replies and hydration state to every task route.
- Modify `apps/mobile/src/e2eTestIds.ts`, `apps/mobile/e2e/helpers/selectors.ts`, `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`, and `relay-task-flow.test.ts` — native drag journey.

### Task 1: Quick-reply domain model

**Files:**
- Modify: `apps/mobile/src/screens/taskQuickReplies.ts`
- Modify: `apps/mobile/src/screens/taskQuickReplies.test.ts`

- [ ] **Step 1: Write failing tests for the new text-only model and list rules**

Replace the catalog-only assertions with tests that require this public API:

```ts
import {
  addTaskQuickReply,
  buildTaskQuickReply,
  DEFAULT_TASK_QUICK_REPLIES,
  deleteTaskQuickReply,
  MAX_TASK_QUICK_REPLIES,
  MAX_TASK_QUICK_REPLY_LENGTH,
  moveTaskQuickReply,
  normalizeTaskQuickReplies,
  updateTaskQuickReply,
  validateTaskQuickReplies
} from "./taskQuickReplies";

it("starts with the existing SGTM reply", () => {
  expect(DEFAULT_TASK_QUICK_REPLIES).toEqual([
    { id: "sgtm-proceed", text: "SGTM. Proceed." }
  ]);
});

it("trims entries, removes case-insensitive duplicates, and caps at five", () => {
  expect(normalizeTaskQuickReplies([
    { id: "a", text: "  One  " },
    { id: "b", text: "one" },
    { id: "c", text: "Two" },
    { id: "d", text: "Three" },
    { id: "e", text: "Four" },
    { id: "f", text: "Five" },
    { id: "g", text: "Six" }
  ])).toEqual([
    { id: "a", text: "One" },
    { id: "c", text: "Two" },
    { id: "d", text: "Three" },
    { id: "e", text: "Four" },
    { id: "f", text: "Five" }
  ]);
});

it("validates one to five unique replies of at most 200 characters", () => {
  expect(MAX_TASK_QUICK_REPLIES).toBe(5);
  expect(MAX_TASK_QUICK_REPLY_LENGTH).toBe(200);
  expect(validateTaskQuickReplies([]).valid).toBe(false);
  expect(validateTaskQuickReplies([
    { id: "a", text: "Same" },
    { id: "b", text: " same " }
  ]).errors[1]).toMatch(/unique/i);
});

it("adds, updates, deletes, and moves replies without mutation", () => {
  const original = [
    { id: "a", text: "One" },
    { id: "b", text: "Two" }
  ];
  expect(addTaskQuickReply(original, { id: "c", text: "Three" })).toHaveLength(3);
  expect(updateTaskQuickReply(original, "a", "Updated")[0]?.text).toBe("Updated");
  expect(deleteTaskQuickReply(original, "a")).toEqual([{ id: "b", text: "Two" }]);
  expect(moveTaskQuickReply(original, "b", -1).map((reply) => reply.id)).toEqual(["b", "a"]);
  expect(original).toEqual([
    { id: "a", text: "One" },
    { id: "b", text: "Two" }
  ]);
});
```

Keep the existing empty-draft and populated-draft composition assertions, updated to `{ id, text }`.

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `pnpm --dir apps/mobile test -- src/screens/taskQuickReplies.test.ts`

Expected: FAIL because the new constants and list operations do not exist and the current model still uses `label`/`messagePrefix`.

- [ ] **Step 3: Implement the minimal domain API**

Use these exact exports and constraints:

```ts
export interface TaskQuickReply { id: string; text: string }
export const MIN_TASK_QUICK_REPLIES = 1;
export const MAX_TASK_QUICK_REPLIES = 5;
export const MAX_TASK_QUICK_REPLY_LENGTH = 200;
export const DEFAULT_TASK_QUICK_REPLIES: readonly TaskQuickReply[] = [
  { id: "sgtm-proceed", text: "SGTM. Proceed." }
];

export interface TaskQuickReplyValidation {
  valid: boolean;
  errors: Record<number, string>;
  listError: string | null;
}
```

`normalizeTaskQuickReplies(value)` accepts `unknown`, keeps only object entries with nonblank string IDs and text, trims outer whitespace, preserves internal whitespace, removes later case-insensitive duplicates, and returns at most five. `validateTaskQuickReplies` reports list-count, blank, length, and duplicate errors. The immutable helpers return unchanged arrays when the requested ID/direction is invalid and prevent a sixth add or deletion of the final reply. `buildTaskQuickReply(reply, draft)` uses `reply.text` and the existing blank-line composition.

- [ ] **Step 4: Run the domain tests and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/screens/taskQuickReplies.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain model**

```bash
git add apps/mobile/src/screens/taskQuickReplies.ts apps/mobile/src/screens/taskQuickReplies.test.ts
git commit -m "feat(mobile): model customizable quick replies"
```

### Task 2: Versioned device-local persistence

**Files:**
- Create: `apps/mobile/src/state/taskQuickReplyPreferences.ts`
- Create: `apps/mobile/src/state/taskQuickReplyPreferences.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create a memory storage adapter and require missing/corrupt fallback, valid-subset normalization, version rejection, round-trip, write-before-live semantics, and storage read failure fallback:

```ts
const storage = {
  getItem: vi.fn<() => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>()
};

it.each([null, "not json", JSON.stringify({ version: 2, replies: [] })])(
  "falls back to the default for unsupported data %#",
  async (raw) => {
    storage.getItem.mockResolvedValue(raw);
    const repository = createTaskQuickReplyPreferences(storage);
    expect(await repository.load()).toEqual(DEFAULT_TASK_QUICK_REPLIES);
  }
);

it("normalizes and round-trips valid version-one replies", async () => {
  storage.getItem.mockResolvedValue(JSON.stringify({
    version: 1,
    replies: [{ id: "custom", text: "  Ship it  " }]
  }));
  const repository = createTaskQuickReplyPreferences(storage);
  expect(await repository.load()).toEqual([{ id: "custom", text: "Ship it" }]);
  await repository.save([{ id: "custom", text: "Ship it" }]);
  expect(storage.setItem).toHaveBeenCalledWith(
    TASK_QUICK_REPLY_STORAGE_KEY,
    JSON.stringify({ version: 1, replies: [{ id: "custom", text: "Ship it" }] })
  );
});

it("rejects invalid lists without writing", async () => {
  const repository = createTaskQuickReplyPreferences(storage);
  await expect(repository.save([])).rejects.toThrow(/at least one/i);
  expect(storage.setItem).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the persistence tests and verify RED**

Run: `pnpm --dir apps/mobile test -- src/state/taskQuickReplyPreferences.test.ts`

Expected: FAIL because the repository module is missing.

- [ ] **Step 3: Implement the repository**

Expose:

```ts
export const TASK_QUICK_REPLY_STORAGE_KEY = "kanna.mobile.quick-replies.v1";
export interface TaskQuickReplyStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface TaskQuickReplyPreferences {
  load(): Promise<TaskQuickReply[]>;
  save(replies: readonly TaskQuickReply[]): Promise<TaskQuickReply[]>;
}
export function createTaskQuickReplyPreferences(
  storage: TaskQuickReplyStorageAdapter
): TaskQuickReplyPreferences;
export async function createDefaultTaskQuickReplyPreferences():
  Promise<TaskQuickReplyPreferences>;
```

`load` catches storage/JSON errors and returns a mutable copy of the default. Version 1 data passes through domain normalization and falls back when no valid entries remain. `save` normalizes, validates, throws an `Error` carrying the first validation message before any write, stores `{ version: 1, replies }`, and returns the normalized saved list. The default factory dynamically imports AsyncStorage, matching `sessionPersistence.ts`.

- [ ] **Step 4: Run persistence tests and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/state/taskQuickReplyPreferences.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit persistence**

```bash
git add apps/mobile/src/state/taskQuickReplyPreferences.ts apps/mobile/src/state/taskQuickReplyPreferences.test.ts
git commit -m "feat(mobile): persist global quick replies"
```

### Task 3: Pure gesture geometry

**Files:**
- Create: `apps/mobile/src/screens/taskQuickReplyGesture.ts`
- Create: `apps/mobile/src/screens/taskQuickReplyGesture.test.ts`

- [ ] **Step 1: Write failing geometry tests**

Require no selection at rest, each card center, nearest-card boundary behavior, horizontal cancellation, and list bounds:

```ts
it("maps upward displacement to the nearest reply", () => {
  expect(selectTaskQuickReplyIndex({ dx: 0, dy: 0 }, 5)).toBeNull();
  expect(selectTaskQuickReplyIndex({ dx: 0, dy: -52 }, 5)).toBe(0);
  expect(selectTaskQuickReplyIndex({ dx: 0, dy: -108 }, 5)).toBe(1);
  expect(selectTaskQuickReplyIndex({ dx: 0, dy: -276 }, 5)).toBe(4);
});

it("cancels outside the card band", () => {
  expect(selectTaskQuickReplyIndex({ dx: -240, dy: -52 }, 5)).toBeNull();
  expect(selectTaskQuickReplyIndex({ dx: 38, dy: -52 }, 5)).toBeNull();
  expect(selectTaskQuickReplyIndex({ dx: 0, dy: -350 }, 5)).toBeNull();
});

it("uses ten-point tap slop", () => {
  expect(exceedsTaskQuickReplyTapSlop({ dx: 6, dy: 8 })).toBe(false);
  expect(exceedsTaskQuickReplyTapSlop({ dx: 8, dy: 8 })).toBe(true);
});
```

- [ ] **Step 2: Run geometry tests and verify RED**

Run: `pnpm --dir apps/mobile test -- src/screens/taskQuickReplyGesture.test.ts`

Expected: FAIL because the geometry module is missing.

- [ ] **Step 3: Implement geometry constants and functions**

```ts
export const TASK_QUICK_REPLY_LONG_PRESS_MS = 400;
export const TASK_QUICK_REPLY_TAP_SLOP = 10;
export const TASK_QUICK_REPLY_CARD_HEIGHT = 48;
export const TASK_QUICK_REPLY_CARD_GAP = 8;
export const TASK_QUICK_REPLY_CARD_WIDTH = 260;
export const TASK_QUICK_REPLY_FIRST_CENTER_Y = 52;

export function exceedsTaskQuickReplyTapSlop(
  displacement: { dx: number; dy: number }
): boolean;
export function selectTaskQuickReplyIndex(
  displacement: { dx: number; dy: number },
  replyCount: number
): number | null;
```

Use centers `52 + index * 56`, accept a vertical half-band of 28 points, and accept horizontal displacement from `-239` through `37` points. Clamp `replyCount` to 0–5 and return `null` outside a valid card.

- [ ] **Step 4: Run geometry tests and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/screens/taskQuickReplyGesture.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit geometry**

```bash
git add apps/mobile/src/screens/taskQuickReplyGesture.ts apps/mobile/src/screens/taskQuickReplyGesture.test.ts
git commit -m "feat(mobile): define quick reply drag geometry"
```

### Task 4: Responder-backed Send control and accessible picker

**Files:**
- Create: `apps/mobile/src/screens/QuickReplySendControl.tsx`
- Create: `apps/mobile/src/screens/QuickReplySendControl.test.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write failing component tests**

Mock `PanResponder.create` so the captured callbacks can be invoked directly, use fake timers, and assert this contract:

```ts
interface QuickReplySendControlProps {
  disabled: boolean;
  hydrated: boolean;
  replies: readonly TaskQuickReply[];
  onPress(): void;
  onSelectReply(replyId: string): void;
}
```

Capture the `PanResponder.create` callbacks in `nativeHarness.panResponderConfig`, use a `renderControl(overrides)` helper that supplies one SGTM reply and callback spies, and use this gesture-state helper:

```ts
const displacement = (dx = 0, dy = 0) => ({ dx, dy }) as never;
const event = {} as never;

it("releases a short stationary touch as normal Send", () => {
  const { onPress, onSelectReply } = renderControl();
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement()));
  expect(onPress).toHaveBeenCalledOnce();
  expect(onSelectReply).not.toHaveBeenCalled();
});

it("cancels a pre-activation move beyond ten points", () => {
  const { onPress, onSelectReply } = renderControl();
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => nativeHarness.panResponderConfig.onPanResponderMove?.(event, displacement(11, 0)));
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement(11, 0)));
  expect(onPress).not.toHaveBeenCalled();
  expect(onSelectReply).not.toHaveBeenCalled();
});

it("activates after 400ms, highlights, and selects on release", () => {
  const { onPress, onSelectReply, renderer } = renderControl();
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => vi.advanceTimersByTime(400));
  act(() => nativeHarness.panResponderConfig.onPanResponderMove?.(event, displacement(0, -52)));
  expect(renderer.root.findByProps({ testID: "mobile.quick-reply.sgtm-proceed" })).toBeDefined();
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement(0, -52)));
  expect(onSelectReply).toHaveBeenCalledWith("sgtm-proceed");
  expect(onPress).not.toHaveBeenCalled();
});

it("cancels an active release outside every card", () => {
  const { onPress, onSelectReply } = renderControl();
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => vi.advanceTimersByTime(400));
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement()));
  expect(onPress).not.toHaveBeenCalled();
  expect(onSelectReply).not.toHaveBeenCalled();
});

it("keeps short-tap Send available before hydration but cancels a hold", () => {
  const { onPress, onSelectReply } = renderControl({ hydrated: false });
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement()));
  expect(onPress).toHaveBeenCalledOnce();
  onPress.mockClear();
  act(() => nativeHarness.panResponderConfig.onPanResponderGrant?.(event, displacement()));
  act(() => vi.advanceTimersByTime(400));
  act(() => nativeHarness.panResponderConfig.onPanResponderRelease?.(event, displacement()));
  expect(onPress).not.toHaveBeenCalled();
  expect(onSelectReply).not.toHaveBeenCalled();
});

it("opens the accessible picker and selects through the same callback", () => {
  const { onSelectReply, renderer } = renderControl();
  act(() => renderer.root.findByProps({ testID: "mobile.task-send-button" }).props.onAccessibilityAction({
    nativeEvent: { actionName: "showQuickReplies" }
  }));
  act(() => renderer.root.findByProps({ testID: "mobile.quick-reply.sgtm-proceed" }).props.onPress());
  expect(onSelectReply).toHaveBeenCalledWith("sgtm-proceed");
});
```

Add separate assertions that disabled controls return `false` from `onStartShouldSetPanResponder`, responder termination clears the rail, and unmount clears the timer.

- [ ] **Step 2: Run the component test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/screens/QuickReplySendControl.test.tsx`

Expected: FAIL because the component is missing.

- [ ] **Step 3: Implement the responder state machine**

Use `PanResponder` and refs for touch ownership:

```ts
type GesturePhase = "idle" | "tracking" | "active";
const phaseRef = useRef<GesturePhase>("idle");
const selectedIndexRef = useRef<number | null>(null);
const cancelledTapRef = useRef(false);
const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

On grant, start the 400 ms timer. Before activation, movement beyond tap slop cancels the timer and the tap. When hydration is incomplete, timer expiry cancels the held touch instead of opening the rail, while release before expiry remains a normal tap. After hydrated activation, each move calls `selectTaskQuickReplyIndex`. On release, active gestures select only a valid reply ID; tracking gestures call normal `onPress` only when not canceled; all paths reset refs, timer, visual state, and picker state. Termination and unmount cancel without callbacks.

Render an accessible `View` with role `button`, label `Send reply`, disabled state, activate and `showQuickReplies` accessibility actions, plus the existing `MOBILE_E2E_IDS.taskSendButton`. Render the reply rail absolutely above it only while active. Use text-only cards in array order with `flexDirection: "column-reverse"`; do not display numbers or icons. Add IDs through `MOBILE_E2E_IDS.taskQuickReply(reply.id)`.

Use one 140 ms `Animated.Value` for rail opacity/translate/scale entry and per-card 90 ms values for selected scale. The visible card is 48 points tall, 8 points apart, at most 260 points wide, two lines, tail ellipsis. A React Native `Modal` with conventional reply `Pressable`s and Cancel serves the accessibility action.

- [ ] **Step 4: Run component tests and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/screens/QuickReplySendControl.test.tsx`

Expected: PASS with fake timers restored after each test.

- [ ] **Step 5: Commit the gesture component**

```bash
git add apps/mobile/src/screens/QuickReplySendControl.tsx apps/mobile/src/screens/QuickReplySendControl.test.tsx apps/mobile/src/e2eTestIds.ts
git commit -m "feat(mobile): add drag quick reply send control"
```

### Task 5: Task composer integration

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.component.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.integration.test.tsx`
- Delete: `apps/mobile/src/screens/taskQuickReplyMenu.ts`
- Delete: `apps/mobile/src/screens/taskQuickReplyMenu.test.ts`

- [ ] **Step 1: Rewrite TaskScreen and navigation tests for injected replies**

Extend `TaskScreenProps` with:

```ts
quickReplies: readonly TaskQuickReply[];
quickRepliesHydrated: boolean;
```

Replace native-menu mocks with a mocked `QuickReplySendControl`. Assert that TaskScreen passes disabled/hydrated/replies, normal press still sends the current trimmed draft, and `onSelectReply("sgtm-proceed")` uses the latest draft. Preserve and adapt the existing tests that reject selection after task change or composer disablement. Add a missing-ID test that sends nothing.

Extend `RootNavigatorProps` and `NavigationContent` with the same two fields, and assert both component and integration renderings pass them to `TaskScreen` for task routes across repository changes.

- [ ] **Step 2: Run the focused integration tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx src/navigation/RootNavigator.component.test.tsx src/navigation/RootNavigator.integration.test.tsx
```

Expected: FAIL because current code imports the native menu and has no injected quick-reply props.

- [ ] **Step 3: Wire the new control into TaskScreen and navigation**

Replace `showTaskQuickReplyMenu` and the Send `Pressable` with:

```tsx
<QuickReplySendControl
  disabled={isComposerDisabled}
  hydrated={quickRepliesHydrated}
  replies={quickReplies}
  onPress={sendDraftInput}
  onSelectReply={(replyId) => {
    const currentSnapshot = composerSnapshotRef.current;
    if (currentSnapshot.taskId !== task.id) return;
    const reply = quickReplies.find((candidate) => candidate.id === replyId);
    if (!reply || currentSnapshot.isComposerDisabled) return;
    submitInput(buildTaskQuickReply(reply, currentSnapshot.draftInput));
  }}
/>
```

Keep task identity in `composerSnapshotRef`; the selection handler must compare the current task ID with the rendered task ID before sending. Pass the preference props from `RootNavigator` context to every task detail render. Delete the superseded native-menu module and tests.

- [ ] **Step 4: Run focused integration tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS.

- [ ] **Step 5: Commit composer integration**

```bash
git add apps/mobile/src/screens apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/RootNavigator.component.test.tsx apps/mobile/src/navigation/RootNavigator.integration.test.tsx
git commit -m "feat(mobile): send replies with drag selection"
```

### Task 6: Quick-reply editor and app ownership

**Files:**
- Create: `apps/mobile/src/components/QuickReplyEditorModal.tsx`
- Create: `apps/mobile/src/components/QuickReplyEditorModal.test.tsx`
- Modify: `apps/mobile/src/components/AccountSheet.tsx`
- Modify: `apps/mobile/src/components/AccountSheet.test.tsx`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write failing editor tests**

Require this API:

```ts
interface QuickReplyEditorModalProps {
  replies: readonly TaskQuickReply[];
  visible: boolean;
  onClose(): void;
  onSave(replies: readonly TaskQuickReply[]): Promise<void>;
}
```

Test opening from a fresh prop copy, editing, add capped at five, delete disabled at one, up/down ordering, blank/duplicate/201-character errors, Cancel discard, successful async save/close, and rejected save preserving draft with `Could not save quick replies` inline.

Add an account-sheet test that `mobile.account-quick-replies` calls `onOpenQuickReplies`. Add App component tests with a mocked repository to prove:

```ts
expect(rootNavigator.props.quickRepliesHydrated).toBe(false);
// resolve load
expect(rootNavigator.props.quickReplies).toEqual(customReplies);
expect(rootNavigator.props.quickRepliesHydrated).toBe(true);
// open account then quick replies
expect(accountSheet.props.visible).toBe(false);
expect(editor.props.visible).toBe(true);
// resolve save
expect(repository.save).toHaveBeenCalledWith(editedReplies);
expect(rootNavigator.props.quickReplies).toEqual(editedReplies);
```

Also assert load rejection uses defaults and still marks hydration complete, while save rejection leaves live props unchanged.

- [ ] **Step 2: Run editor/app tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/QuickReplyEditorModal.test.tsx src/components/AccountSheet.test.tsx src/App.component.test.tsx
```

Expected: FAIL because the editor and persistence wiring do not exist.

- [ ] **Step 3: Implement the editor**

Use a slide `Modal` and `KeyboardAvoidingView`. Reset draft replies, row errors, list error, and save error whenever `visible` transitions false-to-true. Each row contains a multiline `TextInput`, Move Up, Move Down, and Delete controls. Add creates a stable ID with a module helper using `Date.now().toString(36)` plus an incrementing suffix. Done normalizes, validates, focuses the first invalid row when possible, awaits `onSave`, and closes only after success.

Add stable E2E IDs:

```ts
accountQuickRepliesButton: "mobile.account-quick-replies",
quickReplyEditor: "mobile.quick-replies.editor",
quickReplyEditorAdd: "mobile.quick-replies.add",
quickReplyEditorDone: "mobile.quick-replies.done",
quickReplyEditorCancel: "mobile.quick-replies.cancel",
quickReplyEditorInput(id: string) { return `mobile.quick-replies.${id}.input`; },
quickReplyEditorMoveUp(id: string) { return `mobile.quick-replies.${id}.up`; },
quickReplyEditorMoveDown(id: string) { return `mobile.quick-replies.${id}.down`; },
quickReplyEditorDelete(id: string) { return `mobile.quick-replies.${id}.delete`; }
```

- [ ] **Step 4: Implement AccountSheet and App ownership**

Add `onOpenQuickReplies()` to AccountSheet and a row beside Machines. In App, create the default repository once, load in an effect independent of session initialization, and own:

```ts
const [quickReplies, setQuickReplies] = useState<TaskQuickReply[]>(
  () => [...DEFAULT_TASK_QUICK_REPLIES]
);
const [quickRepliesHydrated, setQuickRepliesHydrated] = useState(false);
const [quickReplyEditorVisible, setQuickReplyEditorVisible] = useState(false);
```

On any load outcome, set hydrated true; on a successful load use its replies. Pass list/hydration to RootNavigator. Opening Quick Replies closes AccountSheet first. Render `QuickReplyEditorModal` at App level. Its save callback awaits repository save and only then updates live state; let errors propagate to the editor.

- [ ] **Step 5: Run editor/app tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS.

- [ ] **Step 6: Commit customization UI**

```bash
git add apps/mobile/src/App.tsx apps/mobile/src/App.component.test.tsx apps/mobile/src/components apps/mobile/src/e2eTestIds.ts
git commit -m "feat(mobile): add quick reply editor"
```

### Task 7: Relay E2E drag journey

**Files:**
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`

- [ ] **Step 1: Write the failing orchestration contract**

Replace the native-menu journey mocks with `dragFirstQuickReply()` and require this call order:

```ts
[
  "input.waitForDisplayed",
  'input.setValue:"  Preserve the relay fixture.  "',
  "send.waitForDisplayed",
  "ui.dragFirstQuickReply",
  "input.getAttribute:value",
  "input.getAttribute:label"
]
```

Assert no `click`, action-sheet title, or action-sheet option is used.

- [ ] **Step 2: Run the relay contract and verify RED**

Run: `pnpm --dir apps/mobile test -- e2e/specs/relay/relay-task-flow.test.ts`

Expected: FAIL because the UI contract still long-presses and clicks the native action sheet.

- [ ] **Step 3: Implement the W3C pointer action**

Add `taskQuickReply(id)` to selectors. Add `dragFirstQuickReply()` to `RelayUi`; the real driver implementation reads the Send element location/size and performs one touch pointer action sequence:

Extend the local `RelayElement` contract with `getLocation(): Promise<{ x: number; y: number }>` and the test double with a fixed Send location and size. Add `performActions` and `releaseActions` spies to the orchestration harness.

```ts
try {
  await driver.performActions([{
    type: "pointer",
    id: "quick-reply-finger",
    parameters: { pointerType: "touch" },
    actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", x: centerX, y: centerY },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 650 },
      { type: "pointerMove", duration: 180, origin: "viewport", x: centerX, y: centerY - 52 },
      { type: "pointerUp", button: 0 }
    ]
  }]);
} finally {
  await driver.releaseActions();
}
```

Use `getLocation()` plus `getSize()` and round viewport coordinates. Keep the existing composer-clear and exact-single-transport assertions.

- [ ] **Step 4: Run the relay contract and verify GREEN**

Run: `pnpm --dir apps/mobile test -- e2e/specs/relay/relay-task-flow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the journey update**

```bash
git add apps/mobile/e2e apps/mobile/src/e2eTestIds.ts
git commit -m "test(mobile): drag quick reply in relay journey"
```

### Task 8: Full verification and cleanup

**Files:**
- Review all files changed above.

- [ ] **Step 1: Run the complete mobile unit suite**

Run: `pnpm --dir apps/mobile test -- --runInBand`

Expected: PASS with no unhandled timers, React act warnings, or stale native-menu assertions.

- [ ] **Step 2: Run mobile typecheck**

Run: `pnpm --dir apps/mobile run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Confirm the old menu and numbered visual affordances are gone**

Run:

```bash
rg -n "showTaskQuickReplyMenu|TASK_QUICK_REPLIES|Quick Replies.*ActionSheet|messagePrefix|quick-reply.*num" apps/mobile/src apps/mobile/e2e
```

Expected: no obsolete production references. `Quick Replies` remains only for the editor/accessibility picker and relevant tests.

- [ ] **Step 4: Confirm OTA compatibility remains unchanged**

Run: `git diff HEAD~7 -- apps/mobile/src/mobileEnvironments.json apps/mobile/app.config.ts apps/mobile/plugins apps/mobile/package.json`

Expected: no native configuration, runtime version, plugin, or dependency changes.

- [ ] **Step 5: Inspect the final diff**

Run: `git status --short && git diff --check && git log --oneline -8`

Expected: only planned mobile implementation/tests and the design/plan documents; `git diff --check` is clean.

- [ ] **Step 6: Run the explicit relay journey when its environment is available**

Run: `pnpm --dir apps/mobile run test:e2e:relay`

Expected: PASS, including one exact `SGTM. Proceed.\n\nPreserve the relay fixture.` input from the W3C hold-drag-release gesture. If simulator, relay, credentials, or desktop prerequisites are absent, record the prerequisite blocker separately; do not treat it as a unit/typecheck failure.

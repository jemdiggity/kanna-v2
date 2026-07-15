# Mobile Send Quick Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a press-and-hold menu to the mobile task composer that immediately sends `SGTM. Proceed.` plus any current draft through the existing input path.

**Architecture:** Keep reply data and composition in a pure module, isolate iOS/other-platform native menu presentation in a small adapter, and let `TaskScreen` retain ownership of draft state and submission. The feature changes no controller, transport, server, native configuration, dependency, or OTA runtime version.

**Tech Stack:** React Native 0.79, React 19, TypeScript, Vitest, `ActionSheetIOS`, `Alert`, `Pressable`

---

## File Structure

- Create `apps/mobile/src/screens/taskQuickReplies.ts` for the typed shortcut catalog and pure message composition.
- Create `apps/mobile/src/screens/taskQuickReplies.test.ts` for catalog and composition behavior.
- Create `apps/mobile/src/screens/taskQuickReplyMenu.ts` for platform-native menu presentation.
- Create `apps/mobile/src/screens/taskQuickReplyMenu.test.ts` for iOS selection, cancel, invalid-index, and non-iOS fallback behavior.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` to wire the long press into the existing composer submission path.
- Modify `apps/mobile/src/screens/TaskScreen.test.tsx` to cover normal press, long press, draft composition, clearing, accessibility, and disabled state.

### Task 1: Quick-reply catalog and message composition

**Files:**
- Create: `apps/mobile/src/screens/taskQuickReplies.test.ts`
- Create: `apps/mobile/src/screens/taskQuickReplies.ts`

- [ ] **Step 1: Write the failing model tests**

Create `apps/mobile/src/screens/taskQuickReplies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildTaskQuickReply,
  TASK_QUICK_REPLIES
} from "./taskQuickReplies";

describe("task quick replies", () => {
  it("defines the initial SGTM reply with a stable id", () => {
    expect(TASK_QUICK_REPLIES).toEqual([
      {
        id: "sgtm-proceed",
        label: "SGTM. Proceed.",
        messagePrefix: "SGTM. Proceed."
      }
    ]);
  });

  it.each(["", "   ", "\n\t"]) (
    "builds only the shortcut for an empty draft %#",
    (draft) => {
      expect(buildTaskQuickReply(TASK_QUICK_REPLIES[0]!, draft)).toBe(
        "SGTM. Proceed."
      );
    }
  );

  it("appends a trimmed draft after one blank line", () => {
    expect(
      buildTaskQuickReply(
        TASK_QUICK_REPLIES[0]!,
        "  Also add regression tests.  "
      )
    ).toBe("SGTM. Proceed.\n\nAlso add regression tests.");
  });
});
```

- [ ] **Step 2: Run the model test and confirm the expected failure**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/taskQuickReplies.test.ts
```

Expected: FAIL because `./taskQuickReplies` does not exist.

- [ ] **Step 3: Implement the catalog and pure builder**

Create `apps/mobile/src/screens/taskQuickReplies.ts`:

```ts
export interface TaskQuickReply {
  id: string;
  label: string;
  messagePrefix: string;
}

export const TASK_QUICK_REPLIES: readonly TaskQuickReply[] = [
  {
    id: "sgtm-proceed",
    label: "SGTM. Proceed.",
    messagePrefix: "SGTM. Proceed."
  }
];

export function buildTaskQuickReply(
  quickReply: TaskQuickReply,
  draft: string
): string {
  const trimmedDraft = draft.trim();
  return trimmedDraft
    ? `${quickReply.messagePrefix}\n\n${trimmedDraft}`
    : quickReply.messagePrefix;
}
```

- [ ] **Step 4: Run the model test and confirm it passes**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/taskQuickReplies.test.ts
```

Expected: PASS with five test instances, including the three parameterized empty-draft values.

- [ ] **Step 5: Commit the model**

```bash
git add apps/mobile/src/screens/taskQuickReplies.ts apps/mobile/src/screens/taskQuickReplies.test.ts
git commit -m "feat(mobile): define task quick replies"
```

### Task 2: Native quick-reply menu adapter

**Files:**
- Create: `apps/mobile/src/screens/taskQuickReplyMenu.test.ts`
- Create: `apps/mobile/src/screens/taskQuickReplyMenu.ts`
- Read: `apps/mobile/src/screens/taskQuickReplies.ts`

- [ ] **Step 1: Write the failing native-menu tests**

Create `apps/mobile/src/screens/taskQuickReplyMenu.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  actionSheet: vi.fn(),
  alert: vi.fn(),
  platform: { OS: "ios" }
}));

vi.mock("react-native", () => ({
  ActionSheetIOS: {
    showActionSheetWithOptions: nativeMocks.actionSheet
  },
  Alert: {
    alert: nativeMocks.alert
  },
  Platform: nativeMocks.platform
}));

import { showTaskQuickReplyMenu } from "./taskQuickReplyMenu";
import { TASK_QUICK_REPLIES } from "./taskQuickReplies";

describe("showTaskQuickReplyMenu", () => {
  beforeEach(() => {
    nativeMocks.actionSheet.mockReset();
    nativeMocks.alert.mockReset();
    nativeMocks.platform.OS = "ios";
  });

  it("shows the iOS shortcut and derived cancel index", () => {
    showTaskQuickReplyMenu(vi.fn());

    expect(nativeMocks.actionSheet).toHaveBeenCalledWith(
      {
        title: "Quick Replies",
        options: ["SGTM. Proceed.", "Cancel"],
        cancelButtonIndex: 1
      },
      expect.any(Function)
    );
  });

  it("selects only a valid iOS quick-reply index", () => {
    const onSelect = vi.fn();
    showTaskQuickReplyMenu(onSelect);
    const callback = nativeMocks.actionSheet.mock.calls[0]![1] as (
      index: number
    ) => void;

    callback(0);
    callback(1);
    callback(99);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(TASK_QUICK_REPLIES[0]);
  });

  it("shows equivalent shortcut and cancel actions off iOS", () => {
    nativeMocks.platform.OS = "android";
    const onSelect = vi.fn();

    showTaskQuickReplyMenu(onSelect);

    expect(nativeMocks.alert).toHaveBeenCalledWith(
      "Quick Replies",
      undefined,
      [
        expect.objectContaining({ text: "SGTM. Proceed." }),
        { text: "Cancel", style: "cancel" }
      ]
    );

    const shortcutAction = nativeMocks.alert.mock.calls[0]![2]![0]!;
    shortcutAction.onPress?.();
    expect(onSelect).toHaveBeenCalledWith(TASK_QUICK_REPLIES[0]);
  });
});
```

- [ ] **Step 2: Run the native-menu test and confirm the expected failure**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/taskQuickReplyMenu.test.ts
```

Expected: FAIL because `./taskQuickReplyMenu` does not exist.

- [ ] **Step 3: Implement the platform adapter**

Create `apps/mobile/src/screens/taskQuickReplyMenu.ts`:

```ts
import { ActionSheetIOS, Alert, Platform } from "react-native";
import {
  TASK_QUICK_REPLIES,
  type TaskQuickReply
} from "./taskQuickReplies";

const MENU_TITLE = "Quick Replies";
const CANCEL_LABEL = "Cancel";

export function showTaskQuickReplyMenu(
  onSelect: (quickReply: TaskQuickReply) => void
): void {
  if (Platform.OS === "ios") {
    const cancelButtonIndex = TASK_QUICK_REPLIES.length;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: MENU_TITLE,
        options: [
          ...TASK_QUICK_REPLIES.map((quickReply) => quickReply.label),
          CANCEL_LABEL
        ],
        cancelButtonIndex
      },
      (buttonIndex) => {
        const quickReply = TASK_QUICK_REPLIES[buttonIndex];
        if (quickReply) {
          onSelect(quickReply);
        }
      }
    );
    return;
  }

  Alert.alert(
    MENU_TITLE,
    undefined,
    [
      ...TASK_QUICK_REPLIES.map((quickReply) => ({
        text: quickReply.label,
        onPress: () => onSelect(quickReply)
      })),
      { text: CANCEL_LABEL, style: "cancel" as const }
    ]
  );
}
```

- [ ] **Step 4: Run the model and menu tests and confirm they pass**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/taskQuickReplies.test.ts src/screens/taskQuickReplyMenu.test.ts
```

Expected: PASS for both test files.

- [ ] **Step 5: Commit the native menu adapter**

```bash
git add apps/mobile/src/screens/taskQuickReplyMenu.ts apps/mobile/src/screens/taskQuickReplyMenu.test.ts
git commit -m "feat(mobile): present native quick reply menu"
```

### Task 3: Task composer integration

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Read: `apps/mobile/src/screens/taskQuickReplies.ts`
- Read: `apps/mobile/src/screens/taskQuickReplyMenu.ts`

- [ ] **Step 1: Extend the component-test state and menu mocks**

In `apps/mobile/src/screens/TaskScreen.test.tsx`, add hoisted controls before the React mock:

```ts
const componentMocks = vi.hoisted(() => ({
  draftInput: "",
  draftSetter: vi.fn(),
  onSendInput: vi.fn(),
  showQuickReplyMenu: vi.fn()
}));
```

Change the mocked `useState` implementation so string state uses the controlled draft and all other state keeps its initial value:

```ts
useState: <T,>(initialValue: T) =>
  typeof initialValue === "string"
    ? [componentMocks.draftInput as T, componentMocks.draftSetter] as const
    : [initialValue, vi.fn()] as const
```

Mock the native menu adapter after the existing component mocks:

```ts
vi.mock("./taskQuickReplyMenu", () => ({
  showTaskQuickReplyMenu: componentMocks.showQuickReplyMenu
}));
```

Extend the Vitest import, import the terminal-status type and quick-reply catalog, then reset the controlled values before every test:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskTerminalStatus } from "../state/sessionStore";
import { TASK_QUICK_REPLIES } from "./taskQuickReplies";
```

```ts
beforeEach(() => {
  componentMocks.draftInput = "";
  componentMocks.draftSetter.mockReset();
  componentMocks.onSendInput.mockReset();
  componentMocks.showQuickReplyMenu.mockReset();
});
```

Replace the positional render helper with this options-based version:

```ts
interface RenderTaskScreenOptions {
  agentType: "agent" | "pty";
  terminalDims?: { cols: number | null; rows: number | null };
  e2eTaskSnapshotMarker?: string;
  activity?: "idle" | "working" | "unread";
  draftInput?: string;
  terminalStatus?: TaskTerminalStatus;
  agentStatus?: TaskTerminalStatus;
}

function renderTaskScreen({
  agentType,
  terminalDims = { cols: null, rows: null },
  e2eTaskSnapshotMarker,
  activity = "idle",
  draftInput = "",
  terminalStatus = "live",
  agentStatus = "live"
}: RenderTaskScreenOptions): ElementNode {
  if (!TaskScreen) {
    throw new Error("TaskScreen was not loaded");
  }

  componentMocks.draftInput = draftInput;

  return TaskScreen({
    task: {
      id: "task-1",
      repoId: "repo-1",
      title: "Task",
      stage: "in progress",
      agentType,
      activity
    },
    terminalOutput: "terminal",
    terminalStatus,
    terminalCols: terminalDims.cols,
    terminalRows: terminalDims.rows,
    terminalErrorMessage: null,
    agentEvents: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
    agentStatus,
    agentErrorMessage: null,
    e2eTaskSnapshotMarker,
    onBack: vi.fn(),
    onOpenMore: vi.fn(),
    onSendInput: componentMocks.onSendInput,
    onStopAgent: vi.fn(),
    onResolveAgentPermission: vi.fn()
  }) as ElementNode;
}
```

Update the existing test calls to pass named options, preserving their current assertions:

```ts
renderTaskScreen({ agentType: "agent" });
renderTaskScreen({ agentType: "pty" });
renderTaskScreen({ agentType: "pty", terminalDims: { cols: 132, rows: 43 } });
renderTaskScreen({ agentType: "agent", e2eTaskSnapshotMarker: marker });
renderTaskScreen({
  agentType: "pty",
  e2eTaskSnapshotMarker: "other-task:Task\ntask-1:Task"
});
renderTaskScreen({ agentType: "pty", activity: "unread" });
```

- [ ] **Step 2: Write failing normal-send and long-press component tests**

Add these cases to `TaskScreen.test.tsx`, adapting existing calls to the options-based `renderTaskScreen` helper:

```ts
it("sends a trimmed draft normally and clears the composer", () => {
  const tree = renderTaskScreen({
    agentType: "agent",
    draftInput: "  Use the smaller API.  "
  });
  const sendButton = findByTestId(tree, "mobile.task-send-button");

  (sendButton?.props?.onPress as (() => void))();

  expect(componentMocks.onSendInput).toHaveBeenCalledWith("Use the smaller API.");
  expect(componentMocks.draftSetter).toHaveBeenCalledWith("");
});

it("opens quick replies on long press even with an empty draft", () => {
  const tree = renderTaskScreen({ agentType: "agent" });
  const sendButton = findByTestId(tree, "mobile.task-send-button");

  expect(sendButton?.props).toMatchObject({
    accessibilityHint: "Press and hold for quick replies.",
    accessibilityLabel: "Send reply",
    disabled: false
  });
  (sendButton?.props?.onLongPress as (() => void))();

  expect(componentMocks.showQuickReplyMenu).toHaveBeenCalledOnce();
});

it("sends the selected quick reply plus the current draft and clears it", () => {
  const tree = renderTaskScreen({
    agentType: "agent",
    draftInput: "  Also add regression tests.  "
  });
  const sendButton = findByTestId(tree, "mobile.task-send-button");
  (sendButton?.props?.onLongPress as (() => void))();
  const onSelect = componentMocks.showQuickReplyMenu.mock.calls[0]![0] as (
    quickReply: (typeof TASK_QUICK_REPLIES)[number]
  ) => void;

  onSelect(TASK_QUICK_REPLIES[0]!);

  expect(componentMocks.onSendInput).toHaveBeenCalledWith(
    "SGTM. Proceed.\n\nAlso add regression tests."
  );
  expect(componentMocks.draftSetter).toHaveBeenCalledWith("");
});

it("disables ordinary and shortcut sends only when the composer is unavailable", () => {
  const tree = renderTaskScreen({
    agentType: "agent",
    agentStatus: "error"
  });

  expect(findByTestId(tree, "mobile.task-send-button")?.props).toMatchObject({
    accessibilityState: { disabled: true },
    disabled: true
  });
  const sendButton = findByTestId(tree, "mobile.task-send-button");
  (sendButton?.props?.onLongPress as (() => void))();
  (sendButton?.props?.onPress as (() => void))();

  expect(componentMocks.showQuickReplyMenu).not.toHaveBeenCalled();
  expect(componentMocks.onSendInput).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the component test and confirm the expected failure**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/TaskScreen.test.tsx
```

Expected: FAIL because Send has no long-press menu handler, remains disabled for an empty draft, and does not expose the specified accessibility properties.

- [ ] **Step 4: Wire quick replies into `TaskScreen`**

In `apps/mobile/src/screens/TaskScreen.tsx`, import the new modules:

```ts
import { showTaskQuickReplyMenu } from "./taskQuickReplyMenu";
import {
  buildTaskQuickReply,
  type TaskQuickReply
} from "./taskQuickReplies";
```

Replace the current `sendDisabled` and `sendDraftInput` definitions with shared submission helpers:

```ts
const submitInput = (input: string) => {
  const nextInput = input.trim();
  if (!nextInput || isComposerDisabled) {
    return;
  }

  onSendInput(nextInput);
  setDraftInput("");
};
const sendDraftInput = () => submitInput(draftInput);
const sendQuickReply = (quickReply: TaskQuickReply) => {
  submitInput(buildTaskQuickReply(quickReply, draftInput));
};
const openQuickReplyMenu = () => {
  if (!isComposerDisabled) {
    showTaskQuickReplyMenu(sendQuickReply);
  }
};
```

Update the Send pressable so only genuine composer unavailability disables it:

```tsx
<Pressable
  accessibilityHint="Press and hold for quick replies."
  accessibilityLabel="Send reply"
  accessibilityRole="button"
  accessibilityState={{ disabled: isComposerDisabled }}
  disabled={isComposerDisabled}
  style={[
    styles.sendButton,
    isComposerDisabled ? styles.sendButtonDisabled : null
  ]}
  testID={MOBILE_E2E_IDS.taskSendButton}
  onLongPress={openQuickReplyMenu}
  onPress={sendDraftInput}
>
  <Text style={styles.sendButtonLabel}>Send</Text>
</Pressable>
```

Keep `TextInput.editable={!isComposerDisabled}` and the existing disabled style unchanged.

- [ ] **Step 5: Run the focused mobile screen tests and confirm they pass**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/screens/taskQuickReplies.test.ts src/screens/taskQuickReplyMenu.test.ts src/screens/TaskScreen.test.tsx
```

Expected: PASS for the quick-reply model, platform adapter, and task composer tests.

- [ ] **Step 6: Run mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 7: Commit the task composer integration**

```bash
git add apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx
git commit -m "feat(mobile): send quick replies on long press"
```

### Task 4: Full mobile verification and handoff

**Files:**
- Verify: `apps/mobile/src/screens/taskQuickReplies.ts`
- Verify: `apps/mobile/src/screens/taskQuickReplyMenu.ts`
- Verify: `apps/mobile/src/screens/TaskScreen.tsx`
- Verify: `docs/superpowers/specs/2026-07-16-mobile-send-quick-replies-design.md`

- [ ] **Step 1: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand
```

Expected: PASS for every mobile Vitest file.

- [ ] **Step 2: Re-run mobile typecheck after the complete suite**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 3: Inspect only task-related history and worktree state**

Run:

```bash
git log --oneline --max-count=8
git status --short
```

Expected: the design, plan, quick-reply model, native menu adapter, and composer integration are committed; no task-related file remains modified or untracked.

- [ ] **Step 4: Record the successful Kanna stage result**

Use the task id from `KANNA_TASK_ID` and report the exact committed behavior:

```bash
kanna-cli stage-complete \
  --task-id "$KANNA_TASK_ID" \
  --status success \
  --summary "Added a native long-press Send menu on mobile that sends SGTM. Proceed. plus any current draft through the existing task input route; covered the shortcut model, iOS/other-platform menu behavior, composer integration, accessibility, disabled states, and mobile verification."
```

Expected: Kanna accepts the successful stage result. Prefer the equivalent `kanna_complete_stage` MCP call when that MCP tool is available.

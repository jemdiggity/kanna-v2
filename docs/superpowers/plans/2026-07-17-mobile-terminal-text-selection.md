# Mobile Terminal Text Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add double-tap-to-select and drag-to-extend text selection to the mobile PTY terminal, with native Copy/Cancel controls that preserve existing scroll, pinch, file-link, and streaming behavior.

**Architecture:** The generated xterm document owns touch recognition, screen-to-buffer coordinate conversion, and xterm's public selection APIs. `TerminalWebView` validates selection bridge messages, renders accessible native controls, and writes through Expo's platform clipboard before injecting a public clear-selection hook back into the document.

**Tech Stack:** React Native 0.86, Expo SDK 57, `react-native-webview`, xterm 6.1 beta public APIs, `expo-clipboard`, Vitest/happy-dom, Playwright TUI-fidelity harness, pnpm.

**Kanna stage constraint:** Do not create implementation commits while executing this plan. This task's pipeline post owns the implementation commit after human review; use test and diff checkpoints instead.

---

## File Map

- Modify `apps/mobile/package.json` and `pnpm-lock.yaml`: add the Expo SDK-compatible clipboard module.
- Modify `apps/mobile/src/mobileEnvironments.json` and `apps/mobile/src/mobileAppConfig.test.ts`: bump and verify the OTA runtime because the clipboard module changes native compatibility.
- Modify `apps/mobile/src/screens/buildTerminalDocument.ts`: implement public xterm selection state, touch-to-cell mapping, double-tap activation, drag extension, bridge notification, and clear hook.
- Modify `apps/mobile/src/screens/buildTerminalDocument.test.ts`: model xterm selection APIs and test generated-document selection and gesture behavior.
- Modify `apps/mobile/src/screens/TerminalWebView.tsx`: validate selection messages, own native toolbar/error state, invoke the platform clipboard, and clear the document selection.
- Modify `apps/mobile/src/screens/TerminalWebView.test.tsx`: mock the clipboard and cover toolbar, validation, copy failure, cancellation, reload, and task-switch behavior.
- Modify `tests/tui-fidelity/src/render.ts`: exercise double-tap selection and range extension against the real bundled xterm renderer.
- Modify `tests/tui-fidelity/src/run.ts`: execute and report the real-browser mobile selection regression.

### Task 1: Add the native clipboard boundary and selection toolbar

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/mobile/src/mobileEnvironments.json`
- Modify: `apps/mobile/src/mobileAppConfig.test.ts`
- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx:1-483`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx:1-456`
- Test: `apps/mobile/src/screens/TerminalWebView.test.tsx`

- [x] **Step 1: Add the Expo SDK-compatible clipboard package**

Run:

```sh
pnpm --dir apps/mobile add expo-clipboard@~57.0.1
```

Expected: `apps/mobile/package.json` contains `"expo-clipboard": "~57.0.1"`, the lockfile gains the workspace dependency/importer resolution, and pnpm exits 0.

- [x] **Step 1a: Bump native OTA compatibility**

Change all dev, staging, and production `runtimeVersion` entries from `2.0.0` to `2.0.1`, and update the three production/dev/staging assertions in `mobileAppConfig.test.ts`. Run `pnpm --dir apps/mobile test -- src/mobileAppConfig.test.ts`; expected: all five configuration tests pass.

- [x] **Step 2: Add clipboard and tree helpers to the terminal wrapper test harness**

Add a hoisted clipboard mock and a recursive element finder near the existing test globals:

```tsx
const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn<(value: string) => Promise<void>>()
}));

vi.mock("expo-clipboard", () => clipboardMocks);

function findByAccessibilityLabel(
  node: ElementNode | null,
  label: string
): ElementNode | null {
  if (!node) return null;
  if (node.props.accessibilityLabel === label) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    if (typeof child === "object" && child !== null && "type" in child) {
      const match = findByAccessibilityLabel(child as ElementNode, label);
      if (match) return match;
    }
  }
  return null;
}
```

Reset `clipboardMocks.setStringAsync` in `beforeEach` and default it to `mockResolvedValue(undefined)`.

- [x] **Step 3: Write failing tests for message validation and toolbar rendering**

Add these tests before the E2E inspection tests:

```tsx
it("renders native controls for a validated terminal selection", async () => {
  const webView = await renderTerminalWebView({});
  (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({
        type: "terminal-selection-change",
        text: "selected output"
      })
    }
  } as WebViewMessageEvent);

  await renderTerminalWebView({});

  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).not.toBeNull();
  expect(findByAccessibilityLabel(lastTree, "Cancel terminal text selection")).not.toBeNull();
});

it("ignores malformed and oversized terminal selections", async () => {
  const webView = await renderTerminalWebView({});
  const send = (text: unknown) => {
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text })
      }
    } as WebViewMessageEvent);
  };

  send(null);
  send(42);
  send("x".repeat(2_300_001));
  await renderTerminalWebView({});

  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).toBeNull();
});
```

- [x] **Step 4: Run the focused test and verify RED**

Run:

```sh
pnpm --dir apps/mobile test -- src/screens/TerminalWebView.test.tsx
```

Expected: FAIL because `terminal-selection-change` is ignored and no Copy/Cancel controls render.

- [x] **Step 5: Add validated selection state and native controls**

Import the clipboard module:

```tsx
import * as Clipboard from "expo-clipboard";
```

Add the fixed bridge ceiling and clear script helper near the existing interfaces:

```tsx
const MAX_TERMINAL_SELECTION_LENGTH = 2_300_000;

function clearTerminalSelectionScript(): string {
  return "window.__clearTerminalSelection(); true;";
}
```

Add component state:

```tsx
const [terminalSelection, setTerminalSelection] = useState("");
const [selectionCopyError, setSelectionCopyError] = useState<string | null>(null);
```

Extend the parsed payload type with `text?: unknown`, then handle the new message before `terminal-tap`:

```tsx
if (payload.type === "terminal-selection-change") {
  if (
    typeof payload.text !== "string" ||
    payload.text.length > MAX_TERMINAL_SELECTION_LENGTH
  ) {
    return;
  }
  setTerminalSelection(payload.text);
  setSelectionCopyError(null);
  return;
}
```

Add explicit handlers. Only clipboard success clears the active range:

```tsx
const clearTerminalSelection = () => {
  setTerminalSelection("");
  setSelectionCopyError(null);
  webViewRef.current?.injectJavaScript(clearTerminalSelectionScript());
};

const copyTerminalSelection = async () => {
  if (!terminalSelection) return;
  try {
    await Clipboard.setStringAsync(terminalSelection);
    clearTerminalSelection();
  } catch {
    setSelectionCopyError("Couldn’t copy. Try again.");
  }
};
```

Render this toolbar immediately before the WebView:

```tsx
{terminalSelection ? (
  <View
    accessibilityLabel="Terminal text selection controls"
    style={[
      styles.selectionToolbar,
      { top: terminalFileLinks.length ? 55 : 12 }
    ]}
  >
    <Text accessibilityLiveRegion="polite" style={styles.selectionStatus}>
      {selectionCopyError ?? "Text selected"}
    </Text>
    <Pressable
      accessibilityLabel="Copy selected terminal text"
      accessibilityRole="button"
      onPress={() => void copyTerminalSelection()}
      style={styles.selectionButtonPrimary}
    >
      <Text style={styles.selectionButtonPrimaryText}>Copy</Text>
    </Pressable>
    <Pressable
      accessibilityLabel="Cancel terminal text selection"
      accessibilityRole="button"
      onPress={clearTerminalSelection}
      style={styles.selectionButton}
    >
      <Text style={styles.selectionButtonText}>Cancel</Text>
    </Pressable>
  </View>
) : null}
```

Add focused styles using the existing palette:

```tsx
selectionToolbar: {
  alignItems: "center",
  alignSelf: "center",
  backgroundColor: "#10213A",
  borderColor: "#365B83",
  borderRadius: 10,
  borderWidth: 1,
  flexDirection: "row",
  gap: 8,
  padding: 8,
  position: "absolute",
  zIndex: 10
},
selectionStatus: { color: "#D8E7F7", fontSize: 12 },
selectionButton: { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7 },
selectionButtonText: { color: "#A9D7FF", fontSize: 12, fontWeight: "700" },
selectionButtonPrimary: {
  backgroundColor: "#A9D7FF",
  borderRadius: 7,
  paddingHorizontal: 10,
  paddingVertical: 7
},
selectionButtonPrimaryText: { color: "#07101D", fontSize: 12, fontWeight: "700" }
```

- [x] **Step 6: Run the focused test and verify GREEN**

Run the same focused command. Expected: all existing `TerminalWebView` tests and the two new validation tests pass.

- [x] **Step 7: Write failing tests for Copy, failure, Cancel, task switch, and reload**

Add the following concrete Copy and failure tests:

```tsx
it("copies exact terminal text and clears only after clipboard success", async () => {
  let resolveCopy!: () => void;
  clipboardMocks.setStringAsync.mockReturnValue(
    new Promise<void>((resolve) => { resolveCopy = resolve; })
  );
  const webView = await renderTerminalWebView({});
  (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({ type: "terminal-selection-change", text: "  exact\ntext  " })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({});

  const copy = findByAccessibilityLabel(lastTree, "Copy selected terminal text");
  const pending = (copy?.props.onPress as () => Promise<void> | void)();
  expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith("  exact\ntext  ");
  expect(injectedScripts).not.toContain("window.__clearTerminalSelection(); true;");

  resolveCopy();
  await pending;
  expect(injectedScripts).toContain("window.__clearTerminalSelection(); true;");
});

it("keeps selection available when clipboard writing fails", async () => {
  clipboardMocks.setStringAsync.mockRejectedValue(new Error("denied"));
  const webView = await renderTerminalWebView({});
  (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({ type: "terminal-selection-change", text: "retry me" })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({});

  await (findByAccessibilityLabel(lastTree, "Copy selected terminal text")?.props.onPress as () => Promise<void>)();
  await renderTerminalWebView({});

  expect(injectedScripts).not.toContain("window.__clearTerminalSelection(); true;");
  expect(JSON.stringify(lastTree)).toContain("Couldn’t copy. Try again.");
  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).not.toBeNull();
});
```

Add these lifecycle tests:

```tsx
it("cancels terminal selection without writing the clipboard", async () => {
  const webView = await renderTerminalWebView({});
  (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({ type: "terminal-selection-change", text: "discard me" })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({});

  (findByAccessibilityLabel(
    lastTree,
    "Cancel terminal text selection"
  )?.props.onPress as () => void)();

  expect(clipboardMocks.setStringAsync).not.toHaveBeenCalled();
  expect(injectedScripts).toContain("window.__clearTerminalSelection(); true;");
});

it("clears stale selection when switching tasks or reloading the WebView", async () => {
  const initial = await renderTerminalWebView({ taskId: "task-1" });
  runEffects();
  (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({ type: "terminal-selection-change", text: "old task" })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({ taskId: "task-1" });
  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).not.toBeNull();

  await renderTerminalWebView({ taskId: "task-2" });
  runEffects();
  await renderTerminalWebView({ taskId: "task-2" });
  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).toBeNull();

  (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({ type: "terminal-selection-change", text: "reload" })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({ taskId: "task-2" });
  (initial.props.onLoadStart as () => void)();
  await renderTerminalWebView({ taskId: "task-2" });
  expect(findByAccessibilityLabel(lastTree, "Copy selected terminal text")).toBeNull();
});
```

- [x] **Step 8: Run focused tests to verify RED, implement lifecycle clearing, then verify GREEN**

Before changing lifecycle code, run the focused test and confirm task-switch/reload cases fail. Then clear `terminalSelection` and `selectionCopyError` in the existing task-change branch and `onLoadStart`. Re-run until the file is green.

- [x] **Step 9: Check the native boundary diff**

Run:

```sh
git diff --check
git diff -- apps/mobile/package.json pnpm-lock.yaml apps/mobile/src/screens/TerminalWebView.tsx apps/mobile/src/screens/TerminalWebView.test.tsx
```

Expected: no whitespace errors; changes are limited to dependency, validated bridge state, native controls, clipboard behavior, and tests.

### Task 2: Implement double-tap word selection in the generated xterm document

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts:1-921`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts:183-768`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

- [x] **Step 1: Extend the terminal stub with public selection behavior**

Add state and public APIs to `StubTerminal`:

```ts
selection = "";
selectionCalls: Array<{ column: number; row: number; length: number }> = [];
clearSelectionCalls = 0;
private selectionListeners: Array<() => void> = [];

onSelectionChange(listener: () => void): { dispose(): void } {
  this.selectionListeners.push(listener);
  return {
    dispose: () => {
      this.selectionListeners = this.selectionListeners.filter(
        (candidate) => candidate !== listener
      );
    }
  };
}

select(column: number, row: number, length: number): void {
  this.selectionCalls.push({ column, row, length });
  const endOffset = column + length;
  const endRow = row + Math.floor(endOffset / this.cols);
  const endColumn = endOffset % this.cols;
  const selectedLines: string[] = [];
  for (let lineIndex = row; lineIndex <= endRow; lineIndex += 1) {
    const line = this.bufferLines.get(lineIndex) ?? "";
    const start = lineIndex === row ? column : 0;
    const end = lineIndex === endRow ? endColumn : line.length;
    selectedLines.push(line.slice(start, end).trimEnd());
  }
  this.selection = selectedLines.join("\n");
  for (const listener of this.selectionListeners) listener();
}

getSelection(): string {
  return this.selection;
}

clearSelection(): void {
  this.clearSelectionCalls += 1;
  this.selection = "";
  for (const listener of this.selectionListeners) listener();
}
```

Extend `createTouchEvent` with optional changed touches so tap-ending coordinates are available:

```ts
function createTouchEvent(
  window: Window,
  type: string,
  touches: TouchPoint[],
  options: EventInit = { bubbles: true, cancelable: true },
  changedTouches: TouchPoint[] = touches
): Event {
  const event = new window.Event(type, options);
  Object.defineProperties(event, {
    touches: { configurable: true, value: touches },
    changedTouches: { configurable: true, value: changedTouches }
  });
  return event;
}
```

Add a `tapTerminal` helper that dispatches touchstart/touchend with controlled time and preserves the ending touch coordinate:

```ts
function tapTerminal(
  window: Window,
  viewport: HTMLElement,
  point: TouchPoint,
  at: number
): void {
  const now = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [point]));
    viewport.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [point])
    );
  } finally {
    now.mockRestore();
  }
}
```

- [x] **Step 2: Write failing double-tap selection tests**

Add tests covering one tap, word selection, separator fallback, and Unicode cells:

```ts
it("selects the terminal word under a qualifying double tap", () => {
  const { messages, terminal, viewport, window } = createExecutedTerminalDocument();
  terminal.buffer.active.viewportY = 0;
  terminal.bufferLines.set(2, "alpha selected omega");

  tapTerminal(window, viewport, { clientX: 9 * 7, clientY: 18 * 2 + 9 }, 1000);
  tapTerminal(window, viewport, { clientX: 9 * 9, clientY: 18 * 2 + 9 }, 1200);

  expect(terminal.selectionCalls.at(-1)).toEqual({ column: 6, row: 2, length: 8 });
  expect(terminal.getSelection()).toBe("selected");
  expect(messages.map((value) => JSON.parse(value))).toContainEqual({
    type: "terminal-selection-change",
    text: "selected"
  });
});
```

Add a one-tap assertion with no selection call, a tap on the separating space that selects one cell, and wide/combining-prefix cases that assert terminal-cell columns rather than UTF-16 offsets.

- [x] **Step 3: Run the generated-document test and verify RED**

Run:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
```

Expected: FAIL because the generated document neither recognizes double taps nor calls xterm selection APIs.

- [x] **Step 4: Add selection constants, state, bridge notification, and clear hook**

Add constants beside the gesture constants:

```js
const DOUBLE_TAP_MAX_DELAY_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
```

Add state beside `touchScroll` and `pinch`:

```js
let lastTap = null;
let selectionAnchor = null;
let selectionMode = false;
```

After `term.open(root)`, subscribe using only public APIs:

```js
term.onSelectionChange(() => {
  if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: "terminal-selection-change",
    text: term.getSelection()
  }));
});
```

Expose a lifecycle-safe public hook:

```js
function clearTerminalSelection() {
  selectionMode = false;
  selectionAnchor = null;
  lastTap = null;
  term.clearSelection();
  stickyToBottom = isNearBottom();
}

window.__clearTerminalSelection = clearTerminalSelection;
```

Call `clearTerminalSelection()` before `term.reset()` in replacement state handling so buffer replacement cannot retain stale coordinates.

- [x] **Step 5: Add public screen-to-buffer and word-range helpers**

Implement these generated-script helpers near `cellDimensions()`:

```js
function terminalPoint(touch) {
  const screen = root.querySelector(".xterm-screen");
  if (!screen || !touch) return null;
  const rect = screen.getBoundingClientRect();
  const { width, height } = cellDimensions();
  if (
    width <= 0 || height <= 0 ||
    touch.clientX < rect.left || touch.clientX >= rect.right ||
    touch.clientY < rect.top || touch.clientY >= rect.bottom
  ) return null;
  const column = Math.floor(clamp((touch.clientX - rect.left) / width, 0, term.cols - 1));
  const viewportRow = Math.floor(clamp((touch.clientY - rect.top) / height, 0, term.rows - 1));
  const row = Math.floor(clamp(
    term.buffer.active.viewportY + viewportRow,
    0,
    Math.max(0, term.buffer.active.length - 1)
  ));
  return { column, row };
}

function terminalCellSegments(line) {
  const segments = [];
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    segments.push({
      start: column,
      end: column + Math.max(1, cell.getWidth()),
      text: cell.getChars() || " "
    });
  }
  return segments;
}

function isWordSegment(segment) {
  const separators = term.options.wordSeparator || " ()[]{}',\"`";
  return Array.from(segment.text).some(
    (character) => !/\\s/u.test(character) && !separators.includes(character)
  );
}
```

Implement word-range lookup with an exclusive end point:

```js
function terminalWordRange(point) {
  const line = term.buffer.active.getLine(point.row);
  if (!line) return null;
  const segments = terminalCellSegments(line);
  const tappedIndex = segments.findIndex(
    (segment) => point.column >= segment.start && point.column < segment.end
  );
  if (tappedIndex < 0) return null;

  let first = tappedIndex;
  let last = tappedIndex;
  if (isWordSegment(segments[tappedIndex])) {
    while (first > 0 && isWordSegment(segments[first - 1])) first -= 1;
    while (last + 1 < segments.length && isWordSegment(segments[last + 1])) last += 1;
  }
  return {
    start: { row: point.row, column: segments[first].start },
    end: { row: point.row, column: segments[last].end }
  };
}
```

Add ordered range helpers:

```js
function compareTerminalPoints(left, right) {
  return left.row === right.row
    ? left.column - right.column
    : left.row - right.row;
}

function selectTerminalRange(start, end) {
  const orderedStart = compareTerminalPoints(start, end) <= 0 ? start : end;
  const orderedEnd = compareTerminalPoints(start, end) <= 0 ? end : start;
  const length =
    (orderedEnd.row - orderedStart.row) * term.cols +
    orderedEnd.column - orderedStart.column;
  term.select(orderedStart.column, orderedStart.row, Math.max(1, length));
}
```

- [x] **Step 6: Recognize the second tap without breaking ordinary gestures**

In touch end, capture `changedTouches[0]` and whether the gesture moved before clearing state. A settled first tap stores `{ at, x, y }`. A settled second tap within both thresholds calls `terminalWordRange`, stores the word's start/end as `selectionAnchor`, sets `selectionMode = true`, disables sticky follow, selects the word, suppresses file-link activation, prevents the second touchend default, and clears `lastTap`.

Reset `lastTap` on movement, multi-touch, cancel, buffer replacement, and explicit selection clear. Change the touchend listener to `{ passive: false, capture: true }` so only a recognized second tap can call `preventDefault()` and suppress WebView double-tap zoom.

- [x] **Step 7: Run the focused generated-document test and verify GREEN**

Expected: new double-tap tests pass alongside all existing scrolling, pinch, file-link, streaming, and resize tests.

- [x] **Step 8: Check the generated-document diff**

Run `git diff --check` and inspect only the two generated-document source/test files. Confirm the production script contains no `term._core` or xterm asset edits.

### Task 3: Extend selection by drag without gesture collisions

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

- [x] **Step 1: Write failing tests for selection-mode drag behavior**

After using `tapTerminal` twice to enter selection mode, dispatch a new one-finger touchstart and touchmove. Assert:

```ts
expect(terminal.selectionCalls.at(-1)).toEqual({
  column: expectedStartColumn,
  row: expectedStartRow,
  length: expectedLinearLength
});
expect(terminal.scrollToLineCalls).toEqual([]);
expect(viewport.scrollLeft).toBe(initialScrollLeft);
expect(move.defaultPrevented).toBe(true);
```

Use separate cases for forward extension, backward extension, and a later visible row. Add a control case proving the same drag scrolls before selection mode. Add a Markdown-link case proving double tap and range drag never emit `terminal-file-link`.

- [x] **Step 2: Run the focused test and verify RED**

Expected: selection-mode drags still enter the current scroll branch or leave the original word unchanged.

- [x] **Step 3: Route one-finger selection-mode movement to xterm selection**

On selection-mode touchstart, record the current terminal point instead of creating `touchScroll`. During touchmove:

```js
if (selectionMode && event.touches.length === 1 && selectionAnchor) {
  const point = terminalPoint(event.touches[0]);
  if (!point) return;
  const beforeAnchor = compareTerminalPoints(point, selectionAnchor.start) < 0;
  const start = beforeAnchor ? point : selectionAnchor.start;
  const end = beforeAnchor
    ? selectionAnchor.end
    : { row: point.row, column: Math.min(term.cols, point.column + 1) };
  selectTerminalRange(start, end);
  touchGestureMoved = true;
  suppressTerminalFileLinkActivation();
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  return;
}
```

The anchor preserves the entire initially selected word when the current point is inside or after it. Before-anchor movement uses the current cell as the inclusive start and the original word end as the exclusive end.

Multi-touch while selection mode is active must not pinch: suppress the link gesture, prevent the event when cancelable, and leave the current selection unchanged. Copy/Cancel is the explicit way to return to pinch/scroll mode.

- [x] **Step 4: Keep streaming and lifecycle behavior consistent**

Ensure append/finalize does not set sticky follow true while `selectionMode` is active:

```js
function finalizeRender(shouldStick) {
  stickyToBottom = selectionMode ? false : shouldStick;
  if (stickyToBottom) scrollToBottomImmediately();
  // existing alignment, links, and inspection behavior follows
}
```

In `__setTerminalDims`, `__setTerminalBottomInset`, `applyFontScale`, and the resize listener, calculate and restore sticky intent with the same guard:

```js
const shouldStick = selectionMode ? false : stickyToBottom || isNearBottom();
// existing resize, inset, scale, or fit operation
stickyToBottom = selectionMode ? false : shouldStick;
if (stickyToBottom) scrollToBottomImmediately();
```

In `__replaceTerminalState`, call `clearTerminalSelection()` before `term.reset()`.

- [x] **Step 5: Run generated-document tests and verify GREEN**

Run the focused test. Expected: all selection and existing gesture tests pass with no test warnings.

- [x] **Step 6: Run both mobile selection test files together**

Run:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx
```

Expected: both files pass, proving the bridge contract matches on each side.

### Task 4: Add a real-xterm browser regression

**Files:**
- Modify: `tests/tui-fidelity/src/render.ts:1-280`
- Modify: `tests/tui-fidelity/src/run.ts:1-60`
- Test: `pnpm test:tui-fidelity`

- [x] **Step 1: Add a reusable touch dispatcher and result type in the browser harness**

Refactor the existing inline synthetic touch construction into a browser-evaluated helper that sets `touches`, `targetTouches`, and `changedTouches` with stable identifiers. Preserve the eased-scroll test's current event sequence and assertions.

Add:

```ts
interface MobileSelectionResult {
  initialSelection: string;
  extendedSelection: string;
  scrollCallsDuringSelection: number;
  viewportYBeforeOrdinaryDrag: number;
  viewportYAfterOrdinaryDrag: number;
}
```

- [x] **Step 2: Implement `verifyMobileTerminalSelection(browser)`**

Create a touch-enabled context, load `buildInstrumentedMobileDocument()`, set a deterministic 80x20 grid, and render lines containing `alpha selected omega` at known visible rows. In `page.evaluate`:

1. Dispatch two settled taps 200 ms apart at the center of `selected`.
2. Read `term.getSelection()` as `initialSelection`.
3. Wrap `term.scrollToLine` to count scroll calls.
4. Dispatch a new touchstart/move/end toward `omega` and read `extendedSelection`.
5. Clear through `window.__clearTerminalSelection()`.
6. Dispatch an ordinary vertical drag and sample `viewportY` after the 80 ms smoothing window.

Assert outside the browser callback:

```ts
if (result.initialSelection !== "selected") {
  throw new Error(`mobile selection chose ${JSON.stringify(result.initialSelection)}`);
}
if (!result.extendedSelection.includes("selected omega")) {
  throw new Error(`mobile selection did not extend (${JSON.stringify(result.extendedSelection)})`);
}
if (result.scrollCallsDuringSelection !== 0) {
  throw new Error("mobile selection drag also scrolled xterm");
}
if (result.viewportYAfterOrdinaryDrag === result.viewportYBeforeOrdinaryDrag) {
  throw new Error("ordinary terminal drag stopped scrolling after selection clear");
}
```

- [x] **Step 3: Wire the regression into the runner and verify RED/GREEN sensitivity**

Call the new verifier after eased scrolling:

```ts
await verifyMobileTerminalSelection(browser);
process.stdout.write("PASS mobile-terminal-selection\n");
```

Before implementing or enabling the generated selection behavior, the new check must fail on `initialSelection`. After Tasks 2-3 it must pass. Temporarily disable the selection-mode touchmove branch and confirm the scroll-collision assertion fails, then restore it and rerun.

- [x] **Step 4: Run TUI-fidelity verification**

Run:

```sh
pnpm test:tui-fidelity
```

Expected: `PASS mobile-terminal-selection`, the existing eased-scroll/safe-region checks, and every fixture golden pass.

### Task 5: Full verification and review handoff

**Files:**
- Review all files listed in the File Map.

- [x] **Step 1: Run mobile typechecking**

```sh
pnpm --dir apps/mobile run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [x] **Step 2: Run the complete mobile unit suite**

```sh
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest files pass with zero failures.

- [x] **Step 3: Re-run the real-browser terminal suite**

```sh
pnpm test:tui-fidelity
```

Expected: safe-region, eased scrolling, mobile terminal selection, and all fixture comparisons pass.

- [x] **Step 4: Run repository whitespace and status checks**

```sh
git diff --check
git status --short
```

Expected: no whitespace errors; status lists only the plan plus the package, lockfile, mobile terminal source/tests, and TUI-fidelity source changes described above.

- [x] **Step 5: Review requirements against the diff**

Confirm from the final diff that:

- double tap selects a visible word through public xterm APIs;
- a later drag extends forward/backward/across visible rows;
- Copy waits for successful native clipboard completion;
- failure retains selection and is visible/retryable;
- Cancel, task switch, reload, and replace clear stale selection;
- selection gestures do not also scroll, pinch, double-zoom, or activate file links;
- ordinary gestures recover after clear;
- no physical-device automation, xterm private API, generated asset edit, push, PR, stage completion, or implementation commit occurred.

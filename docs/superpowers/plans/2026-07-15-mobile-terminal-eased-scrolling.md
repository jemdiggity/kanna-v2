# Mobile Terminal Eased Scrolling Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Route mobile one-finger vertical terminal drags through xterm's public eased scroll controller so row changes animate over a short 80 ms window without changing horizontal pan or pinch zoom.

**Architecture:** Keep all production gesture ownership inside the generated mobile terminal document. Axis-lock each one-finger gesture, translate vertical finger movement into a clamped, nearest-integer xterm buffer line, and call public `scrollToLine`; observe sticky-bottom state through public `onScroll`. Keep Kanna-owned bottom-follow immediate by temporarily disabling smooth duration around public `scrollToBottom()`, then restore 80 ms for gesture retargets. Cover the behavior twice: a fast happy-dom contract test around the generated script and a real Chromium regression using the bundled xterm implementation.

**Tech Stack:** TypeScript, xterm.js 6.1, happy-dom, Vitest, Playwright/Chromium, pnpm.

---

## Task 1: Add fast failing contracts for eased vertical gestures

**Files:**

- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

### Step 1: Model only the public xterm APIs required by the design

Extend `StubTerminal` with:

```ts
options: { fontSize: number; smoothScrollDuration?: number };
scrollToLineCalls: number[] = [];
scrollListeners: Array<(viewportY: number) => void> = [];
buffer = {
  active: {
    baseY: 100,
    viewportY: 76
  }
};
```

Capture `smoothScrollDuration` in the constructor. Implement `scrollToLine(line)` by rejecting non-integers with xterm's `This API only accepts integers` error and recording valid integer targets without synchronously changing `buffer.active.viewportY` or notifying scroll listeners; real eased scrolling advances asynchronously. Implement `onScroll(listener)` with a disposable return value, and add an explicit `emitScroll(viewportY)` helper that advances the buffer position and notifies listeners for sticky-bottom tests.

Add a minimal `scrollToBottomHook` to the stub so the rapid-append regression can model the public event timing: an 80 ms programmatic call emits a far intermediate row, while a duration-zero call emits the final bottom row synchronously.

Remove the stub's private `_core` render service. Make its `.xterm-screen.getBoundingClientRect()` return dynamic public geometry equivalent to 9 px per current column and 18 px per current row, including after `resize()`.

Do not make the stub emulate xterm's private scrolling implementation or mutable DOM `scrollTop`; it should describe the public contract the production document is expected to use.

### Step 2: Replace the old vertical delegation assertion with eased-scroll contracts

Add or update tests to prove:

- the terminal constructor receives `smoothScrollDuration: 80`;
- a vertical drag starting at `viewportY = 76` and moving upward by 45 px with an 18 px cell height rounds the clamped raw target to the nearest line, calls `scrollToLine(79)`, leaves `viewport.scrollLeft` unchanged, and prevents the handled event;
- after the first move locks vertical, a later move whose total displacement is horizontally dominant remains vertical and retargets `scrollToLine` rather than changing `scrollLeft`;
- a horizontal gesture still changes only `scrollLeft` and never calls `scrollToLine`;
- the existing two-finger pinch behavior still works and never calls `scrollToLine`;
- emitting xterm scroll positions outside and inside the row-converted bottom threshold changes `.xterm-viewport.style.bottom` from `0px` back to `24px`;
- two rapid appends each request bottom follow even when the stub models a far intermediate event for eased programmatic scrolling, and `smoothScrollDuration` is restored to 80 afterward;
- pinned root sizing uses the dynamic public 9-by-18 px cell geometry, and the generated application script contains no `term._core` access.

Update the non-E2E inspection test so it checks that inspection-only traversal (`renderedTerminalText`, `buffer.getLine`, and `terminal-inspection`) is absent instead of asserting that all `term.buffer.active` access is absent; buffer position is now legitimate production behavior.

### Step 3: Run the focused test and confirm RED

Run:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
```

Expected: FAIL because the document does not configure the 80 ms duration, does not call `scrollToLine` for vertical touch movement, still listens for sticky state on the inert DOM viewport, and loses auto-follow intent when an eased programmatic bottom scroll emits a far intermediate row before a rapid second append.

Do not edit production code until this failure is observed.

## Task 2: Add a real-browser regression against bundled xterm

**Files:**

- Modify: `tests/tui-fidelity/src/render.ts`
- Modify: `tests/tui-fidelity/src/run.ts`
- Test: `tests/tui-fidelity/src/run.ts`

### Step 1: Expose a focused smooth-scroll verification from the renderer

Add `verifyMobileEasedScrolling(browser: Browser): Promise<void>` to `render.ts`. It should:

1. Load `buildInstrumentedMobileDocument()` in a new page from a Chromium context configured with `hasTouch: true`, and verify touch capability is active.
2. Pin the real terminal to a deterministic grid and write at least 100 numbered CRLF-delimited lines through `__replaceTerminalState` so `buffer.active.baseY > 0` and the viewport starts at the bottom.
3. In the page, wrap the real terminal's public `scrollToLine` method to record the target chosen by the generated gesture handler.
4. Dispatch a cancelable one-finger `touchstart`, a predominantly vertical `touchmove` that moves the finger downward enough to scroll upward several rows, and `touchend` from inner `.xterm-screen`. Define complete touch-like `touches`, `targetTouches`, and `changedTouches` lists rather than relying on a browser-specific `Touch` constructor. Each touch carries its identifier, screen target, client/page/screen coordinates, radius, rotation, and force. Back the lists with arrays and assign `item: Array.prototype.at` directly so tsx does not leak a helper callback's `__name` transform into the browser.
5. Sample `buffer.active.viewportY` immediately, during the 80 ms window, and after the animation settles.
6. Throw a detailed error unless:
   - `scrollToLine` received a finite integer target smaller than the initial bottom line;
   - the immediate sample has not jumped directly to the requested target;
   - at least one later sample lies strictly between the initial and final positions;
   - the final position is within one row of the requested target;
   - the terminal's `.xterm-viewport.scrollTop` remains zero, proving the document is not relying on that inert element.
7. Always close both the page and its touch-enabled context.

Extend the global terminal probe type with `buffer.active.viewportY`, `scrollToLine`, and the temporary recorded-target field needed by the assertion. Keep all production instrumentation out of the generated mobile document.

### Step 2: Run the browser check before the fixture loop

Import the new function in `run.ts`, call it after launching Chromium and before the existing fixture loop, and print:

```text
PASS mobile-eased-scrolling
```

only after the check succeeds.

### Step 3: Run the real-browser suite and confirm RED

Run:

```sh
pnpm test:tui-fidelity
```

Expected: FAIL in `verifyMobileEasedScrolling` because the old document delegates vertical touch directly to xterm's immediate touch path and never calls public `scrollToLine`.

After production handling exists, prove this regression remains sensitive to propagation ownership: temporarily remove the handled one-finger move's `event.stopPropagation()`, rerun the suite, and require an immediate-jump or no-intermediate failure from xterm's competing direct handler. Restore the line and rerun GREEN; do not leave the broken variant.

## Task 3: Implement public-API eased scrolling and sticky observation

**Files:**

- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Test: `tests/tui-fidelity/src/run.ts`

### Step 1: Configure xterm's reusable smooth scroll controller

Near the existing terminal constants add:

```js
const SMOOTH_SCROLL_DURATION_MS = 80;
```

Pass it to the terminal constructor as:

```js
smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
```

Do not patch xterm internals or generated xterm assets.

### Step 2: Use public cell geometry and observe scroll state through xterm

Replace the private render-service lookup in `cellDimensions()` with `.xterm-screen.getBoundingClientRect()`. Divide the rendered width and height by public `term.cols` and `term.rows`, accept only finite positive dimensions, and retain `{ width: 8, height: 17 }` while screen geometry is unavailable. Do not access `term._core`.

Delete the `.xterm-viewport` `scroll` listener and its `dataset.kannaScrollBound` bookkeeping from `syncViewport()`. Keep viewport discovery, `overflowX`, and inset application there.

After `term.open(root)`, subscribe once:

```js
term.onScroll(() => {
  stickyToBottom = isNearBottom();
  applyViewportInset();
});
```

Replace `isNearBottom()` with a buffer-position calculation:

```js
function isNearBottom() {
  try {
    const buffer = term.buffer.active;
    const { height } = cellDimensions();
    const thresholdRows = Math.max(1, Math.ceil(24 / height));
    return buffer.baseY - buffer.viewportY <= thresholdRows;
  } catch (_error) {
    return true;
  }
}
```

This preserves the existing 24 px intent while using xterm's actual scroll owner.

### Step 3: Axis-lock one-finger gestures and target public buffer lines

On one-finger `touchstart`, store:

```js
touchScroll = {
  axis: null,
  x: touch.clientX,
  y: touch.clientY,
  scrollLeft: viewport.scrollLeft,
  terminalScrollLine: term.buffer.active.viewportY
};
```

On `touchmove`, retain the existing four-pixel activation threshold, then set `axis` only once to `"vertical"` or `"horizontal"` from the predominant displacement.

For the locked vertical branch:

```js
const { height } = cellDimensions();
const targetLine = Math.round(
  clamp(
    touchScroll.terminalScrollLine + deltaY / height,
    0,
    term.buffer.active.baseY
  )
);
term.scrollToLine(targetLine);
```

For the locked horizontal branch, keep:

```js
viewport.scrollLeft = touchScroll.scrollLeft + deltaX;
```

After either handled branch, prevent the cancelable event and stop propagation so xterm's direct, immediate touch path cannot also run. Leave the existing two-finger pinch branch, touch-end cleanup, and touch-cancel cleanup intact.

### Step 4: Keep Kanna-owned bottom follow immediate

Add a generated-document helper that uses only public APIs:

```js
function scrollToBottomImmediately() {
  const smoothScrollDuration = term.options.smoothScrollDuration;
  term.options.smoothScrollDuration = 0;
  try {
    term.scrollToBottom();
  } finally {
    term.options.smoothScrollDuration = smoothScrollDuration;
  }
}
```

Use it for Kanna's font-scale follow, initial settle, resize follow, and `finalizeRender` auto-follow. This keeps pre-feature auto-follow immediate, prevents intermediate programmatic `onScroll` events from erasing sticky intent between rapid appends, and restores 80 ms easing for gesture `scrollToLine()` calls. Update the document source assertion to require the helper.

### Step 5: Run both focused checks and confirm GREEN

Run:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
pnpm test:tui-fidelity
```

Expected: both pass, including `PASS mobile-eased-scrolling`, and the existing fidelity fixtures retain their golden output.

If the browser timing assertion flakes, first inspect the captured position samples and event ownership. Widen sampling intervals or tolerances only if they continue to prove an intermediate animated state and final target; do not replace the check with source matching.

## Task 4: Verify the mobile and harness surfaces

**Files:**

- Verify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Verify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Verify: `tests/tui-fidelity/src/render.ts`
- Verify: `tests/tui-fidelity/src/run.ts`
- Verify: `docs/superpowers/specs/2026-07-15-mobile-terminal-eased-scrolling-design.md`

### Step 1: Run targeted typechecks

Run:

```sh
pnpm --dir apps/mobile run typecheck
pnpm --filter @kanna/tui-fidelity typecheck
```

Expected: both exit zero.

### Step 2: Run the full mobile test suite

Run:

```sh
pnpm --dir apps/mobile test
```

Expected: all mobile tests pass.

### Step 3: Re-run the layout-capable browser suite

Run:

```sh
pnpm test:tui-fidelity
```

Expected: the eased-scroll check and all existing fidelity fixtures pass.

### Step 4: Inspect the final patch

Run:

```sh
git diff --check
git status --short
git diff -- apps/mobile/src/screens/buildTerminalDocument.ts apps/mobile/src/screens/buildTerminalDocument.test.ts tests/tui-fidelity/src/render.ts tests/tui-fidelity/src/run.ts docs/superpowers/specs/2026-07-15-mobile-terminal-eased-scrolling-design.md docs/superpowers/plans/2026-07-15-mobile-terminal-eased-scrolling.md
```

Expected: no whitespace errors; only the approved mobile scrolling implementation, tests, and design/plan docs are changed.

### Step 5: Leave physical-device feel validation to human review

Do not install, launch, or automate an attached iPhone. Report that Chromium proves the real xterm controller animates and that tactile review on a physical device remains the manual review step.

## Commit Ownership

Do not commit in this stage. Kanna's manual workflow will run the configured commit post after the user reviews and advances the task, so all verified implementation changes should remain in the current worktree.

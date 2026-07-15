# Mobile Terminal Eased Scrolling Design

## Goal

Make vertical scrolling in the mobile terminal feel smoother by easing xterm's row transitions instead of applying each touch update as an immediate row jump.

This is a low-risk feel experiment, not a claim of true sub-pixel terminal rendering. xterm remains row-oriented. The animation should follow the user's vertical drag with low latency, finish within a short bounded interval, and add no momentum or inertial physics after the drag.

## Root Cause

The mobile terminal uses xterm.js 6.1 inside a WebView. xterm 6 owns its scroll position in an internal `SmoothScrollableElement`; `.xterm-viewport` is only a layout host and is not a native scroll container. In a real Chromium render its `scrollHeight` equals its `clientHeight`, so direct `scrollTop` assignments are clamped to zero.

xterm's touch path updates the internal scroll position immediately and then rounds that position by cell height to select a buffer row. That produces the visible line-by-line snap. xterm already supports easing public API scrolls through `smoothScrollDuration`, but its direct touch handler deliberately bypasses that animation.

The smooth-duration option also affects programmatic `scrollToBottom()` calls. If Kanna auto-follows from far above, public `onScroll` can report intermediate rows outside the near-bottom threshold. Treating those transient rows as user intent clears sticky mode, so a rapid subsequent append can stop following output before the first animation finishes.

## Approach

Keep xterm as the renderer and route one-finger vertical drags through its public animated scroll API:

- Configure the terminal with an 80 ms `smoothScrollDuration`.
- Keep Kanna-owned programmatic bottom-follow immediate by temporarily setting that option to zero around `scrollToBottom()`, then restoring 80 ms for gesture retargets.
- Extend the existing touch fallback with a per-gesture predominant-axis lock after the current four-pixel threshold.
- Preserve the existing outer-viewport `scrollLeft` behavior for horizontal gestures.
- For vertical gestures, convert the exact finger delta into a raw buffer-line target using the current rendered cell height and the gesture-start `viewportY`. Derive cell size from public DOM/grid geometry: divide `.xterm-screen.getBoundingClientRect()` by public `term.cols` and `term.rows`.
- Clamp the raw target between the top of scrollback and `buffer.active.baseY`, round the clamped value to the nearest integer buffer line required by xterm's public API, then call `term.scrollToLine(targetLine)`.
- Prevent the handled vertical event from also reaching xterm's immediate touch path.
- Keep two-finger pinch zoom unchanged.

Repeated `scrollToLine` calls reuse xterm's in-flight animation, so new touch positions retarget the same short easing window rather than creating a queue. When touch input stops, only the current animation may finish; it remains bounded by the configured duration and does not calculate release velocity.

The duration applies only to user gesture `scrollToLine()` calls. Initial settling, font scaling, resize follow, and output auto-follow use an immediate public `scrollToBottom()` wrapper. The wrapper temporarily sets `smoothScrollDuration` to zero in a `try`/`finally`, synchronously cancels any pending smooth operation and reaches the final row, then restores 80 ms. This prevents intermediate programmatic scroll events from clearing sticky intent between rapid appends.

## Scroll and Sticky-Bottom State

The current sticky-bottom listener is attached to the inert `.xterm-viewport` DOM element. Move scroll-state observation to xterm's public `term.onScroll` event.

Near-bottom state is derived from `buffer.active.baseY - buffer.active.viewportY`. Convert the existing 24-pixel threshold to terminal rows using the rendered cell height, with a minimum threshold of one row.

- Moving above the threshold disables sticky-bottom mode so appended output does not pull the reader down.
- Returning within the threshold re-enables sticky-bottom mode.
- Existing append, replace, resize, and bottom-inset behavior continues to consult the corrected sticky state.
- Kanna-owned `scrollToBottom()` calls remain immediate so their intermediate animation positions cannot make a rapid subsequent append lose auto-follow intent.

## Components and Data Flow

### Generated Mobile Terminal Document

`apps/mobile/src/screens/buildTerminalDocument.ts` remains the sole production file responsible for this behavior. It will own the easing constant, gesture state, public screen-geometry measurement, buffer-line target calculation, and xterm scroll subscription.

No React Native state, WebView bridge messages, transport data, PTY dimensions, or server APIs change.

### Gesture Flow

1. One-finger touch start records the finger coordinates, outer horizontal offset, and `term.buffer.active.viewportY`.
2. The first movement beyond four pixels locks the gesture to the predominant axis.
3. Horizontal moves update only `viewport.scrollLeft`.
4. Vertical moves calculate a clamped, nearest-integer buffer-line target and retarget xterm's eased `scrollToLine()` animation.
5. Touch end or cancellation clears gesture state. Two-finger input continues through the existing pinch branch.
6. `term.onScroll` updates sticky-bottom state for touch, programmatic, and output-driven scroll changes.
7. When Kanna must follow output, it temporarily disables smooth duration, scrolls to the final bottom row, and restores gesture easing before returning.

## Error and Boundary Behavior

- When there is no scrollback, `baseY` is zero and the clamped target remains zero.
- Cell dimensions come from the rendered `.xterm-screen` bounds divided by public `term.cols` and `term.rows`. Non-finite, zero, or unavailable geometry uses the existing `{ width: 8, height: 17 }` estimate while layout settles.
- Browser event cancellation happens only after Kanna has selected and handled an axis.
- Horizontal and pinch gestures do not call the vertical terminal API.
- The immediate bottom helper restores `smoothScrollDuration` in `finally`, including when `scrollToBottom()` throws.
- The experiment does not reach into xterm private fields or patch generated xterm assets.

## Testing

### Fast Document Tests

Extend `apps/mobile/src/screens/buildTerminalDocument.test.ts` so its terminal stub models the public APIs used by the generated script:

- Assert that the constructor receives the 80 ms smooth-scroll duration.
- Assert that a drag spanning a fractional number of rows rounds to the expected integer `scrollToLine()` target and does not change horizontal scroll.
- Assert that the selected axis remains locked for the touch sequence.
- Assert horizontal pan and two-finger pinch retain their existing behavior.
- Assert xterm scroll notifications update sticky-bottom inset state.
- Assert two rapid appends both request immediate bottom follow even when an eased programmatic call would emit a far intermediate scroll position, and assert the 80 ms gesture duration is restored afterward.
- Model dynamic `.xterm-screen` bounds in the stub, assert pinned sizing uses the public 9-by-18 px cell geometry, and assert the generated application script contains no `term._core` access.

### Real-Browser Regression

Extend the existing Playwright-based `tests/tui-fidelity` harness, which already loads the real generated mobile document and bundled xterm:

- Render deterministic scrollback in a touch-enabled Chromium context.
- Dispatch complete synthetic touch-like start, move, and end events from inner `.xterm-screen`, so they traverse Kanna's outer capture listener toward xterm's real gesture handler.
- Sample `term.buffer.active.viewportY` immediately and across the animation window.
- Prove the target is not applied as one immediate jump, intermediate rows are rendered, and the final target is reached.
- Prove the test uses xterm's real scroll controller rather than assigning `.xterm-viewport.scrollTop`.
- Prove propagation ownership by temporarily removing Kanna's handled-move `stopPropagation()` and observing an immediate-jump failure, then restore it.

Verify with:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile test
pnpm test:tui-fidelity
```

Physical-iPhone feel remains a human review step. Agent automation will not install, launch, or drive an attached device.

## Non-Goals

- True sub-pixel rendering between terminal rows
- Custom momentum, velocity, spring, or overscroll physics
- Replacing xterm with a serialized transcript or native renderer
- Patching or forking xterm internals
- Changing horizontal pan, pinch limits, terminal dimensions, or PTY ownership
- Changing desktop terminal behavior

## Success Criteria

- A one-finger vertical drag targets xterm's real buffer scroll state rather than an inert DOM property.
- Visible row changes are distributed across the configured short animation instead of occurring as one immediate jump.
- Repeated moves retarget the active animation without accumulating a delayed queue.
- Rapid consecutive appends retain immediate sticky-bottom auto-follow while gesture scrolling remains configured for 80 ms easing.
- New critical-path cell measurement uses only public DOM and terminal grid state.
- The real-browser regression is sensitive to Kanna's ownership of the touchmove propagation path.
- Horizontal pan, pinch zoom, terminal streaming, sticky-bottom behavior, and desktop-owned PTY dimensions continue to work.
- Both fast unit coverage and a layout-capable real-browser regression pass.

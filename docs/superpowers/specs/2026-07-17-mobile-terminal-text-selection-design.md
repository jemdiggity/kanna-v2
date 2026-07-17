# Mobile Terminal Text Selection Design

## Goal

Let mobile users select and copy arbitrary text from PTY agent consoles without disrupting the terminal's existing one-finger scrolling, pinch zoom, streaming, file-link activation, or desktop-owned grid geometry.

This design covers `TerminalWebView`, which renders xterm inside a React Native WebView. Structured SDK-agent messages rendered by `AgentMessageView` are outside this change.

## Root Cause

Desktop xterm selection is not native browser text selection. Xterm renders terminal cells on canvas, maps mouse drags to buffer coordinates, draws the selection highlight itself, and exposes the selected value through `getSelection()`. Its bundled CSS deliberately applies `user-select: none` to the terminal surface.

On mobile, WebKit's native long-press selection applies to DOM text, not xterm's canvas. Kanna also captures terminal touch input: one-finger movement becomes horizontal or vertical scrolling, and two-finger movement controls terminal font scaling. There is consequently no touch gesture that enters xterm's selection engine. Enabling WebView text interaction or overriding `user-select` would not make the canvas-backed terminal selectable.

## Considered Approaches

### Double-tap selection mode (chosen)

A double tap selects the word under the second tap and enters an explicit selection mode. Subsequent one-finger drags extend the xterm selection. A native Copy/Cancel toolbar controls the active range.

This preserves the terminal in context, supports arbitrary ranges, uses xterm's public selection model, and leaves ordinary single-finger scrolling unchanged outside selection mode. It requires Kanna to map touch positions to xterm buffer cells and provide mobile selection controls.

### Double tap to copy one word or line

This is simpler, but it does not satisfy arbitrary text selection. Users could not copy a multi-word command, error, or output block.

### Plain-text selection sheet

Kanna could serialize scrollback into a separate native selectable transcript. Native selection handles would work, but terminal colors, layout, cursor context, wrapped rows, and the user's current viewport would be lost. Maintaining a second renderer would also create unnecessary synchronization and memory costs.

## Interaction Design

- A normal tap retains the existing terminal-tap behavior.
- A single-finger drag continues to pan horizontally or scroll xterm vertically.
- A two-finger gesture continues to pinch-scale the terminal.
- Two taps within 300 ms and 24 CSS pixels select the word under the second tap and enter selection mode. The second tap is consumed so WebView double-tap zoom and terminal file-link activation do not also run.
- The initial range uses xterm's configured word separators. If the tapped cell contains whitespace or a separator, select that single terminal cell so selection mode still has an unambiguous anchor.
- While selection mode is active, a one-finger drag extends from the original word anchor to the current terminal cell. It may extend forward or backward and across visible rows. Selection drags do not scroll or activate file links.
- Selection is limited to cells reachable in the current viewport in the first version. Edge-triggered auto-scroll and native-style drag handles are non-goals.
- A compact native toolbar overlays the terminal with Copy and Cancel controls. Copy uses the platform clipboard and exits selection mode only after the clipboard write succeeds. Cancel clears the range and exits immediately.
- If the clipboard write fails, the selection remains active and the toolbar displays a concise failure state so the user can retry or cancel.
- Exiting selection mode restores normal terminal gestures. Tapping elsewhere does not silently discard a selection; the explicit toolbar controls avoid accidental loss.

## Architecture

### Generated terminal document

`apps/mobile/src/screens/buildTerminalDocument.ts` remains the owner of xterm gesture interpretation and buffer-coordinate mapping.

The generated script will:

1. Track recent tap time and position independently from the existing scroll and pinch state.
2. Convert the second tap's client coordinates to a public xterm buffer row and terminal column using `.xterm-screen.getBoundingClientRect()`, `term.cols`, `term.rows`, and `term.buffer.active.viewportY`.
3. Read the public buffer line, find word boundaries using xterm's word separators, and call the public `term.select(column, row, length)` API.
4. Store the ordered word anchor. During selection-mode drags, calculate an ordered start/end pair and call `term.select` with the corresponding linear cell length.
5. Subscribe to `term.onSelectionChange` and report the current selection through the WebView bridge.
6. Expose `window.__clearTerminalSelection()` so native Copy/Cancel controls can clear xterm state and exit selection mode.

Entering selection mode disables sticky-bottom following so new output cannot move the selected text out from under the gesture. Clearing selection recomputes sticky intent from the current buffer position. Append, replace, resize, bottom-inset, and font-scale paths otherwise remain unchanged.

No xterm private fields or generated dependency assets are patched.

### React Native terminal wrapper

`apps/mobile/src/screens/TerminalWebView.tsx` will validate a new bridge payload:

```json
{
  "type": "terminal-selection-change",
  "text": "selected terminal text"
}
```

A non-empty validated value becomes the active selection and renders a native Copy/Cancel toolbar above the WebView. An empty value removes the toolbar. Selection state is cleared when the task changes or the WebView reloads.

Copy uses `expo-clipboard`, added as a bundled mobile dependency compatible with the repository's Expo SDK. On success, or when Cancel is pressed, `TerminalWebView` injects `window.__clearTerminalSelection(); true;`. Clipboard failures retain the value and surface an inline error in the toolbar.

The toolbar uses native `Pressable` controls with button roles and descriptive accessibility labels. Clipboard access stays outside the generated document, avoiding WebView origin and permission differences.

## Data Flow

```text
double tap in xterm
  -> map screen point to buffer cell
  -> term.select(word range)
  -> term.onSelectionChange
  -> WebView bridge validates selected text
  -> native Copy/Cancel toolbar appears

selection-mode drag
  -> map current point to buffer cell
  -> order anchor and current endpoint
  -> term.select(updated range)
  -> bridge refreshes native selection value

Copy
  -> expo-clipboard writes selected text
  -> inject __clearTerminalSelection
  -> term.clearSelection and leave selection mode
  -> empty bridge update removes toolbar
```

## Boundary and Error Behavior

- Coordinate conversion clamps columns and visible rows to the current public terminal dimensions.
- A tap outside `.xterm-screen`, on the fallback file-link controls, or before cell geometry is usable does not enter selection mode.
- Wide and combining characters use buffer-cell widths rather than JavaScript string offsets when determining the selected word.
- Double-tap detection is reset by multi-touch, cancellation, a moved gesture, task replacement, or selection-mode exit.
- Existing file-link cooldown applies to double taps and selection drags so a selection gesture cannot open a file preview.
- Terminal output may continue while text is selected, but sticky-bottom following remains disabled until selection mode exits.
- Replace operations and WebView reloads clear selection because prior buffer coordinates are no longer valid.
- Malformed, non-string, or unexpected bridge payloads are ignored. React Native rejects selection values above 2,300,000 UTF-16 code units, a fixed ceiling covering the configured 10,000-row scrollback plus the visible 220-column grid and line breaks without accepting unbounded bridge data.
- Clipboard failure does not clear the terminal selection.

## Testing

### Generated-document tests

Extend `apps/mobile/src/screens/buildTerminalDocument.test.ts` and its terminal stub to model public selection APIs and selection-change events.

Cover:

- one tap does not select and existing tap notification remains intact;
- a qualifying double tap selects the word under the second tap;
- whitespace and separators produce a one-cell selection;
- wide and combining characters map to the correct terminal cells;
- a selection-mode drag expands forward, backward, and across rows;
- selection drags do not call horizontal or vertical scroll APIs;
- ordinary one-finger scrolling and two-finger pinch behavior remain unchanged outside selection mode;
- double taps and selection drags suppress file-link activation;
- clearing, cancellation, replace, and reload paths leave gesture and sticky state consistent;
- generated code uses public xterm APIs and contains no private-field access.

### React Native wrapper tests

Extend `apps/mobile/src/screens/TerminalWebView.test.tsx` to verify:

- valid non-empty selection messages render accessible Copy/Cancel controls;
- malformed and oversized messages are ignored;
- Copy writes the exact text, clears selection only after success, and removes stale clipboard errors;
- clipboard rejection retains the selection and displays a retryable error;
- Cancel injects the clear-selection script without writing the clipboard;
- task switches and WebView reloads remove stale native selection state.

### Real-browser regression

Add focused coverage to the existing TUI-fidelity browser harness using the real bundled xterm renderer. Dispatch touch-like events at known terminal cells and assert that double tap produces `term.getSelection()`, a subsequent drag changes the selected range, and an ordinary drag before selection still scrolls. This guards the geometry and event-propagation boundary that a DOM-only terminal stub cannot prove.

Verify with:

```sh
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile test
pnpm test:tui-fidelity
```

Physical-iPhone interaction remains a human review step. Agent automation will not install, launch, or drive an attached device.

## Non-Goals

- Native iOS text-selection handles or loupe behavior
- Selection auto-scroll at the viewport edges
- A separate transcript or plain-text renderer
- Select All, line-selection shortcuts, sharing, or editing
- Structured SDK-agent message selection
- Changes to desktop terminal selection
- Changes to PTY transport, scrollback size, terminal dimensions, or xterm dependency assets

## Success Criteria

- Double tapping a visible terminal word enters selection mode and visibly selects it.
- Dragging in selection mode extends the range across terminal cells and visible rows in either direction.
- Copy writes exactly xterm's selected text to the platform clipboard; failure keeps the range available for retry.
- Cancel and successful Copy return the terminal to its normal scrolling and pinch behavior.
- Selection gestures never scroll, zoom, or activate terminal file links at the same time.
- Existing terminal streaming, sticky-bottom behavior, resizing, composer safe-area handling, scrolling, pinch zoom, and file-link tests continue to pass.

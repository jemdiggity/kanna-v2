# Mobile Terminal Composer Safe Region Design

## Goal

Keep every readable PTY terminal row above the mobile task screen's floating
composer in its resting, multiline, and keyboard-shifted states. A user who is
reading scrollback must stay at the same xterm buffer position while output
arrives, and live following must resume only after the user returns within the
existing 24 px near-bottom threshold.

## Verified Runtime Contract

The bundled `@xterm/xterm` version is `6.1.0-beta.195`. Its live DOM is:

```text
#viewport                         Kanna-owned horizontal/vertical wrapper
└─ #terminal-root
   └─ .terminal.xterm
      ├─ .xterm-viewport          empty legacy sibling
      └─ .xterm-scrollable-element
         ├─ .xterm-screen         rendered rows and touch target
         └─ xterm scrollbars
```

`.xterm-scrollable-element` uses xterm's internal `Scrollable` model; neither it
nor `.xterm-viewport` reports live position through native `scrollTop` events.
The supported follow-state boundary is `term.onScroll` together with
`term.buffer.active.viewportY` and `baseY`.

The current document also reserves fixed space on Kanna's outer `#viewport`
with `padding-bottom`. That happens to fit the one-line composer, but a pinned
PTY grid can overflow the content box. The document must therefore align the
outer viewport to its maximum vertical offset after changing the inset so the
rendered xterm host ends at or above the safe-region boundary.

## Approaches Considered

### Measured obstruction and runtime WebView bridge (selected)

Measure the final native composer top in the same coordinate space as the task
screen. Propagate the resulting bottom obstruction through `TerminalWebView`
without rebuilding the WebView document. The generated document applies it to
the Kanna-owned viewport, refits unpinned terminals, and aligns pinned grids.

This preserves the floating UI, captures actual font and multiline layout, and
keeps xterm DOM details out of the layout contract.

### Resize the native terminal canvas

End the React Native WebView above the measured composer. This is a valid
structural boundary, but resizing WKWebView during every multiline and keyboard
animation would add native/WebView churn and would remove the terminal
background beneath the translucent chrome.

### Put the composer in normal flow

Place the terminal and composer in one flex column. This removes overlap by
construction, but materially changes the existing terminal-first presentation
and keyboard behavior.

Directly styling `.xterm-scrollable-element` was rejected. It is an xterm beta
implementation detail and is not a native scrolling element.

## Native Geometry

`TaskScreen` records:

- the task screen height from its root `onLayout` callback; and
- the floating chrome's final `layout.y` from its own `onLayout` callback.

Both values share the same parent coordinate space. The terminal inset is:

```text
ceil(screenHeight - composerTop + 8 px reading gap)
```

This includes the plus control, the gap below it, the full multiline input,
composer padding, the resting bottom margin, and keyboard displacement. It does
not duplicate the device safe-area inset. Until both measurements exist, the
current 132 px one-line value is a short-lived fallback.

Representative regression geometries for an 800 px task screen are:

| State | Composer top | Terminal inset |
|---|---:|---:|
| Resting, one line | 676 | 132 |
| Resting, max multiline | 596 | 212 |
| Keyboard shifted, one line | 362 | 446 |
| Keyboard shifted, max multiline | 282 | 526 |

## React Native to WebView Data Flow

1. `TaskScreen` calculates the measured `bottomInset` and passes it to
   `TerminalWebView`.
2. `TerminalWebView` keeps its generated HTML stable and injects a
   `__setTerminalBottomInset` script whenever the measurement changes.
3. Before `terminal-ready`, resize scripts are coalesced first, inset scripts
   second, and terminal state scripts last. Repeated inset changes retain only
   the newest measurement.
4. WebView reload seeds the same resize, latest inset, and snapshot ordering.
5. The document clamps the inset, updates `#viewport` padding, refits an
   unpinned terminal, and aligns the Kanna-owned viewport to its vertical end.
   A pinned grid keeps its desktop dimensions and is shifted within the outer
   viewport so its rendered bottom remains above the obstruction.

Changing the inset must never replace `source.html`, reset xterm, or change the
user's xterm scrollback position.

## Follow State

The document subscribes once to `term.onScroll`. A buffer is near the bottom
when:

```text
(baseY - viewportY) * cellHeight <= 24 px
```

`cellHeight` comes from xterm's public `term.dimensions` API, with the existing
estimate only before dimensions are ready. Appending output captures follow
intent before writing:

- while the user is farther than the threshold, xterm's own write behavior
  preserves `viewportY` and Kanna does not call `scrollToBottom`;
- within the threshold, completion follows the new live bottom; and
- layout inset changes remain independent from follow intent.

The legacy `.xterm-viewport` listener and bottom style are removed. The Happy
DOM terminal stub models the public buffer and `onScroll` contract rather than
inventing native scroll metrics.

## Testing

### Unit and component coverage

- Geometry tests cover all four representative native layouts.
- `TaskScreen` tests execute both native `onLayout` callbacks and verify the
  measured inset reaching `TerminalWebView`.
- `TerminalWebView` tests prove pre-ready inset coalescing, deterministic script
  order, immediate ready-state injection, and stable document HTML.
- Generated-document tests model xterm's real DOM hierarchy and public scroll
  API as narrow, fast coverage.

### Real-browser integration

The existing `tests/tui-fidelity` Playwright harness loads the actual generated
HTML, bundled xterm script, and fit addon in Chromium. Its safe-region check:

- applies 132, 212, 446, and 526 px insets to a pinned terminal;
- asserts the real `.xterm-scrollable-element` ends above each obstruction;
- uses real wheel input to enter scrollback;
- appends output and verifies `viewportY` and the top rendered line remain
  stable; and
- returns one row from the bottom and verifies following resumes.

Run it with `pnpm test:tui-fidelity` in addition to the normal unit suites.

### Why Appium is not the blocking regression

The current Appium path needs a running kd-managed simulator stack and a known
live PTY task supplied by environment variables. It cannot create a controlled
PTY fixture, and its native driver cannot yet inject a reliable gesture while
simultaneously inspecting the embedded WebView context. Making it deterministic
requires a test-only server fixture that registers a synthetic terminal session
plus a cross-context gesture helper. The Chromium test exercises the bundled
xterm document and real scrolling behavior now; native measurement and bridge
wiring remain covered at their React component boundaries.

## Success Criteria

- Measured normal, multiline, and keyboard-shifted composer geometry reaches
  the generated terminal document without a reload.
- The real rendered xterm host has sufficient clearance in Chromium for every
  representative obstruction.
- Appending output never moves manual scrollback.
- Returning within 24 px of the bottom resumes following.
- No follow or layout logic depends on `.xterm-viewport` native scroll state.
- Pinned PTY dimensions, horizontal scrolling, pinch zoom, and byte replay keep
  their existing behavior.

# Mobile terminal selection toolbar occlusion: why there is no E2E

2026-07-30. Written alongside the fix that moves the terminal selection
toolbar below the floating task chrome
(`apps/mobile/src/screens/TerminalWebView.tsx`,
`apps/mobile/src/screens/TaskScreen.tsx`,
`apps/mobile/src/screens/terminalSafeArea.ts`).

## The bug this covers

Selecting text in a PTY terminal on the mobile app shows Kanna's own
React Native toolbar (`Text selected / Copy / Cancel`). It was absolutely
positioned at `top: 12` inside the fullscreen terminal wrapper, whose canvas
spans the entire task screen (`terminalCanvas` is `top: 0 … bottom: 0`). The
floating top chrome — back button plus title chip — is a **later sibling** of
that canvas at `top: 16`, so React Native paints it above the toolbar and its
title chip swallows the toolbar's taps. The toolbar's own `zIndex: 10` never
competes with the chrome: RN z-order is resolved among siblings, and the
toolbar and the chrome live in different subtrees. This is an
occlusion/stacking defect in markup we own, not a mis-anchored platform
callout — the terminal's selection is created programmatically through
xterm's `term.select(...)`, no DOM range ever exists, and WKWebView therefore
never shows the native copy menu.

## Why the real repro cannot run in CI

Proving the fix end-to-end means: long-press/double-tap inside the terminal
WebView to create an xterm selection, then tap the native toolbar's Copy
button and observe the clipboard. Two pieces of that are outside what the
mobile E2E harness can drive today:

- **The selection gesture.** xterm renders the terminal to a canvas. In
  Appium's WebView context there are no text nodes to target, and the
  double-tap word-select plus drag-extend gestures are handled by the
  document's own touch handlers keyed to canvas cell geometry. The existing
  smoke (`e2e/specs/smoke/list-detail-back.e2e.ts`) inspects xterm state via
  the injected inspection hook, but it cannot synthesize an in-canvas
  selection gesture with cell precision from XCUITest.
- **The occlusion assertion.** The defect is native-layer paint order and
  touch interception between two RN sibling subtrees. XCUITest reports both
  the toolbar and the title chip as visible accessibility elements whether or
  not one paints over the other; asserting "this tap landed on the chip, not
  the toolbar" would need coordinate taps against layout-dependent frames,
  which is exactly the kind of flaky pixel-hunting the harness avoids.

A device run additionally needs a live PTY fixture with a real selection,
which the smoke only exercises when `KANNA_E2E_PTY_TASK_ID` points at one.

## What would make it testable

An injected test hook that creates a deterministic xterm selection
(`window.__selectTerminalRange(start, end)` already exists internally as
`selectTerminalRange`) exposed to the E2E inspection surface, plus an Appium
coordinate tap on the toolbar's accessibility element with a clipboard
assertion, run against the live PTY fixture. That combination would prove the
toolbar is both visible and tappable below the chrome.

## Narrower tests added instead

- `terminalSafeArea.test.ts` — `getTerminalSelectionToolbarTop` clears the
  measured chrome bottom (collapsed and expanded), rounds up, and falls back
  to collapsed-chrome clearance until the header reports a layout.
- `TerminalWebView.test.tsx` — the toolbar renders at the owner-measured
  clearance, at the fallback clearance for fullscreen embeds that were never
  measured, and at `top: 12` for non-fullscreen cards that have no floating
  chrome.
- `TaskScreen.test.tsx` — the top chrome's `onLayout` measurement flows into
  `TerminalWebView`'s `selectionToolbarTop` prop, including when the expanded
  title chip grows the chrome.

## Device-unverified

The fix was verified by geometry (measured chrome bottom + 12px gap) and the
component wiring above; the on-device visual — toolbar rendered fully below
the title chip, Copy tappable on first try, on staging hardware — was not
reproduced in this change because no device or booted simulator was reachable
from the working session.

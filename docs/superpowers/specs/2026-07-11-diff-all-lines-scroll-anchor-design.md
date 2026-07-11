# Diff All-Lines Scroll Anchor

**Date:** 2026-07-11
**Status:** Approved
**Goal:** Keep the same code line at the same viewport position when the diff viewer changes from compact Context mode to All lines.

## Context

`DiffView` already saves and restores the active scope's numeric `scrollTop` while a diff reloads. That works when the rendered document keeps the same geometry. All-lines mode instead requests every unchanged line from Git and expands collapsed context in the renderer. Lines inserted above the viewport change the document geometry, so restoring the old pixel offset displays an earlier line.

## Design

Before changing from Context to All lines, `DiffView` captures a transient viewport anchor for the top-visible rendered code line:

- the containing diff file path;
- the rendered source line number and line type;
- the line's vertical offset from the scroll container's viewport top.

The anchor is associated with the new diff load. As files finish rendering asynchronously, scroll restoration looks for the matching file and line in the new shadow DOM. Once present, it adjusts `scrollTop` so that line returns to its captured viewport offset. Reapplying the anchor during later post-render callbacks prevents subsequently rendered files above it from moving it again.

The existing numeric scroll position remains the fallback when no rendered line can be captured or the matching line cannot be found. Other reloads and per-scope scroll persistence retain their current behavior. The change is limited to transitions from compact Context mode to All lines; collapsing back to Context continues using existing scroll restoration because the anchored unchanged line may no longer be rendered.

## Boundaries

The anchor capture and restoration logic belongs with the existing scroll-state functions in `apps/desktop/src/components/DiffView.vue`. `useDiffRenderer` continues to signal post-render opportunities through the current callbacks; it does not own viewport policy.

No persistent state shape changes are needed. The anchor is meaningful only for one in-flight render and must be ignored if a newer diff load supersedes it.

## Failure Handling

If the container, file wrapper, shadow root, or matching line is unavailable, restoration falls back to the saved numeric `scrollTop`. Stale render callbacks remain guarded by the existing active-load identifier.

## Testing

Add a focused `DiffView` component regression test that:

1. renders a compact diff with a known line at a nonzero viewport offset;
2. toggles to All lines;
3. simulates added context above that line in the rerendered DOM;
4. verifies that the matching line, rather than the original raw pixel offset, is restored to the same viewport position;
5. exercises a deferred post-render callback so the anchor remains correct during asynchronous rendering.

Run the focused component test, then the desktop frontend typecheck and relevant diff-view test suite.

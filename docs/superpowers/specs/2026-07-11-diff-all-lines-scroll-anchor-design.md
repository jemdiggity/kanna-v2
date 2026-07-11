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

The existing numeric scroll position remains the fallback when no rendered line can be captured or the matching line cannot be found. That persisted per-scope number always describes compact Context geometry. The all-lines `scrollTop` derived from the semantic anchor is render-local state and must not overwrite the compact number.

Context-to-All-lines saves the compact position and captures the line anchor before changing modes. Anchor restoration may move the live all-lines viewport repeatedly as progressive content arrives, but it does not emit those derived pixel coordinates. All-lines-to-Context skips saving the expanded coordinate and restores the saved compact number. Closing and reopening also starts in compact mode with that same compact coordinate.

Reloads that remain in All-lines mode recapture the currently visible semantic line before replacing the rendered DOM, then use that anchor transiently for the new load. They likewise never emit the expanded pixel coordinate into compact recall state.

## Boundaries

The anchor capture and restoration logic belongs with the existing scroll-state functions in `apps/desktop/src/components/DiffView.vue`. `useDiffRenderer` continues to signal post-render opportunities through the current callbacks; it does not own viewport policy.

No persistent state shape changes are needed. `DiffScrollPositions` remains keyed by scope because it stores compact coordinates only. The semantic anchor is meaningful only for one in-flight render and must be ignored if a newer diff load supersedes it.

## Failure Handling

If the container, file wrapper, shadow root, or matching line is unavailable, expansion falls back to the saved compact numeric `scrollTop`. Stale render callbacks remain guarded by the existing active-load identifier. Scroll events and reloads while All lines is active do not replace compact recall state.

## Testing

Add focused `DiffView` component regression tests that:

1. renders a compact diff with a known line at a nonzero viewport offset;
2. toggles to All lines;
3. simulates added context above that line in the rerendered DOM;
4. verifies that the matching line, rather than the original raw pixel offset, is restored to the same viewport position;
5. exercises a deferred post-render callback so the anchor remains correct during asynchronous rendering;
6. toggles immediately back to Context without manual scrolling and restores the original compact position;
7. closes after expansion, remounts in Context mode with emitted recall state, and restores the original compact position;
8. reloads while remaining in All-lines mode and keeps the current semantic line fixed without changing compact recall state.

Add a WebDriver regression using the real Git command and real `@pierre/diffs` shadow DOM. Capture a top-visible line in a later file by file path, `data-line`, `data-line-type`, and viewport offset; expand to All lines; wait for progressive geometry to settle; and verify the same line remains within a two-pixel tolerance.

Run the focused component test, desktop frontend typecheck, diff-view E2E file, repository test suite, serialized daemon suite, and final diff/status checks.

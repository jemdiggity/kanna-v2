# Sidebar pin drag synthesis E2E gap (2026-08-17)

`apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts` retains a
quarantined case — "pins and unpins a remote-only LAN task through the sidebar
drag gesture" — that drags a remote-only LAN row from its stage group into the
viewer's pinned zone and back out through the unpin receiver.

## Blocker

`tauri-plugin-webdriver` 0.2 does not produce native input. Its pointer actions
are JavaScript `MouseEvent`s dispatched at a viewport coordinate
(`dispatch_pointer_event` in `src/platform/executor.rs` builds
`new MouseEvent('mousedown'|'mousemove'|'mouseup', …)` and dispatches it on
`document.elementFromPoint(x, y)`), and there is no `PointerEvent`, no drag
protocol, and no OS-level cursor. The suite's own synthesizer
(`apps/desktop/tests/e2e/helpers/sidebarDrag.ts`) therefore has to fabricate the
whole gesture in the page.

SortableJS *starts* under that synthesis. Instrumenting the run shows the
dragged remote row picking up `sortable-chosen` and then `sortable-ghost`, and
the pointer/mouse sequence arriving in order:

```text
classes: ["task-subtree sortable-chosen|cloud:lan:[…]",
          "task-subtree sortable-chosen sortable-ghost|cloud:lan:[…]"]
events:  pointermove, pointerdown, mousedown, pointermove ×6, mouseup
```

What never happens is the drop: no `add` reaches `onPinnedChange`, the viewer's
`remoteTaskPins` setting stays `{}`, and the pinned zone keeps only the local
anchor. In fallback mode SortableJS resolves the list under the pointer itself
(`_emulateDragOver` → `document.elementFromPoint`), and that resolution does not
land on the pinned zone from a synthesized move out of a `sort: false` stage
group. Sidebar state is not the obstacle — the same run confirms both rows are
`state: "ready"`, the remote row unpinned and the anchor pinned, which is what
`canMoveTask` gates on.

Nothing in the harness can express this gesture more faithfully, so the case is
skipped rather than rewritten into method calls masquerading as a gesture.

## What would close the gap

Native input injection for the desktop E2E harness — a WebDriver implementation
that posts real OS mouse events, or an explicit drag protocol in
`tauri-plugin-webdriver` — after which the retained case should pass as written.
Kanna does not own that plugin, so the alternative is a native-input path in the
harness itself.

## Coverage that remains

- The active case in the same file drives the App-level pin contract for a
  remote-only row (`pinSidebarTask` / `reorderPinnedSidebarTasks` /
  `unpinSidebarTask`) and proves what only a real two-instance E2E can: the
  viewer's `remoteTaskPins` setting, pinned-zone rendering, mixed local/remote
  pin ordering, survival across a full viewer reload, and that the owning
  desktop's task and settings are never mutated.
- `apps/desktop/src/components/__tests__/Sidebar.test.ts` covers the drop
  handler itself — `onPinnedChange` with an `added` event emits `pin-item` and
  `reorder-pinned`, and forged or not-yet-ready rows are refused.
- `apps/desktop/src/App.test.ts` covers the remote-pin settings persistence the
  handler's emissions reach.
- `apps/desktop/tests/e2e/mock/sidebar-task-parenting.test.ts` still drives real
  SortableJS drags for the directions the synthesizer does register (out of the
  pinned zone onto an unpinned task, and into the empty unpin receiver), so the
  helper itself stays exercised.

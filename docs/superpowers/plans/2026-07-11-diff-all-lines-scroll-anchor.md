# Diff All-Lines Scroll Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the same rendered code line at the same viewport offset when the diff viewer expands from compact Context mode to All lines.

**Architecture:** Capture a one-load viewport anchor from the existing `@pierre/diffs` shadow DOM before expansion, keyed by file path, source line, line type, and viewport offset. Route existing render-time restoration callbacks through anchor-aware logic while keeping the persisted per-scope numeric `scrollTop` explicitly compact-only; anchor-derived all-lines pixels remain render-local, and existing load-id guards protect against stale renders.

**Tech Stack:** Vue 3 Composition API, TypeScript, `@pierre/diffs`, Vitest, Vue Test Utils, happy-dom.

---

## Workflow constraint

This Kanna stage leaves commits to the later workflow. Execute the steps without creating a local commit.

## File structure

- Modify `apps/desktop/src/components/__tests__/DiffView.test.ts`: add a component-level regression test using the existing renderer harness.
- Modify `apps/desktop/src/components/DiffView.vue`: capture, associate, and restore a transient code-line anchor during compact-to-all expansion.

### Task 1: Add the failing line-anchor regression test

**Files:**
- Test: `apps/desktop/src/components/__tests__/DiffView.test.ts`, beside the existing scroll restoration tests around line 1019.

- [ ] **Step 1: Write the failing behavior test**

Add this test before the existing per-scope scroll test:

```ts
it("keeps the anchored code line fixed throughout all-lines rendering", async () => {
  vi.useFakeTimers();
  diffMocks.parsePatchFilesMock
    .mockReturnValueOnce([
      {
        files: [
          {
            name: "anchored-context.txt",
            __searchRows: [{ lineIndex: "anchor", text: "changed anchor" }],
          },
        ],
      },
    ])
    .mockReturnValueOnce([
      {
        files: [
          {
            name: "anchored-context.txt",
            __searchRows: [{ lineIndex: "anchor", text: "changed anchor" }],
            __deferPostRender: true,
          },
        ],
      },
    ]);

  invokeMock.mockImplementation(async (command) => {
    if (command === "git_diff") return "diff --git a/anchored-context.txt b/anchored-context.txt";
    return "";
  });

  const makeRect = (top: number, height: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    width: 800,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

  const containerTop = 100;
  const compactLineDocumentTop = 280;
  let allLinesDocumentTop = 700;
  let renderCount = 0;
  let container!: HTMLElement;

  renderMock.mockImplementation(({ containerWrapper }: { containerWrapper?: HTMLElement }) => {
    renderCount += 1;
    const line = containerWrapper
      ?.querySelector("diffs-container")
      ?.shadowRoot
      ?.querySelector<HTMLElement>('[data-content] [data-line-index="anchor"]');
    if (!line) return;
    line.setAttribute("data-line", "8");
    line.setAttribute("data-line-type", "change-addition");
    line.getBoundingClientRect = () => makeRect(
      containerTop
        + (renderCount === 1 ? compactLineDocumentTop : allLinesDocumentTop)
        - container.scrollTop,
      20,
    );
  });

  let wrapper: ReturnType<typeof mount<typeof DiffView>> | null = null;
  try {
    wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    container = wrapper.get(".diff-container").element as HTMLElement;
    container.getBoundingClientRect = () => makeRect(containerTop, 400);
    container.scrollTo = ({ top }: ScrollToOptions) => {
      container.scrollTop = top ?? 0;
    };

    await flushPromises();
    await flushPromises();

    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();

    await wrapper.get(".context-toggle").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(container.scrollTop).toBe(620);

    allLinesDocumentTop = 900;
    await vi.runOnlyPendingTimersAsync();
    await flushPromises();

    const anchoredLine = wrapper
      .get(".diff-file")
      .element
      .querySelector("diffs-container")
      ?.shadowRoot
      ?.querySelector<HTMLElement>('[data-line="8"][data-line-type="change-addition"]');
    expect(anchoredLine).not.toBeNull();
    expect(anchoredLine!.getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(80);
    expect(container.scrollTop).toBe(820);
  } finally {
    wrapper?.unmount();
    vi.useRealTimers();
  }
});
```

The test uses the existing mocked external renderer only to expose the same shadow-DOM attributes as real `@pierre/diffs`; its assertions exercise `DiffView`'s real viewport behavior rather than mock call counts.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts -t "keeps the anchored code line fixed throughout all-lines rendering"
```

Expected: FAIL because `container.scrollTop` remains the saved raw value (`200`) instead of moving to `620` to keep line 8 at its original 80px viewport offset.

### Task 2: Implement one-load code-line anchoring

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue`, scroll state helpers around lines 190-395, `loadDiff` around line 395, and `toggleContextLines` around line 594.

- [ ] **Step 1: Define the transient anchor and load option types**

Add beside the existing diff view types:

```ts
interface DiffScrollAnchor {
  filePath: string;
  lineNumber: string;
  lineType: string | null;
  viewportOffset: number;
}

interface ActiveDiffScrollAnchor {
  loadId: number;
  anchor: DiffScrollAnchor;
}

interface LoadDiffOptions {
  preserveCurrentScroll?: boolean;
  scrollAnchor?: DiffScrollAnchor | null;
}
```

Add beside the existing load identifiers:

```ts
let activeDiffScrollAnchor: ActiveDiffScrollAnchor | null = null;
```

- [ ] **Step 2: Add DOM anchor capture and lookup helpers**

Replace the duplicated file-header lookup in `getFileWrapper` with these helpers and use `getDiffFilePath(candidate)` in its predicate:

```ts
function getDiffFilePath(wrapper: HTMLElement): string {
  const header = wrapper.querySelector<HTMLElement>(".diff-file-header");
  return (header?.title || header?.textContent || "").trim();
}

function getRenderedCodeLines(wrapper: HTMLElement): HTMLElement[] {
  return Array.from(wrapper.querySelectorAll<HTMLElement>("diffs-container"))
    .flatMap((diffContainer) => Array.from(
      diffContainer.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [],
    ));
}

function getFileWrapper(filePath: string): HTMLElement | null {
  const container = containerRef.value;
  if (!container) return null;
  return Array.from(container.querySelectorAll<HTMLElement>(".diff-file"))
    .find((candidate) => getDiffFilePath(candidate) === filePath) ?? null;
}

function captureScrollAnchor(): DiffScrollAnchor | null {
  const container = containerRef.value;
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();

  for (const wrapper of container.querySelectorAll<HTMLElement>(".diff-file")) {
    const filePath = getDiffFilePath(wrapper);
    if (!filePath) continue;
    const line = getRenderedCodeLines(wrapper).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    });
    if (!line) continue;
    const lineNumber = line.getAttribute("data-line");
    if (lineNumber == null) continue;
    return {
      filePath,
      lineNumber,
      lineType: line.getAttribute("data-line-type"),
      viewportOffset: line.getBoundingClientRect().top - containerRect.top,
    };
  }

  return null;
}

function findAnchoredLine(anchor: DiffScrollAnchor): HTMLElement | null {
  const wrapper = getFileWrapper(anchor.filePath);
  if (!wrapper) return null;
  return getRenderedCodeLines(wrapper).find((line) =>
    line.getAttribute("data-line") === anchor.lineNumber
      && line.getAttribute("data-line-type") === anchor.lineType
  ) ?? null;
}
```

- [ ] **Step 3: Restore the matching line through the existing load callbacks**

Add beside `restoreScrollPosition`:

```ts
function restoreScrollAnchor(anchor: DiffScrollAnchor): boolean {
  const container = containerRef.value;
  const line = findAnchoredLine(anchor);
  if (!container || !line) return false;
  const containerRect = container.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  const top = Math.max(
    0,
    container.scrollTop + lineRect.top - containerRect.top - anchor.viewportOffset,
  );
  container.scrollTo({ top, behavior: "auto" });
  return true;
}

function restoreScrollAnchorForActiveLoad(context: DiffRenderContext): boolean {
  if (!isActiveDiffLoad(context.loadId)) return false;
  const activeAnchor = activeDiffScrollAnchor;
  if (!activeAnchor || activeAnchor.loadId !== context.loadId) return false;
  return restoreScrollAnchor(activeAnchor.anchor);
}
```

Update the current callback restoration so the anchor takes precedence over raw pixels:

```ts
function restoreScrollPositionForActiveLoad(context: DiffRenderContext) {
  if (!isActiveDiffLoad(context.loadId)) return;
  if (restoreScrollAnchorForActiveLoad(context)) return;
  if ((scrollPositions.value[scope.value] ?? 0) <= 0) return;
  restoreScrollPosition();
}
```

- [ ] **Step 4: Associate the anchor with exactly one diff load**

Change the load signature and initialize the active anchor immediately after allocating `loadId`:

```ts
async function loadDiff(options: LoadDiffOptions = {}) {
  if (options.preserveCurrentScroll !== false) {
    saveCurrentScrollPosition();
  }
  emit("scope-change", scope.value);
  closeSearch();
  const path = props.worktreePath || props.repoPath;
  const loadId = ++nextDiffLoadId;
  activeDiffLoadId = loadId;
  activeDiffScrollAnchor = options.scrollAnchor
    ? { loadId, anchor: options.scrollAnchor }
    : null;
```

After `renderDiff`, replace the unconditional raw restoration with:

```ts
if (!restoreScrollAnchorForActiveLoad(renderContext)) {
  restoreScrollPosition();
}
```

Add this helper beside the other restoration helpers:

```ts
function clearScrollAnchorForLoad(loadId: number) {
  if (activeDiffScrollAnchor?.loadId === loadId) {
    activeDiffScrollAnchor = null;
  }
}
```

Call `clearScrollAnchorForLoad(loadId)` in the active-load empty-patch branch and active-load `catch` block, next to the existing `scrollRestorePendingLoadId = 0` assignments. Set `activeDiffScrollAnchor = null` in `onUnmounted` beside the existing load-id cleanup. A newer load already replaces the value, and the `loadId` comparison prevents stale callbacks from clearing or using its anchor.

- [ ] **Step 5: Capture only the compact-to-all transition**

Replace `toggleContextLines` with:

```ts
function toggleContextLines() {
  const expanding = !allLines.value;
  const scrollAnchor = expanding ? captureScrollAnchor() : null;
  if (expanding) {
    saveCurrentScrollPosition();
  }
  contextMode.value = allLines.value ? "compact" : "all";
  void loadDiff({ preserveCurrentScroll: false, scrollAnchor });
}
```

Guard `saveCurrentScrollPosition` so all-lines geometry cannot overwrite compact recall state:

```ts
function saveCurrentScrollPosition() {
  if (!containerRef.value || allLines.value) return;
  updateScrollPosition(scope.value, containerRef.value.scrollTop);
}
```

This intentionally leaves all-to-compact behavior on the compact numeric fallback because an unchanged all-lines row may not be rendered in compact mode.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts -t "keeps the anchored code line fixed throughout all-lines rendering"
```

Expected: PASS, with the immediate restore moving to `620` and the delayed post-render restore moving to `820` while line 8 remains 80px below the viewport top.

### Task 3: Regression verification

**Files:**
- Verify: `apps/desktop/src/components/DiffView.vue`
- Verify: `apps/desktop/src/components/__tests__/DiffView.test.ts`

- [ ] **Step 1: Run the complete DiffView component suite**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts
```

Expected: all `DiffView` tests pass, including existing per-scope, render-time, all-lines, search, and review behaviors.

- [ ] **Step 2: Run the desktop TypeScript check**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run formatting and worktree checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the approved spec, plan, component implementation/tests, and diff-view E2E test are changed.

### Task 4: Add reverse and remount regressions

**Files:**
- Modify: `apps/desktop/src/components/__tests__/DiffView.test.ts`

- [ ] **Step 1: Add the immediate round-trip test**

Reuse the existing mocked shadow-DOM geometry to render compact, all-lines, then compact documents. Scroll compact mode to `200`, expand until the semantic anchor moves the live viewport to `620`, toggle back without a manual scroll, and assert the compact viewport is `200`.

- [ ] **Step 2: Add the close/remount test**

Mount at compact `200`, expand to anchored all-lines geometry, dispatch the browser-style scroll event caused by restoration, then unmount. Mount a fresh `DiffView` with the last emitted `scroll-state-change` payload and assert its compact viewport restores to `200`, not the all-lines coordinate.

- [ ] **Step 3: Verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts -t "restores the compact scroll position|remounts with the compact scroll position"
```

Expected: both tests fail with an all-lines coordinate such as `620` because the current implementation emits and reloads that coordinate.

### Task 5: Keep anchor-derived pixels render-local

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue`
- Verify: `apps/desktop/src/components/__tests__/DiffView.test.ts`

- [ ] **Step 1: Stop persisting anchor restoration**

Remove `updateScrollPosition(scope.value, container.scrollTop)` from `restoreScrollAnchor`; the semantic anchor remains associated with the active load and continues to reapply during progressive callbacks.

- [ ] **Step 2: Save only compact geometry**

Make `saveCurrentScrollPosition` return while `allLines.value` is true. In `toggleContextLines`, save compact position before switching into All lines, then call `loadDiff({ preserveCurrentScroll: false, scrollAnchor })` for both directions so the old DOM is never recorded under the new mode. When a reload remains in All-lines mode, recapture the current semantic line before replacing the DOM and carry that transient anchor into the new load without persisting its pixel coordinate.

- [ ] **Step 3: Verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts
```

Expected: all focused component tests pass, including forward anchoring, immediate reverse, remount recall, same-mode reload, numeric fallback, and stale-load guards.

### Task 6: Add real-renderer WebDriver coverage

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/diff-view.test.ts`

- [ ] **Step 1: Build a long real diff through the Tauri git path**

Create multiple zero-padded tracked text files with at least 100 lines each, commit their baseline, and change a middle line in each file. Use a later file as the anchor target so earlier progressive renders can change its geometry.

- [ ] **Step 2: Capture and compare the real semantic line**

Traverse each real `diffs-container.shadowRoot`, choose the first intersecting `[data-line]` in the target file, and record `{ filePath, lineNumber, lineType, viewportOffset }`. Toggle the real toolbar to All lines, wait until every expected shadow root has rendered and geometry is stable for three consecutive samples, then locate the same selector and assert the viewport offset differs by at most two pixels.

- [ ] **Step 3: Run the required browser check**

Run:

```bash
./kd dev up
pnpm --dir apps/desktop test:e2e -- mock/diff-view.test.ts
./kd dev down
```

Expected: the diff-view WebDriver file passes through the real renderer, real scroll geometry, Tauri invoke path, toolbar, and progressive rendering.

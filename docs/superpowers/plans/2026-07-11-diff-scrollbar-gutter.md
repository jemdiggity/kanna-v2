# Diff Scrollbar Gutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long diff content out of the macOS overlay scrollbar lane in the regular diff modal.

**Architecture:** Preserve `.diff-container` as the persisted diff scroll owner and reserve a 12 px logical inline-end lane inside it. Prove the behavior through the real Tauri WebView by measuring a long rendered diff's overflow, computed padding, and content-to-container edge gap.

**Tech Stack:** Vue 3 scoped CSS, Tauri WKWebView, Vitest WebDriver E2E, pnpm

---

### Task 1: Add the failing WebView regression

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/diff-view.test.ts`
- Reference: `docs/superpowers/specs/2026-07-10-diff-scrollbar-gutter-design.md`

- [ ] **Step 1: Start the worktree app with an isolated E2E database**

Run:

```bash
./kd dev down --kill-daemon
KANNA_E2E_TEST_SQL=1 ./kd dev up --db kanna-test-db67dd60.db
```

Expected: kd reports that the worktree tmux session started. Wait until `curl -sf http://127.0.0.1:$KANNA_WEBDRIVER_PORT/status` reports the WebDriver as ready.

- [ ] **Step 2: Write the failing E2E test**

Add this test immediately before the existing sticky-header scroller test in `apps/desktop/tests/e2e/mock/diff-view.test.ts`:

```ts
  it("keeps diff content clear of the vertical scrollbar lane", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const scrollbarFile = "e2e-scrollbar-gutter.txt";

    await tauriInvoke(client, "run_script", {
      script: `for i in $(seq 1 220); do printf '# scrollbar gutter e2e %03d\\n' "$i"; done > ${scrollbarFile}`,
      cwd: worktreePath,
      env: {},
    });

    await openDiffModal(client);
    await waitForDiffText(client, `return text.includes(${JSON.stringify(scrollbarFile)});`);
    await waitForDiffScrollHeight(client, 1_200);

    const result = await client.executeSync<{
      hasVerticalOverflow: boolean;
      paddingInlineEnd: number;
      contentGap: number;
    } | null>(
      `const container = document.querySelector(".diff-container");
       const wrapper = Array.from(document.querySelectorAll(".diff-file")).find((element) => {
         const header = element.querySelector(".diff-file-header");
         return (header?.getAttribute("title") || header?.textContent || "") === ${JSON.stringify(scrollbarFile)};
       });
       if (!(container instanceof HTMLElement) || !(wrapper instanceof HTMLElement)) return null;
       const containerRect = container.getBoundingClientRect();
       const wrapperRect = wrapper.getBoundingClientRect();
       return {
         hasVerticalOverflow: container.scrollHeight > container.clientHeight,
         paddingInlineEnd: Number.parseFloat(getComputedStyle(container).paddingInlineEnd),
         contentGap: containerRect.right - wrapperRect.right,
       };`
    );

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.hasVerticalOverflow).toBe(true);
    expect(result.paddingInlineEnd).toBe(12);
    expect(result.contentGap).toBeGreaterThanOrEqual(result.paddingInlineEnd);
  });
```

- [ ] **Step 3: Run the focused test and verify the red state**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config ./tests/e2e/vitest.config.ts tests/e2e/mock/diff-view.test.ts -t "keeps diff content clear of the vertical scrollbar lane"
```

Expected: FAIL because `paddingInlineEnd` and `contentGap` are both `0`, proving that rendered content currently occupies the overlay scrollbar lane.

### Task 2: Reserve the scrollbar lane and verify the fix

**Files:**
- Modify: `apps/desktop/src/components/DiffContentPane.vue`
- Test: `apps/desktop/tests/e2e/mock/diff-view.test.ts`

- [ ] **Step 1: Add the minimal CSS fix**

Update the existing `.diff-container` rule in `apps/desktop/src/components/DiffContentPane.vue` to:

```css
.diff-container {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding-inline-end: 12px;
  overflow: auto;
}
```

- [ ] **Step 2: Re-run the focused E2E test and verify the green state**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config ./tests/e2e/vitest.config.ts tests/e2e/mock/diff-view.test.ts -t "keeps diff content clear of the vertical scrollbar lane"
```

Expected: PASS. The test reports vertical overflow, 12 px inline-end padding, and a content gap of at least 12 px.

- [ ] **Step 3: Run the focused component suite**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/DiffView.test.ts
```

Expected: all `DiffView` component tests pass with no new warnings or errors.

- [ ] **Step 4: Run the complete diff-view E2E file**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- mock/diff-view.test.ts
```

Expected: every diff-view E2E test passes against the isolated test database.

- [ ] **Step 5: Check the final patch**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Only the approved design/plan documentation, the diff-view E2E test, and `DiffContentPane.vue` are changed. Do not commit; Kanna's later workflow post owns the commit.

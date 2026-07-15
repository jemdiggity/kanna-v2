# Mobile Terminal Composer Safe Region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep raw PTY terminal scrollback above the mobile task screen's floating composer without changing sticky live-output following.

**Architecture:** Preserve the existing `TerminalWebView` inset contract and make the generated xterm document apply that inset independently from its sticky-bottom state. Keep `stickyToBottom` responsible only for deciding whether appended output calls `term.scrollToBottom()`, with executable Happy DOM coverage for scrolling away from and back to the live bottom.

**Tech Stack:** TypeScript, React Native WebView, xterm.js, Vitest, Happy DOM

---

## File Map

- Modify `apps/mobile/src/screens/buildTerminalDocument.test.ts`: add the regression scenario and update the generated-document assertion to describe an unconditional safe region.
- Modify `apps/mobile/src/screens/buildTerminalDocument.ts`: keep the configured inset applied to xterm's internal viewport regardless of sticky state.
- No changes to `TerminalWebView.tsx`, `TaskScreen.tsx`, or `AgentMessageView.tsx`; their existing responsibilities and inset values remain valid.

This Kanna stage intentionally leaves commits to the later pipeline step, so the plan contains no intermediate `git commit` actions.

### Task 1: Specify the permanent xterm safe region

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts:224`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

- [x] **Step 1: Update the generated-document expectation**

In `builds an xterm shell with sticky scroll behavior and bottom inset`, replace the conditional-inset assertion with assertions for the new separation of concerns:

```ts
expect(html).toContain('terminalViewport.style.bottom = "132px"');
expect(html).not.toContain("terminalViewport.style.bottom = stickyToBottom");
```

- [x] **Step 2: Add an executable scroll regression test**

Add this test after the generated-document shell test:

```ts
it("keeps the terminal safe region while scrollback disables sticky following", () => {
  const { terminal, terminalViewport, window } = createExecutedTerminalDocument();
  const initialScrollToBottomCalls = terminal.scrollToBottomCalls;

  terminalViewport.scrollTop = 100;
  terminalViewport.dispatchEvent(new window.Event("scroll"));

  expect(terminalViewport.style.bottom).toBe("24px");

  window.__appendTerminalChunk({ chunksB64: [b64("new output\n")] });

  expect(terminal.scrollToBottomCalls).toBe(initialScrollToBottomCalls);

  terminalViewport.scrollTop = 876;
  terminalViewport.dispatchEvent(new window.Event("scroll"));
  window.__appendTerminalChunk({ chunksB64: [b64("latest output\n")] });

  expect(terminalViewport.style.bottom).toBe("24px");
  expect(terminal.scrollToBottomCalls).toBe(initialScrollToBottomCalls + 1);
});
```

The fixture's `scrollHeight` is 1000 and `clientHeight` is 100. A `scrollTop` of 100 is well outside the 24 px near-bottom threshold; 876 is exactly at that threshold.

- [x] **Step 3: Run the focused test and verify the red state**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
```

Expected: FAIL because the generated source still contains the conditional assignment and scrolling away changes `terminalViewport.style.bottom` from `24px` to `0px`. Existing unrelated tests should continue to pass.

### Task 2: Decouple viewport clearance from sticky following

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts:169`
- Test: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

- [x] **Step 1: Make inset application unconditional**

Replace `applyViewportInset` with:

```ts
function applyViewportInset() {
  if (!terminalViewport) {
    return;
  }

  terminalViewport.style.bottom = "${bottomInset}px";
}
```

Do not change the scroll listener's `stickyToBottom = isNearBottom()` update or the append/replace `shouldStick` logic. Those paths still own live-output following; they no longer own layout clearance.

- [x] **Step 2: Run the focused test and verify the green state**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
```

Expected: PASS. The runtime regression proves the safe region remains `24px` while scrollback is active, appended output does not yank the user down, and returning to the threshold resumes following.

- [x] **Step 3: Review the focused diff**

Run:

```bash
git diff --check
git diff -- apps/mobile/src/screens/buildTerminalDocument.ts apps/mobile/src/screens/buildTerminalDocument.test.ts
```

Expected: no whitespace errors; the production diff changes only the inset assignment, and the test diff contains the static contract update plus the executable regression.

### Task 3: Verify the mobile package

**Files:**
- Verify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Verify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`

- [x] **Step 1: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [x] **Step 2: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: PASS with no failing mobile tests.

- [x] **Step 3: Confirm final scope and worktree state**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. The only task changes are the approved design spec, this implementation plan, `buildTerminalDocument.ts`, and `buildTerminalDocument.test.ts`. No native files or dependency manifests change, so the mobile OTA `runtimeVersion` remains unchanged.

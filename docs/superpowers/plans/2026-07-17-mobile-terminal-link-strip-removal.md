# Mobile Terminal Link Strip Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the floating mobile terminal file-link lists while keeping file paths directly tappable inside xterm.

**Architecture:** The generated terminal document remains the source of file-path parsing and xterm link activation, but no longer discovers or renders a recent-files list. The React Native wrapper continues accepting individual `terminal-file-link` activations and removes all state and UI for bulk `terminal-file-links` discovery messages.

**Tech Stack:** React Native, TypeScript, React Native WebView, xterm.js, Vitest

---

### Task 1: Specify terminal-only file-link behavior

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx`

- [x] **Step 1: Replace generated-document strip tests with a no-floating-UI test**

Replace the tests that expect persistent file buttons, recent-link limits, and gesture behavior over those buttons with a test that updates terminal output and asserts that the generated page has no floating region and emits no discovery-list message:

```ts
it("keeps file links inside xterm without rendering a floating link list", () => {
  const { messages, window } = createExecutedTerminalDocument();

  window.__replaceTerminalState({
    text: "See README.md and docs/spec.md:42\n"
  });

  expect(window.document.getElementById("terminal-file-links")).toBeNull();
  expect(
    messages.map((message) => JSON.parse(message).type)
  ).not.toContain("terminal-file-links");
});
```

Keep the existing row-provider test that proves `provideLinks(...)` returns xterm links, and keep direct activation coverage that proves xterm posts `terminal-file-link`.

- [x] **Step 2: Replace native-strip tests with a discovery-message rejection test**

Replace the tests that press a native file button and clear discovered links on task change with:

```tsx
it("does not render a native strip for discovered file-list messages", async () => {
  const onOpenFile = vi.fn();
  const webView = await renderTerminalWebView({ onOpenFile });

  (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
    nativeEvent: {
      data: JSON.stringify({
        type: "terminal-file-links",
        links: [{ raw: "docs/spec.md:42", path: "docs/spec.md", line: 42 }]
      })
    }
  } as WebViewMessageEvent);
  await renderTerminalWebView({ onOpenFile });

  expect(
    React.Children.toArray(lastTree?.props.children).some(
      (child) =>
        typeof child === "object" && child !== null &&
        "type" in child && (child as ElementNode).type === "ScrollView"
    )
  ).toBe(false);
  expect(onOpenFile).not.toHaveBeenCalled();
});
```

Keep existing `terminal-file-link` tests to prove direct link activation still forwards the file path.

- [x] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile exec vitest run src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx
```

Expected: FAIL because the generated document still contains `#terminal-file-links`, and `TerminalWebView` still renders a `ScrollView` after a `terminal-file-links` message.

### Task 2: Remove generated and native floating link lists

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx`

- [x] **Step 1: Remove generated-document list discovery and markup**

In `buildTerminalDocument.ts`, delete:

- `.terminal-file-links`, label, and button CSS;
- the `#terminal-file-links` body markup;
- `terminalFileLinks` and `terminalFileLinkButtons` DOM lookups;
- recent-link scan constants;
- `refreshTerminalFileLinks()` and its call after terminal writes.

Keep `terminalFileCandidates`, `detectTerminalFileLinks`, `term.registerLinkProvider`, the gesture cooldown, and `notifyTerminalFileLink` unchanged so direct xterm taps continue to post:

```ts
{ type: "terminal-file-link", path, line }
```

- [x] **Step 2: Remove native discovered-link state and strip**

In `TerminalWebView.tsx`:

- narrow React Native imports to `StyleSheet`, `Text`, and `View`;
- delete `TerminalFileLink` and `terminalFileLinks` state;
- delete the task-change state reset;
- remove `links` from the bridge payload type and delete `terminal-file-links` handling;
- delete the conditional `ScrollView`/`Pressable` render block;
- delete `fileLink`, `fileLinks`, `fileLinksLabel`, and `fileLinkText` styles.

Leave the individual activation handler intact:

```ts
if (payload.type === "terminal-file-link") {
  // validate path/line and call onOpenFile
}
```

- [x] **Step 3: Run focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile exec vitest run src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx
```

Expected: both test files pass.

- [x] **Step 4: Run mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: exit 0 with no TypeScript errors.

- [x] **Step 5: Check generated diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the design, plan, and four mobile screen/test files are changed.

No commit is created in this stage because Kanna's later pipeline stage owns committing.

### Task 3: Align relay E2E coverage with terminal-only links

**Files:**
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`

- [x] **Step 1: Add failing tests for inline-only relay link verification**

Cover a helper that waits until all emitted file paths are present in terminal inspection and fails if any removed `Open file …` native accessibility control still exists.

- [x] **Step 2: Verify the tests fail before implementation**

Run:

```bash
pnpm --dir apps/mobile exec vitest run e2e/specs/relay/relay-task-flow.test.ts
```

Expected: FAIL because `verifyTerminalFileLinksStayInline` does not exist.

- [x] **Step 3: Replace the obsolete preview-button Appium journey**

Remove native-button presses and preview assertions that cannot run without the floating strip. Add `verifyTerminalFileLinksStayInline`, then call it after the relay harness emits file paths.

- [x] **Step 4: Verify the focused E2E helper tests pass**

Run:

```bash
pnpm --dir apps/mobile exec vitest run e2e/specs/relay/relay-task-flow.test.ts
```

Expected: 15 tests pass.

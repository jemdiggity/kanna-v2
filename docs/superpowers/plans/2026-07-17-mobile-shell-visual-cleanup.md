# Mobile Shell Visual Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the generic ambient background shapes from Kanna Mobile and make its floating shell chrome use a consistent opaque dark surface.

**Architecture:** Keep this narrow presentation change inside the existing root shell and floating toolbar components. Add rendering-level regression tests that assert the root shell has only its content layer and that the floating chrome uses the approved opaque color; no state, navigation, or data APIs change.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Vitest, `react-test-renderer`, Appium/WebdriverIO, PNGJS, pnpm

---

### Task 1: Remove the root ambient decoration

**Files:**
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/App.tsx`

- [ ] **Step 1: Write the failing root-layer test**

Add this test inside `describe("App component wiring", ...)` in
`apps/mobile/src/App.component.test.tsx`:

```tsx
it("renders the root shell without ambient decoration layers", async () => {
  const { model } = createModel("connected");
  const renderer = await mountModel(model);
  const safeArea = findTestId(renderer.root, MOBILE_E2E_IDS.appShell);

  expect(safeArea.findAllByType("View", { deep: false })).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand App.component.test.tsx
```

Expected: FAIL because the safe area has three immediate `View` children: the
two ambient decorations and the shell.

- [ ] **Step 3: Remove the ambient elements and styles**

In `apps/mobile/src/App.tsx`, change the root rendering from:

```tsx
<SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
  <View style={styles.backgroundGlow} />
  <View style={styles.backgroundOrb} />
  <View
```

to:

```tsx
<SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
  <View
```

Delete both obsolete style entries from the same file:

```tsx
backgroundGlow: {
  backgroundColor: "#122B51",
  borderRadius: 280,
  height: 280,
  opacity: 0.22,
  position: "absolute",
  right: -70,
  top: -40,
  width: 280
},
backgroundOrb: {
  backgroundColor: "#163057",
  borderRadius: 220,
  bottom: 120,
  height: 220,
  left: -90,
  opacity: 0.16,
  position: "absolute",
  width: 220
},
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand App.component.test.tsx
```

Expected: PASS, including the new root-layer assertion.

- [ ] **Step 5: Commit the root cleanup**

```bash
git add apps/mobile/src/App.tsx apps/mobile/src/App.component.test.tsx
git commit -m "style(mobile): remove ambient shell decoration"
```

### Task 2: Make floating shell chrome opaque

**Files:**
- Create: `apps/mobile/src/components/FloatingToolbar.test.tsx`
- Modify: `apps/mobile/src/components/FloatingToolbar.tsx`

- [ ] **Step 1: Write the failing chrome-color test**

Create `apps/mobile/src/components/FloatingToolbar.test.tsx` with:

```tsx
import React from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { FloatingToolbar } from "./FloatingToolbar";

vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (result, item) => ({ ...result, ...flattenStyle(item) }),
      {}
    );
  }

  return style && typeof style === "object"
    ? (style as Record<string, unknown>)
    : {};
}

describe("FloatingToolbar", () => {
  it("uses opaque dark surfaces for secondary floating chrome", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <FloatingToolbar
          activeTab="tasks"
          tabs={[
            { name: "tasks", label: "Tasks", icon: "home-outline" },
            { name: "recent", label: "Activity", icon: "notifications-outline" },
            { name: "more", label: "More", icon: "ellipsis-horizontal" }
          ]}
          utilityActions={[
            { name: "search", label: "Search", icon: "search-outline" },
            { name: "create", label: "Add task", icon: "add" }
          ]}
          onSelectTab={vi.fn()}
          onSelectUtilityAction={vi.fn()}
        />
      );
    });

    const searchButton = renderer!.root.find(
      (node) =>
        node.type === "Pressable" && node.props.accessibilityLabel === "Search"
    );
    const navigationBar = renderer!.root.findAllByType("View").find(
      (node) => node.findAllByType("Pressable", { deep: false }).length === 3
    );

    expect(flattenStyle(searchButton.props.style).backgroundColor).toBe(
      "#080F1B"
    );
    expect(flattenStyle(navigationBar?.props.style).backgroundColor).toBe(
      "#080F1B"
    );

    act(() => renderer!.unmount());
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/components/FloatingToolbar.test.tsx
```

Expected: FAIL because the navigation bar and search button still use
`rgba(8, 15, 27, 0.97)`.

- [ ] **Step 3: Apply the approved opaque chrome color**

In `apps/mobile/src/components/FloatingToolbar.tsx`, replace both instances of:

```tsx
backgroundColor: "rgba(8, 15, 27, 0.97)"
```

with:

```tsx
backgroundColor: "#080F1B"
```

Leave the pale active item and primary create button unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand src/components/FloatingToolbar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the opaque chrome change**

```bash
git add apps/mobile/src/components/FloatingToolbar.tsx apps/mobile/src/components/FloatingToolbar.test.tsx
git commit -m "style(mobile): simplify floating shell chrome"
```

### Task 3: Verify the complete mobile package

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/components/FloatingToolbar.tsx`
- Modify: `apps/mobile/src/screens/TasksScreen.tsx`
- Modify: `apps/mobile/src/screens/SearchScreen.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Create: `apps/mobile/e2e/helpers/dev-client.ts`
- Create: `apps/mobile/e2e/helpers/dev-client.test.ts`
- Create: `apps/mobile/e2e/helpers/native-shell-visual.ts`
- Create: `apps/mobile/e2e/helpers/native-shell-visual.test.ts`
- Create: `apps/mobile/e2e/specs/smoke/shell-visual.e2e.ts`
- Create: `apps/mobile/e2e/specs/smoke/shell-visual.test.ts`
- Modify: `apps/mobile/e2e/run.ts`
- Modify: `apps/mobile/e2e/run.test.ts`

- [ ] **Step 1: Add failing tests for screenshot pixel inspection and shell navigation**

Add unit tests that construct small PNG fixtures and require the screenshot
helper to map native point rectangles to screenshot pixels, measure exact color
coverage, and report useful failures. Add a smoke-flow unit test with a fake UI
that requires the flow to visit Tasks, Recent, Search, and More and capture each
screen.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand e2e/helpers/native-shell-visual.test.ts e2e/specs/smoke/shell-visual.test.ts
```

Expected: FAIL because the screenshot helper and smoke flow do not exist yet.

- [ ] **Step 3: Add stable native selectors and PNG inspection support**

Add `pngjs` and `@types/pngjs` as mobile development dependencies. Extend
`MOBILE_E2E_IDS` and the Appium selectors with IDs for the Recent, Search, and
More screen roots, the toolbar navigation container, and the search utility
button. Apply those IDs to the existing native views without changing their
layout or behavior. Replace the launch runner's early Expo-overlay probe with
an app-owned toolbar readiness marker; accept first-launch onboarding or dismiss
the native developer-menu sheet before visual sampling.

- [ ] **Step 4: Implement the native shell visual smoke**

Implement a pure PNG helper that decodes WebDriver screenshots, maps native
rectangles using the screenshot/window scale, and asserts exact-color coverage.
Implement a simulator smoke flow that:

1. waits for Tasks and captures the shell;
2. visits Recent, Search, and More and captures each rendered screen;
3. checks right/top and left/lower canvas patches where the removed ambient
   circles used to appear for exact `#08111E` coverage;
4. checks exposed search-button and navigation-container patches for exact
   `#080F1B` coverage across screens with different content behind the floating
   chrome, so translucent `rgba(...)` surfaces cannot pass by flattening over a
   similar dark canvas; and
5. checks that `#1E304C` border pixels remain present around the toolbar.

Wire the flow into simulator `smoke` runs after the list/detail flow has returned
to the task list, and expose a dedicated `shell-visual` simulator mode that does
not require the unrelated live PTY fixture. Keep physical-device smoke unchanged
because its device model, display scale, and human-owned launch flow are
intentionally not pinned.

- [ ] **Step 5: Run focused unit and simulator coverage**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand e2e/helpers/native-shell-visual.test.ts e2e/specs/smoke/shell-visual.test.ts App.component.test.tsx src/components/FloatingToolbar.test.tsx
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile run test:e2e:shell-visual
```

Expected: all focused tests and typecheck pass; the booted simulator visits all
four top-level screens and the native screenshot assertions pass.

- [ ] **Step 6: Prove the native visual regression fails against the old shell**

Temporarily restore the removed ambient circle views and translucent toolbar
colors, rerun `pnpm --dir apps/mobile run test:e2e:shell-visual`, and verify the new
pixel assertion fails for the expected canvas/chrome mismatch. Restore the
implementation and rerun the simulator smoke to green.

### Task 4: Verify the complete repository

**Files:**
- Verify only; no planned file changes.

- [ ] **Step 1: Run the reviewer-requested focused tests**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand App.component.test.tsx src/components/FloatingToolbar.test.tsx
```

Expected: both focused component test files pass.

- [ ] **Step 2: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: `tsc --noEmit` exits successfully with no diagnostics.

- [ ] **Step 3: Run the repository JavaScript/TypeScript suite**

Run:

```bash
pnpm test
```

Expected: all workspace JavaScript/TypeScript test projects pass.

- [ ] **Step 4: Run the daemon Rust suite serially**

Run:

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: all daemon tests pass.

- [ ] **Step 5: Check the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only this revision's intended files are
uncommitted for the manual workflow transition.

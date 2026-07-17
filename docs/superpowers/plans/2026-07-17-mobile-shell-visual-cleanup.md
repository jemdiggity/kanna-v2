# Mobile Shell Visual Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the generic ambient background shapes from Kanna Mobile and make its floating shell chrome use a consistent opaque dark surface.

**Architecture:** Keep this narrow presentation change inside the existing root shell and floating toolbar components. Add rendering-level regression tests that assert the root shell has only its content layer and that the floating chrome uses the approved opaque color; no state, navigation, or data APIs change.

**Tech Stack:** React Native 0.86, React 19, TypeScript, Vitest, `react-test-renderer`, pnpm

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
pnpm --dir apps/mobile test -- App.component.test.tsx --runInBand
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
pnpm --dir apps/mobile test -- App.component.test.tsx --runInBand
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
pnpm --dir apps/mobile test -- src/components/FloatingToolbar.test.tsx --runInBand
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
pnpm --dir apps/mobile test -- src/components/FloatingToolbar.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit the opaque chrome change**

```bash
git add apps/mobile/src/components/FloatingToolbar.tsx apps/mobile/src/components/FloatingToolbar.test.tsx
git commit -m "style(mobile): simplify floating shell chrome"
```

### Task 3: Verify the complete mobile package

**Files:**
- Verify only; no planned file changes.

- [ ] **Step 1: Run the full mobile unit test suite**

Run:

```bash
pnpm --dir apps/mobile test -- --runInBand
```

Expected: all mobile Vitest files pass.

- [ ] **Step 2: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: `tsc --noEmit` exits successfully with no diagnostics.

- [ ] **Step 3: Check the final diff**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted implementation files.

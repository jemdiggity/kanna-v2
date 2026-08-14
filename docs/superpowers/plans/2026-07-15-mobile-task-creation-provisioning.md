# Mobile Task Creation Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile create-task button's text-only pending state with a blocking, terminal-inspired provisioning panel.

**Architecture:** Keep `isComposerSubmitting` as the single source of truth because the synchronous create API exposes no intermediate phases. `CreateTaskComposer` returns a dedicated, accessible pending-state sheet while submitting and retains the existing composer unchanged for idle and error states.

**Tech Stack:** React Native 0.79, React 19, TypeScript, Vitest, existing mobile E2E selector catalog.

---

### Task 1: Stable Provisioning Selector

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write the failing selector test**

Add this assertion to `keeps the smoke-test selectors stable`:

```ts
expect(MOBILE_E2E_IDS.createTaskProvisioning).toBe(
  "mobile.create-task.provisioning"
);
```

- [ ] **Step 2: Run the selector test to verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts
```

Expected: FAIL because `createTaskProvisioning` is undefined.

- [ ] **Step 3: Add the selector to the catalog**

Insert this property beside the existing create-task selectors:

```ts
createTaskPromptInput: "mobile.create-task.prompt",
createTaskSubmitButton: "mobile.create-task.submit",
createTaskProvisioning: "mobile.create-task.provisioning",
createTaskError: "mobile.create-task.error",
```

- [ ] **Step 4: Run the selector test to verify it passes**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts
```

Expected: PASS.

### Task 2: Blocking Provisioning Sheet

**Files:**
- Modify: `apps/mobile/src/components/CreateTaskComposer.test.tsx`
- Modify: `apps/mobile/src/components/CreateTaskComposer.tsx`

- [ ] **Step 1: Write failing component tests**

Add `ActivityIndicator: "ActivityIndicator"` to the test's React Native mock.
Add `onClose: () => void` to the `renderComposer` override type and replace the
fixed `onClose: vi.fn()` prop with:

```ts
onClose: overrides.onClose ?? vi.fn(),
```

Replace `disables create and shows progress while submitting` with:

```ts
it("replaces the composer with a technical provisioning panel", () => {
  const tree = renderComposer({
    isSubmitting: true,
    selectedAgentProvider: "codex"
  });
  const provisioning = findNodeByTestId(
    tree,
    "mobile.create-task.provisioning"
  );

  expect(provisioning).not.toBeNull();
  expect(findNodeByType(provisioning as ElementNode, "ActivityIndicator")).not.toBeNull();
  expect(findNodeByText(provisioning as ElementNode, ">_")).not.toBeNull();
  expect(findNodeByText(provisioning as ElementNode, "Provisioning task")).not.toBeNull();
  expect(
    findNodeByText(
      provisioning as ElementNode,
      "Repo One → Studio Mac · Codex"
    )
  ).not.toBeNull();
  expect(
    findNodeByText(
      provisioning as ElementNode,
      "Creating worktree and starting Codex…"
    )
  ).not.toBeNull();
  expect(findNodeByTestId(tree, "mobile.create-task.prompt")).toBeNull();
  expect(findNodeByTestId(tree, "mobile.create-task.submit")).toBeNull();
  expect(findNodeByText(tree, "Cancel")).toBeNull();
});

it("announces provisioning as an indeterminate accessible operation", () => {
  const tree = renderComposer({ isSubmitting: true });
  const provisioning = findNodeByTestId(
    tree,
    "mobile.create-task.provisioning"
  );

  expect(provisioning?.props).toMatchObject({
    accessible: true,
    accessibilityLabel:
      "Provisioning task for Repo One on Studio Mac with Claude",
    accessibilityLiveRegion: "polite",
    accessibilityRole: "progressbar",
    accessibilityState: { busy: true }
  });
});

it("blocks every composer dismissal path while provisioning", () => {
  const onClose = vi.fn();
  const tree = renderComposer({ isSubmitting: true, onClose });
  const modal = findNodeByType(tree, "Modal");
  const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
  const backdrop = flattenChildren(keyboardAvoider?.props?.children)[0];

  (modal?.props?.onRequestClose as (() => void) | undefined)?.();
  (backdrop?.props?.onPress as (() => void) | undefined)?.();

  expect(backdrop?.props?.disabled).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps normal composer dismissal available before submission", () => {
  const onClose = vi.fn();
  const tree = renderComposer({ onClose });
  const modal = findNodeByType(tree, "Modal");
  const keyboardAvoider = findNodeByType(tree, "KeyboardAvoidingView");
  const backdrop = flattenChildren(keyboardAvoider?.props?.children)[0];

  (modal?.props?.onRequestClose as (() => void) | undefined)?.();
  (backdrop?.props?.onPress as (() => void) | undefined)?.();

  expect(onClose).toHaveBeenCalledTimes(2);
});
```

Add this assertion to the existing composer validation-error test:

```ts
expect(findNodeByTestId(tree, "mobile.create-task.provisioning")).toBeNull();
```

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/CreateTaskComposer.test.tsx
```

Expected: FAIL because there is no provisioning panel and submitting still
shows the editable composer.

- [ ] **Step 3: Implement the minimal blocking pending state**

Add `ActivityIndicator` to the React Native imports. Immediately after deriving
`selectedDesktopLabel`, add this early return:

```tsx
if (isSubmitting) {
  const provisioningRepoLabel = selectedRepo?.name ?? "Selected repo";
  const provisioningDesktopLabel = selectedDesktop?.name ?? "Selected machine";
  const provisioningRoute =
    `${provisioningRepoLabel} → ${provisioningDesktopLabel} · ${selectedAgentLabel}`;

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => undefined}
      transparent
      visible={isOpen}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <Pressable disabled style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View
            accessible
            accessibilityLabel={
              `Provisioning task for ${provisioningRepoLabel} on ` +
              `${provisioningDesktopLabel} with ${selectedAgentLabel}`
            }
            accessibilityLiveRegion="polite"
            accessibilityRole="progressbar"
            accessibilityState={{ busy: true }}
            style={styles.provisioning}
            testID={MOBILE_E2E_IDS.createTaskProvisioning}
          >
            <View style={styles.provisioningHeader}>
              <View
                accessibilityElementsHidden
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                style={styles.terminalTile}
              >
                <Text style={styles.terminalPrompt}>{">_"}</Text>
                <ActivityIndicator
                  color="#8FC5FF"
                  size="small"
                  style={styles.provisioningIndicator}
                />
              </View>
              <View style={styles.provisioningHeading}>
                <Text style={styles.provisioningEyebrow}>Workspace boot</Text>
                <Text style={styles.provisioningTitle}>Provisioning task</Text>
              </View>
            </View>

            <View style={styles.provisioningRouteCard}>
              <Text numberOfLines={2} style={styles.provisioningRoute}>
                {provisioningRoute}
              </Text>
            </View>

            <View style={styles.provisioningStatus}>
              <Text style={styles.provisioningStatusPrompt}>{"›"}</Text>
              <Text style={styles.provisioningStatusCopy}>
                {`Creating worktree and starting ${selectedAgentLabel}…`}
              </Text>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
```

Add these styles to `StyleSheet.create`:

```ts
provisioning: {
  gap: 20,
  paddingBottom: 8,
  paddingTop: 6
},
provisioningHeader: {
  alignItems: "center",
  flexDirection: "row",
  gap: 14
},
terminalTile: {
  alignItems: "center",
  backgroundColor: "#09111F",
  borderColor: "#2A4268",
  borderRadius: 16,
  borderWidth: 1,
  height: 64,
  justifyContent: "center",
  width: 64
},
terminalPrompt: {
  color: "#CBE1FF",
  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  fontSize: 18,
  fontWeight: "700"
},
provisioningIndicator: {
  bottom: 6,
  position: "absolute",
  right: 6,
  transform: [{ scale: 0.72 }]
},
provisioningHeading: {
  flex: 1,
  gap: 4
},
provisioningEyebrow: {
  color: "#8FC5FF",
  fontSize: 11,
  fontWeight: "800",
  letterSpacing: 1.2,
  textTransform: "uppercase"
},
provisioningTitle: {
  color: "#F5F7FB",
  fontSize: 22,
  fontWeight: "700"
},
provisioningRouteCard: {
  backgroundColor: "#101B2D",
  borderColor: "#263A5B",
  borderRadius: 14,
  borderWidth: 1,
  paddingHorizontal: 14,
  paddingVertical: 12
},
provisioningRoute: {
  color: "#BFD2EF",
  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  fontSize: 12,
  lineHeight: 18
},
provisioningStatus: {
  alignItems: "flex-start",
  flexDirection: "row",
  gap: 8
},
provisioningStatusPrompt: {
  color: "#8FC5FF",
  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  fontSize: 15,
  fontWeight: "800",
  lineHeight: 20
},
provisioningStatusCopy: {
  color: "#A9B8D1",
  flex: 1,
  fontSize: 13,
  fontWeight: "700",
  lineHeight: 20
},
```

- [ ] **Step 4: Run the component test to verify it passes**

Run:

```bash
pnpm --dir apps/mobile test -- src/components/CreateTaskComposer.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the controller pending-state regression**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "keeps create task feedback inside the composer while submitting"
```

Expected: PASS, confirming the pending state spans the API request and clears
when it resolves.

### Task 3: Final Mobile Verification

**Files:**
- Verify: `apps/mobile/src/components/CreateTaskComposer.tsx`
- Verify: `apps/mobile/src/components/CreateTaskComposer.test.tsx`
- Verify: `apps/mobile/src/e2eTestIds.ts`
- Verify: `apps/mobile/src/e2eTestIds.test.ts`

- [ ] **Step 1: Run focused mobile suites together**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts src/components/CreateTaskComposer.test.tsx src/state/mobileController.test.ts
```

Expected: all focused suites PASS.

- [ ] **Step 2: Run mobile typechecking**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 3: Check formatting and the final diff**

Run:

```bash
git diff --check
git diff -- apps/mobile/src/e2eTestIds.ts apps/mobile/src/e2eTestIds.test.ts apps/mobile/src/components/CreateTaskComposer.tsx apps/mobile/src/components/CreateTaskComposer.test.tsx
```

Expected: the whitespace check exits zero and the diff contains only the
approved mobile provisioning behavior and its tests.

- [ ] **Step 4: Leave implementation and docs uncommitted for review**

Run:

```bash
git status --short
```

Expected: the spec, plan, implementation, and tests remain uncommitted for
Kanna's later workflow stages.

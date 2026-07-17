# Mobile Search Focus Appium Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Appium smoke journey proving the mobile toolbar Search action focuses and repeatedly refocuses the native Search tasks input.

**Architecture:** Stable React Native identifiers expose the toolbar action, Search root, native input, and outside-input dismissal target to XCUITest. A dedicated smoke module adapts WebdriverIO to a small testable UI interface, compares the input with WebDriver's active element, asserts keyboard visibility, dismisses through a real heading tap, repeats the toolbar action, and restores the Tasks screen for following smoke modules.

**Tech Stack:** React Native 0.86, TypeScript, Vitest, WebdriverIO 9, Appium 2, XCUITest

---

## File Structure

- Modify `apps/mobile/src/e2eTestIds.ts` and `apps/mobile/src/e2eTestIds.test.ts` for stable Search identifiers.
- Modify `apps/mobile/src/components/FloatingToolbar.tsx` and `apps/mobile/src/screens/SearchScreen.tsx` to expose native automation identifiers.
- Modify `apps/mobile/e2e/helpers/selectors.ts` and `apps/mobile/e2e/helpers/selectors.test.ts` to map the identifiers into accessibility-id selectors.
- Create `apps/mobile/e2e/specs/smoke/search-focus.e2e.ts` for the driver adapter and journey.
- Create `apps/mobile/e2e/specs/smoke/search-focus.test.ts` for helper-level ordering, focus, keyboard, and repeated-tap coverage.
- Modify `apps/mobile/e2e/run.ts` and `apps/mobile/e2e/run.test.ts` to register and execute the journey in aggregate and standalone smoke modes.
- Modify `apps/mobile/package.json` to expose the standalone simulator command.

### Task 1: Define the failing Search automation contract

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.test.ts`
- Modify: `apps/mobile/e2e/run.test.ts`

- [x] **Step 1: Add failing stable-ID expectations**

Expect `searchScreen`, `searchInput`, `searchKeyboardDismissTarget`, and `toolbarSearch` to resolve to their stable mobile identifiers.

- [x] **Step 2: Add failing selector expectations**

Expect `selectors.searchScreen`, `selectors.searchInput`, `selectors.searchKeyboardDismissTarget`, and `selectors.searchToolbarButton` to expose accessibility-id selectors.

- [x] **Step 3: Add the failing smoke-manifest expectation**

Expect `smokeSpecPaths` to contain `specs/smoke/search-focus.e2e.ts`.

- [x] **Step 4: Verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts e2e/helpers/selectors.test.ts e2e/run.test.ts
```

Expected: FAIL because the Search identifiers, selectors, and smoke registration do not exist.

### Task 2: Expose Search controls to native automation

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/components/FloatingToolbar.tsx`
- Modify: `apps/mobile/src/screens/SearchScreen.tsx`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Test: `apps/mobile/src/e2eTestIds.test.ts`
- Test: `apps/mobile/e2e/helpers/selectors.test.ts`

- [x] **Step 1: Add the stable identifiers**

Add fixed `searchScreen`, `searchInput`, and `searchKeyboardDismissTarget` fields, and reuse the existing `toolbarSearch` identifier from `MOBILE_E2E_IDS`.

- [x] **Step 2: Attach the toolbar identifier**

Keep the Search `Pressable` test ID on `MOBILE_E2E_IDS.toolbarSearch` while retaining its accessibility label and press behavior.

- [x] **Step 3: Attach Search screen and input identifiers**

Set the root `ScrollView`, heading, and `TextInput` test IDs without changing focus or query behavior.

- [x] **Step 4: Map Appium selectors**

Add `searchScreen`, `searchInput`, `searchKeyboardDismissTarget`, and `searchToolbarButton` mappings in `selectors.ts` using accessibility-id (`~`) selectors.

- [x] **Step 5: Verify GREEN for the selector contract**

Run:

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts e2e/helpers/selectors.test.ts
```

Expected: PASS with the exact stable selector strings.

### Task 3: Specify the repeated native-focus journey

**Files:**
- Create: `apps/mobile/e2e/specs/smoke/search-focus.test.ts`
- Create: `apps/mobile/e2e/specs/smoke/search-focus.e2e.ts`

- [x] **Step 1: Write the failing helper test**

Build fake Search button, screen, input, heading dismissal target, and Tasks tab elements. Model active-input and keyboard-visible state changes: Search clicks focus the input and show the keyboard; heading taps clear both; Tasks clicks restore the Tasks view. Assert the helper clicks Search twice, dismisses the keyboard twice, observes the Search screen after dismissal, and restores Tasks.

- [x] **Step 2: Verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/search-focus.test.ts
```

Expected: FAIL because `runSearchFocusJourney` is not exported yet.

- [x] **Step 3: Implement the testable journey helper**

Define a narrow UI interface with element getters, `isSearchInputFocused`, `isKeyboardShown`, and `waitUntil`. Poll for these states in order:

1. Search screen exists after the first Search click.
2. Input is focused and keyboard is visible.
3. A heading tap hides the keyboard and clears input focus while Search remains displayed.
4. Input is focused and keyboard is visible after the second Search click.
5. Keyboard is dismissed and Tasks is selected for cleanup.

- [x] **Step 4: Implement the WebdriverIO adapter**

Map interface methods to `driver.$`, `driver.getActiveElement()`, `driver.isKeyboardShown()`, and `driver.waitUntil()`. Export `runSearchFocusSmoke(driver)` to wait for the app shell and run the helper.

- [x] **Step 5: Verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/specs/smoke/search-focus.test.ts
```

Expected: PASS, including the two Search clicks and the focus-loss precondition before refocusing.

### Task 4: Wire the journey into standard smoke mode

**Files:**
- Modify: `apps/mobile/e2e/run.ts`
- Test: `apps/mobile/e2e/run.test.ts`

- [x] **Step 1: Register the smoke module**

Import `runSearchFocusSmoke`, add its path to `smokeSpecPaths`, call it in standard `smoke` mode after `runListDetailBackSmoke` and before `runProfileConnectionSmoke`, and add a standalone `search-focus` mode.

- [x] **Step 2: Verify runner coverage**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/run.test.ts e2e/specs/smoke/search-focus.test.ts
```

Expected: PASS with the dedicated journey registered.

### Task 5: Verify the complete revision

**Files:**
- Review all files listed above plus the retained component tests.

- [x] **Step 1: Run focused review coverage**

```bash
pnpm --dir apps/mobile test -- SearchScreen.test.tsx App.component.test.tsx e2e/specs/smoke/search-focus.test.ts
```

Expected: PASS.

- [x] **Step 2: Run mobile typecheck**

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [x] **Step 3: Run required repository tests**

```bash
pnpm test
```

Expected: PASS.

- [x] **Step 4: Run required daemon tests**

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: PASS.

- [x] **Step 5: Attempt the simulator smoke when prerequisites permit**

Run the canonical preflight before the smoke:

```bash
pnpm --dir apps/mobile run test:e2e:preflight
KANNA_E2E_DESKTOP_SERVER_URL=http://127.0.0.1:<assigned-port> pnpm --dir apps/mobile run test:e2e:search-focus
```

Expected: PASS when the dev client, simulator, XCUITest driver, desktop API, and Metro are available. The aggregate `test:e2e:smoke` remains available when the known live-PTY fixture is also configured. Otherwise record the exact missing prerequisite or preflight failure; do not claim simulator execution.

- [x] **Step 6: Inspect the final diff**

```bash
git diff --check
git status --short
git diff -- apps/mobile docs/superpowers/specs/2026-07-17-mobile-search-focus-appium-coverage-design.md docs/superpowers/plans/2026-07-17-mobile-search-focus-appium-coverage.md
```

Expected: no whitespace errors and only revision-scoped changes. Leave the worktree uncommitted for Kanna's later commit stage.

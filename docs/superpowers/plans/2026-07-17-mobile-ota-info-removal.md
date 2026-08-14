# Mobile OTA Information Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove OTA diagnostics from the mobile More screen while preserving automatic OTA checks and the update-ready restart prompt.

**Architecture:** Delete the presentation-specific metadata flow from `App` through `MoreScreen` and its formatter. Leave the independent update-check, download, and reload flow intact, and preserve integration coverage by navigating to a positively identified More screen before asserting the historical OTA element is absent.

**Tech Stack:** React Native, React 19, TypeScript, Vitest, WebdriverIO/Appium helpers

---

### Task 1: Lock the More-screen behavior with a regression test

**Files:**
- Create: `apps/mobile/src/screens/MoreScreen.test.tsx`

- [x] **Step 1: Write a component test that renders `MoreScreen` with representative OTA metadata and asserts that “App update”, “staging”, the runtime version, and the shortened update id are absent.**
- [x] **Step 2: Run `pnpm --dir apps/mobile test -- src/screens/MoreScreen.test.tsx` and confirm it fails because the current diagnostics card renders those values.**

### Task 2: Remove the UI metadata flow

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Delete: `apps/mobile/src/screens/moreUpdateInfo.ts`
- Delete: `apps/mobile/src/screens/moreUpdateInfo.test.ts`
- Modify: `apps/mobile/src/lib/updates/otaUpdates.ts`
- Modify: `apps/mobile/src/lib/updates/otaUpdates.test.ts`

- [x] **Step 1: Remove `CurrentUpdateInfo`, `getCurrentUpdateInfo`, and their tests while keeping `checkAndFetchUpdate` and `reloadToApplyUpdate` unchanged.**
- [x] **Step 2: Remove the current-update-info state and `updateInfo` prop plumbing from `App`.**
- [x] **Step 3: Remove the diagnostics card, formatter, and card-only styles from `MoreScreen`, then delete the formatter files.**
- [x] **Step 4: Re-run `pnpm --dir apps/mobile test -- src/screens/MoreScreen.test.tsx src/lib/updates/otaUpdates.test.ts src/components/UpdateReadyBanner.test.tsx src/App.component.test.tsx` and confirm all focused tests pass.**

### Task 3: Remove obsolete E2E diagnostics hooks and verify

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.test.ts`

- [x] **Step 1: Remove the OTA-value test id, selector, dev-smoke UI interface, helper, invocation, and helper unit tests that depended on the deleted card.**
- [x] **Step 2: Run `pnpm --dir apps/mobile test` and confirm the complete mobile unit suite passes.**
- [x] **Step 3: Run `pnpm --dir apps/mobile typecheck` and confirm TypeScript reports no errors.**
- [x] **Step 4: Inspect `git diff --check` and `git status --short` to confirm the patch is clean and limited to the approved scope.**

### Task 4: Restore Appium coverage for the removed diagnostics card

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.test.ts`

- [x] **Step 1: Add a failing helper test that requires the More tab to be clicked, the More-screen marker to be displayed, and the legacy `mobile.update-info.ota` element to be absent.**
- [x] **Step 2: Run `pnpm --dir apps/mobile test -- e2e/specs/smoke/profile-connection.test.ts` and confirm the new test fails because the helper is not implemented.**
- [x] **Step 3: Add the stable More-screen test id, selectors, Appium helper, and smoke invocation needed to satisfy the test.**
- [x] **Step 4: Run `pnpm --dir apps/mobile test -- e2e/specs/smoke/profile-connection.test.ts src/screens/MoreScreen.test.tsx` and confirm both regression layers pass.**
- [x] **Step 5: Run `pnpm --dir apps/mobile typecheck`, evaluate whether the managed Appium environment is available, and run the smoke when available.**
- [x] **Step 6: Run `git diff --check` and inspect `git status --short` before handoff.**

No commit step is included because this Kanna stage explicitly leaves committing to the later workflow transition.

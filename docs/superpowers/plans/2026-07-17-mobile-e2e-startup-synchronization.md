# Mobile E2E Startup Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the profile-disconnected mobile E2E runner survive an Expo dev menu that appears after a cold Metro bundle.

**Architecture:** Keep startup coordination in the mobile E2E runner. Replace one-shot overlay probes with a bounded WebdriverIO condition wait that handles transient native overlays and succeeds only when the Kanna app shell is displayed.

**Tech Stack:** TypeScript, WebdriverIO/Appium, Vitest, Expo development client

---

### Task 1: Reproduce delayed overlay ordering in a unit test

**Files:**
- Modify: `apps/mobile/e2e/run.test.ts`
- Test: `apps/mobile/e2e/run.test.ts`

- [x] Add a fake WebdriverIO driver that advances through an empty initial UI state, a late Expo dev-menu state, and an app-shell state after the menu is dismissed.
- [x] Call the exported startup readiness helper and assert that it polls past the initial state, clicks the late close control, and observes the app shell before returning.
- [x] Run `pnpm --dir apps/mobile exec vitest run e2e/run.test.ts` and confirm the new test fails because the helper is not exported or does not yet wait through the delayed state.

### Task 2: Implement condition-driven startup readiness

**Files:**
- Modify: `apps/mobile/e2e/run.ts`
- Test: `apps/mobile/e2e/run.test.ts`

- [x] Export the startup readiness helper and define a bounded readiness timeout.
- [x] In each condition poll, handle visible onboarding, a visible Expo dev-menu close control or marker fallback, and the recognized Bonjour alert.
- [x] Check `~mobile.app-shell` after overlay handling and return only when it is displayed.
- [x] Replace the existing one-shot startup call with the readiness helper.
- [x] Run `pnpm --dir apps/mobile exec vitest run e2e/run.test.ts` and confirm the regression test and existing runner tests pass.

### Task 3: Verify the revision

**Files:**
- Verify only

- [x] Run `pnpm --dir apps/mobile run test:e2e:profile-disconnected` to completion.
- [x] Run `pnpm test`.
- [x] Run `cd crates/daemon && cargo test -- --test-threads=1`.
- [x] Run `cargo test -p kanna-server -- --test-threads=1`.
- [x] Inspect `git diff --check`, the final diff, and worktree status before reporting completion.

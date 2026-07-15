# Mobile Quick Reply Relay E2E Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on the iOS simulator that a long press on the mobile task Send button opens the native quick-reply menu and submits exactly `SGTM. Proceed.\n\n<trimmed draft>` once through the real relay task-input path.

**Architecture:** Extend the existing relay Appium flow with a focused quick-reply journey helper, and extend the existing scripted terminal fixture with an assertion that observes the exact input after it has crossed `TaskScreen -> App -> mobileController -> remote transport -> server task-input`. The runner supplies the fixture draft and waits for the terminal-side proof, including a single-submission count.

**Tech Stack:** React Native, TypeScript, WebdriverIO/Appium XCUITest, Vitest, Kanna relay/PTY test harness.

---

### Task 1: Define and test the Appium quick-reply journey

**Files:**
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`

- [x] Add a failing Vitest contract test that requires the flow to populate a whitespace-padded draft, long-press Send, wait for `Quick Replies`, select `SGTM. Proceed.`, and wait for an empty native composer value without clicking Send normally.
- [x] Run the focused relay-flow test and confirm it fails because the quick-reply journey helper is absent.
- [x] Implement the smallest exported helper and WebdriverIO element/UI surface needed by both the unit contract and real Appium flow.
- [x] Re-run the focused test and confirm it passes.

### Task 2: Observe exact input and reject duplicate sends

**Files:**
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/run.ts`

- [x] Add a relay fixture expectation containing a padded draft and the exact trimmed quick-reply composition.
- [x] Add a harness assertion that waits for the exact `SCRIPT_INPUT:` terminal marker, briefly allows any duplicate gesture submission to arrive, and rejects any output containing more than one `SCRIPT_INPUT:` marker.
- [x] Replace the relay runner's normal Send click with the real quick-reply Appium journey and wait for the new harness assertion.
- [x] Run the focused E2E unit tests and typecheck.

### Task 3: Verify the revision

**Files:**
- Verify all modified files and the worktree diff.

- [x] Run `pnpm --dir apps/mobile test -- --runInBand`.
- [x] Run `pnpm --dir apps/mobile run typecheck`.
- [x] Check simulator/Appium prerequisites and run `pnpm --dir apps/mobile run test:e2e:relay` without targeting a physical device. The simulator run was attempted twice but could not reach the test: the first attempt never delivered the assigned Metro deep link, and the second Firebase emulator process exited before relay authentication.
- [x] Review the final diff against every reviewer requirement.

# Mobile Terminal Prompt Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reveal the canonical task prompt from the mobile terminal header while retaining the renamed display title in the collapsed state.

**Architecture:** Add an optional `prompt` field to the shared mobile task summary. Populate it from the full LAN database prompt and from the existing cloud `promptSnippet`, prefer LAN prompt data during hybrid merges, and render it in a bounded scrollable `TaskScreen` title chip controlled by one accessible toggle.

**Tech Stack:** Rust/Axum/Serde, React Native 0.79, TypeScript, Vitest, WebdriverIO/Appium, live desktop API fixture data.

---

## File structure

- Modify `crates/kanna-server/src/mobile_api.rs` and route tests to serialize the canonical prompt separately from the display title.
- Modify `apps/mobile/src/lib/api/types.ts`, `apps/mobile/src/lib/firebase/taskIndex.ts`, and `apps/mobile/src/lib/sources/cloudLanClient.ts` to carry the prompt through every task source.
- Modify focused mapping tests with a renamed title and multiline prompt end sentinel.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` and its focused test to render a bounded scrollable prompt with one accessible toggle.
- Modify `apps/mobile/src/e2eTestIds.ts`, Appium selectors, their contract tests, and the list/detail/back smoke journey.
- Keep `tools/kd`, physical-device workflows, native identity, and OTA runtime configuration unchanged.

### Task 1: Preserve canonical prompt data

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Test: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`

- [x] **Step 1: Write failing mapping tests**

Use `display_name = "Short renamed task"` and a multiline prompt ending in `PROMPT_END_SENTINEL`. Assert LAN JSON exposes both `title` and `prompt`, cloud mapping sets `TaskSummary.prompt` from `promptSnippet`, and a hybrid merge replaces a cloud snippet with the LAN prompt.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
cargo test -p kanna-server mobile_prompt -- --nocapture
pnpm --dir apps/mobile test -- src/lib/firebase/taskIndex.test.ts src/lib/sources/cloudLanClient.test.ts
```

Expected: assertions fail because `TaskSummary` does not yet expose `prompt` and the cloud mapper discards `promptSnippet`.

- [x] **Step 3: Implement the minimal contract changes**

Add `prompt: Option<String>` to the Rust `TaskSummary` and `TaskDetail`, populated from `item.prompt`. Add `prompt?: string | null` to the TypeScript `TaskSummary`, map `snapshot.promptSnippet ?? undefined`, and explicitly prefer a non-null LAN prompt in both current and preserved hybrid merge paths.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the commands from Step 2 and confirm the renamed title remains distinct from the prompt through its sentinel.

### Task 2: Specify and implement bounded prompt expansion

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [x] **Step 1: Write failing component and selector tests**

Give the test task `title: "Short renamed task"` and a long multiline `prompt` ending in `PROMPT_END_SENTINEL`. Assert the collapsed text is the short title; after pressing the toggle, the prompt text contains the entire fixture; the expanded `ScrollView` has a finite window-derived `maxHeight`; Back and the title toggle are siblings; text descendants and dismissal layer are not accessible; and title/outside presses collapse.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx src/e2eTestIds.test.ts
```

Expected: the current screen expands `task.title`, has no bounded `ScrollView`, and lacks the prompt selector.

- [x] **Step 3: Implement the minimal presentation**

Import `ScrollView` and `useWindowDimensions`. Compute `expandedPrompt = task.prompt?.trim() || task.title` and cap its scroll viewport at `Math.min(320, windowHeight * 0.45)`. Make the title chip itself the accessible `Pressable`, render non-accessible collapsed title text or expanded prompt text inside it, align top chrome to `flex-start`, and retain the non-accessible dismissal layer below top chrome.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and confirm all existing routing, terminal dimension, activity, and task-switch assertions remain green.

### Task 3: Add simulator Appium coverage

**Files:**
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Test: `apps/mobile/e2e/helpers/selectors.test.ts`
- Modify: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Test: `apps/mobile/e2e/specs/smoke/list-detail-back.test.ts`

- [x] **Step 1: Validate the known task fixture is distinct**

Require the configured real open PTY task to have a short renamed title and a distinct multiline prompt ending in a stable sentinel. Extend the smoke fixture validation with the exact display title and prompt sentinel returned by `/v1/tasks/{id}`. The existing runner cannot manufacture this fixture because task creation starts a real agent CLI and cannot deterministically control its terminal snapshot; the caller provisions it and supplies `KANNA_E2E_PTY_TASK_ID` and `KANNA_E2E_PTY_SENTINEL`.

- [x] **Step 2: Write failing selector and journey tests**

Pin `taskTitleButton`, `taskExpandedPrompt`, and `taskTitleDismissLayer`. Add a fake-UI contract test proving the journey presses the title, observes the prompt sentinel, presses the outside layer, observes collapse, and finally presses Back.

- [x] **Step 3: Implement the Appium journey**

After terminal rendering, tap the title toggle, wait until the expanded prompt element exposes the sentinel, assert Back still exists, collapse through the outside layer, wait for the expanded prompt to disappear, and use Back to return to the task list.

- [x] **Step 4: Run focused contract tests**

```bash
pnpm --dir apps/mobile test -- src/e2eTestIds.test.ts e2e/helpers/selectors.test.ts e2e/specs/smoke/list-detail-back.test.ts
```

Expected: all selector and smoke contract tests pass.

### Task 4: Verify the revision

**Files:**
- Review: every file changed from `4789aeb1`

- [x] **Step 1: Run required automated checks**

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx src/e2eTestIds.test.ts e2e/helpers/selectors.test.ts e2e/specs/smoke/list-detail-back.test.ts src/lib/firebase/taskIndex.test.ts
pnpm --dir apps/mobile typecheck
cargo test -p kanna-server
pnpm test
git diff --check
```

- [x] **Step 2: Run the canonical simulator smoke**

```bash
./kd dev up --mobile
pnpm --dir apps/mobile run test:e2e:smoke
```

Use only the simulator target. Record any environment blocker with the exact command/output; do not substitute physical-device Appium. The revision run reached XCUITest and then stopped at the expected real-fixture guard because the isolated worktree database was empty and `KANNA_E2E_PTY_TASK_ID` was not provisioned; see `apps/mobile/e2e/terminal-streaming-coverage.md`.

- [x] **Step 3: Audit scope**

```bash
git diff --name-only 4789aeb1...HEAD
git diff --name-only 4789aeb1
```

Confirm no `tools/kd` or kd physical-device plan/spec/documentation file appears and no unrelated daemon code changed.

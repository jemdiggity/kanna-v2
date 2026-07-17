# Mobile Repo Command Review Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate current main and make repository commands preserve canonical task metadata, route empty repositories to their owning desktop, keep stable server command IDs, and exercise the real mobile launch path.

**Architecture:** The composed mobile client will retain repository-source provenance from successful LAN repository reads and consult it before task-derived routing. The controller will treat command launch as `run -> refresh canonical collections -> open canonical task`, with errors stopping navigation. UI and E2E changes will preserve main's task-action, pressed-feedback, accessibility, search-focus, optimistic-creation, terminal-replay, and OTA-removal behavior.

**Tech Stack:** TypeScript, React Native, Vue 3, Vitest, WebdriverIO/Appium, Rust/Axum, pnpm, Cargo.

---

### Task 1: Integrate current main

**Files:**
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.test.tsx`

- [ ] Merge `origin/main` into the current branch and inspect every conflict against both sides.
- [ ] Resolve `App.tsx` by retaining main's task-scoped actions, search-focus request, optimistic task slots, terminal replay inputs, and OTA-removal behavior while wiring the repository-command More screen.
- [ ] Resolve `MoreScreen.tsx` and its test by retaining repository selection/grouping and main's functional pressed styles and stable accessibility IDs.
- [ ] Run the merged focused More/App tests and confirm the retained behavior.

### Task 2: Refresh canonical task collections before opening a command task

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`

- [ ] Add a failing test whose event log proves `runRepoCommand`, canonical refresh reads, and `openTask` happen in that order, and whose refreshed task metadata differs from the command label/description.
- [ ] Add a failing error test proving a failed refresh records the error, does not open the task, and clears the running-command state.
- [ ] Remove the hard-coded `TaskSummary` insertion and await the existing canonical refresh path before calling `openTask(response.taskId)`.
- [ ] Run the focused controller tests until green.

### Task 3: Preserve repository ownership without task rows

**Files:**
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts`

- [ ] Add a failing composed-client test where LAN lists a repository, neither source has a task for it, and list/run commands must use that LAN desktop.
- [ ] Add a failing multi-desktop/app-model test proving the selected repository routes through its owning trusted desktop client.
- [ ] Replace anonymous LAN repository caching with a snapshot containing the successful desktop ID and repositories; update provenance only from accepted reads and preserve the existing optional-LAN fallback semantics.
- [ ] Make `routeForRepo` prefer task-derived ownership when present, then repository provenance, then cloud routing.
- [ ] Add/retain transport contract assertions for encoded list/run paths and owner/canonical response fields.
- [ ] Run all affected source, transport, and app-model tests until green.

### Task 4: Preserve server command identity in the desktop palette

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`

- [ ] Add a failing test with two custom commands that share a label but have distinct stable IDs.
- [ ] Map each dynamic command's palette ID directly from `command.id`, without label-derived identity.
- [ ] Run the focused composable test until green.

### Task 5: Cover the real mobile repo-command journey

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts`
- Modify: `apps/mobile/e2e/specs/smoke/profile-connection.test.ts`

- [ ] Add failing helper tests for the event sequence: open More, select the seeded repository, observe grouped factory commands, launch the safe create-agent command, wait for task detail, and assert the canonical returned task appears in the task snapshot marker.
- [ ] Expose selectors through production accessibility IDs for repository chips, group headings, and repo commands.
- [ ] Implement the smoke helper using only the real app controls and existing seeded server wiring; preserve OTA absence and task-action journeys.
- [ ] Run the smoke helper unit test and mobile E2E TypeScript checks until green.

### Task 6: Verification

**Files:**
- Verify all modified files and the final merge result.

- [ ] Run `pnpm --dir apps/mobile test -- --runInBand`.
- [ ] Run `pnpm --dir apps/mobile run typecheck`.
- [ ] Run `cargo test -p kanna-server repo_commands -- --nocapture`.
- [ ] Run `git merge-tree --write-tree HEAD origin/main` and require a zero exit code.
- [ ] Run `pnpm test`.
- [ ] Run `(cd crates/daemon && cargo test -- --test-threads=1)`.
- [ ] Run `cargo test -p kanna-server`.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete diff for unrelated changes.

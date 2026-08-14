# Mobile Task Status Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make working, unread, and idle activity transitions reach mobile task cards over LAN and cloud, and make selected unread tasks converge safely to idle.

**Architecture:** Keep structural Firestore reconciliation separate from a bounded per-task activity publisher, serialize the two write paths, and consume Firestore changes through the existing live subscription. Add mark-read to the shared mobile client contract and coordinate it in the controller with a one-second generation guard that updates all task collections only from an authoritative idle response.

**Tech Stack:** Vue 3, TypeScript, React Native, Firestore, Vitest, WebdriverIO/Appium

**Stage constraint:** Do not commit during this revision stage; Kanna advances and commits in later workflow stages.

---

### Task 1: Publish Activity-Only Desktop Changes

**Files:**
- Modify: `apps/desktop/src/utils/cloudTaskFingerprint.ts`
- Test: `apps/desktop/src/utils/cloudTaskFingerprint.test.ts`
- Modify: `apps/desktop/src/services/desktopCloudPublisher.ts`
- Test: `apps/desktop/src/services/desktopCloudPublisher.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Test: `apps/desktop/src/App.test.ts`

- [x] Add a failing fingerprint test proving semantic activity changes alter a dedicated activity key while timestamp churn does not.
- [x] Add failing publisher tests proving a targeted update writes only `{ activity }` and is serialized behind a structural reconcile.
- [x] Add a failing App watcher test proving activity-only changes invoke the targeted publisher and never a full reconcile.
- [x] Implement `computeTaskActivityFingerprint()` over open task id, repo id, and activity.
- [x] Implement serialized cloud writes plus a targeted activity update with authoritative fallback when the cloud task document is not present.
- [x] Add a per-task latest-value queue in `useAppCloudWorkspace`; scope it to auth and publication ownership and clear it on invalidation.
- [x] Run the three focused desktop test files and confirm green.

### Task 2: Route Mark-Read Through Mobile Clients

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify/Test: `apps/mobile/src/lib/api/client.ts`, `apps/mobile/src/lib/api/client.test.ts`
- Modify/Test: `apps/mobile/src/lib/transports/lanTransport.ts`, `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify/Test: `apps/mobile/src/lib/transports/remoteTransport.ts`, `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify/Test: `apps/mobile/src/appModel.ts`, `apps/mobile/src/appModel.cloudFallback.test.ts`

- [x] Add failing forwarding and routing tests for LAN, selected remote desktop, and cloud owner/local task identity.
- [x] Define `TaskActivityResponse` and required `markTaskRead(taskId)` methods on `KannaTransport` and `KannaClient`.
- [x] Implement the exact LAN POST route and reuse `requestTask()` for relay routing.
- [x] Forward the method through disconnected, delegating, trusted-LAN, and cloud-with-LAN-fallback clients.
- [x] Run client and transport tests and confirm green.

### Task 3: Match the Desktop Unread Lifecycle

**Files:**
- Modify/Test: `apps/mobile/src/state/sessionStore.ts`, `apps/mobile/src/state/sessionStore.test.ts`
- Modify/Test: `apps/mobile/src/state/mobileController.ts`, `apps/mobile/src/state/mobileController.test.ts`

- [x] Add a failing store test for atomically changing one task's activity in repo, recent, and search collections.
- [x] Add failing controller tests for opening unread, becoming unread through an activity-only LAN poll, live-cloud unread, and stale selection/activity races.
- [x] Implement `setTaskActivity()` with one store publication.
- [x] Implement a one-second visible-task generation coordinator with cross-collection agreement, bounded nonfatal retries, and pre/post response guards.
- [x] Run controller/store tests and confirm green.

### Task 4: Cover the Live Subscription and Rendered Card

**Files:**
- Modify/Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts`
- Modify/Test: `apps/mobile/src/components/TaskCard.tsx`, `apps/mobile/src/components/TaskCard.test.tsx`
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify/Test: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`, `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/run.ts`
- Create: `apps/mobile/e2e/task-activity-coverage.md`

- [x] Add a failing live-subscription test that emits the same Firestore task with only activity changing through working, unread, and idle.
- [x] Preserve the exact title font assertions and add a failing assertion for normalized `accessibilityValue.text`.
- [x] Fix the relay fixture to use `status: active` plus `activity: working`, and expose a PATCH helper whose update mask contains only activity.
- [x] Add relay-flow helper coverage for working -> unread -> idle and real relay mark-read, then implement native row/detail value polling.
- [x] Document why XCUITest cannot inspect React Native font traits and the narrower typography proof.
- [x] Run all focused mobile tests and typecheck.

### Task 5: Harden Publication and Read Races

**Files:** desktop publication/lease files, mobile controller/task-index/remote transport files

- [x] Coalesce structural publication, retry failures with bounded backoff, and distinguish desired from successfully published state.
- [x] Elect one desktop publisher with an exclusive Web Lock, queued-window handoff, crash release, and drain-before-voluntary-release ordering.
- [x] Prevent close-during-retry activity writes from recreating a closed task.
- [x] Remove the parallel Firestore prime race and ignore callbacks from removed desktop generations.
- [x] Require all visible task copies to agree on unread; cancel hidden/disconnected and stale responses.
- [x] Refresh cloud owner routing before mark-read mutations and cover owner migration.

### Task 6: Integrated Verification and Review

**Files:** all modified revision files

- [x] Run the exact focused mobile and desktop commands from the review request.
- [x] Run `pnpm --dir apps/mobile run test:e2e:relay`; capture the concrete preflight blocker that `build.kanna.app` is not installed on the selected iPhone 17 Pro simulator.
- [x] Run `pnpm test`, daemon tests, and `git diff --check`; after rebasing onto PR #812, the monorepo gate completed all 15/15 tasks successfully.
- [x] Inspect the final diff against every review requirement and complete independent mobile and desktop code reviews with no critical or important findings.

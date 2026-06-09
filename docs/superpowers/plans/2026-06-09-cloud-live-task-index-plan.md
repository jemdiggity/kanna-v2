# Cloud Live Task Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Firestore a live metadata index for currently open local tasks, using auto-generated document IDs and deleting cloud metadata when local tasks close.

**Architecture:** Move desktop cloud writes/deletes to Firestore SDK helpers that identify task documents by `ownerDesktopId + localRepoId + ownerLocalTaskId`, not by document id. Reconciliation publishes all currently open local tasks, queries owned cloud docs, deletes stale owned docs, and deduplicates duplicate owned docs. The sidebar cloud reader tolerates legacy deterministic documents but maps by identity fields going forward.

**Tech Stack:** Vue 3 desktop app, Firebase Auth/Firestore JS SDK, Pinia store, `@kanna/db` query helpers, Vitest, Kanna real E2E cloud sync harness.

---

## File Structure

- Modify `apps/desktop/src/utils/cloudTaskSnapshot.ts`
  - Add `localRepoId` to snapshot payloads while retaining `cloudTaskId` as a legacy compatibility field during migration.
- Modify `apps/desktop/src/services/desktopCloudPublisher.ts`
  - Replace Cloud Function-only publish/delete behavior with Firestore SDK publish, delete, and reconcile helpers.
  - Keep auth/config/desktop-id resolution in one place.
- Modify `apps/desktop/src/services/desktopCloudTaskIndex.ts`
  - Read auto-id documents and map `localRepoId`/`ownerLocalTaskId`; tolerate legacy documents that only have `cloudTaskId`/`repo.cloudRepoId`.
- Modify `apps/desktop/src/App.vue`
  - Replace startup `publishDesktopTaskSnapshots(... closedSinceDays)` with live-index reconciliation.
  - Replace remote-close tombstone publish with metadata deletion.
- Modify `apps/desktop/src/stores/tasks.ts`
  - Local close already calls `publishTaskSnapshotBestEffort`; update the helper implementation it uses so closed rows delete metadata.
- Modify tests:
  - `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`
  - `apps/desktop/src/services/desktopCloudPublisher.test.ts`
  - `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`
  - `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`

## Task 1: Snapshot Identity Fields

**Files:**
- Modify: `apps/desktop/src/utils/cloudTaskSnapshot.ts`
- Test: `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`

- [ ] **Step 1: Add failing test for `localRepoId`**

Add an assertion to the existing snapshot test:

```ts
expect(snapshot).toMatchObject({
  localRepoId: "repo-1",
  ownerLocalTaskId: "task-1",
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
pnpm --dir apps/desktop test -- src/utils/cloudTaskSnapshot.test.ts
```

Expected: FAIL because `localRepoId` is not present.

- [ ] **Step 3: Add `localRepoId` to the snapshot**

In `buildCloudTaskSnapshot`, include:

```ts
localRepoId: input.repo.id,
```

Keep `cloudTaskId: `${input.repo.id}:${input.item.id}`` for migration compatibility.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --dir apps/desktop test -- src/utils/cloudTaskSnapshot.test.ts
```

Expected: PASS.

## Task 2: Firestore Publisher, Delete, and Reconcile

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudPublisher.ts`
- Test: `apps/desktop/src/services/desktopCloudPublisher.test.ts`

- [ ] **Step 1: Write publisher tests**

Add tests that mock Firestore SDK functions and prove:

```ts
await publishDesktopTaskSnapshot(db, openItem, repo);
expect(mocks.addDoc).toHaveBeenCalled(); // when identity query returns empty

await publishDesktopTaskSnapshot(db, openItem, repo);
expect(mocks.updateDoc).toHaveBeenCalled(); // when identity query returns an existing doc

await publishDesktopTaskSnapshot(db, closedItem, repo);
expect(mocks.deleteDoc).toHaveBeenCalled(); // close deletes matching cloud metadata
```

Also add a reconciliation test:

```ts
await reconcileDesktopTaskSnapshots(db);
expect(mocks.deleteDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "stale-doc" }));
expect(mocks.deleteDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "duplicate-old" }));
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopCloudPublisher.test.ts
```

Expected: FAIL because Firestore SDK helpers and reconciliation do not exist.

- [ ] **Step 3: Implement Firestore writes**

In `desktopCloudPublisher.ts`, import:

```ts
import {
  addDoc,
  collection,
  deleteDoc,
  getDocs,
  query,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
```

Use `getConfiguredDesktopFirestore()` from `desktopCloudTaskIndex.ts`.

Implement identity query:

```ts
function taskIdentityQuery(tasksRef, desktopId: string, localRepoId: string, ownerLocalTaskId: string) {
  return query(
    tasksRef,
    where("ownerDesktopId", "==", desktopId),
    where("localRepoId", "==", localRepoId),
    where("ownerLocalTaskId", "==", ownerLocalTaskId),
  );
}
```

For open items, query identity docs. If no docs exist, `addDoc(tasksRef, snapshot)`. If docs exist, `updateDoc(first.ref, snapshot)` and delete duplicate refs.

For closed items, delete all docs matching identity and return without publishing.

- [ ] **Step 4: Implement reconciliation**

Create:

```ts
export async function reconcileDesktopTaskSnapshots(db: DbHandle): Promise<void>
```

Behavior:

1. Resolve auth/firestore/config/desktop id.
2. Load repos with `listRepos(db)`.
3. For each repo, call `listPipelineItems(db, repo.id)`; this intentionally returns open tasks only.
4. Publish each open task.
5. Query owned docs: `where("ownerDesktopId", "==", desktopId)`.
6. Delete docs whose `localRepoId:ownerLocalTaskId` key is absent from the open set.
7. For duplicate keys, keep the doc with greatest `updatedAt`, delete the rest.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopCloudPublisher.test.ts
```

Expected: PASS.

## Task 3: Cloud Reader Auto-ID Compatibility

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Test: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`

- [ ] **Step 1: Add reader tests for auto-id docs**

Add a test that passes a snapshot with:

```ts
{
  localRepoId: "local-repo",
  ownerDesktopId: "desktop-owner",
  ownerLocalTaskId: "task-1",
  cloudTaskId: undefined,
  repo: { cloudRepoId: "legacy-repo", remoteUrlHash: "same-remote", name: "kanna" }
}
```

Expect mapped task id to be stable and remote:

```ts
expect(snapshot.items[0]).toMatchObject({
  id: "cloud:desktop-owner:local-repo:task-1",
  repo_id: "local-repo",
});
expect(snapshot.terminalRefs["cloud:desktop-owner:local-repo:task-1"]).toEqual({
  ownerDesktopId: "desktop-owner",
  ownerLocalTaskId: "task-1",
  transport: "cloud",
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopCloudTaskIndex.test.ts
```

Expected: FAIL because `localRepoId` is not read and id still derives from `cloudTaskId`.

- [ ] **Step 3: Implement identity mapping**

Extend `DesktopCloudTaskSnapshot`:

```ts
cloudTaskId?: string;
localRepoId?: string;
closedAt?: string | null;
```

Resolve identity:

```ts
const ownerLocalTaskId = snapshot.ownerLocalTaskId;
const localRepoId = snapshot.localRepoId ?? snapshot.repo.cloudRepoId;
const itemId = snapshot.cloudTaskId
  ? cloudTaskId(snapshot.cloudTaskId)
  : `cloud:${snapshot.ownerDesktopId}:${localRepoId}:${ownerLocalTaskId}`;
```

Use `localRepoId` for exact local repo matching before falling back to remote URL hash.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopCloudTaskIndex.test.ts
```

Expected: PASS.

## Task 4: App Wiring

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Test: `apps/desktop/src/App.test.ts` if existing mocks need assertion updates

- [ ] **Step 1: Replace startup reconciliation call**

Change import:

```ts
import { reconcileDesktopTaskSnapshots, deleteRemoteTaskSnapshots } from "./services/desktopCloudPublisher";
```

Replace:

```ts
publishDesktopTaskSnapshots(db, { closedSinceDays: 30 })
```

with:

```ts
reconcileDesktopTaskSnapshots(db)
```

- [ ] **Step 2: Replace remote close tombstone helper**

Rename `publishRemoteCloseTombstones` to `deleteRemoteCloudTaskMetadata` and call:

```ts
void deleteRemoteTaskSnapshots({
  ownerDesktopId: source.terminalRef.ownerDesktopId,
  localRepoId: workspaceTask.item.repo_id,
  ownerLocalTaskId: source.terminalRef.ownerLocalTaskId,
}).catch((error) => {
  console.warn("[cloud] failed to delete remote task metadata:", error);
});
```

For legacy cloud snapshots lacking `localRepoId`, use the workspace repo key or legacy `repo.cloudRepoId` fallback carried by the mapped item.

- [ ] **Step 3: Verify app tests/build**

Run:

```bash
pnpm --dir apps/desktop test -- src/App.test.ts src/services/desktopCloudPublisher.test.ts src/services/desktopCloudTaskIndex.test.ts
pnpm --dir apps/desktop run build
```

Expected: PASS.

## Task 5: E2E Cloud Close Regression

**Files:**
- Modify: `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`

- [ ] **Step 1: Keep the refresh-after-close regression assertion**

Keep the existing behavior:

```ts
await waitForSidebarTaskToDisappear(secondary, "Cloud sync visible task");
await waitForCloudTaskToStayGoneAfterRefresh(secondary, "Cloud sync visible task");
```

The second assertion must clear `locallyClosedRemoteTaskIds`, refresh cloud, and require zero matching cloud snapshot items.

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: PASS.

## Task 6: Final Verification and Commit

**Files:**
- All modified implementation and test files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm --dir apps/desktop test -- src/utils/cloudTaskSnapshot.test.ts src/services/desktopCloudPublisher.test.ts src/services/desktopCloudTaskIndex.test.ts src/App.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run DB/runtime tests affected by earlier closed-row guard**

Run:

```bash
pnpm --dir packages/db test -- queries.test.ts
pnpm --dir apps/desktop test -- src/stores/kanna.runtimeStatusSync.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm --dir apps/desktop run build
```

Expected: PASS with only existing Vite chunk warnings.

- [ ] **Step 4: Commit**

Commit all intended implementation changes:

```bash
git add apps/desktop/src apps/desktop/tests/e2e/real/cloud-task-sync.test.ts packages/db/src Cargo.lock
git commit -m "fix: make cloud task metadata a live index"
```

Do not stage unrelated local work outside this task.

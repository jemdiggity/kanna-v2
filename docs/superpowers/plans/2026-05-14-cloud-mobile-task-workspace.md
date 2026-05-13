# Cloud Mobile Task Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first cloud-backed mobile task workspace slice: signed-in mobile reads cloud-indexed tasks across desktops and routes task actions to the current owner desktop.

**Architecture:** Desktop remains authoritative and publishes lightweight task snapshots to Firestore. Mobile uses Firestore for the signed-in task list and the relay for owner-routed actions. Transfer data structures are added now, but full cloud Push/Pull UI is kept out of this first vertical slice.

**Tech Stack:** Firebase Functions v2, Firestore emulator/rules tests, TypeScript, React Native/Expo mobile app, Vitest, existing relay WebSocket service, existing desktop Pinia store.

---

## Scope Check

The approved spec covers several subsystems: Firebase, relay, desktop sync, mobile cloud transport, and cloud-brokered transfer. Implementing all transfer UI and artifact movement in one patch would be too broad. This plan implements the first working vertical slice and leaves the existing local Push to Machine behavior unchanged.

Included:

- Cloud task snapshot types and validation.
- Function-mediated desktop task snapshot upsert.
- Firestore rules for user-scoped reads and no direct client task writes.
- Mobile cloud task index reader.
- Mobile app model switches to cloud transport after sign-in.
- Relay request routing remains by explicit `desktopId`.
- Desktop snapshot mapper and publisher entry point.

Not included in this first plan:

- New desktop Push/Pull cloud UI.
- Cloud artifact storage for bundles/session archives.
- Offline mutation queueing.

## File Structure

- Create `services/firebase-functions/src/taskSnapshots.ts`: pure validation and Firestore write helpers for cloud task snapshots.
- Modify `services/firebase-functions/src/index.ts`: export HTTP endpoint `upsertTaskSnapshot`.
- Modify `services/firebase-functions/src/types.ts`: shared cloud task and transfer types.
- Modify `services/firebase-functions/test/firestore-rules.test.ts`: rules coverage for user reads and blocked direct writes.
- Create `services/firebase-functions/test/taskSnapshots.test.ts`: validation and function helper tests.
- Create `apps/mobile/src/lib/firebase/taskIndex.ts`: Firestore task index reader and mapper.
- Create `apps/mobile/src/lib/firebase/taskIndex.test.ts`: mobile mapping tests.
- Modify `apps/mobile/src/appModel.ts`: build cloud transport as the signed-in default when Firebase and relay config are present.
- Modify `apps/mobile/src/state/mobileController.ts`: connect cloud after sign-in and refresh cloud task collections.
- Modify `apps/mobile/src/state/mobileController.test.ts`: cloud bootstrap/sign-in behavior.
- Create `apps/desktop/src/utils/cloudTaskSnapshot.ts`: map local repo/task rows to cloud snapshot payloads.
- Create `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`: snapshot mapper tests.
- Modify `apps/desktop/src/stores/kanna.ts`: call snapshot publishing after relevant local task changes through a small service hook.
- Create `apps/desktop/src/services/cloudTaskPublisher.ts`: HTTP client for `upsertTaskSnapshot`.
- Create `apps/desktop/src/services/cloudTaskPublisher.test.ts`: publisher request tests.
- Modify `services/relay/test/integration.test.ts`: add owner-routed task action isolation test.

## Task 1: Firebase Cloud Task Snapshot Contract

**Files:**
- Modify: `services/firebase-functions/src/types.ts`
- Create: `services/firebase-functions/src/taskSnapshots.ts`
- Test: `services/firebase-functions/test/taskSnapshots.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `services/firebase-functions/test/taskSnapshots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildTaskSnapshotWrite,
  validateTaskSnapshotInput,
} from "../src/taskSnapshots.js";

describe("task snapshot validation", () => {
  it("accepts a minimal owner-routable task snapshot", () => {
    const input = {
      cloudTaskId: "cloud-task-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      title: "Fix mobile cloud",
      promptSnippet: "Fix mobile cloud",
      displayName: null,
      stage: "in progress",
      activity: "working",
      status: "active",
      repo: {
        cloudRepoId: "repo-hash-1",
        name: "kanna",
        remoteUrlHash: "remote-hash-1",
        defaultBranch: "main",
      },
      branch: "task-1",
      baseRef: "origin/main",
      prNumber: null,
      prUrl: null,
      agent: {
        provider: "claude",
        type: "pty",
      },
      transfer: {
        state: "none",
        transferId: null,
        sourceDesktopId: null,
        destinationDesktopId: null,
      },
      blockedByTaskIds: [],
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:01:00.000Z",
      closedAt: null,
    };

    expect(validateTaskSnapshotInput(input)).toEqual(input);
    expect(buildTaskSnapshotWrite("user-1", input)).toMatchObject({
      path: "users/user-1/tasks/cloud-task-1",
      data: {
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Fix mobile cloud",
      },
    });
  });

  it("rejects snapshots that do not route to an owner desktop", () => {
    expect(() =>
      validateTaskSnapshotInput({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "",
        ownerLocalTaskId: "task-1",
      })
    ).toThrow("ownerDesktopId is required");
  });

  it("rejects oversized prompt snippets", () => {
    expect(() =>
      validateTaskSnapshotInput({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Task",
        promptSnippet: "x".repeat(501),
      })
    ).toThrow("promptSnippet must be 500 characters or fewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/firebase-functions test -- taskSnapshots.test.ts
```

Expected: fail because `src/taskSnapshots.ts` does not exist.

- [ ] **Step 3: Add shared types**

Add to `services/firebase-functions/src/types.ts`:

```ts
export type CloudTaskActivity = "idle" | "working" | "unread";
export type CloudTaskStatus =
  | "active"
  | "blocked"
  | "pr"
  | "merge"
  | "done"
  | "transferring";
export type CloudTaskTransferState =
  | "none"
  | "outgoing"
  | "incoming"
  | "finalization_pending";

export interface CloudTaskSnapshot {
  cloudTaskId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  displayName: string | null;
  stage: string;
  activity: CloudTaskActivity;
  status: CloudTaskStatus;
  repo: {
    cloudRepoId: string;
    name: string;
    remoteUrlHash: string | null;
    defaultBranch: string | null;
  };
  branch: string | null;
  baseRef: string | null;
  prNumber: number | null;
  prUrl: string | null;
  agent: {
    provider: "claude" | "copilot";
    type: string;
  };
  transfer: {
    state: CloudTaskTransferState;
    transferId: string | null;
    sourceDesktopId: string | null;
    destinationDesktopId: string | null;
  };
  blockedByTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
```

- [ ] **Step 4: Implement validation helper**

Create `services/firebase-functions/src/taskSnapshots.ts`:

```ts
import type { CloudTaskSnapshot } from "./types.js";

const ACTIVITIES = new Set(["idle", "working", "unread"]);
const STATUSES = new Set(["active", "blocked", "pr", "merge", "done", "transferring"]);
const TRANSFER_STATES = new Set(["none", "outgoing", "incoming", "finalization_pending"]);

export interface TaskSnapshotWrite {
  path: string;
  data: CloudTaskSnapshot;
}

export function validateTaskSnapshotInput(input: unknown): CloudTaskSnapshot {
  const record = requireRecord(input, "snapshot");
  const snapshot: CloudTaskSnapshot = {
    cloudTaskId: requireString(record, "cloudTaskId"),
    ownerDesktopId: requireString(record, "ownerDesktopId"),
    ownerLocalTaskId: requireString(record, "ownerLocalTaskId"),
    title: requireString(record, "title"),
    promptSnippet: nullableString(record.promptSnippet, "promptSnippet"),
    displayName: nullableString(record.displayName, "displayName"),
    stage: requireString(record, "stage"),
    activity: enumString(record.activity, ACTIVITIES, "activity") as CloudTaskSnapshot["activity"],
    status: enumString(record.status, STATUSES, "status") as CloudTaskSnapshot["status"],
    repo: validateRepo(record.repo),
    branch: nullableString(record.branch, "branch"),
    baseRef: nullableString(record.baseRef, "baseRef"),
    prNumber: nullableNumber(record.prNumber, "prNumber"),
    prUrl: nullableString(record.prUrl, "prUrl"),
    agent: validateAgent(record.agent),
    transfer: validateTransfer(record.transfer),
    blockedByTaskIds: stringArray(record.blockedByTaskIds, "blockedByTaskIds"),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
    closedAt: nullableString(record.closedAt, "closedAt"),
  };

  if (snapshot.promptSnippet && snapshot.promptSnippet.length > 500) {
    throw new Error("promptSnippet must be 500 characters or fewer");
  }

  return snapshot;
}

export function buildTaskSnapshotWrite(
  uid: string,
  input: unknown
): TaskSnapshotWrite {
  const snapshot = validateTaskSnapshotInput(input);
  return {
    path: `users/${uid}/tasks/${snapshot.cloudTaskId}`,
    data: snapshot,
  };
}

function validateRepo(value: unknown): CloudTaskSnapshot["repo"] {
  const record = requireRecord(value, "repo");
  return {
    cloudRepoId: requireString(record, "cloudRepoId"),
    name: requireString(record, "name"),
    remoteUrlHash: nullableString(record.remoteUrlHash, "remoteUrlHash"),
    defaultBranch: nullableString(record.defaultBranch, "defaultBranch"),
  };
}

function validateAgent(value: unknown): CloudTaskSnapshot["agent"] {
  const record = requireRecord(value, "agent");
  const provider = enumString(record.provider, new Set(["claude", "copilot"]), "agent.provider");
  return {
    provider: provider as CloudTaskSnapshot["agent"]["provider"],
    type: requireString(record, "type"),
  };
}

function validateTransfer(value: unknown): CloudTaskSnapshot["transfer"] {
  const record = requireRecord(value, "transfer");
  return {
    state: enumString(record.state, TRANSFER_STATES, "transfer.state") as CloudTaskSnapshot["transfer"]["state"],
    transferId: nullableString(record.transferId, "transfer.transferId"),
    sourceDesktopId: nullableString(record.sourceDesktopId, "transfer.sourceDesktopId"),
    destinationDesktopId: nullableString(record.destinationDesktopId, "transfer.destinationDesktopId"),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number or null`);
  }
  return value;
}

function enumString(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
pnpm --dir services/firebase-functions test -- taskSnapshots.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add services/firebase-functions/src/types.ts services/firebase-functions/src/taskSnapshots.ts services/firebase-functions/test/taskSnapshots.test.ts
git commit -m "feat: add cloud task snapshot contract"
```

## Task 2: Firebase Snapshot Upsert Endpoint And Rules

**Files:**
- Modify: `services/firebase-functions/src/index.ts`
- Modify: `firestore.rules`
- Test: `services/firebase-functions/test/firestore-rules.test.ts`

- [ ] **Step 1: Write failing rules test**

Append to `services/firebase-functions/test/firestore-rules.test.ts` using the existing REST emulator helpers:

```ts
it("allows users to read their own task snapshots but blocks direct task writes", async () => {
  await seedDoc("users/user-1/tasks/cloud-task-1", {
    cloudTaskId: "cloud-task-1",
    ownerDesktopId: "desktop-1",
    ownerLocalTaskId: "task-1",
    title: "Cloud task",
  });

  await expectSucceeds(readDoc(mockUserToken("user-1"), "users/user-1/tasks/cloud-task-1"));
  await expectDenied(readDoc(mockUserToken("user-2"), "users/user-1/tasks/cloud-task-1"));
  await expectDenied(
    clientUpdate("user-1", "users/user-1/tasks/cloud-task-2", { title: "spoofed" })
  );
});
```

- [ ] **Step 2: Run rules test to verify it fails**

Run:

```bash
pnpm --dir services/firebase-functions test -- firestore-rules.test.ts
```

Expected: fail until `users/{uid}/tasks/{taskId}` rules exist.

- [ ] **Step 3: Update Firestore rules**

In `firestore.rules`, add inside the `service cloud.firestore` match tree:

```txt
match /users/{uid}/tasks/{taskId} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false;
}

match /users/{uid}/transfers/{transferId} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false;
}
```

- [ ] **Step 4: Add endpoint**

In `services/firebase-functions/src/index.ts`, import Firebase Auth and the helper:

```ts
import { getAuth } from "firebase-admin/auth";
import { buildTaskSnapshotWrite } from "./taskSnapshots.js";
```

Add this helper near `ensureFirebaseApp()`:

```ts
async function requireBearerUidFromHeader(
  authorization: string | undefined
): Promise<string> {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Missing bearer token");
  }

  ensureFirebaseApp();
  const decoded = await getAuth().verifyIdToken(match[1]!);
  return decoded.uid;
}
```

Add endpoint:

```ts
export const upsertTaskSnapshot = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let uid: string;
  try {
    uid = await requireBearerUidFromHeader(request.header("authorization"));
  } catch (error) {
    response.status(401).json({
      error: error instanceof Error ? error.message : "Unauthorized",
    });
    return;
  }

  try {
    const write = buildTaskSnapshotWrite(uid, request.body);
    ensureFirebaseApp();
    await getFirestore().doc(write.path).set(write.data, { merge: true });
    response.status(200).json({ ok: true, cloudTaskId: write.data.cloudTaskId });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid task snapshot",
    });
  }
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir services/firebase-functions test -- taskSnapshots.test.ts firestore-rules.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add firestore.rules services/firebase-functions/src/index.ts services/firebase-functions/test/firestore-rules.test.ts
git commit -m "feat: expose cloud task snapshot upsert"
```

## Task 3: Mobile Cloud Task Index Reader

**Files:**
- Create: `apps/mobile/src/lib/firebase/taskIndex.ts`
- Test: `apps/mobile/src/lib/firebase/taskIndex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/mobile/src/lib/firebase/taskIndex.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapCloudTaskSnapshot, sortCloudTasks } from "./taskIndex";

describe("cloud task index", () => {
  it("maps cloud snapshots into mobile task summaries", () => {
    expect(
      mapCloudTaskSnapshot({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Fix mobile cloud",
        promptSnippet: "Fix mobile cloud",
        displayName: "Mobile cloud",
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: { cloudRepoId: "repo-1", name: "kanna", remoteUrlHash: null, defaultBranch: "main" },
        branch: "task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "claude", type: "pty" },
        transfer: { state: "none", transferId: null, sourceDesktopId: null, destinationDesktopId: null },
        blockedByTaskIds: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      })
    ).toEqual({
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Mobile cloud",
      stage: "in progress",
      snippet: "Fix mobile cloud",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: false,
    });
  });

  it("sorts newest updated cloud tasks first", () => {
    const tasks = sortCloudTasks([
      { id: "old", updatedAt: "2026-05-14T00:00:00.000Z" },
      { id: "new", updatedAt: "2026-05-14T00:02:00.000Z" },
    ]);

    expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- taskIndex.test.ts
```

Expected: fail because `taskIndex.ts` does not exist.

- [ ] **Step 3: Implement mapper**

Create `apps/mobile/src/lib/firebase/taskIndex.ts`:

```ts
import {
  collection,
  getDocs,
  getFirestore,
  query,
  where,
  type Firestore
} from "firebase/firestore";
import type { TaskSummary } from "../api/types";

export interface CloudTaskSnapshot {
  cloudTaskId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  displayName: string | null;
  stage: string;
  status: string;
  repo: { cloudRepoId: string; name: string };
  updatedAt: string;
  closedAt: string | null;
}

export interface CloudTaskSummary extends TaskSummary {
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  ownerOnline: boolean;
}

export function mapCloudTaskSnapshot(snapshot: CloudTaskSnapshot): CloudTaskSummary {
  return {
    id: snapshot.cloudTaskId,
    repoId: snapshot.repo.cloudRepoId,
    title: snapshot.displayName ?? snapshot.title,
    stage: snapshot.stage,
    snippet: snapshot.promptSnippet ?? undefined,
    ownerDesktopId: snapshot.ownerDesktopId,
    ownerLocalTaskId: snapshot.ownerLocalTaskId,
    ownerOnline: false,
  };
}

export interface CloudTaskIndex {
  listRecentTasks(uid: string): Promise<CloudTaskSummary[]>;
}

export function createFirestoreTaskIndex(
  db: Firestore = getFirestore()
): CloudTaskIndex {
  return {
    async listRecentTasks(uid) {
      const tasksRef = collection(db, "users", uid, "tasks");
      const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
      return sortCloudTasks(
        snapshot.docs.map((doc) => doc.data() as CloudTaskSnapshot)
      ).map(mapCloudTaskSnapshot);
    },
  };
}

export function sortCloudTasks<T extends { updatedAt: string }>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
```

- [ ] **Step 4: Run test**

Run:

```bash
pnpm --dir apps/mobile test -- taskIndex.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/firebase/taskIndex.ts apps/mobile/src/lib/firebase/taskIndex.test.ts
git commit -m "feat: map cloud task index for mobile"
```

## Task 4: Mobile Cloud Transport Selection

**Files:**
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/App.test.tsx`

- [ ] **Step 1: Write failing controller test**

Add to `apps/mobile/src/state/mobileController.test.ts`:

```ts
it("loads task collections from the signed-in cloud client without LAN pairing", async () => {
  const client = createMockClient({
    status: {
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null,
    },
    desktops: [{ id: "desktop-1", name: "MacBook", online: true, mode: "remote" }],
    repos: [{ id: "repo-1", name: "kanna" }],
    recentTasks: [{ id: "cloud-task-1", repoId: "repo-1", title: "Cloud task", stage: "in progress" }],
  });
  const store = createSessionStore();
  const auth = createMockAuthSession({ status: "signedIn", user: { uid: "user-1", email: "u@example.com" } });
  const controller = createMobileController(client, store, auth);

  await controller.bootstrap();

  expect(store.getState()).toMatchObject({
    connectionMode: "remote",
    connectionState: "connected",
    desktopName: "Kanna Cloud",
    recentTasks: [{ id: "cloud-task-1", title: "Cloud task" }],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/mobile test -- mobileController.test.ts
```

Expected: fail because bootstrap always sets `connectionMode` to `lan`.

- [ ] **Step 3: Update controller bootstrap mode**

In `apps/mobile/src/state/mobileController.ts`, change bootstrap mode assignment:

```ts
const resolvedMode = status.lanHost === "cloud" ? "remote" : "lan";
store.setConnectionMode(resolvedMode);
store.setConnectionState("connected");
```

Place it where bootstrap currently calls `store.setConnectionMode("lan")`.

- [ ] **Step 4: Add relay URL resolution in app model**

In `apps/mobile/src/appModel.ts`, add environment field:

```ts
EXPO_PUBLIC_KANNA_RELAY_URL?: string;
```

Add a resolver:

```ts
export function resolveRelayUrl(env: ExpoPublicEnv = readExpoPublicEnv()): string | null {
  const relayUrl = env.EXPO_PUBLIC_KANNA_RELAY_URL?.trim();
  return relayUrl && relayUrl.length > 0 ? relayUrl : null;
}
```

- [ ] **Step 5: Build cloud transport as signed-in default**

In `apps/mobile/src/appModel.ts`, import the existing cloud transport pieces:

```ts
import { createFirestoreTaskIndex } from "./lib/firebase/taskIndex";
import { createRelayDesktopClient } from "./lib/transports/relayClient";
import { createRemoteTransport } from "./lib/transports/remoteTransport";
```

Add cloud transport construction:

```ts
function createClientForMode({
  authSession,
  baseUrl,
  fetchImpl,
  getSelectedDesktopId,
  relayUrl,
}: {
  authSession: MobileAuthSession;
  baseUrl: string;
  fetchImpl: FetchLike;
  getSelectedDesktopId(): string | null;
  relayUrl: string | null;
}): KannaClient {
  const authState = authSession.getState();
  if (authState.status === "signedIn" && relayUrl) {
    const relayClient = createRelayDesktopClient({
      relayUrl,
      getIdToken: (forceRefresh) => authSession.getIdToken(forceRefresh),
    });
    const taskIndex = createFirestoreTaskIndex();
    return createKannaClient(
      createRemoteTransport({
        async listDesktopRecords() {
          return [];
        },
        getSelectedDesktopId,
        invokeDesktop: relayClient.invokeDesktop,
        observeTaskTerminal: relayClient.observeTaskTerminal,
        listCloudTasks: () => taskIndex.listRecentTasks(authState.user.uid),
      })
    );
  }

  return createKannaClient(createLanTransport(baseUrl, fetchImpl));
}
```

Use this factory inside `createAppModel()` so signed-in sessions with `EXPO_PUBLIC_KANNA_RELAY_URL` use cloud transport by default.

Extend `apps/mobile/src/lib/transports/remoteTransport.ts`:

```ts
export interface RemoteTransportDependencies {
  listDesktopRecords(): Promise<RemoteDesktopRecord[]>;
  getSelectedDesktopId(): string | null;
  invokeDesktop: RemoteDesktopInvoker;
  observeTaskTerminal?: RemoteTaskTerminalObserver;
  listCloudTasks?: () => Promise<TaskSummary[]>;
}
```

Change `listRecentTasks` to use the cloud index when available:

```ts
listRecentTasks: () =>
  listCloudTasks ? listCloudTasks() : request<TaskSummary[]>("GET", "/v1/tasks/recent", null),
```

- [ ] **Step 6: Run mobile tests**

Run:

```bash
pnpm --dir apps/mobile test -- mobileController.test.ts appModel.test.ts App.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/appModel.ts apps/mobile/src/state/mobileController.ts apps/mobile/src/lib/transports/remoteTransport.ts apps/mobile/src/state/mobileController.test.ts
git commit -m "feat: support cloud connection mode on mobile"
```

## Task 5: Desktop Cloud Task Snapshot Mapper

**Files:**
- Create: `apps/desktop/src/utils/cloudTaskSnapshot.ts`
- Test: `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`

- [ ] **Step 1: Write failing mapper test**

Create `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCloudTaskSnapshot, hashRemoteUrl } from "./cloudTaskSnapshot";

describe("cloud task snapshot mapper", () => {
  it("maps a local task and repo into a cloud-safe snapshot", async () => {
    await expect(hashRemoteUrl("git@github.com:jemdiggity/kanna.git")).resolves.toHaveLength(64);

    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-1",
        repo_id: "repo-1",
        prompt: "Fix cloud mobile task list",
        stage: "in progress",
        activity: "working",
        branch: "task-1",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: "Cloud mobile",
        agent_provider: "claude",
        agent_type: "pty",
        created_at: "2026-05-14T00:00:00.000Z",
        updated_at: "2026-05-14T00:01:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: "git@github.com:jemdiggity/kanna.git",
      },
      blockedByTaskIds: [],
    });

    expect(snapshot).toMatchObject({
      cloudTaskId: "repo-1:task-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      title: "Cloud mobile",
      promptSnippet: "Fix cloud mobile task list",
      repo: { cloudRepoId: "repo-1", name: "kanna", defaultBranch: "main" },
      transfer: { state: "none" },
    });
    expect(snapshot.repo.remoteUrlHash).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop test -- cloudTaskSnapshot.test.ts
```

Expected: fail because `cloudTaskSnapshot.ts` does not exist.

- [ ] **Step 3: Implement mapper**

Create `apps/desktop/src/utils/cloudTaskSnapshot.ts`:

```ts
import type { PipelineItem, Repo } from "@kanna/db";

export interface CloudTaskSnapshotInput {
  desktopId: string;
  item: Pick<
    PipelineItem,
    | "id"
    | "repo_id"
    | "prompt"
    | "stage"
    | "activity"
    | "branch"
    | "base_ref"
    | "pr_number"
    | "pr_url"
    | "display_name"
    | "agent_provider"
    | "agent_type"
    | "created_at"
    | "updated_at"
    | "closed_at"
  >;
  repo: Pick<Repo, "id" | "name" | "path" | "default_branch"> & { remote_url?: string | null };
  blockedByTaskIds: string[];
}

export async function buildCloudTaskSnapshot(input: CloudTaskSnapshotInput) {
  const prompt = input.item.prompt ?? "";
  const title = input.item.display_name || prompt.split("\n")[0]?.trim() || input.item.id;
  return {
    cloudTaskId: `${input.repo.id}:${input.item.id}`,
    ownerDesktopId: input.desktopId,
    ownerLocalTaskId: input.item.id,
    title,
    promptSnippet: prompt ? prompt.slice(0, 500) : null,
    displayName: input.item.display_name,
    stage: input.item.stage,
    activity: input.item.activity,
    status: deriveStatus(input.item.stage, input.item.closed_at, input.blockedByTaskIds),
    repo: {
      cloudRepoId: input.repo.id,
      name: input.repo.name,
      remoteUrlHash: await hashRemoteUrl(input.repo.remote_url ?? null),
      defaultBranch: input.repo.default_branch,
    },
    branch: input.item.branch,
    baseRef: input.item.base_ref,
    prNumber: input.item.pr_number,
    prUrl: input.item.pr_url,
    agent: {
      provider: input.item.agent_provider,
      type: input.item.agent_type ?? "pty",
    },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: input.blockedByTaskIds,
    createdAt: input.item.created_at,
    updatedAt: input.item.updated_at,
    closedAt: input.item.closed_at,
  };
}

export async function hashRemoteUrl(remoteUrl: string | null): Promise<string | null> {
  if (!remoteUrl) return null;
  const data = new TextEncoder().encode(remoteUrl.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deriveStatus(
  stage: string,
  closedAt: string | null,
  blockedByTaskIds: string[]
): "active" | "blocked" | "pr" | "merge" | "done" {
  if (closedAt) return "done";
  if (blockedByTaskIds.length > 0) return "blocked";
  if (stage === "pr") return "pr";
  if (stage === "merge") return "merge";
  return "active";
}
```

- [ ] **Step 4: Run mapper test**

Run:

```bash
pnpm --dir apps/desktop test -- cloudTaskSnapshot.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/cloudTaskSnapshot.ts apps/desktop/src/utils/cloudTaskSnapshot.test.ts
git commit -m "feat: map desktop tasks to cloud snapshots"
```

## Task 6: Desktop Snapshot Publisher Service

**Files:**
- Create: `apps/desktop/src/services/cloudTaskPublisher.ts`
- Test: `apps/desktop/src/services/cloudTaskPublisher.test.ts`

- [ ] **Step 1: Write failing publisher test**

Create `apps/desktop/src/services/cloudTaskPublisher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createCloudTaskPublisher } from "./cloudTaskPublisher";

describe("cloud task publisher", () => {
  it("posts snapshots to the configured Firebase function", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const publisher = createCloudTaskPublisher({
      endpoint: "http://localhost:5001/upsertTaskSnapshot",
      getIdToken: async () => "id-token-1",
      fetchImpl: fetchMock,
    });

    await publisher.publish({ cloudTaskId: "cloud-task-1", title: "Task" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/upsertTaskSnapshot",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer id-token-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ cloudTaskId: "cloud-task-1", title: "Task" }),
      })
    );
  });

  it("skips publishing when the user is signed out", async () => {
    const fetchMock = vi.fn();
    const publisher = createCloudTaskPublisher({
      endpoint: "http://localhost:5001/upsertTaskSnapshot",
      getIdToken: async () => null,
      fetchImpl: fetchMock,
    });

    await publisher.publish({ cloudTaskId: "cloud-task-1" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop test -- cloudTaskPublisher.test.ts
```

Expected: fail because service file does not exist.

- [ ] **Step 3: Implement publisher**

Create `apps/desktop/src/services/cloudTaskPublisher.ts`:

```ts
export interface CloudTaskPublisher {
  publish(snapshot: unknown): Promise<void>;
}

export interface CloudTaskPublisherDependencies {
  endpoint: string | null;
  getIdToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export function createCloudTaskPublisher({
  endpoint,
  getIdToken,
  fetchImpl = fetch,
}: CloudTaskPublisherDependencies): CloudTaskPublisher {
  return {
    async publish(snapshot) {
      if (!endpoint) {
        return;
      }
      const idToken = await getIdToken();
      if (!idToken) return;

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${idToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });

      if (!response.ok) {
        throw new Error(`cloud task snapshot publish failed with status ${response.status}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run publisher test**

Run:

```bash
pnpm --dir apps/desktop test -- cloudTaskPublisher.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/services/cloudTaskPublisher.ts apps/desktop/src/services/cloudTaskPublisher.test.ts
git commit -m "feat: add desktop cloud task publisher"
```

## Task 7: Relay Owner-Routed Action Isolation

**Files:**
- Modify: `services/relay/test/integration.test.ts`
- Modify: `services/relay/src/router.ts` only if the test exposes a routing bug.

- [ ] **Step 1: Write relay isolation test**

Append to `services/relay/test/integration.test.ts`:

```ts
it("routes mobile task actions only to the requested owner desktop", async () => {
  const { ws: desktopOne } = await connectAndAuth({
    desktop_id: "desktop-owner-one",
    desktop_secret: "secret-one",
  });
  const { ws: desktopTwo } = await connectAndAuth({
    desktop_id: "desktop-owner-two",
    desktop_secret: "secret-two",
  });
  const { ws: phone } = await connectAndAuth({
    id_token: "user-owner-routing",
  });

  const unexpectedDesktopOneInvoke = waitForMessage(
    desktopOne,
    (msg) => msg.type === "invoke",
    250
  ).then(
    () => "invoke",
    () => "timeout"
  );
  const desktopTwoInvoke = waitForMessage(
    desktopTwo,
    (msg) =>
      msg.type === "invoke" &&
      msg.desktopId === "desktop-owner-two" &&
      msg.path === "/v1/tasks/cloud-task-1/input"
  );

  phone.send(
    JSON.stringify({
      type: "invoke",
      id: "task-action-owner-route",
      desktopId: "desktop-owner-two",
      method: "POST",
      path: "/v1/tasks/cloud-task-1/input",
      body: { input: "continue\n" },
    })
  );

  await expect(desktopTwoInvoke).resolves.toMatchObject({
    desktopId: "desktop-owner-two",
    method: "POST",
  });
  await expect(unexpectedDesktopOneInvoke).resolves.toBe("timeout");

  await closeAndWait(phone);
  await closeAndWait(desktopOne);
  await closeAndWait(desktopTwo);
});
```

- [ ] **Step 2: Run relay tests**

Run:

```bash
pnpm --dir services/relay test -- integration.test.ts
```

Expected: pass if current router behavior already satisfies owner-routed isolation. If it fails, inspect `services/relay/src/router.ts` and preserve the existing explicit `desktopId` routing branch.

- [ ] **Step 3: Commit**

```bash
git add services/relay/test/integration.test.ts services/relay/src/router.ts
git commit -m "test: cover relay owner routed task actions"
```

## Task 8: Verification

**Files:**
- All files touched by Tasks 1-7.

- [ ] **Step 1: Run focused test suites**

Run:

```bash
pnpm --dir services/firebase-functions test -- taskSnapshots.test.ts firestore-rules.test.ts
pnpm --dir apps/mobile test -- taskIndex.test.ts mobileController.test.ts App.test.tsx
pnpm --dir apps/desktop test -- cloudTaskSnapshot.test.ts cloudTaskPublisher.test.ts
pnpm --dir services/relay test -- integration.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run workspace checks**

Run:

```bash
pnpm test
```

Expected: pass. If unrelated failures exist, record the exact failing test names and confirm the focused suites above still pass.

- [ ] **Step 3: Inspect git state**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only intentional uncommitted changes remain, or no changes remain after commits.

## Self-Review

Spec coverage:

- Sign-in and cloud task listing: covered by Tasks 3 and 4.
- Desktop-owned read-through snapshots: covered by Tasks 1, 2, 5, and 6.
- Owner-routed mobile actions: covered by Task 7 and existing `remoteTransport` behavior.
- Explicit Push/Pull transfer: represented in cloud transfer types and relay routing contract, but full cloud Push/Pull UI is intentionally outside this first vertical slice.
- Offline no-mutation rule: covered in mobile controller tests to add during Task 4 if offline owner metadata is surfaced in the same patch.

Placeholder scan:

- The plan avoids placeholder markers and provides exact file paths, commands, and expected outcomes.

Type consistency:

- `cloudTaskId`, `ownerDesktopId`, and `ownerLocalTaskId` are used consistently across Firebase, mobile, and desktop mapper tasks.

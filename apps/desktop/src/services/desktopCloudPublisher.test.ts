import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDesktopCloudPublisherCachesForTests,
  deleteRemoteTaskSnapshots,
  publishDesktopTaskSnapshot,
  reconcileDesktopTaskSnapshots,
} from "./desktopCloudPublisher";
import { setDesktopSnapshotFetcherForTests } from "./desktopServerClient";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  commit: vi.fn(),
  collection: vi.fn((...segments: unknown[]) => ({ kind: "collection", segments })),
  doc: vi.fn((collectionRef: unknown, explicitId?: unknown) => ({
    kind: "doc",
    collectionRef,
    id: explicitId ?? "new-auto-task",
  })),
  query: vi.fn((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value })),
  limit: vi.fn((count: number) => ({ kind: "limit", count })),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

vi.mock("@kanna/" + "db", () => ({
  getRepo: vi.fn(async () => repo()),
  listPipelineItems: vi.fn(async () => [openItem("task-open")]),
  listRepos: vi.fn(async () => [repo()]),
  listBlockersForItem: vi.fn(async () => []),
  updateRepoRemoteMetadata: vi.fn(async () => {}),
}));

vi.mock("firebase/firestore", () => ({
  collection: (...args: unknown[]) => mocks.collection(...args),
  doc: (...args: unknown[]) => mocks.doc(...args),
  getDoc: (...args: unknown[]) => mocks.getDoc(...args),
  getDocs: (...args: unknown[]) => mocks.getDocs(...args),
  limit: (...args: unknown[]) => mocks.limit(...args),
  query: (...args: unknown[]) => mocks.query(...args),
  serverTimestamp: (...args: unknown[]) => mocks.serverTimestamp(...args),
  setDoc: (...args: unknown[]) => mocks.setDoc(...args),
  where: (...args: unknown[]) => mocks.where(...args),
  writeBatch: vi.fn(() => ({
    set: (...args: unknown[]) => mocks.set(...args),
    delete: (...args: unknown[]) => mocks.delete(...args),
    commit: () => mocks.commit(),
  })),
}));

vi.mock("../invoke", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("./desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    getState: () => ({
      status: "signedIn",
      user: { uid: "user-1", email: "user@example.com", displayName: null },
    }),
  })),
}));

vi.mock("./desktopCloudTaskIndex", () => ({
  getConfiguredDesktopFirestore: vi.fn(async () => ({ app: "firestore" })),
}));

function repo() {
  return {
    id: "repo-1",
    name: "Repo One",
    path: "/repo",
    default_branch: "main",
    remote_url: "git@github.com:owner/repo.git",
    remote_url_hash: "b1cd17c6cfc6f18ca212b7e8ac47cfe7429102823006de2bc18203527bfb711e",
  };
}

function openItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    repo_id: "repo-1",
    prompt: "Open task",
    stage: "in progress",
    activity: "working",
    branch: id,
    base_ref: "main",
    pr_number: null,
    pr_url: null,
    display_name: null,
    agent_provider: "claude",
    agent_type: "pty",
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:01:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

function closedItem(id: string) {
  return openItem(id, {
    stage: "done",
    activity: "idle",
    closed_at: "2026-05-22T00:02:00.000Z",
    updated_at: "2026-05-22T00:02:00.000Z",
  });
}

function docSnapshot(id: string, data: Record<string, unknown>) {
  return {
    id,
    ref: { kind: "doc-ref", id },
    data: () => data,
    exists: () => true,
  };
}

function missingDocSnapshot() {
  return {
    exists: () => false,
    data: () => undefined,
  };
}

// The desktop id resolves to "desktop-owner" (mobile_server_status), so the
// canonical deterministic desktop document id is "desktop-owner".
function canonicalDesktopDoc() {
  return docSnapshot("desktop-owner", { desktopId: "desktop-owner", displayName: null });
}

// The deterministic desktop document reference the publisher writes to.
const desktopRef = { kind: "doc", collectionRef: expect.any(Object), id: "desktop-owner" };

function taskDocAllocations(): unknown[][] {
  return mocks.doc.mock.calls.filter(([collectionRef]) => {
    if (!collectionRef || typeof collectionRef !== "object" || !("segments" in collectionRef)) {
      return false;
    }
    const segments = (collectionRef as { segments?: unknown[] }).segments;
    return Array.isArray(segments) && segments.at(-1) === "tasks";
  });
}

describe("desktop cloud live task index publisher", () => {
  beforeEach(() => {
    __resetDesktopCloudPublisherCachesForTests();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    mocks.collection.mockImplementation((...segments: unknown[]) => ({ kind: "collection", segments }));
    mocks.doc.mockImplementation((collectionRef: unknown, explicitId?: unknown) => ({
      kind: "doc",
      collectionRef,
      id: explicitId ?? "new-auto-task",
    }));
    mocks.query.mockImplementation((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints }));
    mocks.where.mockImplementation((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value }));
    mocks.limit.mockImplementation((count: number) => ({ kind: "limit", count }));
    mocks.serverTimestamp.mockReturnValue("SERVER_TIMESTAMP");
    mocks.commit.mockResolvedValue(undefined);
    mocks.setDoc.mockResolvedValue(undefined);
    mocks.getDoc.mockResolvedValue(missingDocSnapshot());
    mocks.getDocs.mockResolvedValue({ docs: [] });
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [{
        repo: repo() as never,
        items: [openItem("task-open") as never],
      }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") {
        return { desktopId: "desktop-owner", desktopSecretHash: "secret-hash-1" };
      }
      if (command === "mobile_server_status") return { desktopId: "desktop-owner", desktopName: "Studio Mac" };
      if (command === "read_env_var") return "";
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      return "";
    });
  });

  it("updates an existing task document for an open local task", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] }) // duplicate-desktop sweep: only canonical
      .mockResolvedValueOnce({ docs: [
        docSnapshot("task-doc", {
          localRepoId: "repo-1",
          ownerLocalTaskId: "task-new",
        }),
      ] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.set).toHaveBeenCalledWith(
      { kind: "doc-ref", id: "task-doc" },
      expect.objectContaining({
        localRepoId: "repo-1",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-new",
        closedAt: null,
      }),
    );
    expect(taskDocAllocations()).toHaveLength(0);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("deletes duplicate task documents for the same local identity", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [
        docSnapshot("task-doc-primary", {
          localRepoId: "repo-1",
          ownerLocalTaskId: "task-duplicate",
        }),
        docSnapshot("task-doc-duplicate", {
          localRepoId: "repo-1",
          ownerLocalTaskId: "task-duplicate",
        }),
      ] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-duplicate") as never, repo() as never);

    expect(mocks.set).toHaveBeenCalledWith(
      { kind: "doc-ref", id: "task-doc-primary" },
      expect.objectContaining({
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-duplicate",
      }),
    );
    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "task-doc-duplicate" });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("preserves OpenCode as the task agent provider in direct Firestore writes", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(
      null as never,
      openItem("task-opencode", { agent_provider: "opencode" }) as never,
      repo() as never,
    );

    expect(mocks.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        agent: {
          provider: "opencode",
          type: "pty",
        },
      }),
    );
  });

  it("preserves Antigravity as the task agent provider in direct Firestore writes", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(
      null as never,
      openItem("task-antigravity", { agent_provider: "antigravity" }) as never,
      repo() as never,
    );

    expect(mocks.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        agent: {
          provider: "antigravity",
          type: "pty",
        },
      }),
    );
  });

  it("writes the desktop document to a deterministic id keyed by the desktop id", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [] }) // duplicate sweep finds nothing
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    // No addDoc: the desktop document id is derived from the desktop id so
    // concurrent publishers converge instead of racing to create their own.
    expect(mocks.doc).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "collection" }),
      "desktop-owner",
    );
    expect(mocks.setDoc).toHaveBeenCalledWith(
      desktopRef,
      {
        desktopId: "desktop-owner",
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
        desktopSecretHash: "secret-hash-1",
      },
      { merge: true },
    );
    expect(mocks.set).toHaveBeenCalledWith(
      { kind: "doc", collectionRef: expect.any(Object), id: "new-auto-task" },
      expect.objectContaining({
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-new",
      }),
    );
  });

  it("publishes saved desktop credentials into the desktop document for relay auth", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") {
        return {
          desktopId: "desktop-cloud",
          desktopSecretHash: "secret-cloud-hash",
        };
      }
      if (command === "mobile_server_status") return { desktopId: "desktop-local", desktopName: "Studio Mac" };
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      return "";
    });
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.setDoc).toHaveBeenCalledWith(
      { kind: "doc", collectionRef: expect.any(Object), id: "desktop-cloud" },
      expect.objectContaining({
        desktopId: "desktop-cloud",
        displayName: "Studio Mac",
        desktopSecretHash: "secret-cloud-hash",
      }),
      { merge: true },
    );
    expect(mocks.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        ownerDesktopId: "desktop-cloud",
      }),
    );
  });

  it("removes duplicate desktop documents for the same desktop id, including their tasks", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [
        canonicalDesktopDoc(),
        docSnapshot("legacy-auto-id", { desktopId: "desktop-owner", displayName: null }),
      ] })
      .mockResolvedValueOnce({ docs: [docSnapshot("legacy-task", {})] }) // legacy desktop's tasks
      .mockResolvedValueOnce({ docs: [] }); // canonical desktop's tasks

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "legacy-task" });
    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "legacy-auto-id" });
    // one commit to clean the duplicate desktop + one for the task batch
    expect(mocks.commit).toHaveBeenCalledTimes(2);
  });

  it("updates the signed-in user's Firestore profile with their email address", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.doc).toHaveBeenCalledWith(
      { app: "firestore" },
      "users",
      "user-1",
    );
    expect(mocks.setDoc).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "doc" }),
      {
        primaryEmail: "user@example.com",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
  });

  it("refreshes the existing desktop document with a friendly machine name", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.setDoc).toHaveBeenCalledWith(
      desktopRef,
      {
        desktopId: "desktop-owner",
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
        desktopSecretHash: "secret-hash-1",
      },
      { merge: true },
    );
  });

  it("omits the desktop secret hash when the credential command is unavailable", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") throw new Error("not available in browser mock");
      if (command === "mobile_server_status") return { desktopId: "desktop-owner", desktopName: "Studio Mac" };
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      return "";
    });
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.setDoc).toHaveBeenCalledWith(
      desktopRef,
      {
        desktopId: "desktop-owner",
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
  });

  it("does not attach this desktop's secret hash to another desktop's document", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [docSnapshot("other-desktop-doc", { desktopId: "desktop-other", displayName: null })] })
      .mockResolvedValueOnce({ docs: [] });

    await deleteRemoteTaskSnapshots({
      ownerDesktopId: "desktop-other",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-remote",
    });

    expect(mocks.setDoc).toHaveBeenCalledWith(
      { kind: "doc-ref", id: "other-desktop-doc" },
      {
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
  });
  it("deletes matching auto-id task metadata instead of publishing a closed task snapshot", async () => {
    // Closed task → delete path uses create:false, which reads the desktop doc
    // by deterministic id (getDoc) rather than the duplicate sweep.
    mocks.getDoc.mockResolvedValue({ exists: () => true });
    mocks.getDocs.mockResolvedValueOnce({ docs: [
      docSnapshot("task-closed-doc", {
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-closed",
      }),
    ] });

    await publishDesktopTaskSnapshot(null as never, closedItem("task-closed") as never, repo() as never);

    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "task-closed-doc" });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("deletes remote task metadata by owner identity", async () => {
    mocks.getDoc.mockResolvedValue({ exists: () => true });
    mocks.getDocs.mockResolvedValueOnce({ docs: [
      docSnapshot("task-remote-doc", {
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-remote",
      }),
    ] });

    await deleteRemoteTaskSnapshots({
      ownerDesktopId: "desktop-owner",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-remote",
    });

    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "task-remote-doc" });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("reconciles the owned cloud index to the current open local task set", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [canonicalDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [
        docSnapshot("task-open-doc", {
          localRepoId: "repo-1",
          ownerLocalTaskId: "task-open",
        }),
        docSnapshot("task-stale-doc", {
          localRepoId: "repo-1",
          ownerLocalTaskId: "task-stale",
        }),
      ] });

    await reconcileDesktopTaskSnapshots(null as never);

    expect(mocks.set).toHaveBeenCalledWith(
      { kind: "doc-ref", id: "task-open-doc" },
      expect.objectContaining({
        localRepoId: "repo-1",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-open",
        closedAt: null,
      }),
    );
    expect(mocks.delete).toHaveBeenCalledWith({ kind: "doc-ref", id: "task-stale-doc" });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("refreshes profile, desktop, and task documents during reconcile without deleting unchanged tasks", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") {
        return {
          desktopId: "desktop-noop",
          desktopSecretHash: "secret-noop-hash",
        };
      }
      if (command === "mobile_server_status") return { desktopId: "desktop-noop", desktopName: "Studio Mac" };
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      return "";
    });
    const remoteUrl = "git@github.com:owner/repo.git";
    const remoteUrlHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(remoteUrl),
    ).then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
    const unchangedTask = {
      localRepoId: "repo-1",
      ownerDesktopId: "desktop-noop",
      ownerLocalTaskId: "task-open",
      title: "Open task",
      promptSnippet: "Open task",
      displayName: null,
      stage: "in progress",
      activity: "working",
      status: "active",
      repo: {
        cloudRepoId: "repo-1",
        name: "Repo One",
        remoteUrl,
        remoteUrlHash,
        defaultBranch: "main",
      },
      branch: "task-open",
      baseRef: "main",
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
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:01:00.000Z",
      closedAt: null,
    };
    mocks.getDoc
      .mockResolvedValueOnce(docSnapshot("user-1", { primaryEmail: "user@example.com" }))
      .mockResolvedValueOnce(docSnapshot("user-1", { primaryEmail: "user@example.com" }));
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [docSnapshot("desktop-noop", {
        desktopId: "desktop-noop",
        desktopSecretHash: "secret-noop-hash",
        displayName: "Studio Mac",
      })] })
      .mockResolvedValueOnce({ docs: [docSnapshot("task-open-doc", unchangedTask)] })
      .mockResolvedValueOnce({ docs: [docSnapshot("desktop-noop", {
        desktopId: "desktop-noop",
        desktopSecretHash: "secret-noop-hash",
        displayName: "Studio Mac",
      })] })
      .mockResolvedValueOnce({ docs: [docSnapshot("task-open-doc", unchangedTask)] });

    await reconcileDesktopTaskSnapshots(null as never);
    expect(mocks.setDoc).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledTimes(1);

    mocks.getDoc.mockClear();
    mocks.setDoc.mockClear();
    mocks.set.mockClear();
    mocks.delete.mockClear();
    mocks.commit.mockClear();
    mocks.invoke.mockClear();

    await reconcileDesktopTaskSnapshots(null as never);

    expect(mocks.setDoc).toHaveBeenCalledTimes(2);
    expect(mocks.getDoc).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "git_remote_url")).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRemoteTaskSnapshots,
  publishDesktopTaskSnapshot,
  reconcileDesktopTaskSnapshots,
} from "./desktopCloudPublisher";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDocs: vi.fn(),
  addDoc: vi.fn(),
  setDoc: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  commit: vi.fn(),
  collection: vi.fn((...segments: unknown[]) => ({ kind: "collection", segments })),
  doc: vi.fn((collectionRef: unknown) => ({ kind: "doc", collectionRef, id: "new-auto-task" })),
  query: vi.fn((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value })),
  limit: vi.fn((count: number) => ({ kind: "limit", count })),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

vi.mock("@kanna/db", () => ({
  getRepo: vi.fn(async () => repo()),
  listPipelineItems: vi.fn(async () => [openItem("task-open")]),
  listRepos: vi.fn(async () => [repo()]),
  listBlockersForItem: vi.fn(async () => []),
}));

vi.mock("firebase/firestore", () => ({
  addDoc: (...args: unknown[]) => mocks.addDoc(...args),
  collection: (...args: unknown[]) => mocks.collection(...args),
  doc: (...args: unknown[]) => mocks.doc(...args),
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
  };
}

function mockDesktopDoc(id = "desktop-doc") {
  return docSnapshot(id, { desktopId: "desktop-owner", displayName: null });
}

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
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    mocks.collection.mockImplementation((...segments: unknown[]) => ({ kind: "collection", segments }));
    mocks.doc.mockImplementation((collectionRef: unknown) => ({ kind: "doc", collectionRef, id: "new-auto-task" }));
    mocks.query.mockImplementation((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints }));
    mocks.where.mockImplementation((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value }));
    mocks.limit.mockImplementation((count: number) => ({ kind: "limit", count }));
    mocks.serverTimestamp.mockReturnValue("SERVER_TIMESTAMP");
    mocks.commit.mockResolvedValue(undefined);
    mocks.addDoc.mockResolvedValue({ kind: "doc-ref", id: "created-desktop" });
    mocks.setDoc.mockResolvedValue(undefined);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "mobile_server_status") return { desktopId: "desktop-owner", desktopName: "Studio Mac" };
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      return "";
    });
  });

  it("updates an existing auto-id task document for an open local task", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
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

  it("creates the desktop document and task document with auto ids when missing", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.addDoc).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "collection" }),
      {
        desktopId: "desktop-owner",
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
      },
    );
    expect(mocks.doc).toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(
      { kind: "doc", collectionRef: expect.any(Object), id: "new-auto-task" },
      expect.objectContaining({
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-new",
      }),
    );
  });

  it("updates the signed-in user's Firestore profile with their email address", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
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
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [] });

    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.setDoc).toHaveBeenCalledWith(
      { kind: "doc-ref", id: "desktop-doc" },
      {
        displayName: "Studio Mac",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
  });

  it("deletes matching auto-id task metadata instead of publishing a closed task snapshot", async () => {
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [
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
    mocks.getDocs
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
      .mockResolvedValueOnce({ docs: [
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
      .mockResolvedValueOnce({ docs: [mockDesktopDoc()] })
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
});

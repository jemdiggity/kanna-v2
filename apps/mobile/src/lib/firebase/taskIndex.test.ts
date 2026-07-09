import { afterEach, describe, expect, it, vi } from "vitest";

const firestoreMocks = vi.hoisted(() => ({
  collection: vi.fn((...segments: unknown[]) => ({ kind: "collection", segments })),
  connectFirestoreEmulator: vi.fn(),
  getDocs: vi.fn(),
  getFirestore: vi.fn(() => ({ kind: "firestore" })),
  onSnapshot: vi.fn(),
  query: vi.fn((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value })),
}));

vi.mock("firebase/firestore", () => ({
  collection: (...args: unknown[]) => firestoreMocks.collection(...args),
  connectFirestoreEmulator: (...args: unknown[]) => firestoreMocks.connectFirestoreEmulator(...args),
  getDocs: (...args: unknown[]) => firestoreMocks.getDocs(...args),
  getFirestore: (...args: unknown[]) => firestoreMocks.getFirestore(...args),
  onSnapshot: (...args: unknown[]) => firestoreMocks.onSnapshot(...args),
  query: (...args: unknown[]) => firestoreMocks.query(...args),
  where: (...args: unknown[]) => firestoreMocks.where(...args),
}));

import {
  createFirestoreTaskIndex,
  mapCloudTaskSnapshot,
  sortCloudTasks
} from "./taskIndex";

describe("cloud task index", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    firestoreMocks.collection.mockClear();
    firestoreMocks.connectFirestoreEmulator.mockClear();
    firestoreMocks.getDocs.mockReset();
    firestoreMocks.getFirestore.mockClear();
    firestoreMocks.onSnapshot.mockClear();
    firestoreMocks.query.mockClear();
    firestoreMocks.where.mockClear();
  });

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
        repo: {
          cloudRepoId: "repo-1",
          name: "kanna",
          remoteUrlHash: null,
          defaultBranch: "main",
        },
        branch: "task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "claude", type: "agent" },
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
      }),
    ).toEqual({
      id: "cloud-task-1",
      repoId: "repo-1",
      repoName: "kanna",
      title: "Mobile cloud",
      stage: "in progress",
      snippet: "Fix mobile cloud",
      agentProvider: "claude",
      agentType: "agent",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: false,
    });
  });

  it("uses owner identity as the mobile task id when cloudTaskId is absent", () => {
    expect(
      mapCloudTaskSnapshot({
        ownerDesktopId: "desktop-1",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-1",
        title: "Fix mobile cloud",
        promptSnippet: null,
        displayName: null,
        stage: "in progress",
        status: "active",
        repo: { cloudRepoId: "repo-1", name: "kanna" },
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      }),
    ).toMatchObject({
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "repo-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
    });
  });

  it("sorts newest updated cloud tasks first", () => {
    const tasks = sortCloudTasks([
      { id: "old", updatedAt: "2026-05-14T00:00:00.000Z" },
      { id: "new", updatedAt: "2026-05-14T00:02:00.000Z" },
    ]);

    expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });

  it("lists tasks from desktop task subcollections", async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce({
        docs: [{
          ref: { kind: "desktop-ref", id: "desktop-doc" },
          data: () => ({ desktopId: "desktop-1" }),
        }],
      })
      .mockResolvedValueOnce({
        docs: [{
          data: () => ({
            cloudTaskId: "cloud-task-1",
            ownerDesktopId: "desktop-1",
            ownerLocalTaskId: "task-1",
            title: "Fix mobile cloud",
            promptSnippet: "Fix mobile cloud",
            displayName: null,
            stage: "in progress",
            status: "active",
            repo: { cloudRepoId: "repo-1", name: "kanna" },
            updatedAt: "2026-05-14T00:01:00.000Z",
            closedAt: null,
          }),
        }],
      });

    const tasks = await createFirestoreTaskIndex({ kind: "firestore" } as never).listRecentTasks("user-1");

    expect(tasks).toMatchObject([{
      id: "cloud-task-1",
      repoId: "repo-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
    }]);
    expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(2);
  });

  it("lists desktop records published under the signed-in user", async () => {
    firestoreMocks.getDocs.mockResolvedValueOnce({
      docs: [
        {
          id: "desktop-doc-id",
          data: () => ({
            desktopId: "desktop-owner",
            displayName: "Staging Mac",
            updatedAt: {
              toDate: () => new Date("2026-07-06T12:30:00.000Z")
            }
          })
        }
      ],
    });

    const desktops = await createFirestoreTaskIndex({ kind: "firestore" } as never).listDesktops("user-1");

    expect(desktops).toEqual([
      {
        desktopId: "desktop-owner",
        displayName: "Staging Mac",
        updatedAt: "2026-07-06T12:30:00.000Z"
      }
    ]);
    expect(firestoreMocks.collection).toHaveBeenCalledWith(
      { kind: "firestore" },
      "users",
      "user-1",
      "desktops"
    );
  });

  it("primes live task subscriptions from desktop task collections", async () => {
    const desktopDoc = {
      id: "desktop-doc",
      ref: { kind: "desktop-ref", id: "desktop-doc" },
      data: () => ({ desktopId: "desktop-1" }),
    };
    firestoreMocks.onSnapshot.mockImplementationOnce((_ref, onNext) => {
      onNext({ docs: [desktopDoc] });
      return vi.fn();
    });
    firestoreMocks.onSnapshot.mockImplementationOnce(() => vi.fn());
    firestoreMocks.getDocs.mockResolvedValueOnce({
      docs: [{
        data: () => ({
          cloudTaskId: "cloud-task-1",
          ownerDesktopId: "desktop-1",
          ownerLocalTaskId: "task-1",
          title: "Fix mobile cloud",
          promptSnippet: "Fix mobile cloud",
          displayName: null,
          stage: "in progress",
          status: "active",
          repo: { cloudRepoId: "repo-1", name: "kanna" },
          updatedAt: "2026-05-14T00:01:00.000Z",
          closedAt: null,
        }),
      }],
    });
    const onUpdate = vi.fn();

    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate
    );

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "cloud-task-1",
          ownerDesktopId: "desktop-1",
          ownerLocalTaskId: "task-1"
        })
      ]);
    });
  });

  it("does not emit an empty live task list while known desktops are still hydrating", async () => {
    let resolveActivePrime:
      | ((snapshot: { docs: Array<{ data: () => Record<string, unknown> }> }) => void)
      | null = null;
    const activeDesktop = {
      id: "desktop-active",
      ref: { kind: "desktop-ref", id: "desktop-active" },
      data: () => ({ desktopId: "desktop-active" }),
    };
    const emptyDesktop = {
      id: "desktop-empty",
      ref: { kind: "desktop-ref", id: "desktop-empty" },
      data: () => ({ desktopId: "desktop-empty" }),
    };
    firestoreMocks.onSnapshot.mockImplementationOnce((_ref, onNext) => {
      onNext({ docs: [activeDesktop, emptyDesktop] });
      return vi.fn();
    });
    firestoreMocks.onSnapshot
      .mockImplementationOnce(() => vi.fn())
      .mockImplementationOnce((_query, onNext) => {
        onNext({ docs: [] });
        return vi.fn();
      });
    firestoreMocks.getDocs
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveActivePrime = resolve;
          })
      )
      .mockResolvedValueOnce({ docs: [] });
    const onUpdate = vi.fn();

    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate
    );
    await Promise.resolve();

    expect(onUpdate).not.toHaveBeenCalledWith([]);

    resolveActivePrime?.({
      docs: [{
        data: () => ({
          cloudTaskId: "cloud-task-1",
          ownerDesktopId: "desktop-active",
          ownerLocalTaskId: "task-1",
          title: "Fix mobile cloud",
          promptSnippet: "Fix mobile cloud",
          displayName: null,
          stage: "in progress",
          status: "active",
          repo: { cloudRepoId: "repo-1", name: "kanna" },
          updatedAt: "2026-05-14T00:01:00.000Z",
          closedAt: null,
        }),
      }],
    });

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "cloud-task-1",
          ownerDesktopId: "desktop-active",
          ownerLocalTaskId: "task-1"
        })
      ]);
    });
  });

  it("connects the default Firestore client to the configured emulator", async () => {
    vi.stubEnv("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST", "172.16.0.193");
    vi.stubEnv("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT", "8437");
    firestoreMocks.getDocs.mockResolvedValueOnce({ docs: [] });

    const { createFirestoreTaskIndex: createIndex } = await import("./taskIndex");
    await createIndex().listRecentTasks("user-1");

    expect(firestoreMocks.getFirestore).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.connectFirestoreEmulator).toHaveBeenCalledWith(
      { kind: "firestore" },
      "172.16.0.193",
      8437
    );
  });
});

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
import type { CloudTaskIndexError } from "./taskIndex";
import { createAppModel } from "../../appModel";
import { createStaticBonjourBrowser } from "../discovery/bonjour";
import type { MobileAuthSession } from "./auth";
import type { RelayDesktopClient } from "../transports/relayClient";

interface TestDocument {
  id: string;
  data: () => Record<string, unknown>;
}

interface TestSnapshot {
  docs: TestDocument[];
}

interface CapturedSnapshotListener {
  onNext: (snapshot: TestSnapshot) => void;
  onError: (error: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function desktopDocument(desktopId: string) {
  return {
    id: desktopId,
    ref: { kind: "desktop-ref", id: desktopId },
    data: () => ({ desktopId }),
  };
}

function taskSnapshot(...tasks: Array<Record<string, unknown>>): TestSnapshot {
  return {
    docs: tasks.map((task, index) => ({
      id: `task-doc-${index}`,
      data: () => task,
    })),
  };
}

function validTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cloudTaskId: "cloud-task-1",
    localRepoId: "local-repo-1",
    ownerDesktopId: "desktop-1",
    ownerLocalTaskId: "task-1",
    title: "Fix mobile cloud",
    promptSnippet: "Fix mobile cloud",
    waitingPromptSnippet: null,
    displayName: null,
    stage: "in progress",
    status: "active",
    repo: { cloudRepoId: "cloud-repo-1", name: "kanna" },
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:01:00.000Z",
    closedAt: null,
    pinned: false,
    pinOrder: null,
    ...overrides,
  };
}

function captureSnapshotListeners(
  onChildRegistered?: (
    listener: CapturedSnapshotListener,
    desktopId: string,
    generationIndex: number,
  ) => void,
) {
  let rootListener: CapturedSnapshotListener | null = null;
  const childListeners = new Map<string, CapturedSnapshotListener[]>();

  // A never-settling prime makes the legacy getDocs writer inert while the
  // listener callbacks remain fully deterministic. Tests still assert that
  // subscriptions do not invoke it at all.
  firestoreMocks.getDocs.mockReturnValue(new Promise(() => undefined));
  firestoreMocks.onSnapshot.mockImplementation(
    (reference: unknown, onNext: (snapshot: TestSnapshot) => void, onError?: (error: unknown) => void) => {
      const listener: CapturedSnapshotListener = {
        onNext,
        onError: onError ?? (() => undefined),
        unsubscribe: vi.fn(),
      };
      const queryReference = reference as {
        kind?: string;
        collectionRef?: { segments?: Array<{ id?: string }> };
      };
      if (queryReference.kind !== "query") {
        rootListener = listener;
        return listener.unsubscribe;
      }

      const desktopId = queryReference.collectionRef?.segments?.[0]?.id;
      if (!desktopId) throw new Error("task listener is missing its desktop ref");
      const generations = childListeners.get(desktopId) ?? [];
      generations.push(listener);
      childListeners.set(desktopId, generations);
      onChildRegistered?.(listener, desktopId, generations.length - 1);
      return listener.unsubscribe;
    },
  );

  return {
    root(): CapturedSnapshotListener {
      if (!rootListener) throw new Error("root listener was not registered");
      return rootListener;
    },
    child(desktopId: string, generationIndex = 0): CapturedSnapshotListener {
      const listener = childListeners.get(desktopId)?.[generationIndex];
      if (!listener) {
        throw new Error(`child listener ${desktopId}#${generationIndex} was not registered`);
      }
      return listener;
    },
    registrationCount(): number {
      return firestoreMocks.onSnapshot.mock.calls.length;
    },
  };
}

function createSignedInAuthSession(): MobileAuthSession {
  const state = {
    status: "signedIn" as const,
    user: {
      uid: "user-1",
      email: "user-1@kanna.test",
      displayName: null
    }
  };
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => state),
    subscribe: vi.fn((listener) => {
      listener(state);
      return vi.fn();
    }),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue("id-token"),
    notifyAuthExpired: vi.fn()
  };
}

function createRelayClientMock(): RelayDesktopClient {
  return {
    close: vi.fn(),
    invokeDesktop: vi.fn().mockResolvedValue(null),
    listActiveDesktopIds: vi.fn().mockResolvedValue(new Set<string>()),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskAgent: vi.fn(() => ({
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    })),
    sendTaskInput: vi.fn().mockResolvedValue(undefined)
  };
}

describe("cloud task index", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    firestoreMocks.collection.mockClear();
    firestoreMocks.connectFirestoreEmulator.mockClear();
    firestoreMocks.getDocs.mockReset();
    firestoreMocks.getFirestore.mockClear();
    firestoreMocks.onSnapshot.mockReset();
    firestoreMocks.query.mockClear();
    firestoreMocks.where.mockClear();
  });

  it("maps cloud snapshots into mobile task summaries", () => {
    expect(
      mapCloudTaskSnapshot({
        cloudTaskId: "cloud-task-1",
        localRepoId: "local-repo-1",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Canonical prompt first line",
        promptSnippet:
          "Canonical prompt first line\nDetailed cloud requirements stay distinct from the rename.\nCLOUD_PROMPT_END_SENTINEL",
        waitingPromptSnippet: "Ready for review",
        displayName: "Short renamed cloud task",
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
      title: "Short renamed cloud task",
      prompt:
        "Canonical prompt first line\nDetailed cloud requirements stay distinct from the rename.\nCLOUD_PROMPT_END_SENTINEL",
      stage: "in progress",
      createdAt: "2026-05-14T00:00:00.000Z",
      waitingPromptSnippet: "Ready for review",
      agentProvider: "claude",
      agentType: "agent",
      activity: "working",
      parentTaskId: null,
      blockedByTaskIds: [],
      pinned: false,
      pinOrder: null,
      ownerDesktopId: "desktop-1",
      ownerLocalRepoId: "local-repo-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: false,
    });
  });

  it("carries unresolved blocker ids and defaults them to empty", () => {
    expect(
      mapCloudTaskSnapshot({
        ...legacySnapshot,
        blockedByTaskIds: ["task-blocker-1", "task-blocker-2"],
      }).blockedByTaskIds,
    ).toEqual(["task-blocker-1", "task-blocker-2"]);
    expect(mapCloudTaskSnapshot(legacySnapshot).blockedByTaskIds).toEqual([]);
  });

  it("carries the owner-local parent task id and defaults it to null", () => {
    expect(
      mapCloudTaskSnapshot({ ...legacySnapshot, parentTaskId: "task-parent" })
        .parentTaskId,
    ).toBe("task-parent");
    expect(mapCloudTaskSnapshot(legacySnapshot).parentTaskId).toBeNull();
  });

  it("carries canonical pin metadata and defaults legacy documents to unpinned", () => {
    expect(
      mapCloudTaskSnapshot({
        ...legacySnapshot,
        pinned: true,
        pinOrder: 2
      })
    ).toMatchObject({ pinned: true, pinOrder: 2 });
    expect(mapCloudTaskSnapshot(legacySnapshot)).toMatchObject({
      pinned: false,
      pinOrder: null
    });
  });

  const legacySnapshot = {
    ownerDesktopId: "desktop-1",
    localRepoId: "repo-1",
    ownerLocalTaskId: "task-1",
    title: "Fix mobile cloud",
    promptSnippet: null,
    displayName: null,
    stage: "in progress",
    status: "active",
    repo: { cloudRepoId: "repo-1", name: "kanna" },
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:01:00.000Z",
    closedAt: null,
  };

  it("displays repos with a remote url hash under the canonical cross-machine repo id", () => {
    expect(
      mapCloudTaskSnapshot({
        ...legacySnapshot,
        repo: { cloudRepoId: "repo-1", name: "kanna", remoteUrlHash: "hash-kanna" },
      }),
    ).toMatchObject({
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "git:hash-kanna",
      ownerLocalRepoId: "repo-1",
    });
  });

  it("keeps the owner-local repo id for routing when only the hash canonicalizes", () => {
    const { localRepoId: _localRepoId, ...withoutLocalRepoId } = legacySnapshot;
    expect(
      mapCloudTaskSnapshot({
        ...withoutLocalRepoId,
        repo: { cloudRepoId: "repo-1", name: "kanna", remoteUrlHash: "hash-kanna" },
      }),
    ).toMatchObject({
      repoId: "git:hash-kanna",
      ownerLocalRepoId: "repo-1",
    });
  });

  it("uses owner identity as the mobile task id when cloudTaskId is absent", () => {
    expect(mapCloudTaskSnapshot(legacySnapshot)).toMatchObject({
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "repo-1",
      ownerDesktopId: "desktop-1",
      ownerLocalRepoId: "repo-1",
      ownerLocalTaskId: "task-1",
    });
  });

  for (const { label, activity, expected } of [
    { label: "working", activity: "working", expected: "working" },
    { label: "unread", activity: "unread", expected: "unread" },
    { label: "idle", activity: "idle", expected: "idle" },
    { label: "null", activity: null, expected: "idle" },
    { label: "missing", activity: undefined, expected: "idle" },
    { label: "unrecognized", activity: "paused", expected: "idle" },
  ] as const) {
    it(`maps ${label} cloud activity to ${expected}`, () => {
      const snapshot = activity === undefined
        ? legacySnapshot
        : { ...legacySnapshot, activity };

      expect(mapCloudTaskSnapshot(snapshot).activity).toBe(expected);
    });
  }

  it("sorts newest updated cloud tasks first", () => {
    const tasks = sortCloudTasks([
      { id: "old", updatedAt: "2026-05-14T00:00:00.000Z" },
      { id: "new", updatedAt: "2026-05-14T00:02:00.000Z" },
    ]);

    expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });

  it("uses raw cloud and composite task identities when timestamps tie", () => {
    const timestamp = "2026-05-14T00:02:00.000Z";
    const cloudIdTasks = sortCloudTasks([
      {
        cloudTaskId: "cloud-task-b",
        ownerDesktopId: "desktop-1",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-b",
        repo: { cloudRepoId: "cloud-repo-1" },
        updatedAt: timestamp,
      },
      {
        cloudTaskId: "cloud-task-a",
        ownerDesktopId: "desktop-1",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-a",
        repo: { cloudRepoId: "cloud-repo-1" },
        updatedAt: timestamp,
      },
    ]);
    const compositeTasks = sortCloudTasks([
      {
        ownerDesktopId: "desktop-b",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-b",
        repo: { cloudRepoId: "cloud-repo-1" },
        updatedAt: timestamp,
      },
      {
        ownerDesktopId: "desktop-a",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-a",
        repo: { cloudRepoId: "cloud-repo-1" },
        updatedAt: timestamp,
      },
    ]);

    expect(cloudIdTasks.map((task) => task.cloudTaskId)).toEqual([
      "cloud-task-a",
      "cloud-task-b",
    ]);
    expect(compositeTasks.map((task) => task.ownerDesktopId)).toEqual([
      "desktop-a",
      "desktop-b",
    ]);
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
        docs: [
          {
            id: "valid-task-doc",
            data: () => ({
            cloudTaskId: "cloud-task-1",
            localRepoId: "local-repo-1",
            ownerDesktopId: "desktop-1",
            ownerLocalTaskId: "task-1",
            title: "Fix mobile cloud",
            promptSnippet: "Fix mobile cloud",
            displayName: null,
            stage: "in progress",
            status: "active",
            repo: { cloudRepoId: "repo-1", name: "kanna" },
            createdAt: "2026-05-14 00:00:00",
            updatedAt: "2026-05-14T00:01:00.000Z",
            closedAt: null,
          }),
          },
          {
            id: "invalid-task-doc",
            data: () => ({
              ...validTask({ cloudTaskId: "invalid-task" }),
              title: "   ",
            }),
          },
        ],
      });

    const tasks = await createFirestoreTaskIndex({ kind: "firestore" } as never).listRecentTasks("user-1");

    expect(tasks).toMatchObject([{
      id: "cloud-task-1",
      repoId: "repo-1",
      ownerDesktopId: "desktop-1",
      ownerLocalRepoId: "local-repo-1",
      ownerLocalTaskId: "task-1",
      createdAt: "2026-05-14T00:00:00.000Z",
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

  it("withholds the initial aggregate until every desktop listener settles", () => {
    const onUpdate = vi.fn();
    const listeners = captureSnapshotListeners((listener, desktopId) => {
      if (desktopId === "desktop-a") {
        listener.onNext(taskSnapshot(validTask({
          cloudTaskId: "cloud-task-a",
          ownerDesktopId: "desktop-a",
        })));
      }
    });

    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
    );
    listeners.root().onNext({
      docs: [desktopDocument("desktop-a"), desktopDocument("desktop-b")],
    });

    expect(onUpdate).not.toHaveBeenCalled();

    listeners.child("desktop-b").onNext(taskSnapshot());

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "cloud-task-a" }),
    ]);
    expect(firestoreMocks.getDocs).not.toHaveBeenCalled();
  });

  it("emits live updates when only task activity changes", () => {
    const onUpdate = vi.fn();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });

    for (const activity of ["working", "unread", "idle"] as const) {
      listeners.child("desktop-a").onNext(taskSnapshot(validTask({
        activity,
        ownerDesktopId: "desktop-a",
      })));
    }

    expect(onUpdate.mock.calls.map(([tasks]) => tasks[0]?.activity)).toEqual([
      "working",
      "unread",
      "idle",
    ]);
  });

  it("accepts task documents whose legacy status field is omitted", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });

    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      status: undefined,
      activity: "working",
      ownerDesktopId: "desktop-a",
    })));

    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "cloud-task-1",
        activity: "working",
      }),
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("publishes only the complete initial Firestore aggregate through the app model", async () => {
    const listeners = captureSnapshotListeners();
    firestoreMocks.getDocs.mockResolvedValue({ docs: [] });
    const taskIndex = createFirestoreTaskIndex({ kind: "firestore" } as never);
    const model = createAppModel({
      authSession: createSignedInAuthSession(),
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock()
      }
    });
    await model.initialize();
    model.sessionStore.setRecentTasks([
      {
        id: "previous-task",
        repoId: "previous-repo",
        title: "Previously accepted task",
        stage: "review"
      }
    ]);
    const acceptedTaskHistory: Array<Array<{ id: string; title: string }>> = [[
      { id: "previous-task", title: "Previously accepted task" }
    ]];
    let resolveFirstNonEmptyPublication!: () => void;
    const firstNonEmptyPublication = new Promise<void>((resolve) => {
      resolveFirstNonEmptyPublication = resolve;
    });
    let previousTasks = model.sessionStore.getState().recentTasks;
    model.sessionStore.subscribe(() => {
      const tasks = model.sessionStore.getState().recentTasks;
      if (tasks === previousTasks) return;
      previousTasks = tasks;
      acceptedTaskHistory.push(
        tasks.map(({ id, title }) => ({ id, title }))
      );
      if (tasks.length > 0) {
        resolveFirstNonEmptyPublication();
      }
    });

    listeners.root().onNext({
      docs: [desktopDocument("desktop-a"), desktopDocument("desktop-b")]
    });
    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "task-a",
      title: "Task A",
      updatedAt: "2026-07-11T00:02:00.000Z"
    })));

    expect(acceptedTaskHistory).toEqual([[
      { id: "previous-task", title: "Previously accepted task" }
    ]]);

    listeners.child("desktop-b").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-b",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b",
      title: "Task B",
      updatedAt: "2026-07-11T00:01:00.000Z"
    })));

    await firstNonEmptyPublication;
    expect(acceptedTaskHistory).toEqual([
      [{ id: "previous-task", title: "Previously accepted task" }],
      [
        { id: "cloud-task-a", title: "Task A" },
        { id: "cloud-task-b", title: "Task B" }
      ]
    ]);
  });

  it("normalizes SQLite, ISO, date-only, and Timestamp-like values before sorting", () => {
    const onUpdate = vi.fn();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });

    listeners.child("desktop-a").onNext(taskSnapshot(
      validTask({
        cloudTaskId: "sqlite-later",
        ownerDesktopId: "desktop-a",
        updatedAt: "2026-07-10 12:30:00",
      }),
      validTask({
        cloudTaskId: "timestamp-middle",
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-2",
        updatedAt: {
          toDate: () => new Date("2026-07-10T06:00:00.000Z"),
        },
      }),
      validTask({
        cloudTaskId: "iso-earlier",
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-3",
        updatedAt: "2026-07-10T00:00:00.000Z",
      }),
      validTask({
        cloudTaskId: "date-only-oldest",
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-4",
        updatedAt: "2026-07-09",
      }),
    ));

    expect(onUpdate.mock.calls[0]?.[0].map((task: { id: string }) => task.id)).toEqual([
      "sqlite-later",
      "timestamp-middle",
      "iso-earlier",
      "date-only-oldest",
    ]);
  });

  it("ignores callbacks from a removed and re-added desktop's old generation", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );

    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });
    const oldGeneration = listeners.child("desktop-a");
    oldGeneration.onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-old",
      ownerDesktopId: "desktop-a",
    })));
    listeners.root().onNext({ docs: [] });
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });

    oldGeneration.onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-resurrected",
      ownerDesktopId: "desktop-a",
    })));
    oldGeneration.onError(new Error("late old-generation error"));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith([]);
    expect(onError).not.toHaveBeenCalled();

    listeners.child("desktop-a", 1).onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-new",
      ownerDesktopId: "desktop-a",
    })));
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "cloud-task-new" }),
    ]);
  });

  it("waits for added desktop hydration before publishing a desktop removal", () => {
    const onUpdate = vi.fn();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
    );

    listeners.root().onNext({
      docs: [desktopDocument("desktop-a"), desktopDocument("desktop-c")],
    });
    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a",
      ownerDesktopId: "desktop-a",
    })));
    listeners.child("desktop-c").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-c",
      ownerDesktopId: "desktop-c",
      ownerLocalTaskId: "task-c",
    })));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    listeners.root().onNext({
      docs: [desktopDocument("desktop-b"), desktopDocument("desktop-c")],
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    listeners.child("desktop-b").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-b",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b",
      updatedAt: "2026-05-14T00:02:00.000Z",
    })));
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1]?.[0].map((task: { id: string }) => task.id)).toEqual([
      "cloud-task-b",
      "cloud-task-c",
    ]);
  });

  it("does not publish a partial aggregate after an initial child error", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({
      docs: [desktopDocument("desktop-a"), desktopDocument("desktop-b")],
    });
    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a",
      ownerDesktopId: "desktop-a",
    })));
    const initialError = new Error("desktop-b initial read failed");

    listeners.child("desktop-b").onError(initialError);

    expect(onError).toHaveBeenLastCalledWith({
      scope: "desktop",
      desktopId: "desktop-b",
      error: initialError,
    });
    expect(onUpdate).not.toHaveBeenCalled();

    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a-new",
      ownerDesktopId: "desktop-a",
      updatedAt: "2026-05-14T00:03:00.000Z",
    })));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("withholds healthy sibling updates after a later child error", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({
      docs: [desktopDocument("desktop-a"), desktopDocument("desktop-b")],
    });
    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a",
      ownerDesktopId: "desktop-a",
    })));
    listeners.child("desktop-b").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-b",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b",
    })));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const laterError = new Error("desktop-a listener failed");
    listeners.child("desktop-a").onError(laterError);
    expect(onError).toHaveBeenLastCalledWith({
      scope: "desktop",
      desktopId: "desktop-a",
      error: laterError,
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    listeners.child("desktop-b").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-b-new",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b",
      updatedAt: "2026-05-14T00:03:00.000Z",
    })));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("retains the last good aggregate and reports root listener errors", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });
    listeners.child("desktop-a").onNext(taskSnapshot(validTask({
      cloudTaskId: "cloud-task-a",
      ownerDesktopId: "desktop-a",
    })));
    const rootError = new Error("desktop index unavailable");

    listeners.root().onError(rootError);

    expect(onError).toHaveBeenCalledWith({ scope: "root", error: rootError });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "cloud-task-a" }),
    ]);
  });

  it("blocks every late callback and error after unsubscribe", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    const unsubscribe = createFirestoreTaskIndex({ kind: "firestore" } as never)
      .subscribeRecentTasks("user-1", onUpdate, onError);
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });
    const child = listeners.child("desktop-a");
    child.onNext(taskSnapshot(validTask({ ownerDesktopId: "desktop-a" })));
    const registrationCount = listeners.registrationCount();

    unsubscribe();
    listeners.root().onNext({ docs: [desktopDocument("desktop-b")] });
    listeners.root().onError(new Error("late root error"));
    child.onNext(taskSnapshot(validTask({ cloudTaskId: "late-task" })));
    child.onError(new Error("late child error"));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(listeners.registrationCount()).toBe(registrationCount);
    expect(listeners.root().unsubscribe).toHaveBeenCalledTimes(1);
    expect(child.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("skips and reports malformed documents without hiding valid peers", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });
    const malformedTasks = [
      validTask({ ownerDesktopId: " " }),
      validTask({ ownerLocalTaskId: " " }),
      validTask({ title: " " }),
      validTask({ stage: " " }),
      validTask({ repo: { cloudRepoId: " ", name: "kanna" } }),
      validTask({ repo: { cloudRepoId: "cloud-repo-1", name: " " } }),
      validTask({ updatedAt: " " }),
    ];
    const timestamp = {
      toDate: () => new Date("2026-05-14T00:02:00.000Z"),
    };

    listeners.child("desktop-a").onNext(taskSnapshot(
      ...malformedTasks,
      validTask({
        cloudTaskId: "valid-timestamp-task",
        ownerDesktopId: "desktop-a",
        updatedAt: timestamp,
      }),
      validTask({
        cloudTaskId: "valid-string-task",
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-2",
      }),
    ));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0].map((task: { id: string }) => task.id)).toEqual([
      "valid-timestamp-task",
      "valid-string-task",
    ]);
    expect(onError).toHaveBeenCalledTimes(malformedTasks.length);
    for (const [error] of onError.mock.calls) {
      expect(error).toMatchObject({ scope: "document", desktopId: "desktop-a" });
      expect(error.error).toBeInstanceOf(Error);
    }
  });

  it("skips and reports a nonblank unsupported timestamp string", () => {
    const onUpdate = vi.fn();
    const onError = vi.fn<(error: CloudTaskIndexError) => void>();
    const listeners = captureSnapshotListeners();
    createFirestoreTaskIndex({ kind: "firestore" } as never).subscribeRecentTasks(
      "user-1",
      onUpdate,
      onError,
    );
    listeners.root().onNext({ docs: [desktopDocument("desktop-a")] });

    listeners.child("desktop-a").onNext(taskSnapshot(
      validTask({
        cloudTaskId: "locale-dependent-invalid",
        ownerDesktopId: "desktop-a",
        updatedAt: "July 10, 2026 12:30",
      }),
      validTask({
        cloudTaskId: "valid-task",
        ownerDesktopId: "desktop-a",
      }),
    ));

    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({ id: "valid-task" }),
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      scope: "document",
      desktopId: "desktop-a",
      error: expect.any(Error),
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

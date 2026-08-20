import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./sessionStore";
import {
  createMobileController,
  type CloudTaskPublication
} from "./mobileController";
import type { MobileAuthSession, MobileAuthState } from "../lib/firebase/auth";
import type {
  TaskAgentStreamEvent,
  TaskAgentSubscription,
  TaskCompanionStreamEvent,
  TaskCompanionSubscription,
  KannaClient,
  TaskSummaryStreamEvent,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../lib/api/client";
import { createKannaClient, TaskCreationError } from "../lib/api/client";
import {
  INPUT_HELD_BY_DRAFT_REASON,
  ServerRefusalError
} from "../lib/transports/serverRefusal";
import type { RepoSummary, TaskSummary } from "../lib/api/types";
import { createCloudLanClient } from "../lib/sources/cloudLanClient";
import { createRemoteTransport, type RemoteDesktopInvoker } from "../lib/transports/remoteTransport";
import { mapCloudTaskSnapshot } from "../lib/firebase/taskIndex";
import type { MachinePairingService } from "../lib/pairing/machinePairing";
import { terminalOutputToString } from "./terminalOutputBuffer";
import { visibleActivityTasks } from "../screens/activityTaskOrder";
import {
  emptyLocalTaskListPreferences,
  type LocalTaskListPreferences
} from "./taskListPreferences";
import type { TaskListPreferencesStore } from "./taskListPreferencesStorage";

function terminalText(store: ReturnType<typeof createSessionStore>): string {
  return terminalOutputToString(store.getState().taskTerminalOutput);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

/** An in-memory stand-in for the phone's AsyncStorage-backed record. */
function createTaskListPreferencesStoreMock(
  initial: LocalTaskListPreferences = emptyLocalTaskListPreferences()
): TaskListPreferencesStore & {
  save: ReturnType<typeof vi.fn>;
  saved(): LocalTaskListPreferences;
} {
  let stored = structuredClone(initial);
  return {
    saved: () => stored,
    load: vi.fn(async () => ({
      status: "loaded" as const,
      preferences: structuredClone(stored)
    })),
    save: vi.fn(async (preferences: LocalTaskListPreferences) => {
      stored = structuredClone(preferences);
      return structuredClone(preferences);
    })
  };
}

async function flushMicrotasks(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createTerminalSubscriptionMock(): {
  subscription: TaskTerminalSubscription;
  emit(event: TaskTerminalStreamEvent): void;
} {
  let listener: ((event: TaskTerminalStreamEvent) => void) | null = null;

  return {
    subscription: {
      close: vi.fn(),
      sendInput: vi.fn(),
      resize: vi.fn(),
      setListener(nextListener) {
        listener = nextListener;
      }
    },
    emit(event) {
      listener?.(event);
    }
  };
}

function createAgentSubscriptionMock(): {
  subscription: TaskAgentSubscription;
  emit(event: TaskAgentStreamEvent): void;
} {
  let listener: ((event: TaskAgentStreamEvent) => void) | null = null;

  return {
    subscription: {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn(),
      setListener(nextListener) {
        listener = nextListener;
      }
    },
    emit(event) {
      listener?.(event);
    }
  };
}

function createCompanionSubscriptionMock(): {
  subscription: TaskCompanionSubscription;
  emit(event: TaskCompanionStreamEvent): void;
} {
  let listener: ((event: TaskCompanionStreamEvent) => void) | null = null;
  return {
    subscription: {
      close: vi.fn(),
      sendEvent: vi.fn(() => true),
      setListener(nextListener: (event: TaskCompanionStreamEvent) => void) {
        listener = nextListener;
      }
    } as TaskCompanionSubscription,
    emit(event) {
      listener?.(event);
    }
  };
}

function createClientMock(): ClientMock {
  const terminalStream = createTerminalSubscriptionMock();
  const agentStream = createAgentSubscriptionMock();
  const companionStream = createCompanionSubscriptionMock();

  return {
    getStatus: vi.fn().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null
    }),
    listDesktops: vi.fn().mockResolvedValue([
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" },
      { id: "desktop-2", name: "Laptop", online: false, mode: "remote" }
    ]),
    listRepos: vi.fn().mockResolvedValue([
      { id: "repo-1", name: "Repo One" },
      { id: "repo-2", name: "Repo Two" }
    ]),
    listRepoTasks: vi.fn().mockImplementation(async (repoId: string) => {
      if (repoId === "repo-2") {
        return [
          {
            id: "task-repo-2",
            repoId: "repo-2",
            title: "Repo Two task",
            stage: "pr"
          }
        ];
      }

      return [
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ];
    }),
    listRepoCommands: vi.fn().mockResolvedValue({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{
        id: "factory:create-agent",
        label: "Create Agent",
        description: "Create a new agent definition",
        group: "configure"
      }]
    }),
    runRepoCommand: vi.fn().mockResolvedValue({
      taskId: "task-command",
      reused: false
    }),
    listRecentTasks: vi.fn().mockResolvedValue([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Refactor mobile shell",
        stage: "in progress"
      }
    ]),
    searchTasks: vi.fn().mockResolvedValue([
      {
        id: "task-2",
        repoId: "repo-2",
        title: "Search result",
        stage: "pr"
      }
    ]),
    createTask: vi.fn().mockResolvedValue({
      taskId: "task-3",
      repoId: "repo-2",
      title: "Ship mobile shell",
      prompt: "Ship mobile shell with the canonical requirements",
      stage: "in progress"
    }),
    abortTaskCreation: vi.fn().mockResolvedValue(undefined),
    runMergeAgent: vi.fn().mockResolvedValue({
      taskId: "task-merge"
    }),
    advanceTaskStage: vi.fn().mockResolvedValue({
      taskId: "task-pr"
    }),
    markTaskRead: vi.fn().mockResolvedValue({
      taskId: "task-1",
      activity: "idle"
    }),
    readTaskFile: vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Spec"
    }),
    resolveTaskFileMentions: vi.fn().mockResolvedValue({
      mentions: [{
        path: "TaskScreen.tsx",
        line: 42,
        matches: [{ path: "src/screens/TaskScreen.tsx" }],
        truncated: false
      }]
    }),
    readTaskDiff: vi.fn().mockResolvedValue({
      taskId: "task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "diff --git a/x b/x",
      truncated: false
    }),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    // The desktop the stub stands for advertises the attachment contract.
    supportsTaskInputAttachments: vi.fn().mockResolvedValue(true),
    closeTask: vi.fn().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn().mockImplementation((_taskId, listener) => {
      terminalStream.subscription.setListener(listener);
      return terminalStream.subscription;
    }),
    observeTaskAgent: vi.fn().mockImplementation((_taskId, listener) => {
      agentStream.subscription.setListener(listener);
      return agentStream.subscription;
    }),
    observeTaskCompanion: vi.fn().mockImplementation((_taskId, listener) => {
      (companionStream.subscription as TaskCompanionSubscription & {
        setListener(listener: (event: TaskCompanionStreamEvent) => void): void;
      }).setListener(listener);
      return companionStream.subscription;
    }),
    __terminalStream: terminalStream,
    __agentStream: agentStream,
    __companionStream: companionStream
  };
}

function createAuthSessionMock(): MobileAuthSession {
  return {
    getState: vi.fn(() => ({ status: "signedOut" })),
    subscribe: vi.fn(() => () => undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
    notifyAuthExpired: vi.fn()
  };
}

describe("createMobileController", () => {
  it("scopes live task summaries to foreground list views", async () => {
    const client = createClientMock();
    const close = vi.fn();
    let summaryListener: ((event: TaskSummaryStreamEvent) => void) | null = null;
    const observe = vi.fn((_desktopId, listener: (event: TaskSummaryStreamEvent) => void) => {
      summaryListener = listener;
      return { close };
    });
    client.observeDesktopTaskSummaries = observe;
    client.listRecentTasks.mockResolvedValue([{
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Streaming summary",
      stage: "in progress",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      waitingPromptSnippet: "resting snippet",
      activity: "idle",
      runtimeState: "idle"
    }]);
    client.listRepoTasks.mockResolvedValue([{
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Streaming summary",
      stage: "in progress",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      waitingPromptSnippet: "resting snippet",
      activity: "idle",
      runtimeState: "idle"
    }]);
    const store = createSessionStore();
    const controller = createMobileController(client, store, createAuthSessionMock());

    controller.setNavigationView("recent");
    await controller.bootstrap();
    expect(observe).toHaveBeenCalledOnce();

    summaryListener?.({
      type: "summary",
      taskId: "task-1",
      snippet: "live snippet",
      activity: "working",
      runtimeState: "busy",
      revision: 1
    });
    expect(store.getState().recentTasks[0]?.waitingPromptSnippet).toBe("live snippet");

    summaryListener?.({ type: "connection", connected: false });
    expect(store.getState().recentTasks[0]?.waitingPromptSnippet).toBe("resting snippet");
    expect(store.getState().recentTasks[0]?.runtimeState).toBe("idle");

    controller.setTaskDetailVisible(true);
    expect(close).toHaveBeenCalledOnce();
    controller.setTaskDetailVisible(false);
    expect(observe).toHaveBeenCalledTimes(2);

    summaryListener?.({
      type: "summary",
      taskId: "task-1",
      snippet: "live snippet after revision reset",
      activity: "working",
      runtimeState: "busy",
      revision: 0
    });
    expect(store.getState().recentTasks[0]?.waitingPromptSnippet).toBe(
      "live snippet after revision reset"
    );

    controller.setAppForeground(false);
    expect(close).toHaveBeenCalledTimes(2);
    controller.setAppForeground(true);
    expect(observe).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  const trustedDesktop = {
    desktopId: "desktop-1",
    displayName: "Studio Mac",
    lanEndpoints: [{
      baseUrl: "http://studio.local:48120",
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    }],
    lastSeenAt: "2026-07-17T00:00:00.000Z"
  };

  function createPairingServiceMock(): MachinePairingService {
    return {
      claimCode: vi.fn().mockResolvedValue(trustedDesktop),
      claimPayload: vi.fn().mockResolvedValue(trustedDesktop)
    };
  }

  it("asks the opened task's own desktop whether it can receive a photo", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.openTask("task-1");
    await flushMicrotasks();

    // The question is asked of the task, not of the connection: the relay's
    // own status describes "Kanna Cloud" and no desktop at all.
    expect(client.supportsTaskInputAttachments).toHaveBeenCalledWith("task-1");
    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(true);
  });

  it("treats a desktop that predates attachments as unable to receive one", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.supportsTaskInputAttachments.mockResolvedValue(false);
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.openTask("task-1");
    await flushMicrotasks();

    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(false);
  });

  it("treats an unreachable desktop as unable to receive one", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.supportsTaskInputAttachments.mockRejectedValue(
      new Error("Desktop offline")
    );
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.openTask("task-1");
    await flushMicrotasks();

    // A desktop that will not answer is not one to send a photo into.
    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(false);
  });

  it("does not carry one task's attachment answer onto the next task opened", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.openTask("task-1");
    await flushMicrotasks();
    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(true);

    client.supportsTaskInputAttachments.mockResolvedValue(false);
    controller.openTask("task-2");
    await flushMicrotasks();

    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(false);
  });

  it("pins locally, with no server write, and lifts the row into its own order", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });
    await controller.bootstrap();
    controller.openTask("task-1");

    await controller.setTaskPinned("task-1", true);

    // The phone's own record is the whole state change: nothing is sent, and
    // the task payload keeps whatever the desktop said about its own pins.
    expect(store.getState().localTaskListPreferences.pins).toEqual([
      { taskId: "task-1", repoId: "repo-1" }
    ]);
    expect(preferences.saved().pins).toEqual([
      { taskId: "task-1", repoId: "repo-1" }
    ]);
    expect(store.getState().repoTasks[0]).not.toMatchObject({ pinned: true });
    expect(store.getState().selectedTaskId).toBe("task-1");

    await controller.setTaskPinned("task-1", false);
    expect(store.getState().localTaskListPreferences.pins).toEqual([]);
    expect(preferences.saved().pins).toEqual([]);
  });

  it("keeps the record it could not write and reports the failure on the row", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });
    await controller.bootstrap();
    preferences.save.mockRejectedValueOnce(new Error("storage full"));

    await expect(controller.setTaskPinned("task-1", true)).rejects.toThrow(
      "Could not pin task: storage full"
    );

    expect(store.getState().localTaskListPreferences.pins).toEqual([]);
    expect(preferences.saved().pins).toEqual([]);
  });

  it("keeps a local pin across refreshes that never mention it", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });
    await controller.bootstrap();
    await controller.selectRepo("repo-1");
    await controller.setTaskPinned("task-1", true);

    // Nothing the desktop reports about its own pin columns moves the phone's
    // record either way.
    const desktopUnpinned: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      pinned: false,
      pinOrder: null
    };
    client.listRecentTasks.mockResolvedValueOnce([desktopUnpinned]);
    client.listRepoTasks.mockResolvedValueOnce([desktopUnpinned]);
    await controller.refresh();

    expect(store.getState().localTaskListPreferences.pins).toEqual([
      { taskId: "task-1", repoId: "repo-1" }
    ]);
  });

  it("seeds pins from desktop pin state once, then leaves the phone in charge", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const desktopPinned: TaskSummary[] = [
      {
        id: "task-later",
        repoId: "repo-1",
        title: "Second desktop pin",
        stage: "review",
        pinned: true,
        pinOrder: 1
      },
      {
        id: "task-first",
        repoId: "repo-1",
        title: "First desktop pin",
        stage: "review",
        pinned: true,
        pinOrder: 0
      },
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Refactor mobile shell",
        stage: "in progress"
      }
    ];
    client.listRecentTasks.mockResolvedValue(desktopPinned);
    client.listRepoTasks.mockResolvedValue(desktopPinned);
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });

    await controller.bootstrap();
    await flushMicrotasks();

    expect(store.getState().localTaskListPreferences).toMatchObject({
      pins: [
        { taskId: "task-first", repoId: "repo-1" },
        { taskId: "task-later", repoId: "repo-1" }
      ],
      pinsSeededFromServer: true
    });

    // Once seeded, an unpin on the phone is not undone by the next snapshot
    // that still reports the desktop pin.
    await controller.setTaskPinned("task-first", false);
    await controller.refresh();
    await flushMicrotasks();
    expect(store.getState().localTaskListPreferences.pins).toEqual([
      { taskId: "task-later", repoId: "repo-1" }
    ]);
  });

  it("prunes entries a snapshot proves are gone but keeps repos it does not cover", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock({
      pins: [
        { taskId: "task-1", repoId: "repo-1" },
        { taskId: "task-closed", repoId: "repo-1" },
        { taskId: "task-other-machine", repoId: "repo-elsewhere" }
      ],
      dismissedActivity: [
        { taskId: "task-1", repoId: "repo-1", activityRevision: 7 }
      ],
      pinsSeededFromServer: true
    });
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });

    await controller.bootstrap();
    await flushMicrotasks();

    // `task-closed` is gone from the all-open-tasks snapshot, and `task-1` is
    // no longer unread, so both entries go. The pin for a repo this snapshot
    // says nothing about survives.
    expect(store.getState().localTaskListPreferences).toEqual({
      pins: [
        { taskId: "task-1", repoId: "repo-1" },
        { taskId: "task-other-machine", repoId: "repo-elsewhere" }
      ],
      dismissedActivity: [],
      pinsSeededFromServer: true
    });
  });

  it("dismisses activity on the phone alone, leaving the desktop unread", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });
    await controller.bootstrap();
    client.markTaskRead.mockClear();
    const unread: TaskSummary[] = [
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Unread task",
        stage: "review",
        activity: "unread",
        activityRevision: 7
      }
    ];
    store.setRepoTasks(unread);
    store.setRecentTasks(unread);

    await controller.dismissActivity("task-1");

    expect(client.markTaskRead).not.toHaveBeenCalled();
    expect(store.getState().localTaskListPreferences.dismissedActivity).toEqual([
      { taskId: "task-1", repoId: "repo-1", activityRevision: 7 }
    ]);
    expect(preferences.saved().dismissedActivity).toEqual([
      { taskId: "task-1", repoId: "repo-1", activityRevision: 7 }
    ]);
    // Desktop read state stays authoritative for the desktop: the row the
    // phone hides is still unread everywhere else.
    expect(store.getState().recentTasks[0]).toMatchObject({
      activity: "unread",
      activityRevision: 7
    });
    expect(visibleActivityTasks(
      store.getState().recentTasks,
      store.getState().localTaskListPreferences
    )).toEqual([]);
  });

  it("brings a dismissed row back when the task produces newer activity", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const preferences = createTaskListPreferencesStoreMock();
    const controller = createMobileController(client, store, undefined, {
      taskListPreferencesStore: preferences
    });
    await controller.bootstrap();
    const unread: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Unread task",
      stage: "review",
      activity: "unread",
      activityRevision: 7
    };
    store.setRepoTasks([unread]);
    store.setRecentTasks([unread]);
    await controller.dismissActivity("task-1");

    const newerActivity: TaskSummary = { ...unread, activityRevision: 8 };
    client.listRecentTasks.mockResolvedValueOnce([newerActivity]);
    client.listRepoTasks.mockResolvedValueOnce([newerActivity]);
    await controller.refresh();
    await flushMicrotasks();

    expect(
      store.getState().localTaskListPreferences.dismissedActivity
    ).toEqual([]);
    expect(
      visibleActivityTasks(
        store.getState().recentTasks,
        store.getState().localTaskListPreferences
      ).map((task) => task.id)
    ).toEqual(["task-1"]);
  });

  it("marks polled task collections ready after bootstrap", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.bootstrap();

    expect(store.getState().taskCollectionStatus).toBe("ready");
  });

  it("waits for an authoritative live cloud task publication", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    let liveUpdate: ((
      tasks: TaskSummary[],
      publication?: CloudTaskPublication
    ) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    expect(store.getState().taskCollectionStatus).toBe("loading");

    liveUpdate?.([], { cloudAuthoritative: false });
    expect(store.getState().taskCollectionStatus).toBe("loading");

    liveUpdate?.([], { cloudAuthoritative: true });
    expect(store.getState().taskCollectionStatus).toBe("ready");
  });

  it("stops initial collection loading when the live subscription errors", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    let liveError: ((error: unknown) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, _onUpdate, onError) => {
        liveError = onError ?? null;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveError?.(new Error("cloud tasks unavailable"));

    expect(store.getState().taskCollectionStatus).toBe("error");
  });

  it("pairs by code without auth and refreshes machine sources", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const pairingService = createPairingServiceMock();
    const replaceClientForTrustChange = vi.fn();
    const controller = createMobileController(client, store, undefined, {
      pairingService,
      persistSessionContext: vi.fn().mockResolvedValue(undefined),
      replaceClientForTrustChange
    });

    await expect(controller.pairMachineByCode("ABC123")).resolves.toBe("desktop-1");

    expect(pairingService.claimCode).toHaveBeenCalledWith("ABC123");
    expect(store.getState().trustedDesktops).toContainEqual(trustedDesktop);
    expect(replaceClientForTrustChange).toHaveBeenCalledTimes(1);
    expect(client.listDesktops).toHaveBeenCalled();
  });

  it("loads the paired machine's work, showing loading until it lands", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let releaseTasks!: () => void;
    const pendingTasks = new Promise<void>((resolve) => { releaseTasks = resolve; });
    const recentTasks = await client.listRecentTasks();
    client.listRecentTasks.mockImplementation(async () => {
      await pendingTasks;
      return recentTasks;
    });
    const controller = createMobileController(client, store, undefined, {
      pairingService: createPairingServiceMock(),
      persistSessionContext: vi.fn().mockResolvedValue(undefined),
      replaceClientForTrustChange: vi.fn()
    });

    const paired = controller.pairMachineByPayload("pairing-payload");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().taskCollectionStatus).toBe("loading");

    releaseTasks();
    await paired;

    expect(client.listRepos).toHaveBeenCalled();
    expect(client.listRecentTasks).toHaveBeenCalled();
    expect(store.getState().recentTasks).not.toHaveLength(0);
    expect(store.getState().connectionState).toBe("connected");
    expect(store.getState().taskCollectionStatus).toBe("ready");
  });

  it("still refreshes the machine inventory when the paired desktop is not running", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.getStatus.mockResolvedValue({
      state: "stopped",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null
    });
    const controller = createMobileController(client, store, undefined, {
      pairingService: createPairingServiceMock(),
      persistSessionContext: vi.fn().mockResolvedValue(undefined),
      replaceClientForTrustChange: vi.fn()
    });

    await controller.pairMachineByCode("ABC123");

    expect(client.listDesktops).toHaveBeenCalled();
  });

  it("merges a QR claim into an existing machine instead of duplicating", async () => {
    const store = createSessionStore();
    store.setTrustedDesktops([{
      ...trustedDesktop,
      lanEndpoints: [{
        baseUrl: "http://studio-old.local:48120",
        lastSeenAt: "2026-07-16T00:00:00.000Z"
      }],
      lastSeenAt: "2026-07-16T00:00:00.000Z"
    }]);
    const pairingService = createPairingServiceMock();
    const controller = createMobileController(
      createClientMock(),
      store,
      undefined,
      {
        pairingService,
        persistSessionContext: vi.fn().mockResolvedValue(undefined),
        replaceClientForTrustChange: vi.fn()
      }
    );

    await controller.pairMachineByPayload("pairing-payload");

    expect(store.getState().trustedDesktops).toHaveLength(1);
    expect(store.getState().trustedDesktops[0].lanEndpoints).toEqual([
      trustedDesktop.lanEndpoints[0],
      expect.objectContaining({ baseUrl: "http://studio-old.local:48120" })
    ]);
  });

  it("keeps an existing device secret when a re-pair response omits one", async () => {
    const store = createSessionStore();
    store.setTrustedDesktops([
      { ...trustedDesktop, deviceSecret: "existing-lan-secret" }
    ]);
    const pairingService = createPairingServiceMock();
    const controller = createMobileController(
      createClientMock(),
      store,
      undefined,
      {
        pairingService,
        persistSessionContext: vi.fn().mockResolvedValue(undefined),
        replaceClientForTrustChange: vi.fn()
      }
    );

    await controller.pairMachineByPayload("pairing-payload");

    expect(store.getState().trustedDesktops).toHaveLength(1);
    expect(store.getState().trustedDesktops[0].deviceSecret).toBe(
      "existing-lan-secret"
    );
  });

  it("removes manual trust without deleting the account descriptor", async () => {
    const store = createSessionStore();
    const accountDesktop = {
      id: "desktop-1",
      name: "Studio Mac",
      online: true,
      mode: "remote" as const
    };
    store.setDesktops([accountDesktop]);
    store.setTrustedDesktops([trustedDesktop]);
    const client = createClientMock();
    vi.mocked(client.listDesktops).mockResolvedValue([accountDesktop]);
    const controller = createMobileController(
      client,
      store,
      undefined,
      {
        pairingService: createPairingServiceMock(),
        persistSessionContext: vi.fn().mockResolvedValue(undefined),
        replaceClientForTrustChange: vi.fn()
      }
    );

    await controller.removeManualMachine("desktop-1");

    expect(store.getState().trustedDesktops).toEqual([]);
    expect(store.getState().desktops).toEqual([accountDesktop]);
  });

  it("keeps manual trust published until durable removal succeeds", async () => {
    const store = createSessionStore();
    store.setTrustedDesktops([trustedDesktop]);
    const persistence = createDeferred<void>();
    const persistSessionContext = vi.fn(() => persistence.promise);
    const controller = createMobileController(
      createClientMock(),
      store,
      undefined,
      { persistSessionContext }
    );

    const removal = controller.removeManualMachine("desktop-1");
    await flushMicrotasks();

    expect(store.getState().trustedDesktops).toEqual([trustedDesktop]);
    expect(persistSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({ trustedDesktops: [] })
    );

    persistence.reject(new Error("storage unavailable"));
    await expect(removal).rejects.toThrow("storage unavailable");
    expect(store.getState().trustedDesktops).toEqual([trustedDesktop]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes canonical task collections before opening a command task single-flight", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const run = createDeferred<{ taskId: string; reused: boolean }>();
    client.runRepoCommand.mockReturnValue(run.promise);
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.setNavigationView("more");
    await flushMicrotasks();
    expect(client.listRepoCommands).toHaveBeenCalledWith("repo-1");
    expect(store.getState()).toMatchObject({
      repoCommandStatus: "ready",
      repoCommandCatalog: { revision: "catalog-v1" }
    });

    const canonicalTask = {
      id: "task-command",
      repoId: "repo-1",
      title: "Canonical server title",
      prompt: "Canonical server prompt",
      stage: "review",
      agentProvider: "codex",
      agentType: "agent" as const
    };
    const events: string[] = [];
    client.listRecentTasks.mockImplementation(async () => {
      events.push("refresh recent");
      return [canonicalTask];
    });
    client.listRepoTasks.mockImplementation(async () => {
      events.push("refresh repo");
      return [canonicalTask];
    });
    client.observeTaskAgent.mockImplementation((taskId, listener) => {
      events.push(`open ${taskId}`);
      client.__agentStream.subscription.setListener(listener);
      return client.__agentStream.subscription;
    });

    const first = controller.runRepoCommand("factory:create-agent");
    const selection = controller.selectRepo("repo-2");
    const duplicate = controller.runRepoCommand("factory:create-agent");
    expect(client.runRepoCommand).toHaveBeenCalledTimes(1);
    expect(store.getState().runningRepoCommandId).toBe("factory:create-agent");
    await selection;
    expect(store.getState().selectedRepoId).toBe("repo-1");
    expect(client.listRepoTasks).not.toHaveBeenCalledWith("repo-2");
    run.resolve({ taskId: "task-command", reused: false });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-command",
      activeView: "more",
      runningRepoCommandId: null
    });
    expect(firstResult).toBe("task-command");
    expect(duplicateResult).toBeNull();
    expect(events).toEqual([
      "refresh recent",
      "refresh repo",
      "open task-command"
    ]);
    expect(store.getState().recentTasks).toEqual([canonicalTask]);
    expect(store.getState().repoTasks).toEqual([canonicalTask]);
  });

  it("retains and retries a created command task when canonical loading fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    const openedTaskIds: string[] = [];
    controller.subscribeRepoCommandTaskOpen((taskId) => {
      openedTaskIds.push(taskId);
    });
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();
    const canonicalTask = {
      id: "task-command",
      repoId: "repo-1",
      title: "Canonical command task",
      stage: "in progress",
      agentType: "agent" as const
    };
    client.listRecentTasks
      .mockRejectedValueOnce(new Error("canonical refresh failed"))
      .mockResolvedValueOnce([canonicalTask]);
    client.listRepoTasks.mockResolvedValue([canonicalTask]);

    await controller.runRepoCommand("factory:create-agent");

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      connectionState: "connected",
      errorMessage: null,
      repoCommandStatus: "error",
      repoCommandErrorMessage:
        "The command launched successfully, but its task could not be loaded. Check your connection and try again.",
      pendingRepoCommandTask: {
        commandId: "factory:create-agent",
        taskId: "task-command"
      },
      runningRepoCommandId: null
    });
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();
    expect(client.observeTaskAgent).not.toHaveBeenCalled();

    const commandCatalogReads = client.listRepoCommands.mock.calls.length;
    const retriedTaskId = await controller.retryRepoCommand();

    expect(client.listRepoCommands).toHaveBeenCalledTimes(
      commandCatalogReads + 1
    );
    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-command",
      activeView: "more",
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: null,
      runningRepoCommandId: null
    });
    expect(retriedTaskId).toBe("task-command");
    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      "task-command",
      expect.any(Function)
    );
    expect(openedTaskIds).toEqual([]);
  });

  it("opens a command task when a later collection refresh makes it visible", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    const openedTaskIds: string[] = [];
    const unsubscribe = controller.subscribeRepoCommandTaskOpen((taskId) => {
      openedTaskIds.push(taskId);
    });
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();
    client.listRecentTasks.mockResolvedValueOnce([]);
    client.listRepoTasks.mockResolvedValueOnce([]);

    await controller.runRepoCommand("factory:create-agent");

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      repoCommandStatus: "error",
      pendingRepoCommandTask: { taskId: "task-command" }
    });

    const canonicalTask: TaskSummary = {
      id: "task-command",
      repoId: "repo-1",
      title: "Canonical command task",
      stage: "in progress",
      agentType: "agent"
    };
    client.listRecentTasks.mockResolvedValueOnce([canonicalTask]);
    client.listRepoTasks.mockResolvedValueOnce([canonicalTask]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-command",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: null,
      runningRepoCommandId: null
    });
    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      "task-command",
      expect.any(Function)
    );
    expect(openedTaskIds).toEqual(["task-command"]);

    unsubscribe();
  });

  it("retries both task resolution and the command catalog from a latched error", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();
    client.listRecentTasks.mockResolvedValueOnce([]);
    client.listRepoTasks.mockResolvedValueOnce([]);

    await controller.runRepoCommand("factory:create-agent");

    store.markRepoCommandsUnavailable("repo-1");
    const canonicalTask: TaskSummary = {
      id: "task-command",
      repoId: "repo-1",
      title: "Canonical command task",
      stage: "in progress",
      agentType: "agent"
    };
    client.listRecentTasks.mockResolvedValueOnce([canonicalTask]);
    client.listRepoTasks.mockResolvedValueOnce([canonicalTask]);
    client.listRepoCommands.mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v2",
      commands: []
    });
    const catalogReads = client.listRepoCommands.mock.calls.length;

    await expect(controller.retryRepoCommand()).resolves.toBe("task-command");

    expect(client.listRepoCommands).toHaveBeenCalledTimes(catalogReads + 1);
    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-command",
      repoCommandCatalog: { revision: "catalog-v2" },
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: null,
      runningRepoCommandId: null,
      unavailableRepoCommandIds: []
    });
  });

  it("refreshes the command catalog when retry leaves the created task pending", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();
    client.listRecentTasks.mockResolvedValue([]);
    client.listRepoTasks.mockResolvedValue([]);

    await controller.runRepoCommand("factory:create-agent");

    store.markRepoCommandsUnavailable("repo-1");
    client.listRepoCommands.mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v2",
      commands: []
    });
    const catalogReads = client.listRepoCommands.mock.calls.length;

    await expect(controller.retryRepoCommand()).resolves.toBeNull();

    expect(client.listRepoCommands).toHaveBeenCalledTimes(catalogReads + 1);
    expect(store.getState()).toMatchObject({
      repoCommandCatalog: {
        repoId: "repo-1",
        revision: "catalog-v2"
      },
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      pendingRepoCommandTask: { taskId: "task-command" },
      runningRepoCommandId: null,
      unavailableRepoCommandIds: []
    });
  });

  it("does not let a catalog reload erase a command task loading failure", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const commandRun = createDeferred<{ taskId: string; reused: boolean }>();
    const catalogReload = createDeferred<Awaited<
      ReturnType<KannaClient["listRepoCommands"]>
    >>();
    client.runRepoCommand.mockReturnValueOnce(commandRun.promise);
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();
    client.listRecentTasks.mockRejectedValueOnce(
      new Error("canonical refresh failed")
    );
    client.listRepoCommands.mockReturnValueOnce(catalogReload.promise);

    const launch = controller.runRepoCommand("factory:create-agent");
    const reload = controller.loadRepoCommands();
    commandRun.resolve({ taskId: "task-command", reused: false });
    await launch;
    catalogReload.resolve({
      repoId: "repo-1",
      revision: "catalog-v2",
      commands: []
    });
    await reload;

    expect(store.getState()).toMatchObject({
      repoCommandStatus: "error",
      repoCommandErrorMessage:
        "The command launched successfully, but its task could not be loaded. Check your connection and try again.",
      pendingRepoCommandTask: { taskId: "task-command" },
      runningRepoCommandId: null
    });
  });

  it("does not open a command task from a stale collection refresh", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    controller.setNavigationView("more");
    await flushMicrotasks();

    const recent = createDeferred<TaskSummary[]>();
    const repo = createDeferred<TaskSummary[]>();
    client.listRecentTasks.mockReturnValueOnce(recent.promise);
    client.listRepoTasks.mockReturnValueOnce(repo.promise);

    const launch = controller.runRepoCommand("factory:create-agent");
    await flushMicrotasks();
    controller.openTask("task-1");
    const canonicalTask = {
      id: "task-command",
      repoId: "repo-1",
      title: "Canonical command task",
      stage: "in progress"
    };
    recent.resolve([canonicalTask]);
    repo.resolve([canonicalTask]);
    const launchedTaskId = await launch;

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-1",
      activeView: "more",
      repoCommandStatus: "error",
      pendingRepoCommandTask: { taskId: "task-command" },
      runningRepoCommandId: null
    });
    expect(launchedTaskId).toBeNull();
    expect(client.observeTaskTerminal).not.toHaveBeenCalledWith(
      "task-command",
      expect.any(Function)
    );
  });

  it("bootstraps connection, desktops, repos, and recent tasks", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.bootstrap();

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      connectionMode: "lan",
      desktopName: "Studio Mac",
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-1",
      activeView: "tasks"
    });
    expect(store.getState().recentTasks).toHaveLength(1);
    expect(store.getState().repoTasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("does not switch repositories when the selected command catalog fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands
      .mockRejectedValueOnce(new Error("404 repo not found: repo-1"))
      .mockResolvedValueOnce({
        repoId: "repo-2",
        revision: "catalog-repo-2",
        commands: []
      });
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    controller.setNavigationView("more");
    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({
        selectedRepoId: "repo-1",
        repoCommandStatus: "error",
        repoCommandErrorMessage: "404 repo not found: repo-1",
        unavailableRepoCommandIds: ["repo-1"]
      });
    });

    expect(store.getState().repos.map((repo) => repo.id)).toEqual([
      "repo-1",
      "repo-2"
    ]);
    expect(client.listRepoCommands.mock.calls).toEqual([["repo-1"]]);
  });

  it("reports an error when the selected repository command catalog fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands.mockRejectedValue(new Error("repo unavailable"));
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    await controller.loadRepoCommands();

    expect(client.listRepoCommands).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      repoCommandStatus: "error",
      repoCommandErrorMessage: "repo unavailable",
      unavailableRepoCommandIds: ["repo-1"]
    });
  });

  it("keeps the last-good command catalog when its refresh fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "catalog-v1",
        commands: [{
          id: "factory:create-agent",
          label: "Create Agent",
          description: "Create a new agent definition",
          group: "configure"
        }]
      })
      .mockRejectedValueOnce(new Error("Relay connection closed."));
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    await controller.loadRepoCommands();
    await controller.loadRepoCommands();

    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      repoCommandCatalog: {
        repoId: "repo-1",
        revision: "catalog-v1"
      },
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      unavailableRepoCommandIds: []
    });
    expect(client.listRepoCommands).toHaveBeenCalledTimes(2);
  });

  it("restores cached commands while a repository refresh is in flight", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const repoOneRefresh = createDeferred<Awaited<
      ReturnType<KannaClient["listRepoCommands"]>
    >>();
    client.listRepoCommands
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "repo-1-v1",
        commands: []
      })
      .mockResolvedValueOnce({
        repoId: "repo-2",
        revision: "repo-2-v1",
        commands: []
      })
      .mockReturnValueOnce(repoOneRefresh.promise);
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    controller.setNavigationView("more");
    await vi.waitFor(() => {
      expect(store.getState().repoCommandCatalog?.revision).toBe("repo-1-v1");
    });
    await controller.selectRepo("repo-2");

    const selection = controller.selectRepo("repo-1");
    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({
        selectedRepoId: "repo-1",
        repoCommandCatalog: { revision: "repo-1-v1" },
        repoCommandStatus: "ready"
      });
    });

    repoOneRefresh.resolve({
      repoId: "repo-1",
      revision: "repo-1-v2",
      commands: []
    });
    await selection;
    expect(store.getState().repoCommandCatalog?.revision).toBe("repo-1-v2");
  });

  it("replaces a cached command catalog after a successful refresh", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "catalog-v1",
        commands: []
      })
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "catalog-v2",
        commands: []
      });
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    await controller.loadRepoCommands();
    await controller.loadRepoCommands();

    expect(store.getState().repoCommandCatalog?.revision).toBe("catalog-v2");
  });

  it("does not retain commands after the server rejects their catalog revision", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "catalog-v1",
        commands: [
          {
            id: "factory:create-agent",
            label: "Create Agent",
            description: "Create a new agent definition",
            group: "configure"
          }
        ]
      })
      .mockRejectedValue(new Error("Relay connection closed."));
    client.runRepoCommand.mockRejectedValueOnce(
      new Error("Remote desktop request failed with status 409.")
    );
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    await controller.loadRepoCommands();
    store.setRepos([{ id: "repo-1", name: "Repo One" }]);

    await controller.runRepoCommand("factory:create-agent");

    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      repoCommandCatalog: null,
      repoCommandStatus: "error",
      repoCommandErrorMessage: "Relay connection closed."
    });
  });

  it("keeps an empty successful catalog instead of falling through", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands.mockResolvedValue({
      repoId: "repo-1",
      revision: "empty-catalog",
      commands: []
    });
    const controller = createMobileController(client, store);
    await controller.bootstrap();

    await controller.loadRepoCommands();

    expect(client.listRepoCommands).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      repoCommandStatus: "ready",
      unavailableRepoCommandIds: []
    });
  });

  it("retries repositories previously marked command-unavailable", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listRepoCommands.mockRejectedValue(new Error("repo unavailable"));
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    await controller.loadRepoCommands();
    store.markRepoCommandsUnavailable("repo-1");
    store.markRepoCommandsUnavailable("repo-2");
    client.listRepoCommands.mockReset().mockResolvedValue({
      repoId: store.getState().selectedRepoId!,
      revision: "recovered",
      commands: []
    });

    await controller.retryRepoCommand();

    expect(client.listRepoCommands).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      repoCommandStatus: "ready",
      unavailableRepoCommandIds: []
    });
  });

  it("reads a task file through the client without mutating global errors", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    store.setErrorMessage("existing error");

    await expect(
      controller.readTaskFile("task-1", "docs/spec.md")
    ).resolves.toEqual({
      path: "docs/spec.md",
      content: "# Spec"
    });
    expect(client.readTaskFile).toHaveBeenCalledWith("task-1", "docs/spec.md");
    expect(store.getState().errorMessage).toBe("existing error");
  });

  it("resolves mentioned task files without mutating global errors", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    store.setErrorMessage("existing error");

    await expect(
      controller.resolveTaskFileMentions("task-1", [
        { path: "TaskScreen.tsx", line: 42 }
      ])
    ).resolves.toMatchObject({
      mentions: [{ matches: [{ path: "src/screens/TaskScreen.tsx" }] }]
    });
    expect(client.resolveTaskFileMentions).toHaveBeenCalledWith(
      "task-1",
      [{ path: "TaskScreen.tsx", line: 42 }]
    );
    expect(store.getState().errorMessage).toBe("existing error");
  });

  it("reads the task diff through the client without mutating global errors", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    store.setErrorMessage("existing error");

    await expect(controller.readTaskDiff("task-1")).resolves.toMatchObject({
      patch: "diff --git a/x b/x"
    });
    expect(client.readTaskDiff).toHaveBeenCalledWith("task-1", undefined);
    expect(store.getState().errorMessage).toBe("existing error");
  });

  it("queues a complete trailing bootstrap requested during an active run", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const firstStatus = createDeferred<
      Awaited<ReturnType<KannaClient["getStatus"]>>
    >();
    const stoppedStatus = {
      state: "stopped" as const,
      desktopId: "none",
      desktopName: "No desktop",
      lanHost: "none",
      lanPort: 0,
      pairingCode: null
    };
    client.getStatus
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce(stoppedStatus);
    const controller = createMobileController(client, store);

    const firstBootstrap = controller.bootstrap();
    await Promise.resolve();
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    const trailingBootstrap = controller.bootstrap();
    firstStatus.resolve(stoppedStatus);

    await Promise.all([firstBootstrap, trailingBootstrap]);

    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });

  it("starts a new bootstrap in the runner settlement microtask boundary", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const firstStatus = createDeferred<
      Awaited<ReturnType<KannaClient["getStatus"]>>
    >();
    const stoppedStatus = {
      state: "stopped" as const,
      desktopId: "none",
      desktopName: "No desktop",
      lanHost: "none",
      lanPort: 0,
      pairingCode: null
    };
    client.getStatus
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce(stoppedStatus);
    const controller = createMobileController(client, store);

    const firstBootstrap = controller.bootstrap();
    await Promise.resolve();
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    let boundaryBootstrap: Promise<void> | null = null;
    void firstStatus.promise.then(() => {
      void Promise.resolve().then(() => {
        boundaryBootstrap = controller.bootstrap();
      });
    });
    firstStatus.resolve(stoppedStatus);

    await firstBootstrap;
    await flushMicrotasks();

    expect(client.getStatus).toHaveBeenCalledTimes(2);
    await boundaryBootstrap;
  });

  it("does not attach a session for a blocked task and attaches once unblocked", async () => {
    const blockedTask: TaskSummary = {
      id: "task-blocked",
      repoId: "repo-1",
      title: "Blocked task",
      stage: "in progress",
      blockedByTaskIds: ["task-blocker"]
    };
    const store = createSessionStore();
    const client = createClientMock();
    client.listRecentTasks.mockResolvedValue([blockedTask]);
    client.listRepoTasks.mockResolvedValue([blockedTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(blockedTask.id);

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-blocked",
      taskTerminalTaskId: null,
      taskAgentTaskId: null
    });
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();
    expect(client.observeTaskAgent).not.toHaveBeenCalled();

    const unblockedTask = { ...blockedTask, blockedByTaskIds: [] };
    client.listRecentTasks.mockResolvedValue([unblockedTask]);
    client.listRepoTasks.mockResolvedValue([unblockedTask]);
    await controller.refresh();

    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      "task-blocked",
      expect.any(Function)
    );
    expect(store.getState().taskTerminalTaskId).toBe("task-blocked");
  });

  it("does not start a task stream when openTask cannot resolve the task", () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    controller.openTask("missing-task");

    expect(store.getState()).toMatchObject({
      selectedTaskId: "missing-task",
      taskTerminalTaskId: null,
      taskAgentTaskId: null
    });
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();
    expect(client.observeTaskAgent).not.toHaveBeenCalled();
  });

  it("opens a task without rewriting the navigation projection", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.setNavigationView("recent");
    controller.openTask("task-1");

    expect(store.getState()).toMatchObject({
      activeView: "recent",
      selectedTaskId: "task-1"
    });
  });

  it("replaces a bounded cloud prompt with full owner detail while its terminal is open", async () => {
    const fullPrompt = `${"p".repeat(520)}END-OF-CANONICAL-PROMPT`;
    const promptSnippet = fullPrompt.slice(0, 500);
    const cloudTask: TaskSummary = {
      id: "cloud-task-1",
      repoId: "cloud-repo-1",
      title: "Long cloud task",
      prompt: promptSnippet,
      stage: "in progress",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "local-repo-1",
      ownerLocalTaskId: "local-task-1"
    };
    const detail = createDeferred<Awaited<ReturnType<NonNullable<KannaClient["getTask"]>>>>();
    const store = createSessionStore();
    const client = createClientMock();
    client.listRecentTasks.mockResolvedValue([cloudTask]);
    client.listRepoTasks.mockResolvedValue([cloudTask]);
    client.getTask = vi.fn(() => detail.promise);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(cloudTask.id);

    expect(client.getTask).toHaveBeenCalledWith(cloudTask.id);
    expect(store.getState().recentTasks[0]?.prompt).toBe(promptSnippet);

    detail.resolve({ ...cloudTask, prompt: fullPrompt });
    await flushMicrotasks();

    expect(store.getState().selectedTaskId).toBe(cloudTask.id);
    expect(store.getState().recentTasks[0]?.prompt).toBe(fullPrompt);
    expect(store.getState().repoTasks[0]?.prompt).toBe(fullPrompt);
    expect(store.getState().recentTasks[0]?.prompt).toContain(
      "END-OF-CANONICAL-PROMPT"
    );
  });

  it("keeps the bounded prompt fallback when owner task detail fails", async () => {
    const promptSnippet = "p".repeat(500);
    const cloudTask: TaskSummary = {
      id: "cloud-task-1",
      repoId: "cloud-repo-1",
      title: "Long cloud task",
      prompt: promptSnippet,
      stage: "in progress"
    };
    const store = createSessionStore();
    const client = createClientMock();
    client.listRecentTasks.mockResolvedValue([cloudTask]);
    client.listRepoTasks.mockResolvedValue([cloudTask]);
    client.getTask = vi.fn().mockRejectedValue(new Error("owner offline"));
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(cloudTask.id);
    await flushMicrotasks();

    expect(store.getState().recentTasks[0]?.prompt).toBe(promptSnippet);
    expect(store.getState().selectedTaskId).toBe(cloudTask.id);
    expect(store.getState().taskTerminalTaskId).toBe(cloudTask.id);
    expect(store.getState().errorMessage).toBeNull();
  });

  it("allows a later detail retry when a legacy owner omits prompt", async () => {
    const cloudTask = {
      id: "cloud-task-1",
      repoId: "cloud-repo-1",
      title: "Legacy cloud task",
      prompt: "bounded prompt",
      stage: "in progress"
    } satisfies TaskSummary;
    const store = createSessionStore();
    const client = createClientMock();
    client.listRecentTasks.mockResolvedValue([cloudTask]);
    client.listRepoTasks.mockResolvedValue([cloudTask]);
    client.getTask = vi.fn()
      .mockResolvedValueOnce({ ...cloudTask, prompt: null })
      .mockResolvedValueOnce({ ...cloudTask, prompt: "Full prompt after retry" });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(cloudTask.id);
    await flushMicrotasks();
    controller.openTask(cloudTask.id);
    await flushMicrotasks();

    expect(client.getTask).toHaveBeenCalledTimes(2);
    expect(store.getState().recentTasks[0]?.prompt).toBe(
      "Full prompt after retry"
    );
  });

  it("ignores owner detail that resolves after a different task is opened", async () => {
    const firstTask = {
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "First task",
      prompt: "first snippet",
      stage: "in progress"
    } satisfies TaskSummary;
    const secondTask = {
      id: "cloud-task-2",
      repoId: "repo-1",
      title: "Second task",
      prompt: "second snippet",
      stage: "in progress"
    } satisfies TaskSummary;
    const firstDetail = createDeferred<Awaited<ReturnType<NonNullable<KannaClient["getTask"]>>>>();
    const store = createSessionStore();
    const client = createClientMock();
    client.listRecentTasks.mockResolvedValue([firstTask, secondTask]);
    client.listRepoTasks.mockResolvedValue([firstTask, secondTask]);
    client.getTask = vi.fn((taskId: string) =>
      taskId === firstTask.id
        ? firstDetail.promise
        : Promise.resolve(secondTask)
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(firstTask.id);
    controller.openTask(secondTask.id);
    firstDetail.resolve({
      ...firstTask,
      prompt: `${"p".repeat(520)}STALE-END-SENTINEL`
    });
    await flushMicrotasks();

    expect(store.getState().selectedTaskId).toBe(secondTask.id);
    expect(store.getState().recentTasks.find((task) => task.id === firstTask.id)?.prompt)
      .toBe("first snippet");
  });

  it("preserves last-good remote collections until the first live snapshot without polling", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const oldTask: TaskSummary = {
      id: "old-task",
      repoId: "old-repo",
      repoName: "Old Repo",
      title: "Old replacement result",
      stage: "in progress"
    };
    const replacementTask: TaskSummary = {
      id: "replacement-task",
      repoId: "replacement-repo",
      repoName: "Replacement Repo",
      title: "Replacement result",
      stage: "review"
    };
    store.setRepos([{ id: oldTask.repoId, name: "Old Repo" }]);
    store.setRecentTasks([oldTask]);
    store.setRepoTasks([oldTask]);
    store.setSearchResults("replacement", [oldTask]);
    store.setSelectedTask(oldTask.id);
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos.mockResolvedValue([
      { id: replacementTask.repoId, name: "Replacement Repo" }
    ]);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();

    expect(client.listRepos).not.toHaveBeenCalled();
    expect(client.listRecentTasks).not.toHaveBeenCalled();
    expect(client.listRepoTasks).not.toHaveBeenCalled();
    expect(client.searchTasks).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      recentTasks: [oldTask],
      repoTasks: [oldTask],
      searchResults: [oldTask],
      selectedTaskId: oldTask.id
    });

    liveUpdate?.([replacementTask]);

    expect(store.getState()).toMatchObject({
      recentTasks: [replacementTask],
      searchResults: [replacementTask],
      selectedTaskId: null
    });
    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({
        repos: [{ id: replacementTask.repoId, name: "Replacement Repo" }],
        selectedRepoId: replacementTask.repoId,
        repoTasks: [replacementTask]
      });
    });
    expect(store.getState()).toMatchObject({
      recentTasks: [replacementTask],
      searchResults: [replacementTask],
      selectedTaskId: null
    });
  });

  it("ignores obsolete live callbacks and accepts the current empty snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const selectedTask: TaskSummary = {
      id: "selected-task",
      repoId: "repo-1",
      repoName: "Repo One",
      title: "Selected task",
      stage: "in progress"
    };
    store.setRepos([{ id: selectedTask.repoId, name: "Repo One" }]);
    store.setRecentTasks([selectedTask]);
    store.setRepoTasks([selectedTask]);
    store.setSearchResults("selected", [selectedTask]);
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos.mockResolvedValue([]);
    const subscriptions: Array<{
      onUpdate: (tasks: TaskSummary[]) => void;
      onError: (error: unknown) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate, onError) => {
        const unsubscribe = vi.fn();
        subscriptions.push({
          onUpdate,
          onError: onError ?? (() => undefined),
          unsubscribe
        });
        return unsubscribe;
      })
    });

    await controller.bootstrap();
    controller.openTask(selectedTask.id);
    await controller.refresh();

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      recentTasks: [selectedTask],
      selectedTaskId: selectedTask.id,
      taskTerminalTaskId: selectedTask.id
    });
    expect(client.observeTaskTerminal).toHaveBeenCalledTimes(2);

    subscriptions[0].onUpdate([
      { ...selectedTask, id: "obsolete-task", title: "Obsolete task" }
    ]);
    subscriptions[0].onError(new Error("obsolete listener failed"));

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      recentTasks: [selectedTask],
      selectedTaskId: selectedTask.id
    });

    subscriptions[1].onUpdate([]);

    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({
        connectionState: "connected",
        repos: [],
        recentTasks: [],
        repoTasks: [],
        searchResults: [],
        selectedTaskId: null,
        taskTerminalTaskId: null
      });
    });
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledTimes(2);
  });

  it("retains connected task and stream state when the current live subscription errors", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const selectedTask: TaskSummary = {
      id: "selected-task",
      repoId: "repo-1",
      title: "Selected task",
      stage: "in progress"
    };
    store.setRepos([{ id: selectedTask.repoId, name: "Repo One" }]);
    store.setRecentTasks([selectedTask]);
    store.setRepoTasks([selectedTask]);
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    let liveError: ((error: unknown) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, _onUpdate, onError) => {
        liveError = onError ?? null;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    controller.openTask(selectedTask.id);
    liveError?.(new Error("task subscription unavailable"));

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: "task subscription unavailable",
      recentTasks: [selectedTask],
      repoTasks: [selectedTask],
      selectedTaskId: selectedTask.id,
      taskTerminalTaskId: selectedTask.id
    });
    expect(client.__terminalStream.subscription.close).not.toHaveBeenCalled();
  });

  it("clears an owned cloud subscription error after its current snapshot recovers", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const recoveredTask: TaskSummary = {
      id: "recovered-task",
      repoId: "repo-1",
      title: "Recovered task",
      stage: "in progress"
    };
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    let liveError: ((error: unknown) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate, onError) => {
        liveUpdate = onUpdate;
        liveError = onError ?? null;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveError?.(new Error("cloud tasks unavailable"));
    expect(store.getState().errorMessage).toBe("cloud tasks unavailable");

    liveUpdate?.([recoveredTask]);

    expect(store.getState().errorMessage).toBeNull();
    expect(store.getState().recentTasks).toEqual([recoveredTask]);
  });

  it("clears an old subscription error when its replacement snapshot succeeds", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const refreshStatus = createDeferred<
      Awaited<ReturnType<KannaClient["getStatus"]>>
    >();
    const cloudStatus = {
      state: "running" as const,
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    };
    const recoveredTask: TaskSummary = {
      id: "recovered-task",
      repoId: "repo-1",
      title: "Recovered task",
      stage: "in progress"
    };
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus
      .mockResolvedValueOnce(cloudStatus)
      .mockReturnValueOnce(refreshStatus.promise);
    const subscriptions: Array<{
      onUpdate: (tasks: TaskSummary[]) => void;
      onError: (error: unknown) => void;
    }> = [];
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate, onError) => {
        subscriptions.push({
          onUpdate,
          onError: onError ?? (() => undefined)
        });
        return vi.fn();
      })
    });

    await controller.bootstrap();
    const refresh = controller.refresh();
    await flushMicrotasks();
    subscriptions[0].onError(new Error("old cloud listener failed"));
    expect(store.getState().errorMessage).toBe("old cloud listener failed");

    refreshStatus.resolve(cloudStatus);
    await refresh;
    expect(subscriptions).toHaveLength(2);
    subscriptions[1].onUpdate([recoveredTask]);

    expect(store.getState().errorMessage).toBeNull();
    expect(store.getState().recentTasks).toEqual([recoveredTask]);
  });

  it("supplements live task repositories with explicit source repositories", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const cloudTask: TaskSummary = {
      id: "cloud-task",
      repoId: "repo-with-task",
      repoName: "Repo With Task",
      title: "Cloud task",
      stage: "in progress"
    };
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos.mockResolvedValue([
      { id: "empty-repo", name: "Empty Repo" }
    ]);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([cloudTask]);
    controller.openTask(cloudTask.id);

    expect(store.getState().recentTasks).toEqual([cloudTask]);
    await vi.waitFor(() => {
      expect(store.getState().repos).toEqual([
        { id: "empty-repo", name: "Empty Repo" },
        { id: "repo-with-task", name: "Repo With Task" }
      ]);
    });
  });

  it("preserves the last successful explicit repositories until a current live supplement succeeds", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const cloudTask: TaskSummary = {
      id: "cloud-task",
      repoId: "repo-a",
      repoName: "Repo A",
      title: "Cloud task",
      stage: "in progress"
    };
    const repoA = { id: "repo-a", name: "Repo A" };
    const repoB = { id: "repo-b", name: "Repo B" };
    const repoC = { id: "repo-c", name: "Repo C" };
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos
      .mockResolvedValueOnce([repoA, repoB])
      .mockRejectedValueOnce(new Error("repository supplement unavailable"))
      .mockResolvedValueOnce([repoC]);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([cloudTask]);
    await vi.waitFor(() => {
      expect(store.getState().repos).toEqual([repoA, repoB]);
    });

    liveUpdate?.([cloudTask]);
    expect(store.getState().repos).toEqual([repoA, repoB]);
    await flushMicrotasks();
    expect(store.getState().repos).toEqual([repoA, repoB]);

    liveUpdate?.([cloudTask]);
    expect(store.getState().repos).toEqual([repoA, repoB]);
    await vi.waitFor(() => {
      expect(store.getState().repos).toEqual([repoC, repoA]);
    });
  });

  it("preserves a selected empty repository while its live supplement is pending", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const explicitRepos = createDeferred<
      Awaited<ReturnType<KannaClient["listRepos"]>>
    >();
    const cloudTask: TaskSummary = {
      id: "cloud-task",
      repoId: "repo-with-task",
      repoName: "Repo With Task",
      title: "Cloud task",
      stage: "in progress"
    };
    store.hydrateContext({
      selectedDesktopId: null,
      selectedRepoId: "empty-repo",
      selectedTaskId: null,
      activeView: "tasks",
      authUser: null
    });
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos.mockReturnValue(explicitRepos.promise);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([cloudTask]);

    expect(store.getState()).toMatchObject({
      selectedRepoId: "empty-repo",
      repos: [
        { id: "empty-repo", name: "empty-repo" },
        { id: "repo-with-task", name: "Repo With Task" }
      ],
      repoTasks: []
    });

    explicitRepos.resolve([{ id: "empty-repo", name: "Empty Repo" }]);
    await flushMicrotasks();

    expect(store.getState()).toMatchObject({
      selectedRepoId: "empty-repo",
      repos: [
        { id: "empty-repo", name: "Empty Repo" },
        { id: "repo-with-task", name: "Repo With Task" }
      ],
      repoTasks: []
    });
  });

  it("ignores an obsolete explicit repository supplement after a newer live snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const oldRepos = createDeferred<Awaited<ReturnType<KannaClient["listRepos"]>>>();
    const newRepos = createDeferred<Awaited<ReturnType<KannaClient["listRepos"]>>>();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRepos
      .mockReturnValueOnce(oldRepos.promise)
      .mockReturnValueOnce(newRepos.promise);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([]);
    liveUpdate?.([]);
    newRepos.resolve([{ id: "new-repo", name: "New Repo" }]);
    await vi.waitFor(() => {
      expect(store.getState().repos).toEqual([
        { id: "new-repo", name: "New Repo" }
      ]);
    });

    oldRepos.resolve([{ id: "old-repo", name: "Old Repo" }]);
    await flushMicrotasks();

    expect(store.getState().repos).toEqual([
      { id: "new-repo", name: "New Repo" }
    ]);
  });

  it("preserves an unrelated current error across a successful live snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Cloud task",
      stage: "in progress"
    };
    const sharedError = new Error("shared request failure");
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.sendTaskInput.mockRejectedValueOnce(sharedError);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    let liveError: ((error: unknown) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate, onError) => {
        liveUpdate = onUpdate;
        liveError = onError ?? null;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([task]);
    liveError?.(sharedError);
    await controller.sendTaskInput(task.id, "continue");
    expect(store.getState()).toMatchObject({
      connectionState: "error",
      errorMessage: sharedError.message
    });

    liveUpdate?.([task]);

    expect(store.getState()).toMatchObject({
      connectionState: "error",
      errorMessage: sharedError.message,
      recentTasks: [task]
    });
  });

  it("keeps the connection healthy when a task input is held at that terminal", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Cloud task",
      stage: "in progress"
    };
    // The desktop is fine and connected; a human simply has an unsent line at
    // that terminal. Reported 2026-08-20: before this, one held reply put the
    // whole app into its error state.
    const held = new ServerRefusalError(
      "logical input for session task-1 was not submitted: a human has an unsent line at that terminal",
      INPUT_HELD_BY_DRAFT_REASON,
      409
    );
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.sendTaskInput.mockRejectedValueOnce(held);
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();
    liveUpdate?.([task]);
    const connectedState = store.getState().connectionState;
    const taskCollectionStatus = store.getState().taskCollectionStatus;

    await controller.sendTaskInput(task.id, "please also update the docs");

    expect(store.getState()).toMatchObject({
      connectionState: connectedState,
      taskCollectionStatus,
      errorMessage: held.message
    });
    expect(store.getState().connectionState).not.toBe("error");
  });

  it("does not start a persisted unresolved task stream before its live snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const restoredTask: TaskSummary = {
      id: "restored-task",
      repoId: "repo-1",
      title: "Restored task",
      stage: "in progress"
    };
    store.setSelectedTask(restoredTask.id);
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        return vi.fn();
      })
    });

    await controller.bootstrap();

    expect(store.getState().selectedTaskId).toBe(restoredTask.id);
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();

    liveUpdate?.([restoredTask]);

    expect(store.getState().selectedTaskId).toBe(restoredTask.id);
    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      restoredTask.id,
      expect.any(Function)
    );
  });

  it("does not let a delayed LAN collection read overwrite a newer repo selection", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const staleRead = createDeferred<TaskSummary[]>();
    const staleReadStarted = createDeferred<void>();
    const selectedTask: TaskSummary = {
      id: "new-task",
      repoId: "new-repo",
      repoName: "New Repo",
      title: "New task",
      stage: "in progress"
    };
    const staleTask: TaskSummary = {
      id: "stale-task",
      repoId: "repo-1",
      title: "Stale task",
      stage: "review"
    };
    store.setRepos([{ id: selectedTask.repoId, name: "New Repo" }]);
    store.setRecentTasks([selectedTask]);
    store.setRepoTasks([selectedTask]);
    client.listRecentTasks.mockImplementationOnce(() => {
      staleReadStarted.resolve();
      return staleRead.promise;
    });
    client.listRepoTasks.mockImplementation(async (repoId: string) =>
      repoId === selectedTask.repoId ? [selectedTask] : [staleTask]
    );
    const controller = createMobileController(client, store);

    const bootstrap = controller.bootstrap();
    await staleReadStarted.promise;
    await controller.selectRepo(selectedTask.repoId);
    staleRead.resolve([staleTask]);
    await bootstrap;

    expect(store.getState()).toMatchObject({
      selectedRepoId: selectedTask.repoId,
      recentTasks: [selectedTask],
      repoTasks: [selectedTask]
    });
  });

  it("invalidates an in-flight LAN refresh when remote live ownership starts", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const staleRead = createDeferred<TaskSummary[]>();
    const staleReadStarted = createDeferred<void>();
    const staleTask: TaskSummary = {
      id: "stale-task",
      repoId: "repo-1",
      title: "Stale task",
      stage: "review"
    };
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
      .mockResolvedValue({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });

    await controller.bootstrap();
    controller.openTask("task-1");
    client.listRecentTasks.mockImplementationOnce(() => {
      staleReadStarted.resolve();
      return staleRead.promise;
    });
    client.listRepoTasks.mockResolvedValueOnce([staleTask]);
    const timerAdvance = vi.advanceTimersByTimeAsync(3_000);
    await staleReadStarted.promise;
    await timerAdvance;

    await controller.bootstrap();
    staleRead.resolve([staleTask]);
    await flushMicrotasks();

    expect(store.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      recentTasks: [expect.objectContaining({ id: "task-1" })],
      selectedTaskId: "task-1",
      taskTerminalTaskId: "task-1"
    });
  });

  it("switches the existing refresh timer to desktops as soon as live ownership starts", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const desktopRefresh = createDeferred<
      Awaited<ReturnType<KannaClient["listDesktops"]>>
    >();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
      .mockResolvedValue({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });

    await controller.bootstrap();
    const taskReadCount = client.listRecentTasks.mock.calls.length;
    client.listDesktops.mockReturnValueOnce(desktopRefresh.promise);

    const refresh = controller.refresh();
    await vi.waitFor(() => {
      expect(client.listDesktops).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.listRecentTasks).toHaveBeenCalledTimes(taskReadCount);

    desktopRefresh.resolve([
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "remote" }
    ]);
    await refresh;
  });

  it("ignores a rejected LAN refresh after remote live ownership starts", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const staleRead = createDeferred<TaskSummary[]>();
    const staleReadStarted = createDeferred<void>();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
      .mockResolvedValue({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });

    await controller.bootstrap();
    client.listRecentTasks.mockImplementationOnce(() => {
      staleReadStarted.resolve();
      return staleRead.promise;
    });
    const timerAdvance = vi.advanceTimersByTimeAsync(3_000);
    await staleReadStarted.promise;
    await timerAdvance;

    await controller.bootstrap();
    staleRead.reject(new Error("obsolete LAN tasks failed"));
    await flushMicrotasks();

    expect(store.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      errorMessage: null
    });
  });

  it("ignores a stale active-search refresh rejection after live ownership starts", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const staleSearch = createDeferred<TaskSummary[]>();
    const staleSearchStarted = createDeferred<void>();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });
    client.getStatus
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
      .mockResolvedValue({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });

    await controller.bootstrap();
    await controller.searchTasks("needle");
    client.searchTasks.mockImplementationOnce(() => {
      staleSearchStarted.resolve();
      return staleSearch.promise;
    });
    const timerAdvance = vi.advanceTimersByTimeAsync(3_000);
    await staleSearchStarted.promise;
    await timerAdvance;

    await controller.bootstrap();
    staleSearch.reject(new Error("obsolete search failed"));
    await flushMicrotasks();

    expect(store.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      errorMessage: null
    });
  });

  it("ignores a stale initial collection rejection after a newer repo selection", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const staleRead = createDeferred<TaskSummary[]>();
    const staleReadStarted = createDeferred<void>();
    client.listRecentTasks.mockImplementationOnce(() => {
      staleReadStarted.resolve();
      return staleRead.promise;
    });
    client.listRecentTasks.mockResolvedValueOnce([
      {
        id: "task-repo-2",
        repoId: "repo-2",
        title: "Repo Two task",
        stage: "pr"
      }
    ]);
    const controller = createMobileController(client, store);

    const bootstrap = controller.bootstrap();
    await staleReadStarted.promise;
    await controller.selectRepo("repo-2");
    staleRead.reject(new Error("obsolete bootstrap tasks failed"));
    await bootstrap;
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      taskCollectionStatus: "ready",
      selectedRepoId: "repo-2",
      repoTasks: [expect.objectContaining({ id: "task-repo-2" })]
    });
  });

  it("ignores a stale repo rejection after a newer repo selection commits", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const staleRepoRead = createDeferred<TaskSummary[]>();
    const staleRepoReadStarted = createDeferred<void>();
    const currentTask: TaskSummary = {
      id: "task-current",
      repoId: "repo-2",
      title: "Current repo task",
      stage: "in progress"
    };
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    client.listRepoTasks.mockImplementationOnce(() => {
      staleRepoReadStarted.resolve();
      return staleRepoRead.promise;
    });
    client.listRepoTasks.mockResolvedValueOnce([currentTask]);

    const staleSelection = controller.selectRepo("repo-1");
    await staleRepoReadStarted.promise;
    await controller.selectRepo("repo-2");
    staleRepoRead.reject(new Error("obsolete repo failed"));
    await staleSelection;

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      selectedRepoId: "repo-2",
      repoTasks: [currentTask]
    });
  });

  it("does not let an obsolete repo success clear the current repo error", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const staleRepoRead = createDeferred<TaskSummary[]>();
    const staleRepoReadStarted = createDeferred<void>();
    const currentError = new Error("current repo failed");
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    client.listRepoTasks.mockImplementationOnce(() => {
      staleRepoReadStarted.resolve();
      return staleRepoRead.promise;
    });
    client.listRepoTasks.mockRejectedValueOnce(currentError);

    const staleSelection = controller.selectRepo("repo-1");
    await staleRepoReadStarted.promise;
    await controller.selectRepo("repo-2");
    expect(store.getState()).toMatchObject({
      connectionState: "error",
      errorMessage: currentError.message,
      selectedRepoId: "repo-2"
    });

    staleRepoRead.resolve([]);
    await staleSelection;

    expect(store.getState()).toMatchObject({
      connectionState: "error",
      errorMessage: currentError.message,
      selectedRepoId: "repo-2"
    });
  });

  it("ignores an old UID desktop result after clearing account state", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const oldDesktopRead = createDeferred<
      Awaited<ReturnType<KannaClient["listDesktops"]>>
    >();
    const nextDesktopRead = createDeferred<
      Awaited<ReturnType<KannaClient["listDesktops"]>>
    >();
    const oldDesktopReadStarted = createDeferred<void>();
    const nextDesktopReadStarted = createDeferred<void>();
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-a", email: "a@example.com", displayName: null }
    };
    let authListener: Parameters<MobileAuthSession["subscribe"]>[0] | null = null;
    vi.mocked(auth.getState).mockImplementation(() => authState);
    vi.mocked(auth.subscribe).mockImplementation((listener) => {
      authListener = listener;
      listener(authState);
      return vi.fn();
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops
      .mockImplementationOnce(() => {
        oldDesktopReadStarted.resolve();
        return oldDesktopRead.promise;
      })
      .mockImplementationOnce(() => {
        nextDesktopReadStarted.resolve();
        return nextDesktopRead.promise;
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });

    const bootstrap = controller.bootstrap();
    await oldDesktopReadStarted.promise;
    store.setDesktops([
      { id: "desktop-a", name: "User A Mac", online: true, mode: "remote" }
    ]);
    authState = {
      status: "signedIn",
      user: { uid: "user-b", email: "b@example.com", displayName: null }
    };
    authListener?.(authState);
    expect(store.getState().desktops).toEqual([]);

    oldDesktopRead.resolve([
      { id: "desktop-a", name: "Old User A Mac", online: true, mode: "remote" }
    ]);
    await nextDesktopReadStarted.promise;

    expect(store.getState().desktops).toEqual([]);
    nextDesktopRead.resolve([]);
    await bootstrap;
  });

  it("does not publish an old UID desktop error after account replacement", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const oldDesktopRead = createDeferred<
      Awaited<ReturnType<KannaClient["listDesktops"]>>
    >();
    const nextDesktopRead = createDeferred<
      Awaited<ReturnType<KannaClient["listDesktops"]>>
    >();
    const oldDesktopReadStarted = createDeferred<void>();
    const nextDesktopReadStarted = createDeferred<void>();
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-a", email: "a@example.com", displayName: null }
    };
    let authListener: Parameters<MobileAuthSession["subscribe"]>[0] | null = null;
    vi.mocked(auth.getState).mockImplementation(() => authState);
    vi.mocked(auth.subscribe).mockImplementation((listener) => {
      authListener = listener;
      listener(authState);
      return vi.fn();
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops
      .mockImplementationOnce(() => {
        oldDesktopReadStarted.resolve();
        return oldDesktopRead.promise;
      })
      .mockImplementationOnce(() => {
        nextDesktopReadStarted.resolve();
        return nextDesktopRead.promise;
      });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn(() => vi.fn())
    });
    const publications: ReturnType<typeof store.getState>[] = [];
    store.subscribe(() => publications.push(store.getState()));

    const bootstrap = controller.bootstrap();
    await oldDesktopReadStarted.promise;
    authState = {
      status: "signedIn",
      user: { uid: "user-b", email: "b@example.com", displayName: null }
    };
    authListener?.(authState);
    oldDesktopRead.reject(new Error("old user desktop failed"));
    await nextDesktopReadStarted.promise;

    expect(
      publications.some(
        (state) =>
          state.auth.status === "signedIn" &&
          state.auth.user.uid === "user-b" &&
          state.errorMessage === "old user desktop failed"
      )
    ).toBe(false);
    nextDesktopRead.resolve([]);
    await bootstrap;
  });

  it("loads task collections from the signed-in cloud client without LAN pairing", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-1", name: "MacBook", online: true, mode: "remote" }
    ]);
    client.listRecentTasks.mockResolvedValueOnce([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress"
      }
    ]);
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const controller = createMobileController(client, store, auth);

    await controller.bootstrap();

    expect(store.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud",
      recentTasks: [{ id: "cloud-task-1", title: "Cloud task" }]
    });
  });

  it("marks an unread task idle after it remains open for one second", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(999);

    expect(client.markTaskRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(client.markTaskRead).toHaveBeenCalledTimes(1);
    expect(client.markTaskRead).toHaveBeenCalledWith("task-1");
    expect(store.getState().repoTasks[0]?.activity).toBe("idle");
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("marks an already-open task read after a LAN poll changes only activity", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const workingTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "working" as const
    };
    const unreadTask = { ...workingTask, activity: "unread" as const };
    client.listRecentTasks
      .mockResolvedValueOnce([workingTask])
      .mockResolvedValueOnce([unreadTask]);
    client.listRepoTasks
      .mockResolvedValueOnce([workingTask])
      .mockResolvedValueOnce([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(store.getState().repoTasks[0]?.activity).toBe("unread");
    expect(client.markTaskRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.markTaskRead).toHaveBeenCalledWith("task-1");
    expect(store.getState().repoTasks[0]?.activity).toBe("idle");
  });

  it("does not apply a stale mark-read response after the task closes", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    let resolveMarkRead: ((value: { taskId: string; activity: "idle" }) => void) | null = null;
    client.markTaskRead.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMarkRead = resolve;
    }));
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);

    controller.closeTask();
    resolveMarkRead?.({ taskId: "task-1", activity: "idle" });
    await Promise.resolve();

    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().recentTasks[0]?.activity).toBe("unread");
  });

  it("does not mark read while selected task copies disagree about activity", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([
      { ...unreadTask, activity: "working" as const }
    ]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.markTaskRead).not.toHaveBeenCalled();
  });

  it("does not overwrite a working copy with a delayed mark-read response", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    let resolveMarkRead: ((value: { taskId: string; activity: "idle" }) => void) | null = null;
    client.markTaskRead.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMarkRead = resolve;
    }));
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);

    store.setRecentTasks([{ ...unreadTask, activity: "working" }]);
    resolveMarkRead?.({ taskId: "task-1", activity: "idle" });
    await Promise.resolve();

    expect(store.getState().repoTasks[0]?.activity).toBe("unread");
    expect(store.getState().recentTasks[0]?.activity).toBe("working");
  });

  it("requires a fresh one-second dwell after leaving and returning to the task view", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(999);
    controller.setTaskDetailVisible(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.markTaskRead).not.toHaveBeenCalled();

    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(client.markTaskRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("marks an unread task read after returning from More through Recent", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(999);
    controller.setTaskDetailVisible(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.markTaskRead).not.toHaveBeenCalled();

    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(client.markTaskRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("does not mark read after the connection leaves connected state", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    await vi.advanceTimersByTimeAsync(999);
    store.setConnectionState("idle");
    await vi.advanceTimersByTimeAsync(1);

    expect(client.markTaskRead).not.toHaveBeenCalled();
    expect(store.getState().recentTasks[0]?.activity).toBe("unread");
  });

  it("retries a rejected mark-read without disconnecting", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    client.markTaskRead
      .mockRejectedValueOnce(new Error("relay timeout"))
      .mockResolvedValueOnce({ taskId: "task-1", activity: "idle" });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.markTaskRead).toHaveBeenCalledTimes(1);
    expect(store.getState().connectionState).toBe("connected");

    await vi.advanceTimersByTimeAsync(999);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.markTaskRead).toHaveBeenCalledTimes(2);
    expect(store.getState().connectionState).toBe("connected");
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("retries an exhausted mark-read cycle after a later collection refresh", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const unreadTask = {
      id: "task-1",
      repoId: "repo-1",
      title: "Refactor mobile shell",
      stage: "in progress",
      activity: "unread" as const
    };
    client.listRecentTasks.mockResolvedValue([unreadTask]);
    client.listRepoTasks.mockResolvedValue([unreadTask]);
    client.markTaskRead.mockRejectedValue(new Error("relay timeout"));
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.setTaskDetailVisible(true);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(client.markTaskRead).toHaveBeenCalledTimes(3);
    expect(store.getState().connectionState).toBe("connected");

    client.markTaskRead.mockReset();
    client.markTaskRead.mockResolvedValue({ taskId: "task-1", activity: "idle" });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(client.markTaskRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.markTaskRead).toHaveBeenCalledTimes(1);
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("bootstraps the cloud connection after email sign-in", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    vi.mocked(auth.signInWithEmailPassword).mockImplementation(async () => {
      vi.mocked(auth.getState).mockReturnValue({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      });
    });
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listRecentTasks.mockResolvedValueOnce([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress"
      }
    ]);
    const controller = createMobileController(client, store, auth);

    await controller.signInWithEmailPassword("u@example.com", "password");

    expect(client.getStatus).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      auth: {
        status: "signedIn",
        user: { email: "u@example.com" }
      },
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud",
      recentTasks: [{ id: "cloud-task-1", title: "Cloud task" }]
    });
  });

  it("bootstraps the cloud connection when persisted auth is restored after startup", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    let authListener: Parameters<MobileAuthSession["subscribe"]>[0] | null = null;
    vi.mocked(auth.subscribe).mockImplementation((listener) => {
      authListener = listener;
      listener({ status: "signedOut" });
      return () => undefined;
    });
    vi.mocked(auth.getState).mockReturnValue({ status: "signedOut" });
    client.getStatus
      .mockResolvedValueOnce({
        state: "stopped",
        desktopId: "none",
        desktopName: "No desktop",
        lanHost: "none",
        lanPort: 0,
        pairingCode: null
      })
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    client.listRecentTasks.mockResolvedValueOnce([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress"
      }
    ]);
    const controller = createMobileController(client, store, auth);

    await controller.bootstrap();
    expect(store.getState().connectionState).toBe("idle");

    authListener?.({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    });

    await vi.waitFor(() => {
      expect(store.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud-task-1" })
      ]);
    });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud"
    });
  });

  it("clears account state before publishing a new signed-in UID and restarts live tasks", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-a", email: "a@example.com", displayName: null }
    };
    let authListener: Parameters<MobileAuthSession["subscribe"]>[0] | null = null;
    vi.mocked(auth.getState).mockImplementation(() => authState);
    vi.mocked(auth.subscribe).mockImplementation((listener) => {
      authListener = listener;
      listener(authState);
      return vi.fn();
    });
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const subscriptions: Array<{
      uid: string;
      onUpdate: (tasks: TaskSummary[]) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((uid, onUpdate) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ uid, onUpdate, unsubscribe });
        return unsubscribe;
      })
    });

    await controller.bootstrap();
    expect(subscriptions.map(({ uid }) => uid)).toEqual(["user-a"]);
    const taskA: TaskSummary = {
      id: "task-a",
      repoId: "repo-a",
      repoName: "Repo A",
      title: "User A task",
      stage: "in progress"
    };
    store.setTrustedDesktops([
      {
        desktopId: "trusted-local",
        displayName: "Trusted Local Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-07-11T00:00:00.000Z"
      }
    ]);
    store.upsertRepoCreationProfile({
      repoId: "repo-a",
      desktopId: "desktop-a",
      agentProvider: "codex",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    store.setComposerState(true, "Keep this draft");
    store.setComposerDesktop("desktop-a");
    store.setComposerAgentProvider("codex");
    store.setDesktops([
      { id: "desktop-a", name: "User A Mac", online: true, mode: "remote" }
    ]);
    store.setMachineSourceDesktops({
      account: [
        { id: "desktop-a", name: "User A Mac", online: true, mode: "remote" }
      ],
      local: [
        { id: "desktop-a", name: "User A Mac", online: true, mode: "lan" },
        { id: "trusted-local", name: "Trusted Local Mac", online: true, mode: "lan" }
      ]
    });
    store.setMachineSourceWarnings({ account: "Cloud unavailable", local: null });
    store.setRepos([{ id: "repo-a", name: "Repo A" }]);
    store.setRecentTasks([taskA]);
    store.setRepoTasks([taskA]);
    store.setSearchResults("keep-query", [taskA]);
    controller.openTask(taskA.id);
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: taskA.id,
      cols: 80,
      rows: 24,
      dataB64: ""
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: taskA.id,
      dataB64: "QQ=="
    });
    store.beginTaskAgent(taskA.id);
    store.applyTaskAgentStreamEvent(taskA.id, {
      type: "event",
      seq: 1,
      event: { type: "assistant_text", text: "User A", truncated: false }
    });
    const synchronousPublications: ReturnType<typeof store.getState>[] = [];
    store.subscribe(() => synchronousPublications.push(store.getState()));

    authState = {
      status: "signedIn",
      user: { uid: "user-b", email: "b@example.com", displayName: null }
    };
    authListener?.(authState);

    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      auth: authState,
      desktops: [],
      accountDesktops: [],
      liveLanDesktops: [
        { id: "trusted-local", name: "Trusted Local Mac", online: true, mode: "lan" }
      ],
      machineSourceWarnings: { account: null, local: null },
      selectedDesktopId: null,
      repos: [],
      selectedRepoId: null,
      recentTasks: [],
      repoTasks: [],
      searchQuery: "keep-query",
      searchResults: [],
      selectedTaskId: null,
      taskTerminalTaskId: null,
      taskTerminalStatus: "idle",
      taskTerminalCols: null,
      taskTerminalRows: null,
      taskTerminalErrorMessage: null,
      taskAgentTaskId: null,
      taskAgentStatus: "idle",
      taskAgentEvents: [],
      taskAgentErrorMessage: null,
      trustedDesktops: [expect.objectContaining({ desktopId: "trusted-local" })],
      repoCreationProfiles: [expect.objectContaining({ repoId: "repo-a" })],
      isComposerOpen: true,
      composerPrompt: "Keep this draft",
      composerDesktopId: "desktop-a",
      composerAgentProvider: "codex"
    });
    const userBPublications = synchronousPublications.filter(
      ({ auth: publishedAuth }) =>
        publishedAuth.status === "signedIn" && publishedAuth.user.uid === "user-b"
    );
    expect(userBPublications.length).toBeGreaterThan(0);
    for (const publication of userBPublications) {
      expect(publication).toMatchObject({
        desktops: [],
        accountDesktops: [],
        repos: [],
        recentTasks: [],
        repoTasks: [],
        searchResults: [],
        selectedTaskId: null,
        taskTerminalTaskId: null,
        taskAgentTaskId: null
      });
    }

    await vi.waitFor(() => {
      expect(subscriptions.map(({ uid }) => uid)).toEqual(["user-a", "user-b"]);
    });
    expect(subscriptions[1].unsubscribe).not.toHaveBeenCalled();
    const taskB: TaskSummary = {
      id: "task-b",
      repoId: "repo-b",
      repoName: "Repo B",
      title: "User B task",
      stage: "review"
    };
    subscriptions[1].onUpdate([taskB]);
    expect(store.getState().recentTasks).toEqual([taskB]);

    authListener?.({
      status: "signedIn",
      user: { uid: "user-b", email: "refreshed-b@example.com", displayName: null }
    });
    expect(store.getState().recentTasks).toEqual([taskB]);
    expect(subscriptions.map(({ uid }) => uid)).toEqual(["user-a", "user-b"]);
    expect(subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("clears signed-in account state and reboots routing through sign-out before another UID", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-a", email: "a@example.com", displayName: null }
    };
    let authListener: Parameters<MobileAuthSession["subscribe"]>[0] | null = null;
    vi.mocked(auth.getState).mockImplementation(() => authState);
    vi.mocked(auth.subscribe).mockImplementation((listener) => {
      authListener = listener;
      listener(authState);
      return vi.fn();
    });
    client.getStatus
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      })
      .mockResolvedValueOnce({
        state: "stopped",
        desktopId: "none",
        desktopName: "No desktop",
        lanHost: "none",
        lanPort: 0,
        pairingCode: null
      })
      .mockResolvedValue({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
    const subscriptions: Array<{
      uid: string;
      onUpdate: (tasks: TaskSummary[]) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((uid, onUpdate) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ uid, onUpdate, unsubscribe });
        return unsubscribe;
      })
    });

    await controller.bootstrap();
    const taskA: TaskSummary = {
      id: "task-a",
      repoId: "repo-a",
      repoName: "Repo A",
      title: "User A task",
      stage: "in progress"
    };
    subscriptions[0].onUpdate([taskA]);
    controller.openTask(taskA.id);
    store.setTrustedDesktops([
      {
        desktopId: "trusted-local",
        displayName: "Trusted Local Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-07-11T00:00:00.000Z"
      }
    ]);
    store.setComposerState(true, "Keep draft");
    store.setComposerDesktop("desktop-a");
    store.setComposerAgentProvider("codex");
    store.setDesktops([
      { id: "desktop-a", name: "User A Mac", online: true, mode: "remote" }
    ]);
    store.setMachineSourceDesktops({
      account: [
        { id: "desktop-a", name: "User A Mac", online: true, mode: "remote" }
      ],
      local: [
        { id: "desktop-a", name: "User A Mac", online: true, mode: "lan" },
        { id: "trusted-local", name: "Trusted Local Mac", online: true, mode: "lan" }
      ]
    });

    authState = { status: "signedOut" };
    authListener?.(authState);

    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      auth: { status: "signedOut" },
      desktops: [],
      // No machine may still read as available through an account the phone
      // is no longer signed in to; the manually paired one keeps its row.
      accountDesktops: [],
      liveLanDesktops: [
        { id: "trusted-local", name: "Trusted Local Mac", online: true, mode: "lan" }
      ],
      repos: [],
      recentTasks: [],
      repoTasks: [],
      searchResults: [],
      selectedTaskId: null,
      taskTerminalTaskId: null,
      taskAgentTaskId: null,
      trustedDesktops: [expect.objectContaining({ desktopId: "trusted-local" })],
      isComposerOpen: true,
      composerPrompt: "Keep draft",
      composerDesktopId: "desktop-a",
      composerAgentProvider: "codex"
    });
    await flushMicrotasks();
    expect(client.getStatus).toHaveBeenCalledTimes(2);

    authState = {
      status: "signedIn",
      user: { uid: "user-b", email: "b@example.com", displayName: null }
    };
    authListener?.(authState);
    await vi.waitFor(() => {
      expect(subscriptions.map(({ uid }) => uid)).toEqual(["user-a", "user-b"]);
    });
    const taskB: TaskSummary = {
      id: "task-b",
      repoId: "repo-b",
      repoName: "Repo B",
      title: "User B task",
      stage: "review"
    };
    subscriptions[0].onUpdate([taskA]);
    expect(store.getState().recentTasks).toEqual([]);
    subscriptions[1].onUpdate([taskB]);
    expect(store.getState().recentTasks).toEqual([taskB]);
    expect(client.getStatus).toHaveBeenCalledTimes(3);
  });

  it("searches tasks without choosing a navigation surface", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.searchTasks("search");

    expect(store.getState().activeView).toBe("tasks");
    expect(store.getState().searchQuery).toBe("search");
    expect(store.getState().searchResults.map((task) => task.id)).toEqual(["task-2"]);
  });

  it("creates a task for the selected repo and opens it", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");

    const selectionId = await controller.createTask();

    expect(store.getState().recentTasks[0]).toMatchObject({
      id: "task-3",
      repoId: "repo-2",
      title: "Ship mobile shell",
      prompt: "Ship mobile shell with the canonical requirements"
    });
    expect(store.getState().selectedTaskId).toBe(
      store.getState().taskUiSlots[0]?.slotId
    );
    expect(selectionId).toBe(store.getState().selectedTaskId);
    expect(store.getState().taskUiSlots[0]).toMatchObject({
      taskId: "task-3",
      state: "ready"
    });
    expect(store.getState().isComposerOpen).toBe(false);
    expect(store.getState().composerPrompt).toBe("");
  });

  it("preserves repo registration inventory and blocks an invalid composer machine", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const repo: RepoSummary = {
      id: "git:hash-kanji",
      name: "kanji-kongbu",
      remoteUrlHash: "hash-kanji",
      registeredDesktopIds: ["desktop-1"]
    };
    client.listRepos.mockResolvedValue([repo]);
    client.listRecentTasks.mockResolvedValue([]);
    client.listRepoTasks.mockResolvedValue([]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();

    expect(store.getState().repos).toEqual([repo]);
    controller.openComposer();
    controller.selectComposerDesktop("desktop-2");
    controller.updateComposerPrompt("Study kanji");

    await expect(controller.createTask()).resolves.toBeNull();
    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerDesktopId: "desktop-2",
      composerErrorMessage:
        "kanji-kongbu is not registered on Laptop. Register it on that machine before creating a task."
    });
  });

  it("opens a fresh composer and starts another task while an earlier creation is uncertain", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.createTask
      .mockRejectedValueOnce(new Error("Creation response was lost"))
      .mockRejectedValueOnce(new Error("Second creation response was lost"));
    const taskIds = [
      "11111111111111111111111111111111",
      "22222222222222222222222222222222"
    ];
    const slotIds = ["create:slot-1", "create:slot-2"];
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => taskIds.shift()!,
      createTaskSlotId: () => slotIds.shift()!,
      persistSessionContext: vi.fn().mockResolvedValue(undefined)
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("First uncertain task");
    await controller.createTask();

    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerPrompt: "",
      taskCreationAttempts: [
        {
          slotId: "create:slot-1",
          taskId: "11111111111111111111111111111111",
          phase: "uncertain"
        }
      ]
    });

    controller.updateComposerPrompt("Second uncertain task");
    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledTimes(2);
    expect(store.getState().taskCreationAttempts).toMatchObject([
      {
        slotId: "create:slot-2",
        taskId: "22222222222222222222222222222222",
        prompt: "Second uncertain task",
        phase: "uncertain"
      },
      {
        slotId: "create:slot-1",
        taskId: "11111111111111111111111111111111",
        prompt: "First uncertain task",
        phase: "uncertain"
      }
    ]);
  });

  it("aborts only the selected unresolved creation on its frozen desktop", async () => {
    const store = createSessionStore();
    const attempts = [
      {
        slotId: "create:slot-1",
        taskId: "11111111111111111111111111111111",
        repoId: "repo-2",
        prompt: "First uncertain task",
        desktopId: "desktop-1",
        agentProvider: "claude" as const
      },
      {
        slotId: "create:slot-2",
        taskId: "22222222222222222222222222222222",
        repoId: "repo-2",
        prompt: "Second uncertain task",
        desktopId: "desktop-2",
        agentProvider: "codex" as const
      }
    ];
    store.hydrateContext({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-2",
      selectedTaskId: attempts[0].slotId,
      activeView: "tasks",
      taskCreationAttempts: attempts
    });
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.abortTaskCreation(attempts[0].slotId);

    expect(client.abortTaskCreation).toHaveBeenCalledWith({
      taskId: attempts[0].taskId,
      desktopId: attempts[0].desktopId
    });
    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskCreationAttempts: [
        {
          slotId: attempts[1].slotId,
          taskId: attempts[1].taskId,
          phase: "uncertain"
        }
      ],
      taskUiSlots: [{ slotId: attempts[1].slotId, state: "creating" }]
    });
  });

  it("isolates concurrent aborts and failures between unresolved creations", async () => {
    const store = createSessionStore();
    const attempts = [
      {
        slotId: "create:slot-1",
        taskId: "11111111111111111111111111111111",
        repoId: "repo-2",
        prompt: "First uncertain task",
        desktopId: "desktop-1",
        agentProvider: "claude" as const
      },
      {
        slotId: "create:slot-2",
        taskId: "22222222222222222222222222222222",
        repoId: "repo-2",
        prompt: "Second uncertain task",
        desktopId: "desktop-2",
        agentProvider: "codex" as const
      }
    ];
    store.hydrateContext({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-2",
      selectedTaskId: attempts[0].slotId,
      activeView: "tasks",
      taskCreationAttempts: attempts
    });
    const firstAbort = createDeferred<void>();
    const secondAbort = createDeferred<void>();
    const client = createClientMock();
    client.abortTaskCreation
      .mockReturnValueOnce(firstAbort.promise)
      .mockReturnValueOnce(secondAbort.promise);
    const controller = createMobileController(client, store);

    const firstAbortPromise = controller.abortTaskCreation(attempts[0].slotId);
    const secondAbortPromise = controller.abortTaskCreation(attempts[1].slotId);
    void controller.abortTaskCreation(attempts[0].slotId);
    await flushMicrotasks();

    expect(client.abortTaskCreation).toHaveBeenCalledTimes(2);
    expect(client.abortTaskCreation).toHaveBeenNthCalledWith(1, {
      taskId: attempts[0].taskId,
      desktopId: attempts[0].desktopId
    });
    expect(client.abortTaskCreation).toHaveBeenNthCalledWith(2, {
      taskId: attempts[1].taskId,
      desktopId: attempts[1].desktopId
    });
    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: attempts[0].slotId,
        pendingAction: "close-task",
        errorMessage: null
      }),
      expect.objectContaining({
        slotId: attempts[1].slotId,
        pendingAction: "close-task",
        errorMessage: null
      })
    ]);

    secondAbort.reject(new Error("Second desktop is offline"));
    await secondAbortPromise;

    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: attempts[0].slotId,
        pendingAction: "close-task",
        errorMessage: null
      }),
      expect.objectContaining({
        slotId: attempts[1].slotId,
        phase: "uncertain",
        pendingAction: null,
        errorMessage: "Second desktop is offline"
      })
    ]);

    firstAbort.resolve();
    await firstAbortPromise;

    expect(store.getState()).toMatchObject({
      composerErrorMessage: null,
      taskCreationAttempts: [
        {
          slotId: attempts[1].slotId,
          phase: "uncertain",
          pendingAction: null,
          errorMessage: "Second desktop is offline"
        }
      ],
      taskUiSlots: [{ slotId: attempts[1].slotId, state: "creating" }]
    });
  });

  it("does not dispatch create after abort removes the attempt before persistence resolves", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const persistence = createDeferred<void>();
    const abort = createDeferred<void>();
    client.abortTaskCreation.mockReturnValue(abort.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "dddddddddddddddddddddddddddddddd",
      createTaskSlotId: () => "create:slot-abort-before-persist",
      persistSessionContext: () => persistence.promise
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Abort before persistence");
    const createPromise = controller.createTask();
    await flushMicrotasks();
    const abortPromise = controller.abortTaskCreation(
      "create:slot-abort-before-persist"
    );

    abort.resolve();
    await abortPromise;

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskCreationAttempts: [],
      taskUiSlots: []
    });

    persistence.resolve();
    await createPromise;

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskCreationAttempts: [],
      taskUiSlots: []
    });
  });

  it("does not dispatch create or recovery when persistence resolves during abort and permits retry after abort fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const persistence = createDeferred<void>();
    const abort = createDeferred<void>();
    client.abortTaskCreation.mockReturnValue(abort.promise);
    client.createTask.mockResolvedValue({
      taskId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      repoId: "repo-2",
      title: "Recover after abort fails",
      stage: "in progress"
    });
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      createTaskSlotId: () => "create:slot-abort-during-persist",
      persistSessionContext: () => persistence.promise
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Recover after abort fails");
    const createPromise = controller.createTask();
    await flushMicrotasks();
    const waitingRecovery = controller.recoverTaskCreation(
      "create:slot-abort-during-persist"
    );
    const abortPromise = controller.abortTaskCreation(
      "create:slot-abort-during-persist"
    );

    persistence.resolve();
    await Promise.all([createPromise, waitingRecovery]);
    const createCallsWhileAbortPending = client.createTask.mock.calls.length;

    abort.reject(new Error("Desktop is offline"));
    await abortPromise;
    await controller.recoverTaskCreation(
      "create:slot-abort-during-persist"
    );

    expect(createCallsWhileAbortPending).toBe(0);
    expect(client.createTask).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      composerErrorMessage: null,
      taskCreationAttempts: [],
      taskUiSlots: [
        {
          slotId: "create:slot-abort-during-persist",
          taskId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          state: "ready"
        }
      ]
    });
  });

  it("does not replay creation while abort is in flight and preserves the slot if abort fails", async () => {
    const store = createSessionStore();
    const attempt = {
      slotId: "create:slot-abort",
      taskId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repoId: "repo-2",
      prompt: "Uncertain task",
      desktopId: "desktop-2",
      agentProvider: "codex" as const
    };
    store.hydrateContext({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-2",
      selectedTaskId: attempt.slotId,
      activeView: "tasks",
      taskCreationAttempts: [attempt]
    });
    const client = createClientMock();
    const abort = createDeferred<void>();
    client.abortTaskCreation.mockReturnValue(abort.promise);
    const controller = createMobileController(client, store);

    const abortPromise = controller.abortTaskCreation(attempt.slotId);
    await controller.recoverTaskCreation(attempt.slotId);

    expect(client.createTask).not.toHaveBeenCalled();

    abort.reject(new Error("Desktop is offline"));
    await abortPromise;

    expect(store.getState()).toMatchObject({
      selectedTaskId: attempt.slotId,
      composerErrorMessage: null,
      taskCreationAttempts: [
        {
          ...attempt,
          phase: "uncertain",
          pendingAction: null,
          errorMessage: "Desktop is offline"
        }
      ],
      taskUiSlots: [{ slotId: attempt.slotId, state: "creating" }]
    });
  });

  it("marks a pending slot uncertain when create settles but abort fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const create = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const abort = createDeferred<void>();
    client.createTask.mockReturnValue(create.promise);
    client.abortTaskCreation.mockReturnValue(abort.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "cccccccccccccccccccccccccccccccc",
      createTaskSlotId: () => "create:slot-abort-failure",
      persistSessionContext: vi.fn().mockResolvedValue(undefined)
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Creation may have finished");
    const createPromise = controller.createTask();
    await flushMicrotasks();
    const abortPromise = controller.abortTaskCreation(
      "create:slot-abort-failure"
    );

    create.resolve({
      taskId: "cccccccccccccccccccccccccccccccc",
      repoId: "repo-2",
      title: "Creation may have finished",
      stage: "in progress"
    });
    await createPromise;
    abort.reject(new Error("Could not close the desktop task"));
    await abortPromise;

    expect(store.getState()).toMatchObject({
      composerErrorMessage: null,
      taskCreationAttempts: [
        {
          slotId: "create:slot-abort-failure",
          taskId: "cccccccccccccccccccccccccccccccc",
          phase: "uncertain",
          pendingAction: null,
          errorMessage: "Could not close the desktop task"
        }
      ],
      taskUiSlots: [
        { slotId: "create:slot-abort-failure", state: "creating" }
      ]
    });
  });

  it("lets abort own the slot when the original create response arrives first", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const create = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const abort = createDeferred<void>();
    client.createTask.mockReturnValue(create.promise);
    client.abortTaskCreation.mockReturnValue(abort.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      createTaskSlotId: () => "create:slot-race",
      persistSessionContext: vi.fn().mockResolvedValue(undefined)
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Abort this creation");
    const createPromise = controller.createTask();
    await flushMicrotasks();
    const abortPromise = controller.abortTaskCreation("create:slot-race");

    create.resolve({
      taskId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      repoId: "repo-2",
      title: "Abort this creation",
      stage: "in progress"
    });
    await createPromise;

    expect(store.getState()).toMatchObject({
      taskCreationAttempts: [
        {
          slotId: "create:slot-race",
          taskId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          phase: "pending"
        }
      ],
      taskUiSlots: [{ slotId: "create:slot-race", state: "creating" }]
    });

    abort.resolve();
    await abortPromise;

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskCreationAttempts: [],
      taskUiSlots: []
    });
  });

  it("issues one durable create while an ordinary submission is pending", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const pendingCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask.mockReturnValue(pendingCreate.promise);
    const persistSessionContext = vi.fn().mockResolvedValue(undefined);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "0123456789abcdef0123456789abcdef",
      persistSessionContext
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");

    const firstCreate = controller.createTask();
    const secondCreate = controller.createTask();
    await flushMicrotasks();

    expect(secondCreate).toBe(firstCreate);
    expect(persistSessionContext).toHaveBeenCalledOnce();
    expect(client.createTask).toHaveBeenCalledOnce();
    expect(client.createTask).toHaveBeenCalledWith({
      taskId: "0123456789abcdef0123456789abcdef",
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-1",
      agentProvider: "claude",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });

    pendingCreate.resolve({
      taskId: "0123456789abcdef0123456789abcdef",
      repoId: "repo-2",
      title: "Ship mobile shell",
      stage: "in progress"
    });
    await firstCreate;
  });

  it("selects an optimistic task slot before creation settles", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const pendingCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask.mockReturnValue(pendingCreate.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "11111111111111111111111111111111",
      createTaskSlotId: () => "create:slot-1",
      persistSessionContext: vi.fn().mockResolvedValue(undefined)
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship optimistic creation");

    const creation = controller.createTask();

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      selectedTaskId: "create:slot-1",
      taskCreationPhase: "pending",
      pendingTaskCreation: {
        slotId: "create:slot-1",
        taskId: "11111111111111111111111111111111"
      },
      taskUiSlots: [
        {
          slotId: "create:slot-1",
          taskId: null,
          state: "creating"
        }
      ]
    });
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();

    pendingCreate.resolve({
      taskId: "cloud:desktop-1:repo-2:11111111111111111111111111111111",
      repoId: "repo-2",
      title: "Ship optimistic creation",
      stage: "in progress",
      agentType: "pty"
    });
    await creation;

    expect(store.getState()).toMatchObject({
      selectedTaskId: "create:slot-1",
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      taskUiSlots: [
        {
          slotId: "create:slot-1",
          taskId: "cloud:desktop-1:repo-2:11111111111111111111111111111111",
          state: "ready"
        }
      ]
    });
    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud:desktop-1:repo-2:11111111111111111111111111111111",
      expect.any(Function)
    );
  });

  it("falls back to a valid unique-shaped identity when native crypto is unavailable", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("randomUUID unavailable");
      },
      getRandomValues: () => {
        throw new Error("getRandomValues unavailable");
      }
    });
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Use fallback identity");

    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.stringMatching(/^[0-9a-f]{32}$/)
      })
    );
  });

  it("does not dispatch create when persisting the frozen attempt fails", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const persistenceBarrier = createDeferred<void>();
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "11111111111111111111111111111111",
      persistSessionContext: () => persistenceBarrier.promise
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Persist before dispatch");

    const createPromise = controller.createTask();
    await flushMicrotasks();

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      taskCreationPhase: "pending",
      pendingTaskCreation: {
        taskId: "11111111111111111111111111111111"
      }
    });

    persistenceBarrier.reject(new Error("Could not save pending task"));
    await createPromise;

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      composerPrompt: "Persist before dispatch",
      composerErrorMessage: "Could not save pending task",
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      selectedTaskId: null,
      taskUiSlots: []
    });
  });

  it("holds immediate recovery behind the live attempt persistence barrier", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const persistenceBarrier = createDeferred<void>();
    const originalCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const recoveryCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask
      .mockReturnValueOnce(originalCreate.promise)
      .mockReturnValueOnce(recoveryCreate.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "99999999999999999999999999999999",
      persistSessionContext: () => persistenceBarrier.promise
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Persist before either request");

    const originalPromise = controller.createTask();
    const firstRecovery = controller.recoverTaskCreation();
    const secondRecovery = controller.recoverTaskCreation();
    await flushMicrotasks();

    expect(secondRecovery).toBe(firstRecovery);
    expect(client.createTask).not.toHaveBeenCalled();

    persistenceBarrier.resolve();
    await flushMicrotasks();

    expect(client.createTask).toHaveBeenCalledTimes(2);
    for (const [request] of client.createTask.mock.calls) {
      expect(request).toEqual({
        taskId: "99999999999999999999999999999999",
        repoId: "repo-2",
        prompt: "Persist before either request",
        desktopId: "desktop-1",
        agentProvider: "claude",
        agentType: "pty",
        terminalCols: 80,
        terminalRows: 48
      });
    }

    recoveryCreate.resolve({
      taskId: "99999999999999999999999999999999",
      repoId: "repo-2",
      title: "Persist before either request",
      stage: "in progress"
    });
    await firstRecovery;
    originalCreate.resolve({
      taskId: "99999999999999999999999999999999",
      repoId: "repo-2",
      title: "Persist before either request",
      stage: "in progress"
    });
    await originalPromise;
  });

  it("does not let immediate recovery suppress a rejected persistence barrier", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const persistenceBarrier = createDeferred<void>();
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      persistSessionContext: () => persistenceBarrier.promise
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Stay editable when save fails");

    const originalPromise = controller.createTask();
    const recoveryPromise = controller.recoverTaskCreation();
    await flushMicrotasks();

    expect(client.createTask).not.toHaveBeenCalled();

    persistenceBarrier.reject(new Error("Pending attempt was not saved"));
    await Promise.all([originalPromise, recoveryPromise]);

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      composerPrompt: "Stay editable when save fails",
      composerErrorMessage: "Pending attempt was not saved",
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      selectedTaskId: null,
      taskUiSlots: []
    });
  });

  it("recovers an uncertain create after leaving its task workspace with the exact frozen identity", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const originalCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const recoveryCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask
      .mockReturnValueOnce(originalCreate.promise)
      .mockReturnValueOnce(recoveryCreate.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "22222222222222222222222222222222",
      persistSessionContext: vi.fn().mockResolvedValue(undefined)
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Recover exactly once");
    void controller.createTask({ cols: 120, rows: 70 });
    await flushMicrotasks();

    controller.closeTask();
    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      taskCreationPhase: "pending",
      pendingTaskCreation: {
        taskId: "22222222222222222222222222222222",
        repoId: "repo-2",
        prompt: "Recover exactly once",
        desktopId: "desktop-1",
        agentProvider: "claude",
        terminalCols: 120,
        terminalRows: 70
      }
    });

    const firstRecovery = controller.recoverTaskCreation();
    const secondRecovery = controller.recoverTaskCreation();
    await flushMicrotasks();

    expect(secondRecovery).toBe(firstRecovery);
    expect(client.createTask).toHaveBeenCalledTimes(2);
    expect(client.createTask).toHaveBeenLastCalledWith({
      taskId: "22222222222222222222222222222222",
      repoId: "repo-2",
      prompt: "Recover exactly once",
      desktopId: "desktop-1",
      agentProvider: "claude",
      agentType: "pty",
      terminalCols: 120,
      terminalRows: 70
    });
    expect(store.getState().taskCreationPhase).toBe("recovering");

    recoveryCreate.resolve({
      taskId: "22222222222222222222222222222222",
      repoId: "repo-2",
      title: "Recover exactly once",
      stage: "in progress"
    });
    await firstRecovery;

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      selectedTaskId: null,
      taskCreationPhase: "idle",
      pendingTaskCreation: null
    });
    expect(store.getState().recentTasks[0]?.id).toBe(
      "22222222222222222222222222222222"
    );
  });

  it("opens a fresh composer beside a restarted attempt without allowing recovery identity to drift", async () => {
    const store = createSessionStore();
    const pendingTaskCreation = {
      slotId: "create:slot-restarted",
      taskId: "33333333333333333333333333333333",
      repoId: "repo-2",
      prompt: "Resume this exact task",
      desktopId: "desktop-2",
      agentProvider: "codex" as const
    };
    store.hydrateContext({
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-2",
      selectedTaskId: pendingTaskCreation.slotId,
      activeView: "tasks",
      pendingTaskCreation
    });
    const client = createClientMock();
    client.createTask.mockResolvedValueOnce({
      taskId: pendingTaskCreation.taskId,
      repoId: pendingTaskCreation.repoId,
      title: pendingTaskCreation.prompt,
      stage: "in progress"
    });
    const controller = createMobileController(client, store);

    controller.openComposer();
    controller.updateComposerPrompt("Do not replace this prompt");
    controller.selectComposerDesktop("desktop-1");
    controller.selectComposerAgentProvider("claude");
    controller.closeComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      composerPrompt: "",
      composerRepoId: pendingTaskCreation.repoId,
      composerDesktopId: "desktop-1",
      composerAgentProvider: "claude",
      taskCreationPhase: "uncertain",
      pendingTaskCreation
    });

    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      selectedTaskId: pendingTaskCreation.slotId,
      composerPrompt: "",
      composerRepoId: pendingTaskCreation.repoId,
      composerDesktopId: null,
      composerAgentProvider: "claude",
      taskCreationPhase: "uncertain",
      pendingTaskCreation
    });

    await controller.recoverTaskCreation(pendingTaskCreation.slotId);

    expect(client.createTask).toHaveBeenCalledOnce();
    expect(client.createTask).toHaveBeenCalledWith({
      taskId: pendingTaskCreation.taskId,
      repoId: pendingTaskCreation.repoId,
      prompt: pendingTaskCreation.prompt,
      desktopId: pendingTaskCreation.desktopId,
      agentProvider: pendingTaskCreation.agentProvider,
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });
    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      selectedTaskId: pendingTaskCreation.slotId,
      taskCreationPhase: "idle",
      pendingTaskCreation: null
    });
  });

  it("does not let the original flight clear an in-progress recovery", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const originalCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const recoveryCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask
      .mockReturnValueOnce(originalCreate.promise)
      .mockReturnValueOnce(recoveryCreate.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "66666666666666666666666666666666"
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Recover despite late original failure");
    const originalPromise = controller.createTask();
    await flushMicrotasks();
    const recoveryPromise = controller.recoverTaskCreation();
    await flushMicrotasks();

    originalCreate.reject(
      new TaskCreationError("not-created", "Original path rejected")
    );
    await originalPromise;

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "recovering",
      pendingTaskCreation: {
        taskId: "66666666666666666666666666666666"
      }
    });

    recoveryCreate.resolve({
      taskId: "66666666666666666666666666666666",
      repoId: "repo-2",
      title: "Recovered task",
      stage: "in progress"
    });
    await recoveryPromise;

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      selectedTaskId: store.getState().taskUiSlots[0]?.slotId
    });
  });

  it("keeps an attempt uncertain after recovery ambiguity and a later definite original failure", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const originalCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    const recoveryCreate = createDeferred<
      Awaited<ReturnType<KannaClient["createTask"]>>
    >();
    client.createTask
      .mockReturnValueOnce(originalCreate.promise)
      .mockReturnValueOnce(recoveryCreate.promise);
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "88888888888888888888888888888888"
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Keep recovery ambiguity durable");
    const originalPromise = controller.createTask();
    await flushMicrotasks();
    const recoveryPromise = controller.recoverTaskCreation();
    recoveryCreate.reject(new Error("Recovery response was lost"));
    await recoveryPromise;

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "uncertain",
      pendingTaskCreation: {
        taskId: "88888888888888888888888888888888"
      }
    });

    originalCreate.reject(
      new TaskCreationError("not-created", "Original request was rejected")
    );
    await originalPromise;

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "uncertain",
      pendingTaskCreation: {
        taskId: "88888888888888888888888888888888",
        prompt: "Keep recovery ambiguity durable"
      }
    });
  });

  it("keeps a raw create slot through a publication gap, hydrates it, then removes an authoritative deletion", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const seedTask: TaskSummary = {
      id: "task-seed",
      repoId: "repo-cloud",
      title: "Seed task",
      stage: "in progress",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-seed"
    };
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
    ]);
    client.createTask.mockResolvedValueOnce({
      taskId: "task-created-raw",
      repoId: "repo-cloud",
      title: "Raw created task",
      stage: "in progress",
      agentType: "pty"
    });
    let publishTasks: ((
      tasks: TaskSummary[],
      publication?: CloudTaskPublication
    ) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        publishTasks = onUpdate;
        onUpdate([seedTask]);
        return vi.fn();
      })
    });

    await controller.bootstrap();
    controller.openComposer();
    controller.selectComposerDesktop("desktop-a");
    controller.updateComposerPrompt("Raw created task");
    await controller.createTask();
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-created-raw",
      dataB64: "cmF3LWNyZWF0ZQ=="
    });

    expect(store.getState()).toMatchObject({
      selectedTaskId: store.getState().taskUiSlots[0]?.slotId,
      taskTerminalTaskId: "task-created-raw"
    });
    expect(terminalText(store)).toBe("cmF3LWNyZWF0ZQ==\n");
    const stableSlotId = store.getState().taskUiSlots[0]?.slotId;

    publishTasks?.([], { cloudAuthoritative: false });

    expect(store.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskTerminalTaskId: "task-created-raw",
      taskUiSlots: [
        {
          slotId: stableSlotId,
          taskId: "task-created-raw",
          authoritativeMissGraceRemaining: 1
        }
      ]
    });

    publishTasks?.([]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskTerminalTaskId: "task-created-raw",
      taskUiSlots: [
        {
          slotId: stableSlotId,
          taskId: "task-created-raw",
          authoritativeMissGraceRemaining: 0
        }
      ]
    });
    expect(terminalText(store)).toBe("cmF3LWNyZWF0ZQ==\n");
    expect(client.__terminalStream.subscription.close).not.toHaveBeenCalled();

    const publishedTask: TaskSummary = {
      id: "task-created-raw",
      repoId: "repo-cloud",
      title: "Published raw created task",
      stage: "in progress",
      agentType: "pty"
    };
    publishTasks?.([publishedTask]);

    expect(store.getState().taskUiSlots).toEqual([
      expect.objectContaining({
        slotId: stableSlotId,
        taskId: publishedTask.id,
        task: publishedTask,
        authoritativeMissGraceRemaining: 0
      })
    ]);

    publishTasks?.([]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskTerminalTaskId: null,
      taskUiSlots: []
    });
    expect(terminalText(store)).toBe("");
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledOnce();
  });

  it("strictly removes a raw new-action result that is absent from the next live snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const sourceTask: TaskSummary = {
      id: "cloud-source",
      repoId: "repo-cloud",
      title: "Source task",
      stage: "merge",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-source"
    };
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
    ]);
    client.listRecentTasks.mockResolvedValue([sourceTask]);
    client.listRepoTasks.mockResolvedValue([sourceTask]);
    client.runMergeAgent.mockResolvedValueOnce({
      taskId: "task-action-raw",
      followTask: true,
      task: {
        id: "task-action-raw",
        repoId: "repo-cloud",
        title: "Raw merge task",
        stage: "merge",
        agentType: "agent"
      }
    });
    let publishTasks: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        publishTasks = onUpdate;
        onUpdate([sourceTask]);
        return vi.fn();
      })
    });

    await controller.bootstrap();
    await controller.runMergeAgent(sourceTask.id);
    client.__agentStream.emit({
      type: "snapshot",
      taskId: "task-action-raw",
      events: [{
        seq: 0,
        event: { type: "assistant_text", text: "Raw action", truncated: false }
      }],
      nextSeq: 1
    });

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-action-raw",
      taskAgentTaskId: "task-action-raw",
      taskAgentStatus: "live"
    });

    publishTasks?.([]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskAgentTaskId: null,
      taskAgentEvents: []
    });
    expect(client.__agentStream.subscription.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      description: "when the publisher includes the local repository identity",
      localRepoId: "repo-local" as string | undefined,
      canonicalId: "cloud:desktop-a:repo-local:task-created"
    },
    {
      description: "when the publisher omits the optional local repository identity",
      localRepoId: undefined,
      canonicalId: "cloud:desktop-a:repo-cloud:task-created"
    }
  ])(
    "migrates a route-qualified create result to its publisher-derived cloud identity $description",
    async ({ localRepoId, canonicalId }) => {
      const store = createSessionStore();
      const client = createClientMock();
      const auth = createAuthSessionMock();
      const pendingTaskId = "cloud:desktop-a:repo-local:task-created";
      auth.getState = vi.fn(() => ({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      }));
      client.getStatus.mockResolvedValueOnce({
        state: "running",
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      });
      client.listDesktops.mockResolvedValueOnce([
        { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
      ]);
      client.listRepos.mockResolvedValue([
        { id: "repo-cloud", name: "Repo" }
      ]);
      client.getTaskRouteIdentity = vi.fn(
        () => "desktop-a:repo-local:task-created"
      );
      client.createTask.mockResolvedValueOnce({
        taskId: pendingTaskId,
        repoId: "repo-local",
        title: "Created task",
        stage: "in progress",
        agentType: "agent",
        ownerDesktopId: "desktop-a",
        ownerLocalRepoId: "repo-local",
        ownerLocalTaskId: "task-created"
      });
      const pendingSubscription = createAgentSubscriptionMock().subscription;
      client.observeTaskAgent.mockReturnValueOnce(pendingSubscription);
      let publishTasks: ((tasks: TaskSummary[]) => void) | null = null;
      const controller = createMobileController(client, store, auth, {
        subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
          publishTasks = onUpdate;
          return vi.fn();
        })
      });

      await controller.bootstrap();
      store.selectRepo("repo-cloud");
      controller.openComposer();
      controller.selectComposerDesktop("desktop-a");
      controller.updateComposerPrompt("Created task");
      await controller.createTask();

      const stableSlotId = store.getState().taskUiSlots[0]?.slotId;

      expect(store.getState()).toMatchObject({
        selectedTaskId: stableSlotId,
        taskAgentTaskId: pendingTaskId
      });
      expect(client.observeTaskAgent).toHaveBeenCalledWith(
        pendingTaskId,
        expect.any(Function)
      );

      const canonical = mapCloudTaskSnapshot({
        ...(localRepoId ? { localRepoId } : {}),
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-created",
        title: "Created task",
        stage: "in progress",
        repo: { cloudRepoId: "repo-cloud", name: "Repo" },
        agent: { provider: "claude", type: "agent" },
        updatedAt: "2026-07-11T00:00:00.000Z"
      });
      expect(canonical.id).toBe(canonicalId);

      publishTasks?.([canonical]);

      expect(store.getState()).toMatchObject({
        selectedTaskId: stableSlotId,
        taskAgentTaskId: canonical.id
      });
      expect(store.getState().taskUiSlots[0]).toMatchObject({
        slotId: stableSlotId,
        taskId: canonical.id
      });
      expect(pendingSubscription.close).not.toHaveBeenCalled();
      expect(client.observeTaskAgent).toHaveBeenCalledTimes(1);

      publishTasks?.([{ ...canonical, title: "Created task metadata refresh" }]);

      expect(client.observeTaskAgent).toHaveBeenCalledTimes(1);
      expect(pendingSubscription.close).not.toHaveBeenCalled();
    }
  );

  it("canonicalizes an acknowledged slot without selecting it", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
    ]);
    client.createTask.mockResolvedValueOnce({
      taskId: "task-created",
      repoId: "repo-local",
      title: "Created task",
      stage: "in progress",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-created"
    });
    let publishTasks: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        publishTasks = onUpdate;
        return vi.fn();
      })
    });
    const canonical = mapCloudTaskSnapshot({
      localRepoId: "repo-local",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "task-created",
      title: "Created task",
      stage: "in progress",
      repo: { cloudRepoId: "repo-cloud", name: "Repo" },
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await controller.bootstrap();
    store.selectRepo("repo-cloud");
    controller.openComposer();
    controller.selectComposerDesktop("desktop-a");
    controller.updateComposerPrompt("Created task");
    await controller.createTask();
    const stableSlotId = store.getState().taskUiSlots[0]?.slotId;
    controller.closeTask();

    publishTasks?.([canonical]);
    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskUiSlots: [
        {
          slotId: stableSlotId,
          taskId: canonical.id,
          state: "ready"
        }
      ]
    });

    controller.openTask(stableSlotId!);
    publishTasks?.([{ ...canonical, title: "Current canonical task" }]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskUiSlots: [
        {
          slotId: stableSlotId,
          taskId: canonical.id
        }
      ]
    });
    expect(store.getState().recentTasks[0]?.title).toBe(
      "Current canonical task"
    );
  });

  it("removes an optimistic slot when recovery proves the task was not created", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.createTask
      .mockRejectedValueOnce(new Error("Relay response was lost"))
      .mockRejectedValueOnce(
        new TaskCreationError("not-created", "Desktop rejected recovery")
      );
    const controller = createMobileController(client, store, undefined, {
      createTaskSlotId: () => "create:slot-definite-recovery"
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Recover or remove this task");
    await controller.createTask();

    expect(store.getState()).toMatchObject({
      selectedTaskId: "create:slot-definite-recovery",
      taskCreationPhase: "uncertain"
    });

    await controller.recoverTaskCreation();

    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      taskUiSlots: [],
      errorMessage: "Desktop rejected recovery",
      composerErrorMessage: "Desktop rejected recovery"
    });
  });

  it("does not resurrect a raw create alias after explicitly closing that task", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-a", name: "Desktop A", online: true, mode: "remote" }
    ]);
    client.createTask.mockResolvedValueOnce({
      taskId: "task-created",
      repoId: "repo-local",
      title: "Created task",
      stage: "in progress"
    });
    let publishTasks: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        publishTasks = onUpdate;
        return vi.fn();
      })
    });
    const canonical = mapCloudTaskSnapshot({
      localRepoId: "repo-local",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "task-created",
      title: "Created task",
      stage: "in progress",
      repo: { cloudRepoId: "repo-cloud", name: "Repo" },
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await controller.bootstrap();
    store.selectRepo("repo-cloud");
    controller.openComposer();
    controller.selectComposerDesktop("desktop-a");
    controller.updateComposerPrompt("Created task");
    await controller.createTask();
    client.listRecentTasks.mockResolvedValue([]);
    client.listRepoTasks.mockResolvedValue([]);

    await controller.closeDesktopTask("task-created");
    controller.openTask("task-created");
    publishTasks?.([canonical]);

    expect(store.getState().selectedTaskId).toBeNull();
  });

  it("creates a task with the selected composer agent provider", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    controller.selectComposerAgentProvider("copilot");

    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith({
      taskId: expect.stringMatching(/^[0-9a-f]{32}$/),
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-1",
      agentProvider: "copilot",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });
  });

  it("opens the composer with the selected repo's saved machine and agent", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    store.upsertRepoCreationProfile({
      repoId: "repo-2",
      desktopId: "desktop-2",
      agentProvider: "opencode",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });

    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerDesktopId: "desktop-2",
      composerAgentProvider: "opencode",
      isComposerOptionsExpanded: false
    });
  });

  it("opens a no-profile repo composer with Claude after another repo selected a different agent", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.bootstrap();
    store.selectRepo("repo-1");
    store.upsertRepoCreationProfile({
      repoId: "repo-1",
      desktopId: "desktop-1",
      agentProvider: "opencode",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });
    controller.openComposer();
    expect(store.getState().composerAgentProvider).toBe("opencode");

    store.selectRepo("repo-2");
    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerAgentProvider: "claude"
    });
  });

  it("defaults the composer to a provider the selected machine can actually run", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listDesktops.mockResolvedValue([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "lan",
        agentProviders: ["opencode"]
      }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-1");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    await controller.createTask();

    // Claude is Kanna's first supported provider, but this machine cannot run
    // it: the task must be created for what the machine actually has.
    expect(store.getState().composerAgentProvider).toBe("opencode");
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-1", agentProvider: "opencode" })
    );
  });

  it("drops a saved provider the newly selected machine cannot run", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listDesktops.mockResolvedValue([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "lan",
        agentProviders: ["claude", "opencode"]
      },
      {
        id: "desktop-2",
        name: "Laptop",
        online: true,
        mode: "lan",
        agentProviders: ["opencode"]
      }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-1");
    store.upsertRepoCreationProfile({
      repoId: "repo-1",
      desktopId: "desktop-1",
      agentProvider: "claude",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });
    controller.openComposer();
    expect(store.getState().composerAgentProvider).toBe("claude");

    controller.selectComposerDesktop("desktop-2");

    expect(store.getState().composerAgentProvider).toBe("opencode");

    controller.updateComposerPrompt("Ship mobile shell");
    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-2", agentProvider: "opencode" })
    );
  });

  it("refuses to create a task on a machine that reports no agent CLI", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listDesktops.mockResolvedValue([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "lan",
        agentProviders: []
      }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-1");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    await controller.createTask();

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerAgentProvider: null,
      composerErrorMessage:
        "Studio Mac has no agent CLI installed. Install one on that machine, then try again.",
      isComposerOptionsExpanded: true
    });
  });

  it("re-resolves the open composer when a refresh brings the machine's inventory", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listDesktops.mockResolvedValue([
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-1");
    controller.openComposer();
    expect(store.getState().composerAgentProvider).toBe("claude");

    client.listDesktops.mockResolvedValue([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "lan",
        agentProviders: ["opencode"]
      }
    ]);
    await controller.refresh();

    expect(store.getState().composerAgentProvider).toBe("opencode");
  });

  // A late LAN read republishes the machine sources without the merged desktop
  // list being re-read, so the machine the composer renders can carry an
  // inventory that `desktops` does not yet have. Resolving the provider from
  // the other list creates exactly the task this feature exists to prevent.
  it("resolves the provider from the machine list the composer renders", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.listDesktops.mockResolvedValue([
      { id: "desktop-1", name: "Reviewer Mac", online: true, mode: "lan" }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.setMachineSourceDesktops({
      account: [],
      local: [
        {
          id: "desktop-1",
          name: "Reviewer Mac",
          online: true,
          mode: "lan",
          agentProviders: ["opencode"]
        }
      ]
    });
    store.selectRepo("repo-1");

    controller.openComposer();
    controller.selectComposerDesktop("desktop-1");
    controller.updateComposerPrompt("Ship mobile shell");
    await controller.createTask();

    expect(store.getState().composerAgentProvider).toBe("opencode");
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentProvider: "opencode" })
    );
  });

  it("treats a saved machine that is no longer listed as unselected", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    store.upsertRepoCreationProfile({
      repoId: "repo-2",
      desktopId: "desktop-stale",
      agentProvider: "opencode",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });

    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    await controller.createTask();

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerDesktopId: null,
      composerAgentProvider: "opencode",
      composerErrorMessage: "Choose a machine for this repo first.",
      isComposerOptionsExpanded: true
    });

    controller.selectComposerDesktop("desktop-1");
    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith({
      taskId: expect.stringMatching(/^[0-9a-f]{32}$/),
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-1",
      agentProvider: "opencode",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });
  });

  it("opens composer options expanded when no machine can be inferred", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRepoTasks).mockResolvedValueOnce([]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-empty");
    store.setRepoTasks([]);
    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: true,
      composerDesktopId: null,
      isComposerOptionsExpanded: true
    });
  });

  it("infers the composer machine from a single cloud repo owner", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.setDesktops([
      ...store.getState().desktops,
      { id: "desktop-owner", name: "Owner Mac", online: true, mode: "remote" }
    ]);
    store.selectRepo("repo-cloud");
    store.setRepoTasks([
      {
        id: "cloud-task-1",
        repoId: "repo-cloud",
        title: "Cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1"
      }
    ] as never);

    controller.openComposer();

    expect(store.getState()).toMatchObject({
      composerDesktopId: "desktop-owner",
      isComposerOptionsExpanded: false
    });
  });

  it("requires a composer machine before creating a task", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-empty");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");

    await controller.createTask();

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      composerErrorMessage: "Choose a machine for this repo first.",
      isComposerOptionsExpanded: true
    });
  });

  it("persists the repo machine and agent after successful create", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    controller.selectComposerDesktop("desktop-2");
    controller.selectComposerAgentProvider("codex");

    await controller.createTask({ cols: 104, rows: 72 });

    expect(client.createTask).toHaveBeenCalledWith({
      taskId: expect.stringMatching(/^[0-9a-f]{32}$/),
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-2",
      agentProvider: "codex",
      agentType: "pty",
      terminalCols: 104,
      terminalRows: 72
    });
    expect(store.getState().repoCreationProfiles).toEqual([
      expect.objectContaining({
        repoId: "repo-2",
        desktopId: "desktop-2",
        agentProvider: "codex"
      })
    ]);
  });

  it("tracks the pending create attempt until it settles", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let resolveCreateTask:
      | ((response: Awaited<ReturnType<ClientMock["createTask"]>>) => void)
      | null = null;
    vi.mocked(client.createTask).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreateTask = resolve;
      })
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");

    const createPromise = controller.createTask();

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "pending",
      pendingTaskCreation: {
        taskId: expect.stringMatching(/^[0-9a-f]{32}$/),
        repoId: "repo-2",
        prompt: "Ship mobile shell"
      },
      composerErrorMessage: null
    });

    resolveCreateTask?.({
      taskId: "task-3",
      repoId: "repo-2",
      title: "Ship mobile shell",
      stage: "in progress"
    });
    await createPromise;

    expect(store.getState()).toMatchObject({
      taskCreationPhase: "idle",
      pendingTaskCreation: null
    });
  });

  it("keeps the exact attempt uncertain when the create result is ambiguous", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.createTask.mockRejectedValueOnce(new Error("Desktop unavailable"));
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "44444444444444444444444444444444",
      createTaskSlotId: () => "create:slot-ambiguous"
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");
    controller.selectComposerDesktop("desktop-2");
    controller.selectComposerAgentProvider("codex");

    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith({
      taskId: "44444444444444444444444444444444",
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-2",
      agentProvider: "codex",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      isComposerOpen: false,
      selectedTaskId: "create:slot-ambiguous",
      composerPrompt: "Ship mobile shell",
      composerDesktopId: "desktop-2",
      composerAgentProvider: "codex",
      composerErrorMessage: null,
      taskCreationPhase: "uncertain",
      taskCreationAttempts: [
        {
          slotId: "create:slot-ambiguous",
          errorMessage: "Desktop unavailable"
        }
      ],
      pendingTaskCreation: {
        slotId: "create:slot-ambiguous",
        taskId: "44444444444444444444444444444444",
        repoId: "repo-2",
        prompt: "Ship mobile shell",
        desktopId: "desktop-2",
        agentProvider: "codex"
      }
    });
  });

  it("removes the optimistic slot after a definite pre-creation failure", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    client.createTask.mockRejectedValueOnce(
      new TaskCreationError("not-created", "Prompt was rejected")
    );
    const controller = createMobileController(client, store, undefined, {
      createTaskId: () => "55555555555555555555555555555555",
      createTaskSlotId: () => "create:slot-rejected"
    });

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Fix the prompt and retry");

    await controller.createTask();

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      selectedTaskId: null,
      composerPrompt: "Fix the prompt and retry",
      composerErrorMessage: "Prompt was rejected",
      errorMessage: "Prompt was rejected",
      taskCreationPhase: "idle",
      pendingTaskCreation: null,
      taskUiSlots: []
    });
  });

  it("shows missing task details as a composer error instead of a global connection error", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    store.setComposerState(true, " ");

    await controller.createTask();

    expect(client.createTask).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      isComposerOpen: true,
      composerErrorMessage: "Choose a repo and enter a task prompt first.",
      taskCreationPhase: "idle",
      pendingTaskCreation: null
    });
  });

  it("keeps the created task visible when terminal startup throws after creation", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.observeTaskTerminal).mockImplementation(() => {
      throw new Error("websocket bootstrap failed");
    });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    store.selectRepo("repo-2");
    controller.openComposer();
    controller.updateComposerPrompt("Ship mobile shell");

    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith({
      taskId: expect.stringMatching(/^[0-9a-f]{32}$/),
      repoId: "repo-2",
      prompt: "Ship mobile shell",
      desktopId: "desktop-1",
      agentProvider: "claude",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      selectedTaskId: store.getState().taskUiSlots[0]?.slotId,
      taskTerminalTaskId: "task-3",
      taskTerminalStatus: "error",
      taskTerminalErrorMessage: "websocket bootstrap failed",
      isComposerOpen: false,
      composerPrompt: ""
    });
    expect(store.getState().recentTasks[0]?.id).toBe("task-3");
    expect(store.getState().errorMessage).toBe("websocket bootstrap failed");
  });

  it("selects a repo and refreshes the repo-scoped task list", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.selectRepo("repo-2");

    expect(client.listRepoTasks).toHaveBeenLastCalledWith("repo-2");
    expect(store.getState().selectedRepoId).toBe("repo-2");
    expect(store.getState().repoTasks.map((task) => task.id)).toEqual(["task-repo-2"]);
  });

  it("shows cached all-repo tasks while a selected repo refresh is pending", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const repoOneTask: TaskSummary = {
      id: "task-repo-1",
      repoId: "repo-1",
      title: "Repo One task",
      stage: "in progress"
    };
    const cachedRepoTwoTask: TaskSummary = {
      id: "task-repo-2-cached",
      repoId: "repo-2",
      title: "Cached Repo Two task",
      stage: "review"
    };
    const refreshedRepoTwoTask: TaskSummary = {
      ...cachedRepoTwoTask,
      title: "Refreshed Repo Two task"
    };
    const repoTwoRefresh = createDeferred<TaskSummary[]>();
    client.listRecentTasks.mockResolvedValue([repoOneTask, cachedRepoTwoTask]);
    client.listRepoTasks
      .mockResolvedValueOnce([repoOneTask])
      .mockReturnValueOnce(repoTwoRefresh.promise);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    const selection = controller.selectRepo("repo-2");

    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-2",
      repoTasks: [cachedRepoTwoTask]
    });

    repoTwoRefresh.resolve([refreshedRepoTwoTask]);
    await selection;

    expect(store.getState().repoTasks).toEqual([refreshedRepoTwoTask]);
  });

  it("selects a desktop without choosing a navigation destination", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.setNavigationView("desktops");
    await controller.selectDesktop("desktop-2");

    expect(store.getState()).toMatchObject({
      activeView: "desktops",
      selectedDesktopId: "desktop-2",
      selectedTaskId: null
    });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    expect(client.listDesktops).toHaveBeenCalledTimes(2);
  });

  it("runs the merge agent for the selected task and refreshes recent tasks", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-merge",
          repoId: "repo-1",
          title: "Merge task",
          stage: "in progress"
        }
      ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.runMergeAgent("task-1");

    expect(client.runMergeAgent).toHaveBeenCalledWith("task-1");
    expect(store.getState().selectedTaskId).toBe("task-merge");
    expect(store.getState().recentTasks[0]?.id).toBe("task-merge");
  });

  it("opens an exact action-result agent summary while publication is pending", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const canonicalMergeTaskId =
      "cloud:desktop-owner:repo-local:task-merge";
    client.runMergeAgent.mockResolvedValue({
      taskId: canonicalMergeTaskId,
      followTask: true,
      task: {
        id: canonicalMergeTaskId,
        repoId: "repo-1",
        title: "Merge task",
        stage: "merge",
        agentType: "agent"
      }
    });
    client.listRecentTasks
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Source task",
          stage: "in progress",
          agentType: "pty"
        }
      ])
      .mockResolvedValueOnce([]);
    client.listRepoTasks
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Source task",
          stage: "in progress",
          agentType: "pty"
        }
      ])
      .mockResolvedValueOnce([]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.runMergeAgent("task-1");

    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      canonicalMergeTaskId,
      expect.any(Function)
    );
    expect(store.getState()).toMatchObject({
      selectedTaskId: canonicalMergeTaskId,
      taskAgentTaskId: canonicalMergeTaskId,
      activeView: "tasks"
    });
    expect(store.getState().recentTasks).toContainEqual(
      expect.objectContaining({
        id: canonicalMergeTaskId,
        agentType: "agent"
      })
    );
  });

  it("waits without retaining the source stream when action metadata lookup misses", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const sourceTask: TaskSummary = {
      id: "cloud-source",
      repoId: "repo-cloud",
      title: "Source task",
      stage: "merge",
      agentType: "pty",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-source"
    };
    const pendingTaskId =
      "cloud:desktop-owner:repo-local:task-merge";
    client.getTaskRouteIdentity = vi.fn((taskId) =>
      taskId === pendingTaskId || taskId === "explicit-merge-task"
        ? "desktop-owner:task-merge"
        : "desktop-owner:task-source"
    );
    client.runMergeAgent.mockResolvedValue({
      taskId: pendingTaskId,
      followTask: true,
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-merge"
    });
    client.listRecentTasks.mockResolvedValue([sourceTask]);
    client.listRepoTasks.mockResolvedValue([sourceTask]);
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops.mockResolvedValueOnce([
      { id: "desktop-owner", name: "Owner", online: true, mode: "remote" }
    ]);
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    let publishTasks: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        publishTasks = onUpdate;
        onUpdate([sourceTask]);
        return vi.fn();
      })
    });

    await controller.bootstrap();
    controller.openTask(sourceTask.id);
    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      sourceTask.id,
      expect.any(Function)
    );
    await controller.runMergeAgent(sourceTask.id);

    expect(store.getState()).toMatchObject({
      selectedTaskId: pendingTaskId,
      taskTerminalTaskId: null,
      taskAgentTaskId: null
    });
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledOnce();

    publishTasks?.([{
      id: "explicit-merge-task",
      repoId: "repo-cloud",
      title: "Published merge task",
      stage: "merge",
      agentType: "agent",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-merge"
    }]);

    expect(store.getState()).toMatchObject({
      selectedTaskId: "explicit-merge-task",
      taskAgentTaskId: "explicit-merge-task"
    });
    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      "explicit-merge-task",
      expect.any(Function)
    );
  });

  it("opens a task terminal stream and accumulates live output", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 24,
      dataB64: ""
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      dataB64: "Rmlyc3QgbGluZQo="
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      dataB64: "U2Vjb25kIGxpbmU="
    });

    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      "task-1",
      expect.any(Function)
    );
    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-1",
      taskTerminalStatus: "live"
    });
    expect(terminalText(store)).toContain("Rmlyc3QgbGluZQo=");
    expect(terminalText(store)).toContain("U2Vjb25kIGxpbmU=");
    expect(terminalText(store)).not.toContain("First line");
  });

  it("applies the measured mobile grid on first attach and reasserts it after reconnect", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    const resize = client.__terminalStream.subscription.resize;

    await controller.bootstrap();
    controller.resizeTaskTerminal("task-1", 80, 48);
    controller.openTask("task-1");

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(80, 48);

    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 24,
      dataB64: ""
    });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith(80, 48);

    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 48,
      dataB64: ""
    });
    expect(resize).toHaveBeenCalledTimes(2);

    controller.resizeTaskTerminal("task-1", 128, 72);
    expect(resize).toHaveBeenCalledTimes(3);
    expect(resize).toHaveBeenLastCalledWith(128, 72);
  });

  it("replaces stale replay output with an authoritative reconnect snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    const reconnectSnapshot = "B".repeat(1_100_000);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 24,
      dataB64: "aW5pdGlhbCBzbmFwc2hvdA=="
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      dataB64: "c3RhbGUgbGl2ZSBvdXRwdXQ="
    });
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 132,
      rows: 43,
      dataB64: reconnectSnapshot
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      dataB64: "ZnJlc2ggbGl2ZSBvdXRwdXQ="
    });

    expect(store.getState()).toMatchObject({
      taskTerminalCols: 132,
      taskTerminalRows: 43
    });
    expect(terminalText(store)).toBe(
      `${reconnectSnapshot}\nZnJlc2ggbGl2ZSBvdXRwdXQ=\n`
    );
  });

  it("owns one companion stream beside the task view and sends only while active", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.openTask("task-1");
    expect(client.observeTaskCompanion).toHaveBeenCalledTimes(1);
    client.__companionStream.emit({
      type: "snapshot",
      taskId: "task-1",
      sessionId: "123-456",
      revision: "rev-1",
      documentKind: "fragment",
      html: "<h2>Choose</h2>"
    });
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "available",
      taskCompanionUnread: true,
      taskCompanionSnapshot: { revision: "rev-1" }
    });

    controller.setTaskCompanionOpen("task-1", true);
    expect(store.getState().taskCompanionUnread).toBe(false);
    const event = {
      event_id: "event-1",
      type: "click" as const,
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    };
    controller.sendTaskCompanionEvent("task-1", "123-456", "rev-1", event);
    expect(client.__companionStream.subscription.sendEvent).toHaveBeenCalledWith(
      "123-456",
      "rev-1",
      event
    );
    expect(store.getState()).toMatchObject({
      taskCompanionEventId: "event-1",
      taskCompanionEventStatus: "sending"
    });
    client.__companionStream.emit({
      type: "event_result",
      taskId: "task-1",
      sessionId: "123-456",
      revision: "rev-1",
      eventId: "event-1",
      accepted: true
    });
    expect(store.getState().taskCompanionEventStatus).toBe("sent");

    controller.closeTask();
    expect(client.__companionStream.subscription.close).toHaveBeenCalledOnce();
    controller.sendTaskCompanionEvent("task-1", "123-456", "rev-1", event);
    expect(client.__companionStream.subscription.sendEvent).toHaveBeenCalledOnce();
    expect(store.getState().taskCompanionStatus).toBe("idle");
  });

  it("requires a fresh companion snapshot and explicit retry after reconnect", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);
    const event = {
      event_id: "event-offline",
      type: "click" as const,
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    };

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__companionStream.emit({
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-1",
      documentKind: "fragment",
      html: '<button data-choice="a">A</button>'
    });
    client.__companionStream.emit({
      type: "connection",
      taskId: "task-1",
      connected: false
    });

    controller.sendTaskCompanionEvent(
      "task-1",
      "session-1",
      "rev-1",
      event
    );
    expect(client.__companionStream.subscription.sendEvent).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "reconnecting",
      taskCompanionSnapshot: null
    });

    client.__companionStream.emit({
      type: "connection",
      taskId: "task-1",
      connected: true
    });
    controller.sendTaskCompanionEvent(
      "task-1",
      "session-1",
      "rev-1",
      event
    );
    expect(client.__companionStream.subscription.sendEvent).not.toHaveBeenCalled();

    client.__companionStream.emit({
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-2",
      documentKind: "fragment",
      html: '<button data-choice="a">A again</button>'
    });
    controller.sendTaskCompanionEvent(
      "task-1",
      "session-1",
      "rev-2",
      { ...event, event_id: "event-retry" }
    );
    expect(client.__companionStream.subscription.sendEvent).toHaveBeenCalledOnce();
    expect(client.__companionStream.subscription.sendEvent).toHaveBeenCalledWith(
      "session-1",
      "rev-2",
      expect.objectContaining({ event_id: "event-retry" })
    );
    expect(store.getState()).toMatchObject({
      taskCompanionEventId: "event-retry",
      taskCompanionEventStatus: "sending"
    });
  });

  it("fails a companion selection immediately when the transport is offline", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.__companionStream.subscription.sendEvent).mockReturnValue(false);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__companionStream.emit({
      type: "snapshot",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "rev-1",
      documentKind: "fragment",
      html: '<button data-choice="a">A</button>'
    });
    controller.sendTaskCompanionEvent("task-1", "session-1", "rev-1", {
      event_id: "event-1",
      type: "click",
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    });

    expect(store.getState()).toMatchObject({
      taskCompanionStatus: "reconnecting",
      taskCompanionSnapshot: null,
      taskCompanionEventStatus: "error",
      taskCompanionErrorMessage:
        "Connection lost before the selection was confirmed. Retry after reconnecting."
    });
  });

  it("stores desktop PTY dimensions from an authoritative snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 132,
      rows: 43,
      dataB64: "c25hcHNob3Q="
    });

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: "task-1",
      taskTerminalCols: 132,
      taskTerminalRows: 43,
      taskTerminalStatus: "live"
    });
  });

  it("replaces stale terminal history when reconnect delivers a fresh snapshot", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 24,
      dataB64: "b2xkLXNuYXBzaG90"
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      dataB64: "c3RhbGUtZGVsdGE="
    });
    const previousEpoch = store.getState().taskTerminalOutputEpoch;

    client.__terminalStream.emit({
      type: "snapshot",
      taskId: "task-1",
      cols: 132,
      rows: 43,
      dataB64: "ZnJlc2gtc25hcHNob3Q="
    });

    expect(store.getState()).toMatchObject({
      taskTerminalOutputEpoch: previousEpoch + 1,
      taskTerminalOutputStart: 0,
      taskTerminalCols: 132,
      taskTerminalRows: 43,
      taskTerminalStatus: "live"
    });
    expect(terminalText(store)).toBe("ZnJlc2gtc25hcHNob3Q=\n");
  });

  it("rebinds the selected terminal when its effective route changes", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let routeIdentity = "lan:desktop-a:task-1";
    let publishRouteChange: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const streams: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    client.getTaskRouteIdentity = vi.fn(() => routeIdentity);
    client.observeTaskTerminal.mockImplementation(() => {
      const close = vi.fn();
      streams.push({ close });
      return { close };
    });
    const controller = createMobileController(client, store, undefined, {
      subscribeTaskRouteChanges(listener) {
        publishRouteChange = listener;
        return unsubscribe;
      }
    });

    await controller.bootstrap();
    controller.openTask("task-1");
    expect(streams).toHaveLength(1);

    publishRouteChange?.();
    expect(streams).toHaveLength(1);

    routeIdentity = "cloud:task-1";
    publishRouteChange?.();
    expect(streams).toHaveLength(2);
    expect(streams[0]!.close).toHaveBeenCalledOnce();

    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores buffered terminal events from the previous route after rebinding", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let routeIdentity = "owner-a";
    const streams: Array<{
      listener: (event: TaskTerminalStreamEvent) => void;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    client.getTaskRouteIdentity = vi.fn(() => routeIdentity);
    client.observeTaskTerminal.mockImplementation((_taskId, listener) => {
      const close = vi.fn();
      streams.push({ listener, close });
      return { close };
    });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.openTask("task-1");
    expect(streams).toHaveLength(1);

    routeIdentity = "owner-b";
    controller.openTask("task-1");
    expect(streams).toHaveLength(2);
    expect(streams[0]!.close).toHaveBeenCalledOnce();

    streams[1]!.listener({
      type: "output",
      taskId: "task-1",
      dataB64: "owner-b-output"
    });
    streams[0]!.listener({
      type: "output",
      taskId: "task-1",
      dataB64: "late-owner-a-output"
    });
    streams[0]!.listener({
      type: "exit",
      taskId: "task-1",
      code: 0
    });

    expect(store.getState()).toMatchObject({
      taskTerminalTaskId: "task-1",
      taskTerminalStatus: "live"
    });
    expect(terminalText(store)).toBe("owner-b-output\n");
  });

  it("opens an agent stream instead of a terminal stream for agent tasks", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValueOnce([
      {
        id: "task-agent",
        repoId: "repo-1",
        title: "Themed task",
        stage: "in progress",
        agentType: "agent"
      }
    ]);
    vi.mocked(client.listRepoTasks).mockResolvedValueOnce([
      {
        id: "task-agent",
        repoId: "repo-1",
        title: "Themed task",
        stage: "in progress",
        agentType: "agent"
      }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-agent");
    client.__agentStream.emit({
      type: "snapshot",
      taskId: "task-agent",
      events: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
      nextSeq: 1
    });
    client.__agentStream.emit({
      type: "event",
      taskId: "task-agent",
      seq: 1,
      event: { type: "assistant_text", text: "hi", truncated: false }
    });

    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      "task-agent",
      expect.any(Function)
    );
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-agent",
      taskAgentTaskId: "task-agent",
      taskAgentStatus: "live"
    });
    expect(store.getState().taskAgentEvents).toEqual([
      { seq: 0, event: { type: "user_message", text: "hello" } },
      { seq: 1, event: { type: "assistant_text", text: "hi", truncated: false } }
    ]);
  });

  it("ignores buffered agent events from the previous route after rebinding", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const agentTask: TaskSummary = {
      id: "task-agent",
      repoId: "repo-1",
      title: "Themed task",
      stage: "in progress",
      agentType: "agent"
    };
    client.listRecentTasks.mockResolvedValueOnce([agentTask]);
    client.listRepoTasks.mockResolvedValueOnce([agentTask]);
    let routeIdentity = "owner-a";
    const streams: Array<{
      listener: (event: TaskAgentStreamEvent) => void;
      subscription: TaskAgentSubscription;
    }> = [];
    client.getTaskRouteIdentity = vi.fn(() => routeIdentity);
    client.observeTaskAgent.mockImplementation((_taskId, listener) => {
      const subscription: TaskAgentSubscription = {
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      };
      streams.push({ listener, subscription });
      return subscription;
    });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask(agentTask.id);
    controller.openTask(agentTask.id);
    expect(streams).toHaveLength(1);

    routeIdentity = "owner-b";
    controller.openTask(agentTask.id);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.subscription.close).toHaveBeenCalledOnce();

    streams[1]!.listener({
      type: "snapshot",
      taskId: agentTask.id,
      events: [{
        seq: 0,
        event: { type: "assistant_text", text: "owner B", truncated: false }
      }],
      nextSeq: 1
    });
    streams[0]!.listener({
      type: "event",
      taskId: agentTask.id,
      seq: 1,
      event: { type: "assistant_text", text: "late owner A", truncated: false }
    });
    streams[0]!.listener({
      type: "exit",
      taskId: agentTask.id,
      code: 0
    });

    expect(store.getState()).toMatchObject({
      taskAgentTaskId: agentTask.id,
      taskAgentStatus: "live",
      taskAgentEvents: [{
        seq: 0,
        event: { type: "assistant_text", text: "owner B", truncated: false }
      }]
    });
  });

  it("opens a signed-in live cloud agent task through the agent stream", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const liveCloudTask = {
      id: "cloud-task-agent",
      repoId: "repo-1",
      title: "Cloud themed task",
      stage: "in progress",
      agentType: "agent" as const,
      ownerDesktopId: "desktop-owner",
      ownerLocalTaskId: "local-task-agent",
      ownerOnline: true
    };
    const subscribeCloudTasks = vi.fn((
      _uid: string,
      onUpdate: (tasks: typeof liveCloudTask[]) => void
    ) => {
      onUpdate([liveCloudTask]);
      return vi.fn();
    });
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks
    });

    await controller.bootstrap();
    controller.openTask("cloud-task-agent");

    expect(subscribeCloudTasks).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
      expect.any(Function)
    );
    expect(client.observeTaskAgent).toHaveBeenCalledWith(
      "cloud-task-agent",
      expect.any(Function)
    );
    expect(client.observeTaskTerminal).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      selectedTaskId: "cloud-task-agent",
      taskAgentTaskId: "cloud-task-agent"
    });
  });

  it("marks an already-open live cloud task read when its activity becomes unread", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const workingTask: TaskSummary = {
      id: "cloud-task-1",
      repoId: "repo-cloud-1",
      repoName: "Cloud Repo",
      title: "Cloud task",
      stage: "in progress",
      activity: "working",
      ownerDesktopId: "desktop-owner",
      ownerLocalTaskId: "local-task-1",
      ownerOnline: true
    };
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        onUpdate([workingTask]);
        return () => undefined;
      })
    });

    await controller.bootstrap();
    controller.openTask("cloud-task-1");
    controller.setTaskDetailVisible(true);
    liveUpdate?.([{ ...workingTask, activity: "unread" }]);
    await vi.advanceTimersByTimeAsync(999);

    expect(client.markTaskRead).not.toHaveBeenCalled();
    expect(store.getState().repoTasks[0]?.activity).toBe("unread");

    await vi.advanceTimersByTimeAsync(1);

    expect(client.markTaskRead).toHaveBeenCalledWith("cloud-task-1");
    expect(store.getState().repoTasks[0]?.activity).toBe("idle");
    expect(store.getState().recentTasks[0]?.activity).toBe("idle");
  });

  it("selects the first repo when live cloud tasks arrive without a selected repo", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const liveCloudTasks = [
      {
        id: "cloud-task-1",
        repoId: "repo-cloud-1",
        title: "First cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      },
      {
        id: "cloud-task-2",
        repoId: "repo-cloud-2",
        title: "Second cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-2",
        ownerOnline: true
      }
    ];
    const subscribeCloudTasks = vi.fn((
      _uid: string,
      onUpdate: (tasks: typeof liveCloudTasks) => void
    ) => {
      onUpdate(liveCloudTasks);
      return vi.fn();
    });
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks
    });

    await controller.bootstrap();

    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-cloud-1",
      recentTasks: liveCloudTasks,
      repoTasks: [liveCloudTasks[0]]
    });
  });

  it("deduplicates live cloud tasks by id before updating task lists", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const duplicateTask = {
      id: "cloud:desktop-1:repo-1:task-1",
      repoId: "repo-1",
      repoName: "Repo One",
      title: "foobar",
      stage: "in progress",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: true
    };
    const subscribeCloudTasks = vi.fn((
      _uid: string,
      onUpdate: (tasks: typeof duplicateTask[]) => void
    ) => {
      onUpdate([duplicateTask, { ...duplicateTask }, { ...duplicateTask }]);
      return vi.fn();
    });
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks
    });

    await controller.bootstrap();

    expect(store.getState().recentTasks.map((task) => task.id)).toEqual([
      duplicateTask.id
    ]);
    expect(store.getState().repoTasks.map((task) => task.id)).toEqual([
      duplicateTask.id
    ]);
  });

  it("derives repo list from live cloud tasks when the initial repo list is empty", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const liveCloudTasks = [
      {
        id: "cloud-task-1",
        repoId: "repo-cloud-1",
        repoName: "Cloud Repo",
        title: "First cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }
    ];
    client.listRepos.mockResolvedValueOnce([]);
    client.listRecentTasks.mockResolvedValueOnce([]);
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const subscribeCloudTasks = vi.fn((
      _uid: string,
      onUpdate: (tasks: typeof liveCloudTasks) => void
    ) => {
      onUpdate(liveCloudTasks);
      return vi.fn();
    });
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks
    });

    await controller.bootstrap();

    expect(store.getState().repos).toEqual([
      {
        id: "repo-cloud-1",
        name: "Cloud Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);
  });

  it("refreshes machines when live cloud tasks arrive", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const liveCloudTasks = [
      {
        id: "cloud-task-1",
        repoId: "repo-cloud-1",
        repoName: "Cloud Repo",
        title: "First cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }
    ];
    client.listDesktops.mockResolvedValueOnce([
      {
        id: "desktop-owner",
        name: "Kanna Desktop",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet"
      }
    ]);
    client.getStatus.mockResolvedValueOnce({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    const subscribeCloudTasks = vi.fn((
      _uid: string,
      onUpdate: (tasks: typeof liveCloudTasks) => void
    ) => {
      onUpdate(liveCloudTasks);
      return vi.fn();
    });
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks
    });

    await controller.bootstrap();
    await vi.waitFor(() => {
      expect(store.getState().desktops).toEqual([
        expect.objectContaining({
          id: "desktop-owner",
          name: "Kanna Desktop",
          mode: "remote"
        })
      ]);
    });

    store.selectRepo("repo-cloud-1");
    controller.openComposer();

    expect(store.getState()).toMatchObject({
      composerDesktopId: "desktop-owner",
      isComposerOptionsExpanded: false
    });
  });

  it("keeps refreshing machines while live cloud tasks replace task polling", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops
      .mockResolvedValueOnce([
        { id: "desktop-owner", name: "Studio Mac", online: false, mode: "remote" }
      ])
      .mockResolvedValueOnce([
        { id: "desktop-owner", name: "Studio Mac", online: true, mode: "remote" }
      ]);
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        onUpdate([
          {
            id: "cloud-task-1",
            repoId: "repo-1",
            title: "Cloud task",
            stage: "in progress",
            ownerDesktopId: "desktop-owner"
          } as TaskSummary
        ]);
        return () => undefined;
      })
    });

    await controller.bootstrap();
    await Promise.resolve();
    expect(liveUpdate).not.toBeNull();
    expect(store.getState().desktops).toEqual([
      { id: "desktop-owner", name: "Studio Mac", online: false, mode: "remote" }
    ]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.listRecentTasks).not.toHaveBeenCalled();
    expect(store.getState().desktops).toEqual([
      { id: "desktop-owner", name: "Studio Mac", online: true, mode: "remote" }
    ]);
  });

  it("keeps a healthy live task connection while desktop metadata retries", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    const auth = createAuthSessionMock();
    const liveTask: TaskSummary = {
      id: "cloud-display",
      repoId: "repo-cloud",
      repoName: "Cloud Repo",
      title: "Healthy live task",
      stage: "in progress",
      agentType: "agent",
      ownerDesktopId: "desktop-owner",
      ownerLocalTaskId: "local-task"
    };
    client.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    });
    client.listDesktops
      .mockRejectedValueOnce(new Error("desktop metadata unavailable"))
      .mockResolvedValueOnce([
        {
          id: "desktop-owner",
          name: "Studio Mac",
          online: true,
          mode: "remote"
        }
      ]);
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        onUpdate([liveTask]);
        return vi.fn();
      })
    });

    await controller.bootstrap();

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: "desktop metadata unavailable",
      recentTasks: [liveTask]
    });
    controller.openTask(liveTask.id);
    expect(store.getState()).toMatchObject({
      selectedTaskId: liveTask.id,
      taskAgentTaskId: liveTask.id
    });
    liveUpdate?.([{ ...liveTask, title: "Updated while metadata is down" }]);
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: "desktop metadata unavailable",
      recentTasks: [
        expect.objectContaining({
          id: liveTask.id,
          title: "Updated while metadata is down"
        })
      ]
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.listDesktops).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
      selectedTaskId: liveTask.id,
      recentTasks: [
        expect.objectContaining({
          id: liveTask.id,
          title: "Updated while metadata is down"
        })
      ],
      desktops: [
        expect.objectContaining({ id: "desktop-owner", name: "Studio Mac" })
      ]
    });
  });

  it("keeps terminal stream errors scoped to the selected task", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "error",
      taskId: "task-1",
      message: "No terminal session is available for this task"
    });

    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-1",
      taskTerminalStatus: "error",
      taskTerminalErrorMessage: "No terminal session is available for this task",
      errorMessage: null
    });
  });

  it("selects a desktop and refreshes status through the active client", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.getStatus)
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
      .mockResolvedValueOnce({
        state: "running",
        desktopId: "desktop-2",
        desktopName: "Laptop",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      });
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.selectDesktop("desktop-2");

    expect(store.getState()).toMatchObject({
      selectedDesktopId: "desktop-2",
      desktopName: "Laptop",
      connectionState: "connected"
    });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces no-selected-desktop errors during bootstrap", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.getStatus).mockRejectedValueOnce(
      new Error("Select a desktop before connecting remotely.")
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();

    expect(store.getState()).toMatchObject({
      connectionState: "error",
      errorMessage: "Select a desktop before connecting remotely."
    });
  });

  it("refreshes desktop-originated task list changes in the background", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        },
        {
          id: "task-desktop",
          repoId: "repo-1",
          title: "Created on desktop",
          stage: "in progress"
        }
      ]);
    vi.mocked(client.listRepoTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        },
        {
          id: "task-desktop",
          repoId: "repo-1",
          title: "Created on desktop",
          stage: "in progress"
        }
      ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(store.getState().recentTasks.map((task) => task.id)).toEqual([
      "task-1",
      "task-desktop"
    ]);
    expect(store.getState().repoTasks.map((task) => task.id)).toEqual([
      "task-1",
      "task-desktop"
    ]);
    vi.useRealTimers();
  });

  it("refreshes active search results in the background", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.searchTasks)
      .mockResolvedValueOnce([
        {
          id: "task-search",
          repoId: "repo-1",
          title: "Original search result",
          stage: "pr"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-search-updated",
          repoId: "repo-1",
          title: "Updated search result",
          stage: "in progress"
        }
      ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.searchTasks("merge");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.searchTasks).toHaveBeenLastCalledWith("merge");
    expect(store.getState().searchResults.map((task) => task.id)).toEqual([
      "task-search-updated"
    ]);
    vi.useRealTimers();
  });

  it("closes the task terminal when a background refresh removes the selected task", async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(client.listRepoTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.__terminalStream.subscription.close).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      selectedTaskId: null,
      taskTerminalTaskId: null,
      taskTerminalStatus: "idle"
    });
    expect(terminalText(store)).toBe("");
    vi.useRealTimers();
  });

  it("reconnects the selected task terminal during an explicit refresh", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    await controller.refresh();

    expect(client.__terminalStream.subscription.close).toHaveBeenCalledTimes(1);
    expect(client.observeTaskTerminal).toHaveBeenCalledTimes(2);
    expect(client.observeTaskTerminal).toHaveBeenNthCalledWith(
      2,
      "task-1",
      expect.any(Function)
    );
    expect(store.getState().taskTerminalTaskId).toBe("task-1");
  });

  it("reports explicit refresh progress and completion", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    const refreshPromise = controller.refresh();

    expect(store.getState().refreshStatus).toBe("refreshing");

    await refreshPromise;

    expect(store.getState().refreshStatus).toBe("updated");
  });

  it.each(["idle", "error"] as const)(
    "recovers live task ownership when foreground refresh starts from %s",
    async (initialState) => {
      const store = createSessionStore();
      const client = createClientMock();
      const auth = createAuthSessionMock();
      const lastGoodTask: TaskSummary = {
        id: "last-good",
        repoId: "repo-1",
        title: "Last good task",
        stage: "in progress"
      };
      const recoveredTask: TaskSummary = {
        id: "cloud-recovered",
        repoId: "repo-cloud",
        repoName: "Cloud Repo",
        title: "Recovered cloud task",
        stage: "in progress"
      };
      store.setRecentTasks([lastGoodTask]);
      store.setRepoTasks([lastGoodTask]);
      auth.getState = vi.fn(() => ({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      }));
      const cloudStatus = {
        state: "running" as const,
        desktopId: "cloud",
        desktopName: "Kanna Cloud",
        lanHost: "cloud",
        lanPort: 0,
        pairingCode: null
      };
      if (initialState === "idle") {
        client.getStatus
          .mockResolvedValueOnce({
            state: "stopped",
            desktopId: "none",
            desktopName: "No desktop",
            lanHost: "none",
            lanPort: 0,
            pairingCode: null
          })
          .mockResolvedValueOnce(cloudStatus);
      } else {
        client.getStatus
          .mockRejectedValueOnce(new Error("temporary status failure"))
          .mockResolvedValueOnce(cloudStatus);
      }
      let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
      const controller = createMobileController(client, store, auth, {
        subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
          liveUpdate = onUpdate;
          return vi.fn();
        })
      });
      await controller.bootstrap();
      expect(store.getState().connectionState).toBe(initialState);
      expect(store.getState().recentTasks).toEqual([lastGoodTask]);

      await controller.refresh();
      liveUpdate?.([recoveredTask]);

      expect(store.getState()).toMatchObject({
        connectionState: "connected",
        connectionMode: "remote",
        errorMessage: null,
        recentTasks: [recoveredTask],
        refreshStatus: "updated"
      });
    }
  );

  it.each([
    ["digit input", "1"],
    ["ordinary text", "continue"],
    ["internal multiline text", "first\nsecond"]
  ])(
    "passes PTY %s to the server without terminal control sequences",
    async (_caseName, input) => {
      const store = createSessionStore();
      const client = createClientMock();
      const controller = createMobileController(client, store);

      await controller.bootstrap();
      await controller.sendTaskInput("task-1", input);

      expect(client.sendTaskInput).toHaveBeenCalledWith("task-1", input);
    }
  );

  it("forwards alt-screen terminal scroll bytes to the active terminal stream", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.sendTaskTerminalInput("task-1", "G1s8NjU7MTsxTQ==");

    expect(client.__terminalStream.subscription.sendInput).toHaveBeenCalledWith(
      "G1s8NjU7MTsxTQ==",
      false,
      true
    );
  });

  it("drops terminal scroll bytes addressed to a task without the active terminal stream", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    controller.sendTaskTerminalInput("task-other", "G1s8NjU7MTsxTQ==");
    controller.sendTaskTerminalInput("task-1", "");

    expect(client.__terminalStream.subscription.sendInput).not.toHaveBeenCalled();
  });

  it("sends agent task input as plain text through the active agent stream", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValueOnce([
      {
        id: "task-agent",
        repoId: "repo-1",
        title: "Themed task",
        stage: "in progress",
        agentType: "agent"
      }
    ]);
    vi.mocked(client.listRepoTasks).mockResolvedValueOnce([
      {
        id: "task-agent",
        repoId: "repo-1",
        title: "Themed task",
        stage: "in progress",
        agentType: "agent"
      }
    ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-agent");
    await controller.sendTaskInput("task-agent", "continue");

    expect(client.__agentStream.subscription.sendInput).toHaveBeenCalledWith("continue");
    expect(client.sendTaskInput).not.toHaveBeenCalled();
  });

  it("closes the selected desktop task and clears the mobile task view", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(client.listRepoTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    await controller.closeDesktopTask("task-1");

    expect(client.closeTask).toHaveBeenCalledWith("task-1");
    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().recentTasks).toEqual([]);
    expect(store.getState().repoTasks).toEqual([]);
  });

  it("ignores duplicate close requests while one is already in flight", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let resolveClose: () => void = () => undefined;
    vi.mocked(client.closeTask).mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveClose = resolve;
      })
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");

    const firstClose = controller.closeDesktopTask("task-1");
    const duplicateClose = controller.closeDesktopTask("task-1");

    expect(store.getState().pendingTaskAction).toEqual({
      taskId: "task-1",
      action: "close-task"
    });

    await duplicateClose;
    expect(client.closeTask).toHaveBeenCalledTimes(1);

    resolveClose();
    await firstClose;

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(client.closeTask).toHaveBeenCalledTimes(1);
  });

  it("blocks stage advancement while a close is in flight and recovers after failure", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let rejectClose: (error: Error) => void = () => undefined;
    vi.mocked(client.closeTask).mockImplementation(
      () => new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
      })
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");

    const pendingClose = controller.closeDesktopTask("task-1");
    await expect(
      controller.advanceDesktopTaskStage("task-1")
    ).resolves.toBeNull();
    expect(client.advanceTaskStage).not.toHaveBeenCalled();

    rejectClose(new Error("daemon unavailable"));
    await pendingClose;

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().errorMessage).toBe("daemon unavailable");

    await controller.advanceDesktopTaskStage("task-1");
    expect(client.advanceTaskStage).toHaveBeenCalledWith("task-1");
  });

  it("ignores duplicate stage advancement while one is already in flight", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    let resolveAdvance: (response: { taskId: string }) => void = () => undefined;
    vi.mocked(client.advanceTaskStage).mockImplementation(
      () => new Promise((resolve) => {
        resolveAdvance = resolve;
      })
    );
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");

    const firstAdvance = controller.advanceDesktopTaskStage("task-1");
    const duplicateAdvance = controller.advanceDesktopTaskStage("task-1");

    expect(store.getState().pendingTaskAction).toEqual({
      taskId: "task-1",
      action: "advance-stage"
    });

    await expect(duplicateAdvance).resolves.toBeNull();
    expect(client.advanceTaskStage).toHaveBeenCalledTimes(1);

    resolveAdvance({ taskId: "task-pr" });
    await firstAdvance;

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(client.advanceTaskStage).toHaveBeenCalledTimes(1);
  });

  it("advances the selected task stage and opens the replacement task", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-pr",
          repoId: "repo-1",
          title: "Review mobile shell",
          stage: "pr"
        }
      ]);
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.advanceDesktopTaskStage("task-1");

    expect(client.advanceTaskStage).toHaveBeenCalledWith("task-1");
    expect(store.getState().selectedTaskId).toBe("task-pr");
    expect(store.getState().recentTasks[0]?.id).toBe("task-pr");
  });

  it("keeps display identities after routed merge and advance responses", async () => {
    const cloudOnly: TaskSummary = {
      id: "cloud-only",
      repoId: "repo-cloud",
      repoName: "Cloud Repo",
      title: "Cloud-only task",
      stage: "merge",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "local-cloud"
    };
    const duplicate: TaskSummary = {
      id: "cloud-duplicate",
      repoId: "repo-cloud",
      repoName: "Cloud Repo",
      title: "Cloud duplicate",
      stage: "review",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-duplicate"
    };
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async ({ path }) => {
      if (path.endsWith("/actions/run-merge-agent")) {
        return { taskId: "local-cloud" };
      }
      throw new Error(`Unexpected remote invocation: ${path}`);
    });
    const cloud = createKannaClient(createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      listCloudTasks: async () => [cloudOnly, duplicate]
    }));
    const lan = createClientMock();
    lan.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "desktop-lan",
      desktopName: "LAN Mac",
      lanHost: "192.168.1.10",
      lanPort: 48120,
      pairingCode: null
    });
    lan.listRecentTasks.mockResolvedValue([
      {
        id: "local-duplicate",
        repoId: "repo-lan",
        title: "Fresh LAN duplicate",
        stage: "review"
      },
      {
        id: "lan-only",
        repoId: "repo-lan",
        title: "LAN-only task",
        stage: "in progress"
      }
    ]);
    lan.listRepos.mockResolvedValue([{ id: "repo-lan", name: "LAN Repo" }]);
    lan.advanceTaskStage.mockResolvedValue({ taskId: "local-duplicate" });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const liveTasks = await client.listRecentTasks();
    const auth = createAuthSessionMock();
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const store = createSessionStore();
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        onUpdate(liveTasks);
        return vi.fn();
      })
    });
    await controller.bootstrap();

    await controller.runMergeAgent(cloudOnly.id);
    expect(store.getState().selectedTaskId).toBe(cloudOnly.id);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-cloud",
      method: "POST",
      path: "/v1/tasks/local-cloud/actions/run-merge-agent",
      body: null
    });

    await controller.advanceDesktopTaskStage(duplicate.id);
    expect(store.getState().selectedTaskId).toBe(duplicate.id);
    expect(lan.advanceTaskStage).toHaveBeenCalledWith("local-duplicate");
  });

  it("moves a provisional canonical action identity to its published cloud identity", async () => {
    const canonicalPendingTaskId =
      "cloud:desktop-lan:repo-lan:local-merge-result";
    const sourceTask: TaskSummary = {
      id: "cloud-source",
      repoId: "repo-cloud",
      repoName: "Cloud Repo",
      title: "Source task",
      stage: "merge",
      agentType: "agent",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-source"
    };
    const projectedTask: TaskSummary = {
      id: "cloud-merge-result",
      repoId: "repo-cloud",
      repoName: "Cloud Repo",
      title: "Projected merge result",
      stage: "merge",
      agentType: "agent",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-merge-result"
    };
    let cloudTasks = [sourceTask];
    let lanTasks: TaskSummary[] = [
      {
        id: "local-source",
        repoId: "repo-lan",
        title: "LAN source",
        stage: "merge",
        agentType: "agent"
      }
    ];
    const cloud = createKannaClient(createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop: vi.fn(),
      listCloudTasks: async () => cloudTasks
    }));
    const lan = createClientMock();
    lan.getStatus.mockResolvedValue({
      state: "running",
      desktopId: "desktop-lan",
      desktopName: "LAN Mac",
      lanHost: "192.168.1.10",
      lanPort: 48120,
      pairingCode: null
    });
    lan.listRecentTasks.mockImplementation(async () => lanTasks);
    lan.listRepos.mockResolvedValue([{ id: "repo-lan", name: "LAN Repo" }]);
    const agentStreams: Array<{
      listener: (event: TaskAgentStreamEvent) => void;
      subscription: TaskAgentSubscription;
    }> = [];
    const companionStreams: Array<{
      listener: (event: TaskCompanionStreamEvent) => void;
      subscription: TaskCompanionSubscription;
    }> = [];
    lan.observeTaskAgent.mockImplementation((_taskId, listener) => {
      const subscription: TaskAgentSubscription = {
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      };
      agentStreams.push({ listener, subscription });
      return subscription;
    });
    lan.observeTaskCompanion.mockImplementation((_taskId, listener) => {
      const subscription: TaskCompanionSubscription = {
        close: vi.fn(),
        sendEvent: vi.fn()
      };
      companionStreams.push({ listener, subscription });
      return subscription;
    });
    lan.runMergeAgent.mockImplementation(async () => {
      cloudTasks = [];
      lanTasks = [
        {
          id: "local-merge-result",
          repoId: "repo-lan",
          title: "LAN merge result",
          stage: "merge",
          agentType: "agent"
        }
      ];
      return { taskId: "local-merge-result", followTask: true };
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const initialTasks = await client.listRecentTasks();
    const auth = createAuthSessionMock();
    auth.getState = vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    }));
    const store = createSessionStore();
    let liveUpdate: ((tasks: TaskSummary[]) => void) | null = null;
    const controller = createMobileController(client, store, auth, {
      subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
        liveUpdate = onUpdate;
        onUpdate(initialTasks);
        return vi.fn();
      })
    });
    await controller.bootstrap();
    controller.openTask(sourceTask.id);

    await controller.runMergeAgent(sourceTask.id);

    expect(lan.runMergeAgent).toHaveBeenCalledWith("local-source");
    expect(store.getState().recentTasks).toEqual([
      expect.objectContaining({ id: canonicalPendingTaskId })
    ]);
    expect(store.getState()).toMatchObject({
      selectedTaskId: canonicalPendingTaskId,
      taskAgentTaskId: canonicalPendingTaskId
    });
    expect(agentStreams).toHaveLength(2);
    expect(agentStreams[0]!.subscription.close).toHaveBeenCalledOnce();
    expect(agentStreams[1]!.subscription.close).not.toHaveBeenCalled();
    expect(companionStreams).toHaveLength(2);
    expect(companionStreams[0]!.subscription.close).toHaveBeenCalledOnce();
    expect(companionStreams[1]!.subscription.close).not.toHaveBeenCalled();

    agentStreams[1]!.listener({
      type: "snapshot",
      taskId: "local-merge-result",
      events: [{
        seq: 0,
        event: { type: "assistant_text", text: "Before publish", truncated: false }
      }],
      nextSeq: 1
    });
    companionStreams[1]!.listener({
      type: "snapshot",
      taskId: "local-merge-result",
      sessionId: "123-456",
      revision: "rev-before-publish",
      documentKind: "fragment",
      html: "<button data-choice=\"ship\">Ship</button>"
    });

    cloudTasks = [projectedTask];
    liveUpdate?.(await client.listRecentTasks());

    expect(store.getState().recentTasks).toEqual([
      expect.objectContaining({
        id: projectedTask.id,
        ownerLocalTaskId: "local-merge-result"
      })
    ]);
    expect(store.getState()).toMatchObject({
      selectedTaskId: projectedTask.id,
      taskAgentTaskId: projectedTask.id,
      taskAgentStatus: "live",
      taskAgentEvents: [{
        seq: 0,
        event: { type: "assistant_text", text: "Before publish", truncated: false }
      }],
      taskCompanionTaskId: projectedTask.id,
      taskCompanionStatus: "available",
      taskCompanionSnapshot: {
        revision: "rev-before-publish"
      }
    });
    expect(agentStreams).toHaveLength(2);
    expect(agentStreams[1]!.subscription.close).not.toHaveBeenCalled();
    expect(companionStreams).toHaveLength(2);
    expect(companionStreams[1]!.subscription.close).not.toHaveBeenCalled();

    agentStreams[1]!.listener({
      type: "event",
      taskId: "local-merge-result",
      seq: 1,
      event: { type: "assistant_text", text: "After publish", truncated: false }
    });

    expect(store.getState().taskAgentEvents).toEqual([
      {
        seq: 0,
        event: { type: "assistant_text", text: "Before publish", truncated: false }
      },
      {
        seq: 1,
        event: { type: "assistant_text", text: "After publish", truncated: false }
      }
    ]);
  });

  it("mirrors auth session state into the mobile store during bootstrap", async () => {
    const store = createSessionStore();
    const auth = createAuthSessionMock();
    vi.mocked(auth.getState).mockReturnValue({
      status: "signedIn",
      user: {
        uid: "user-1",
        email: "dev@kanna.test",
        displayName: null
      }
    });
    const controller = createMobileController(createClientMock(), store, auth);

    await controller.bootstrap();

    expect(auth.initialize).toHaveBeenCalledTimes(1);
    expect(store.getState().auth).toEqual({
      status: "signedIn",
      user: {
        uid: "user-1",
        email: "dev@kanna.test",
        displayName: null
      }
    });
  });

  it("delegates email sign-in and sign-out to the auth session", async () => {
    const store = createSessionStore();
    const auth = createAuthSessionMock();
    const controller = createMobileController(createClientMock(), store, auth);

    await controller.signInWithEmailPassword("dev@kanna.test", "secret");
    await controller.signOut();

    expect(auth.signInWithEmailPassword).toHaveBeenCalledWith({
      email: "dev@kanna.test",
      password: "secret"
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
interface ClientMock extends KannaClient {
  __terminalStream: ReturnType<typeof createTerminalSubscriptionMock>;
  __agentStream: ReturnType<typeof createAgentSubscriptionMock>;
  __companionStream: ReturnType<typeof createCompanionSubscriptionMock>;
}

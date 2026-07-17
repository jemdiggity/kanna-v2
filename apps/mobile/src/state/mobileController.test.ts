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
  KannaClient,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../lib/api/client";
import { createKannaClient, TaskCreationError } from "../lib/api/client";
import type { TaskSummary } from "../lib/api/types";
import { createCloudLanClient } from "../lib/sources/cloudLanClient";
import { createRemoteTransport, type RemoteDesktopInvoker } from "../lib/transports/remoteTransport";
import { mapCloudTaskSnapshot } from "../lib/firebase/taskIndex";
import type { MachinePairingService } from "../lib/pairing/machinePairing";

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

function createClientMock(): ClientMock {
  const terminalStream = createTerminalSubscriptionMock();
  const agentStream = createAgentSubscriptionMock();

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
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    closeTask: vi.fn().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn().mockImplementation((_taskId, listener) => {
      terminalStream.subscription.setListener(listener);
      return terminalStream.subscription;
    }),
    observeTaskAgent: vi.fn().mockImplementation((_taskId, listener) => {
      agentStream.subscription.setListener(listener);
      return agentStream.subscription;
    }),
    __terminalStream: terminalStream,
    __agentStream: agentStream
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    const store = createSessionStore();
    const client = createClientMock();
    const staleRead = createDeferred<TaskSummary[]>();
    const staleReadStarted = createDeferred<void>();
    client.listRecentTasks.mockImplementationOnce(() => {
      staleReadStarted.resolve();
      return staleRead.promise;
    });
    const controller = createMobileController(client, store);

    const bootstrap = controller.bootstrap();
    await staleReadStarted.promise;
    await controller.selectRepo("repo-2");
    staleRead.reject(new Error("obsolete bootstrap tasks failed"));
    await bootstrap;

    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      errorMessage: null,
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
    await vi.advanceTimersByTimeAsync(999);
    controller.showView("more");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.markTaskRead).not.toHaveBeenCalled();

    controller.showView("tasks");
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
    await vi.advanceTimersByTimeAsync(999);
    controller.showView("more");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.markTaskRead).not.toHaveBeenCalled();

    controller.showView("recent");
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
      taskTerminalOutput: "",
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

    authState = { status: "signedOut" };
    authListener?.(authState);

    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(client.__terminalStream.subscription.close).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      auth: { status: "signedOut" },
      desktops: [],
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

  it("searches tasks and switches to the search surface", async () => {
    const store = createSessionStore();
    const controller = createMobileController(createClientMock(), store);

    await controller.searchTasks("search");

    expect(store.getState().activeView).toBe("search");
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

    await controller.createTask();

    expect(store.getState().recentTasks[0]).toMatchObject({
      id: "task-3",
      repoId: "repo-2",
      title: "Ship mobile shell",
      prompt: "Ship mobile shell with the canonical requirements"
    });
    expect(store.getState().selectedTaskId).toBe(
      store.getState().taskUiSlots[0]?.slotId
    );
    expect(store.getState().taskUiSlots[0]).toMatchObject({
      taskId: "task-3",
      state: "ready"
    });
    expect(store.getState().isComposerOpen).toBe(false);
    expect(store.getState().composerPrompt).toBe("");
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

  it("reopens a restarted uncertain attempt without allowing its identity to drift", async () => {
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
      composerPrompt: pendingTaskCreation.prompt,
      composerRepoId: pendingTaskCreation.repoId,
      composerDesktopId: pendingTaskCreation.desktopId,
      composerAgentProvider: pendingTaskCreation.agentProvider,
      taskCreationPhase: "uncertain",
      pendingTaskCreation
    });

    controller.openComposer();

    expect(store.getState()).toMatchObject({
      isComposerOpen: false,
      selectedTaskId: pendingTaskCreation.slotId,
      composerPrompt: pendingTaskCreation.prompt,
      composerRepoId: pendingTaskCreation.repoId,
      composerDesktopId: pendingTaskCreation.desktopId,
      composerAgentProvider: pendingTaskCreation.agentProvider,
      taskCreationPhase: "uncertain",
      pendingTaskCreation
    });

    await controller.recoverTaskCreation();

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
      isComposerOpen: false,
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
      taskTerminalTaskId: "task-created-raw",
      taskTerminalOutput: "cmF3LWNyZWF0ZQ==\n"
    });
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
      taskTerminalOutput: "cmF3LWNyZWF0ZQ==\n",
      taskUiSlots: [
        {
          slotId: stableSlotId,
          taskId: "task-created-raw",
          authoritativeMissGraceRemaining: 0
        }
      ]
    });
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
      taskTerminalOutput: "",
      taskUiSlots: []
    });
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
      composerErrorMessage: "Desktop unavailable",
      taskCreationPhase: "uncertain",
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

  it("selects a desktop and returns to the task list", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.showView("desktops");
    await controller.selectDesktop("desktop-2");

    expect(store.getState()).toMatchObject({
      activeView: "tasks",
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
    expect(store.getState().taskTerminalOutput).toContain("Rmlyc3QgbGluZQo=");
    expect(store.getState().taskTerminalOutput).toContain("U2Vjb25kIGxpbmU=");
    expect(store.getState().taskTerminalOutput).not.toContain("First line");
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
      taskTerminalOutput: "ZnJlc2gtc25hcHNob3Q=\n",
      taskTerminalOutputEpoch: previousEpoch + 1,
      taskTerminalOutputStart: 0,
      taskTerminalCols: 132,
      taskTerminalRows: 43,
      taskTerminalStatus: "live"
    });
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
      taskTerminalOutput: "owner-b-output\n",
      taskTerminalStatus: "live"
    });
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
      { id: "repo-cloud-1", name: "Cloud Repo" }
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
      taskTerminalStatus: "idle",
      taskTerminalOutput: ""
    });
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

    agentStreams[1]!.listener({
      type: "snapshot",
      taskId: "local-merge-result",
      events: [{
        seq: 0,
        event: { type: "assistant_text", text: "Before publish", truncated: false }
      }],
      nextSeq: 1
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
      }]
    });
    expect(agentStreams).toHaveLength(2);
    expect(agentStreams[1]!.subscription.close).not.toHaveBeenCalled();

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
}

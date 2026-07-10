import { describe, expect, it, vi } from "vitest";
import { createAppModel } from "./appModel";
import type { TaskAgentSubscription } from "./lib/api/client";
import type { TaskSummary } from "./lib/api/types";
import { createStaticBonjourBrowser } from "./lib/discovery/bonjour";
import type { MobileAuthSession, MobileAuthState } from "./lib/firebase/auth";
import type {
  CloudTaskIndex,
  CloudTaskIndexError,
  CloudTaskSummary
} from "./lib/firebase/taskIndex";
import type { FetchLike } from "./lib/transports/lanTransport";
import type { RelayDesktopClient } from "./lib/transports/relayClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function cloudTask(
  overrides: Partial<CloudTaskSummary> & Pick<CloudTaskSummary, "id">
): CloudTaskSummary {
  return {
    repoId: "repo-cloud",
    repoName: "Cloud Repo",
    title: "Cloud task",
    stage: "in progress",
    ownerDesktopId: "desktop-cloud",
    ownerLocalTaskId: overrides.id,
    ownerOnline: true,
    ...overrides
  };
}

function createMutableAuthSession(initialState: MobileAuthState) {
  let authState = initialState;
  const listeners = new Set<(state: MobileAuthState) => void>();
  const authSession: MobileAuthSession = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getState: () => authState,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      listener(authState);
      return () => listeners.delete(listener);
    }),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockImplementation(async () => {
      setState({ status: "signedOut" });
    }),
    getIdToken: vi.fn().mockResolvedValue("id-token"),
    notifyAuthExpired: vi.fn()
  };
  const setState = (nextState: MobileAuthState) => {
    authState = nextState;
    for (const listener of listeners) listener(authState);
  };
  return { authSession, setState };
}

function createRelayClientMock(
  listActiveDesktopIds: RelayDesktopClient["listActiveDesktopIds"] = vi
    .fn()
    .mockResolvedValue(new Set<string>())
): RelayDesktopClient {
  return {
    close: vi.fn(),
    invokeDesktop: vi.fn().mockResolvedValue(null),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskAgent: vi.fn(() => ({
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    })),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    listActiveDesktopIds
  };
}

function createTrustedPersistence() {
  return {
    load: vi.fn().mockResolvedValue({
      selectedDesktopId: "desktop-lan",
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks" as const,
      trustedDesktops: [
        {
          desktopId: "desktop-lan",
          displayName: "LAN Mac",
          lanEndpoints: [
            {
              baseUrl: "http://desktop.lan:48120",
              lastSeenAt: "2026-07-10T00:00:00.000Z"
            }
          ],
          lastSeenAt: "2026-07-10T00:00:00.000Z"
        }
      ]
    }),
    save: vi.fn().mockResolvedValue(undefined)
  };
}

function createLanFixture(
  listRecentTasks: () => Promise<TaskSummary[]>
): { bonjourBrowser: ReturnType<typeof createStaticBonjourBrowser>; fetchImpl: FetchLike } {
  const bonjourBrowser = createStaticBonjourBrowser([
    {
      name: "LAN Mac",
      type: "_kanna-mobile._tcp.",
      host: "desktop.lan",
      port: 48120,
      txt: { desktopId: "desktop-lan" }
    }
  ]);
  const fetchImpl = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith("http://desktop.lan:48120")) {
      throw new Error(`Unexpected LAN request: ${url}`);
    }
    if (url.endsWith("/v1/status")) {
      return response({
        state: "running",
        desktopId: "desktop-lan",
        desktopName: "LAN Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      });
    }
    if (url.endsWith("/v1/desktops")) {
      return response([
        { id: "desktop-lan", name: "LAN Mac", online: true, mode: "lan" }
      ]);
    }
    if (url.endsWith("/v1/repos")) {
      return response([{ id: "repo-lan", name: "LAN Repo" }]);
    }
    if (url.endsWith("/v1/tasks/recent")) {
      return response(await listRecentTasks());
    }
    if (/\/v1\/repos\/[^/]+\/tasks$/.test(url)) {
      return response(await listRecentTasks());
    }
    throw new Error(`Unexpected LAN request: ${url}`);
  }) as FetchLike;
  return { bonjourBrowser, fetchImpl };
}

function createTwoDesktopLanFixture() {
  const baseUrls = {
    "desktop-a": "http://desktop-a.lan:48120",
    "desktop-b": "http://desktop-b.lan:48120"
  } as const;
  const bonjourBrowser = createStaticBonjourBrowser([
    {
      name: "LAN Mac A",
      type: "_kanna-mobile._tcp.",
      host: "desktop-a.lan",
      port: 48120,
      txt: { desktopId: "desktop-a" }
    },
    {
      name: "LAN Mac B",
      type: "_kanna-mobile._tcp.",
      host: "desktop-b.lan",
      port: 48120,
      txt: { desktopId: "desktop-b" }
    }
  ]);
  const requests: Array<{ method: string; url: string }> = [];
  const fetchImpl = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({ method: init?.method ?? "GET", url });
    const desktopId = url.startsWith(baseUrls["desktop-a"])
      ? "desktop-a"
      : url.startsWith(baseUrls["desktop-b"])
        ? "desktop-b"
        : null;
    if (!desktopId) {
      throw new Error(`Unexpected LAN request: ${url}`);
    }
    if (url.endsWith("/v1/status")) {
      return response({
        state: "running",
        desktopId,
        desktopName: desktopId === "desktop-a" ? "LAN Mac A" : "LAN Mac B",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      });
    }
    if (url.endsWith("/v1/desktops")) {
      return response([
        {
          id: desktopId,
          name: desktopId === "desktop-a" ? "LAN Mac A" : "LAN Mac B",
          online: true,
          mode: "lan"
        }
      ]);
    }
    if (url.endsWith("/v1/repos")) {
      return response([]);
    }
    if (url.endsWith("/v1/tasks/recent")) {
      return response(
        desktopId === "desktop-a"
          ? [
              {
                id: "task-a",
                repoId: "repo-a",
                title: "Task owned by A",
                stage: "in progress"
              }
            ]
          : []
      );
    }
    if (url.endsWith("/v1/tasks/task-a/actions/close")) {
      return response(undefined);
    }
    throw new Error(`Unexpected LAN request: ${url}`);
  }) as FetchLike;
  const persistence = {
    load: vi.fn().mockResolvedValue({
      selectedDesktopId: "desktop-a",
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks" as const,
      trustedDesktops: [
        {
          desktopId: "desktop-a",
          displayName: "LAN Mac A",
          lanEndpoints: [],
          lastSeenAt: "2026-07-10T00:00:00.000Z"
        },
        {
          desktopId: "desktop-b",
          displayName: "LAN Mac B",
          lanEndpoints: [],
          lastSeenAt: "2026-07-10T00:00:00.000Z"
        }
      ]
    }),
    save: vi.fn().mockResolvedValue(undefined)
  };
  return { baseUrls, bonjourBrowser, fetchImpl, persistence, requests };
}

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value
  } as Response;
}

function signedInState(uid = "user-1"): MobileAuthState {
  return {
    status: "signedIn",
    user: { uid, email: `${uid}@example.com`, displayName: null }
  };
}

async function flushAsyncWork(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe("createAppModel cloud routing", () => {
  it("pins LAN task actions to the desktop learned by the merged snapshot", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lan = createTwoDesktopLanFixture();
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: lan.persistence,
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });

    await app.initialize();
    pushCloudTasks?.([]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "task-a" })
      ]);
    });

    app.sessionStore.selectDesktop("desktop-b");
    await app.client.closeTask("task-a");

    const closeRequests = lan.requests.filter(({ url }) =>
      url.endsWith("/v1/tasks/task-a/actions/close")
    );
    expect(closeRequests).toEqual([
      {
        method: "POST",
        url: `${lan.baseUrls["desktop-a"]}/v1/tasks/task-a/actions/close`
      }
    ]);
  });

  it("publishes live tasks without waiting for optional relay presence", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const presence = deferred<Set<string>>();
    const listActiveDesktopIds = vi.fn(() => presence.promise);
    const subscriptionReady = deferred<void>();
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        subscriptionReady.resolve(undefined);
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock(listActiveDesktopIds)
      }
    });
    let initialized = false;
    const initialize = app.initialize().then(() => {
      initialized = true;
    });
    await subscriptionReady.promise;
    expect(pushCloudTasks).not.toBeNull();

    const task = cloudTask({ id: "cloud:presence-independent" });
    pushCloudTasks?.([task]);
    await flushAsyncWork(12);

    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: task.id })
    ]);
    expect(initialized).toBe(true);
    expect(listActiveDesktopIds).toHaveBeenCalledOnce();

    presence.resolve(new Set());
    await initialize;
  });

  it("republishes duplicate cloud routes when deferred presence resolves", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const presence = deferred<Set<string>>();
    const listActiveDesktopIds = vi.fn(() => presence.promise);
    const relayClient = createRelayClientMock(listActiveDesktopIds);
    const subscriptionReady = deferred<void>();
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        subscriptionReady.resolve(undefined);
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => relayClient
      }
    });
    const initialize = app.initialize();
    await subscriptionReady.promise;
    const taskId = "cloud:deferred-presence";
    pushCloudTasks?.([
      cloudTask({
        id: taskId,
        title: "Stale owner",
        ownerDesktopId: "desktop-stale",
        ownerLocalTaskId: "task-stale",
        ownerOnline: false,
        agentType: "agent"
      }),
      cloudTask({
        id: taskId,
        title: "Active owner",
        ownerDesktopId: "desktop-active",
        ownerLocalTaskId: "task-active",
        ownerOnline: false,
        agentType: "agent"
      })
    ]);
    await flushAsyncWork(12);
    await initialize;

    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({
        id: taskId,
        title: "Stale owner",
        ownerDesktopId: "desktop-stale"
      })
    ]);
    expect(listActiveDesktopIds).toHaveBeenCalledOnce();

    presence.resolve(new Set(["desktop-active"]));
    await flushAsyncWork(20);

    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({
        id: taskId,
        title: "Active owner",
        ownerDesktopId: "desktop-active",
        ownerOnline: true
      })
    ]);
    expect(listActiveDesktopIds).toHaveBeenCalledOnce();

    app.controller.openTask(taskId);
    expect(relayClient.observeTaskAgent).toHaveBeenCalledWith(
      { desktopId: "desktop-active", taskId: "task-active" },
      expect.any(Function)
    );
    await app.client.closeTask(taskId);
    expect(relayClient.invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-active",
      method: "POST",
      path: "/v1/tasks/task-active/actions/close",
      body: null
    });

    let subsequentStorePublications = 0;
    const unsubscribe = app.sessionStore.subscribe(() => {
      subsequentStorePublications += 1;
    });
    await app.client.listRecentTasks();
    await flushAsyncWork();
    expect(listActiveDesktopIds).toHaveBeenCalledTimes(2);
    expect(subsequentStorePublications).toBe(0);
    unsubscribe();
  });

  it("formats structured cloud task index errors before reporting them", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const recovery = deferred<CloudTaskSummary[]>();
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn(() => recovery.promise),
      subscribeRecentTasks: vi.fn((_uid, _onUpdate, onError) => {
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock()
      }
    });

    await app.initialize();
    expect(pushCloudError).not.toBeNull();
    pushCloudError?.({
      scope: "desktop",
      desktopId: "desktop-a",
      error: new Error("permission denied")
    });

    expect(app.sessionStore.getState().errorMessage).toBe(
      "Cloud task index desktop (desktop-a): permission denied"
    );

    recovery.resolve([]);
    await flushAsyncWork();
  });

  it("treats a ready empty live snapshot as authoritative across client re-resolution", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lanTask = {
      id: "task-lan",
      repoId: "repo-lan",
      title: "LAN task",
      stage: "in progress"
    };
    const lanRead = vi.fn().mockResolvedValue([lanTask]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });

    await app.initialize();
    expect(pushCloudTasks).not.toBeNull();
    pushCloudTasks?.([]);
    await flushAsyncWork();
    app.setForceCloud(false);
    vi.mocked(taskIndex.listRecentTasks).mockClear();

    await expect(app.client.listRecentTasks()).resolves.toEqual([lanTask]);
    expect(taskIndex.listRecentTasks).not.toHaveBeenCalled();
  });

  it("publishes only the newest merged live callback", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    app.setForceCloud(false);
    await app.client.listDesktops();
    await flushAsyncWork();
    const mergeA = deferred<TaskSummary[]>();
    const lanTaskA = {
      id: "lan-a",
      repoId: "repo-lan",
      title: "LAN A",
      stage: "review"
    };
    const lanTaskB = {
      id: "lan-b",
      repoId: "repo-lan",
      title: "LAN B",
      stage: "pr"
    };
    lanRead.mockReset();
    lanRead.mockImplementationOnce(() => mergeA.promise);
    lanRead.mockResolvedValueOnce([lanTaskB]);

    pushCloudTasks?.([cloudTask({ id: "cloud-a", title: "Cloud A" })]);
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledTimes(1));
    pushCloudTasks?.([cloudTask({ id: "cloud-b", title: "Cloud B" })]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud-b", title: "Cloud B" }),
        lanTaskB
      ]);
    });
    mergeA.resolve([lanTaskA]);
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: "cloud-b", title: "Cloud B" }),
      lanTaskB
    ]);
  });

  it("invalidates obsolete callbacks and merges when auth replaces a subscription", async () => {
    const auth = createMutableAuthSession(signedInState());
    const subscriptions: Array<{
      onUpdate: (tasks: CloudTaskSummary[]) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const initialTask = cloudTask({ id: "cloud-initial" });
    const freshTask = cloudTask({ id: "cloud-fresh", title: "Fresh task" });
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([initialTask]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ onUpdate, unsubscribe });
        return unsubscribe;
      })
    };
    const activeIds = vi.fn().mockResolvedValue(new Set<string>());
    const app = createAppModel({
      authSession: auth.authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock(activeIds)
      }
    });
    await app.initialize();
    expect(subscriptions).toHaveLength(1);
    subscriptions[0].onUpdate([initialTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: initialTask.id })
      ]);
    });
    const obsoleteMerge = deferred<Set<string>>();
    activeIds.mockReset();
    activeIds.mockImplementationOnce(() => obsoleteMerge.promise);

    subscriptions[0].onUpdate([cloudTask({ id: "cloud-obsolete" })]);
    auth.setState({ status: "signedOut" });
    obsoleteMerge.resolve(new Set());
    await flushAsyncWork();
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(app.sessionStore.getState().recentTasks).toEqual([]);

    subscriptions[0].onUpdate([cloudTask({ id: "cloud-late" })]);
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([]);

    vi.mocked(taskIndex.listRecentTasks).mockClear();
    vi.mocked(taskIndex.listRecentTasks).mockResolvedValue([freshTask]);
    activeIds.mockResolvedValue(new Set());
    auth.setState(signedInState("user-2"));
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    await expect(app.client.listRecentTasks()).resolves.toEqual([
      expect.objectContaining({ id: freshTask.id })
    ]);
    expect(taskIndex.listRecentTasks).toHaveBeenCalledWith("user-2");
  });

  it("isolates live task cache and routes across a direct signed-in UID change", async () => {
    const auth = createMutableAuthSession(signedInState("user-a"));
    const subscriptions: Array<{
      uid: string;
      onUpdate: (tasks: CloudTaskSummary[]) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((uid, onUpdate) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ uid, onUpdate, unsubscribe });
        return unsubscribe;
      })
    };
    const relayClients: RelayDesktopClient[] = [];
    const app = createAppModel({
      authSession: auth.authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => {
          const relay = createRelayClientMock();
          relayClients.push(relay);
          return relay;
        }
      }
    });
    await app.initialize();
    const taskA = cloudTask({
      id: "cloud:user-a-task",
      title: "User A task",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "task-a",
      agentType: "agent"
    });
    subscriptions[0].onUpdate([taskA]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: taskA.id })
      ]);
    });

    auth.setState(signedInState("user-b"));
    await vi.waitFor(() => {
      expect(subscriptions.map(({ uid }) => uid)).toEqual(["user-a", "user-b"]);
    });
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();

    subscriptions[0].onUpdate([
      cloudTask({ id: "cloud:late-user-a-task", title: "Late user A task" })
    ]);
    const taskB = cloudTask({
      id: "cloud:user-b-task",
      title: "User B task",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b",
      agentType: "agent"
    });
    subscriptions[1].onUpdate([taskB]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: taskB.id })
      ]);
    });

    subscriptions[0].onUpdate([taskA]);
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: taskB.id })
    ]);
    app.controller.openTask(taskB.id);
    expect(relayClients.at(-1)?.observeTaskAgent).toHaveBeenCalledWith(
      { desktopId: "desktop-b", taskId: "task-b" },
      expect.any(Function)
    );
  });

  it("closes each superseded relay client exactly once across client replacements", async () => {
    const auth = createMutableAuthSession(signedInState("user-a"));
    const relayClients: RelayDesktopClient[] = [];
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn(() => vi.fn())
    };
    const app = createAppModel({
      authSession: auth.authSession,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => {
          const relay = createRelayClientMock();
          relayClients.push(relay);
          return relay;
        }
      }
    });
    await app.initialize();

    expect(relayClients.length).toBeGreaterThan(1);
    for (const relay of relayClients.slice(0, -1)) {
      expect(relay.close).toHaveBeenCalledOnce();
    }
    expect(relayClients.at(-1)?.close).not.toHaveBeenCalled();

    const beforeForceCloud = relayClients.at(-1)!;
    app.setForceCloud(false);
    expect(beforeForceCloud.close).toHaveBeenCalledOnce();
    expect(relayClients.at(-1)?.close).not.toHaveBeenCalled();

    const beforeSignOut = relayClients.at(-1)!;
    auth.setState({ status: "signedOut" });
    expect(beforeSignOut.close).toHaveBeenCalledOnce();
    for (const relay of relayClients) {
      expect(relay.close).toHaveBeenCalledOnce();
    }

    auth.setState(signedInState("user-b"));
    const userBRelay = relayClients.at(-1)!;
    expect(userBRelay.close).not.toHaveBeenCalled();
    auth.setState(signedInState("user-c"));
    expect(userBRelay.close).toHaveBeenCalledOnce();
    expect(relayClients.at(-1)?.close).not.toHaveBeenCalled();
    for (const relay of relayClients.slice(0, -1)) {
      expect(relay.close).toHaveBeenCalledOnce();
    }
  });

  it("retains the active relay and in-flight merge for same-UID auth notifications", async () => {
    const auth = createMutableAuthSession(signedInState("user-a"));
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const relayClients: RelayDesktopClient[] = [];
    const app = createAppModel({
      authSession: auth.authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => {
          const relay = createRelayClientMock();
          relayClients.push(relay);
          return relay;
        }
      }
    });
    await app.initialize();
    const activeRelay = relayClients.at(-1)!;
    const relayCount = relayClients.length;
    const mergedLanRead = deferred<TaskSummary[]>();
    lanRead.mockReset();
    lanRead.mockImplementationOnce(() => mergedLanRead.promise);
    const cloudTaskBeforeRefresh = cloudTask({
      id: "cloud:same-user",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "task-cloud",
      agentType: "agent"
    });

    pushCloudTasks?.([cloudTaskBeforeRefresh]);
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledOnce());
    auth.setState({
      status: "signedIn",
      user: {
        uid: "user-a",
        email: "refreshed-a@example.com",
        displayName: "Refreshed User A"
      }
    });

    expect(relayClients).toHaveLength(relayCount);
    expect(activeRelay.close).not.toHaveBeenCalled();
    const lanTask = {
      id: "lan:same-user",
      repoId: "repo-lan",
      title: "LAN task after refresh",
      stage: "review"
    };
    mergedLanRead.resolve([lanTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: cloudTaskBeforeRefresh.id }),
        lanTask
      ]);
    });

    app.controller.openTask(cloudTaskBeforeRefresh.id);
    expect(activeRelay.observeTaskAgent).toHaveBeenCalledWith(
      { desktopId: "desktop-cloud", taskId: "task-cloud" },
      expect.any(Function)
    );
  });

  it("ignores a LAN merge completed after force-cloud replaces its client", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    const emittedTaskIds: string[][] = [];
    app.sessionStore.subscribe(() => {
      emittedTaskIds.push(app.sessionStore.getState().recentTasks.map(({ id }) => id));
    });
    const staleLanRead = deferred<TaskSummary[]>();
    lanRead.mockReset();
    lanRead.mockImplementationOnce(() => staleLanRead.promise);

    pushCloudTasks?.([cloudTask({ id: "cloud-before-force" })]);
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledOnce());
    app.setForceCloud(true);
    staleLanRead.resolve([
      { id: "lan-after-force", repoId: "repo-lan", title: "Late LAN", stage: "review" }
    ]);
    await flushAsyncWork(12);
    expect(emittedTaskIds.flat()).not.toContain("cloud-before-force");
    expect(emittedTaskIds.flat()).not.toContain("lan-after-force");

    const currentTask = cloudTask({ id: "cloud-after-force" });
    pushCloudTasks?.([currentTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: currentTask.id })
      ]);
    });
  });

  it("ignores a cloud recovery completed after LAN composition is enabled", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        pushCloudTasks = onUpdate;
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    const emittedTaskIds: string[][] = [];
    app.sessionStore.subscribe(() => {
      emittedTaskIds.push(app.sessionStore.getState().recentTasks.map(({ id }) => id));
    });
    const staleCloudRead = deferred<CloudTaskSummary[]>();
    vi.mocked(taskIndex.listRecentTasks).mockImplementationOnce(
      () => staleCloudRead.promise
    );

    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() => expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce());
    app.setForceCloud(false);
    staleCloudRead.resolve([cloudTask({ id: "cloud-before-lan" })]);
    await flushAsyncWork(12);
    expect(emittedTaskIds.flat()).not.toContain("cloud-before-lan");

    const lanTask = {
      id: "lan-after-enable",
      repoId: "repo-lan",
      title: "Current LAN",
      stage: "in progress"
    };
    lanRead.mockResolvedValue([lanTask]);
    const currentTask = cloudTask({ id: "cloud-after-lan" });
    pushCloudTasks?.([currentTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: currentTask.id }),
        lanTask
      ]);
    });
  });

  it("serializes presence convergence behind current task-index recovery", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const presence = deferred<Set<string>>();
    const listActiveDesktopIds = vi.fn(() => presence.promise);
    const recovery = deferred<CloudTaskSummary[]>();
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        pushCloudTasks = onUpdate;
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock(listActiveDesktopIds)
      }
    });
    await app.initialize();
    const staleTaskId = "cloud:stale-before-recovery";
    pushCloudTasks?.([
      cloudTask({
        id: staleTaskId,
        title: "Stale inactive owner",
        ownerDesktopId: "desktop-stale",
        ownerLocalTaskId: "task-stale"
      }),
      cloudTask({
        id: staleTaskId,
        title: "Stale active owner",
        ownerDesktopId: "desktop-active",
        ownerLocalTaskId: "task-stale-active"
      })
    ]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: staleTaskId,
          title: "Stale inactive owner"
        })
      ]);
    });

    vi.mocked(taskIndex.listRecentTasks).mockClear();
    vi.mocked(taskIndex.listRecentTasks).mockImplementationOnce(
      () => recovery.promise
    );
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() => expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce());
    expect(app.sessionStore.getState().errorMessage).toBe(
      "Cloud task index root: snapshot failed"
    );
    expect(listActiveDesktopIds).toHaveBeenCalledOnce();

    presence.resolve(new Set(["desktop-active"]));
    await flushAsyncWork(12);

    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({
        id: staleTaskId,
        title: "Stale inactive owner"
      })
    ]);
    expect(app.sessionStore.getState().errorMessage).toBe(
      "Cloud task index root: snapshot failed"
    );

    const recoveredTaskId = "cloud:recovered-with-presence";
    recovery.resolve([
      cloudTask({
        id: recoveredTaskId,
        title: "Recovered inactive owner",
        ownerDesktopId: "desktop-stale",
        ownerLocalTaskId: "task-recovered-stale"
      }),
      cloudTask({
        id: recoveredTaskId,
        title: "Recovered active owner",
        ownerDesktopId: "desktop-active",
        ownerLocalTaskId: "task-recovered-active"
      })
    ]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: recoveredTaskId,
          title: "Recovered active owner",
          ownerDesktopId: "desktop-active",
          ownerOnline: true
        })
      ]);
    });
    expect(app.sessionStore.getState().errorMessage).toBeNull();
  });

  it("replays presence convergence that arrives during recovery publication", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const presence = deferred<Set<string>>();
    const listActiveDesktopIds = vi.fn(() => presence.promise);
    const recovery = deferred<CloudTaskSummary[]>();
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        pushCloudTasks = onUpdate;
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock(listActiveDesktopIds)
      }
    });
    await app.initialize();
    pushCloudTasks?.([cloudTask({ id: "cloud:before-late-presence" })]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:before-late-presence" })
      ]);
    });

    const recoveryMerge = deferred<TaskSummary[]>();
    lanRead.mockReset();
    lanRead.mockImplementationOnce(() => recoveryMerge.promise);
    lanRead.mockResolvedValue([]);
    vi.mocked(taskIndex.listRecentTasks).mockClear();
    vi.mocked(taskIndex.listRecentTasks).mockImplementationOnce(
      () => recovery.promise
    );
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() => expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce());

    const recoveredTaskId = "cloud:late-presence-recovery";
    recovery.resolve([
      cloudTask({
        id: recoveredTaskId,
        title: "Recovered owner before presence",
        ownerDesktopId: "desktop-stale",
        ownerLocalTaskId: "task-stale"
      }),
      cloudTask({
        id: recoveredTaskId,
        title: "Recovered owner after presence",
        ownerDesktopId: "desktop-active",
        ownerLocalTaskId: "task-active"
      })
    ]);
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledOnce());

    presence.resolve(new Set(["desktop-active"]));
    await flushAsyncWork(12);
    recoveryMerge.resolve([]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: recoveredTaskId,
          title: "Recovered owner after presence",
          ownerDesktopId: "desktop-active",
          ownerOnline: true
        })
      ]);
    });
  });

  it("lets a newer live snapshot supersede current task-index recovery", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const recovery = deferred<CloudTaskSummary[]>();
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn(() => recovery.promise),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        pushCloudTasks = onUpdate;
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() => expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce());

    const currentTask = cloudTask({
      id: "cloud:newer-live-snapshot",
      title: "Newer live snapshot"
    });
    pushCloudTasks?.([currentTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: currentTask.id })
      ]);
    });

    recovery.resolve([
      cloudTask({ id: "cloud:obsolete-recovery", title: "Obsolete recovery" })
    ]);
    await flushAsyncWork(12);
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: currentTask.id })
    ]);
  });

  it("retains last-good tasks while recovering current subscription errors", async () => {
    const auth = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        pushCloudTasks = onUpdate;
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const app = createAppModel({
      authSession: auth.authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    const lastGood = cloudTask({ id: "cloud-good" });
    pushCloudTasks?.([lastGood]);
    await vi.waitFor(() =>
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: lastGood.id })
      ])
    );
    expect(pushCloudError).not.toBeNull();

    const recovered = cloudTask({ id: "cloud-recovered" });
    vi.mocked(taskIndex.listRecentTasks).mockResolvedValueOnce([recovered]);
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() =>
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: recovered.id })
      ])
    );
    const recoveredTasks = app.sessionStore.getState().recentTasks;

    vi.mocked(taskIndex.listRecentTasks).mockRejectedValueOnce(
      new Error("recovery failed")
    );
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed again") });
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual(recoveredTasks);

    const obsoleteRecovery = deferred<CloudTaskSummary[]>();
    vi.mocked(taskIndex.listRecentTasks).mockImplementationOnce(
      () => obsoleteRecovery.promise
    );
    pushCloudError?.({ scope: "root", error: new Error("snapshot failed last") });
    auth.setState({ status: "signedOut" });
    obsoleteRecovery.resolve([cloudTask({ id: "cloud-obsolete-recovery" })]);
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([]);
  });

  it("ignores recovery merged data completed after force-cloud replaces its client", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudError: ((error: CloudTaskIndexError) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, _onUpdate, onError) => {
        pushCloudError = onError ?? null;
        return vi.fn();
      })
    };
    const lanRead = vi.fn<() => Promise<TaskSummary[]>>().mockResolvedValue([]);
    const lan = createLanFixture(lanRead);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => createRelayClientMock()
      }
    });
    await app.initialize();
    expect(pushCloudError).not.toBeNull();
    const emittedTaskIds: string[][] = [];
    app.sessionStore.subscribe(() => {
      emittedTaskIds.push(app.sessionStore.getState().recentTasks.map(({ id }) => id));
    });
    const recoveryMerge = deferred<TaskSummary[]>();
    const recoveredCloudTask = cloudTask({ id: "cloud-old-recovery" });
    vi.mocked(taskIndex.listRecentTasks).mockResolvedValueOnce([recoveredCloudTask]);
    lanRead.mockReset();
    lanRead.mockImplementationOnce(() => recoveryMerge.promise);

    pushCloudError?.({ scope: "root", error: new Error("snapshot failed") });
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledOnce());
    app.setForceCloud(true);
    recoveryMerge.resolve([
      {
        id: "lan-old-recovery",
        repoId: "repo-lan",
        title: "Late recovery LAN task",
        stage: "review"
      }
    ]);
    await flushAsyncWork(12);

    expect(emittedTaskIds.flat()).not.toContain(recoveredCloudTask.id);
    expect(emittedTaskIds.flat()).not.toContain("lan-old-recovery");
  });

  it.each(["empty", "failed"] as const)(
    "deduplicates cloud IDs when active desktop lookup is %s",
    async (presenceResult) => {
      const { authSession } = createMutableAuthSession(signedInState());
      const duplicateTasks = [
        cloudTask({
          id: "cloud:duplicate",
          ownerDesktopId: "desktop-first",
          ownerLocalTaskId: "task-first"
        }),
        cloudTask({
          id: "cloud:duplicate",
          ownerDesktopId: "desktop-second",
          ownerLocalTaskId: "task-second"
        })
      ];
      const taskIndex: CloudTaskIndex = {
        listDesktops: vi.fn().mockResolvedValue([]),
        listRecentTasks: vi.fn().mockResolvedValue(duplicateTasks),
        subscribeRecentTasks: vi.fn(() => vi.fn())
      };
      const activeIds =
        presenceResult === "empty"
          ? vi.fn().mockResolvedValue(new Set<string>())
          : vi.fn().mockRejectedValue(new Error("presence unavailable"));
      const app = createAppModel({
        authSession,
        options: {
          forceCloud: true,
          relayUrl: "wss://relay.test",
          taskIndex,
          bonjourBrowser: createStaticBonjourBrowser([]),
          createRelayClient: () => createRelayClientMock(activeIds)
        }
      });

      await expect(app.client.listRecentTasks()).resolves.toEqual([
        expect.objectContaining({
          id: "cloud:duplicate",
          ownerDesktopId: "desktop-first"
        })
      ]);
    }
  );

  it("routes visible live cloud task streams from the subscription cache", async () => {
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-1", email: "dev@example.com", displayName: null }
    };
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: () => authState,
      subscribe: vi.fn((listener) => {
        listener(authState);
        return vi.fn();
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockImplementation(async () => {
        authState = { status: "signedOut" };
      }),
      getIdToken: vi.fn().mockResolvedValue("id-token"),
      notifyAuthExpired: vi.fn()
    };
    let pushCloudTasks: ((tasks: Awaited<ReturnType<CloudTaskIndex["listRecentTasks"]>>) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const agentSubscription: TaskAgentSubscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskAgent = vi.fn(() => agentSubscription);
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop: vi.fn().mockResolvedValue(null),
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent,
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi.fn().mockResolvedValue(new Set(["desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: {
          start: vi.fn(),
          stop: vi.fn(),
          getServices: () => [],
          subscribe: () => vi.fn()
        },
        createRelayClient: () => relayClient
      }
    });

    await app.initialize();
    vi.mocked(taskIndex.listRecentTasks).mockClear();
    pushCloudTasks?.([
      {
        id: "cloud:desktop-owner:repo-1:task-visible",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Visible task",
        stage: "in progress",
        agentType: "agent",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-visible",
        ownerOnline: true
      }
    ]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: "cloud:desktop-owner:repo-1:task-visible"
        })
      ]);
    });

    app.controller.openTask("cloud:desktop-owner:repo-1:task-visible");

    await vi.waitFor(() => {
      expect(observeTaskAgent).toHaveBeenCalledWith(
        {
          desktopId: "desktop-owner",
          taskId: "task-visible"
        },
        expect.any(Function)
      );
    });
    expect(taskIndex.listRecentTasks).not.toHaveBeenCalled();
  });

  it("routes duplicate cloud task snapshots to the active owner desktop", async () => {
    let authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-1", email: "dev@example.com", displayName: null }
    };
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: () => authState,
      subscribe: vi.fn((listener) => {
        listener(authState);
        return vi.fn();
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockImplementation(async () => {
        authState = { status: "signedOut" };
      }),
      getIdToken: vi.fn().mockResolvedValue("id-token"),
      notifyAuthExpired: vi.fn()
    };
    let pushCloudTasks: ((tasks: Awaited<ReturnType<CloudTaskIndex["listRecentTasks"]>>) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const observeTaskAgent = vi.fn(() => ({
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    }));
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop: vi.fn().mockResolvedValue(null),
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent,
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi.fn().mockResolvedValue(new Set(["desktop-current"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: {
          start: vi.fn(),
          stop: vi.fn(),
          getServices: () => [],
          subscribe: () => vi.fn()
        },
        createRelayClient: () => relayClient
      }
    });

    await app.initialize();
    pushCloudTasks?.([
      {
        id: "cloud:task-shared",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Visible task",
        stage: "in progress",
        agentType: "agent",
        ownerDesktopId: "desktop-current",
        ownerLocalTaskId: "task-current",
        ownerOnline: true
      },
      {
        id: "cloud:task-shared",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Visible task",
        stage: "in progress",
        agentType: "agent",
        ownerDesktopId: "desktop-stale",
        ownerLocalTaskId: "task-stale",
        ownerOnline: false
      }
    ]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:task-shared" })
      ]);
    });

    app.controller.openTask("cloud:task-shared");

    await vi.waitFor(() => {
      expect(observeTaskAgent).toHaveBeenCalledWith(
        {
          desktopId: "desktop-current",
          taskId: "task-current"
        },
        expect.any(Function)
      );
    });
  });

  it("trusts desktops published to the signed-in cloud account", async () => {
    const authState: MobileAuthState = {
      status: "signedIn",
      user: { uid: "user-1", email: "dev@example.com", displayName: null }
    };
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: () => authState,
      subscribe: vi.fn((listener) => {
        listener(authState);
        return vi.fn();
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue("id-token"),
      notifyAuthExpired: vi.fn()
    };
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-owner",
          displayName: "Staging Mac",
          updatedAt: "2026-07-06T12:30:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        onUpdate([]);
        return vi.fn();
      })
    };
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop: vi.fn().mockResolvedValue(null),
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent: vi.fn(() => ({
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      })),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi.fn().mockResolvedValue(new Set(["desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: null,
          trustedDesktops: [],
          repoCreationProfiles: []
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: {
          start: vi.fn(),
          stop: vi.fn(),
          getServices: () => [],
          subscribe: () => vi.fn()
        },
        createRelayClient: () => relayClient
      }
    });

    await app.initialize();

    expect(app.sessionStore.getState().desktops).toEqual([
      {
        id: "desktop-owner",
        name: "Staging Mac",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet",
        lastSeenAt: "2026-07-06T12:30:00.000Z"
      }
    ]);
    expect(taskIndex.listDesktops).toHaveBeenCalledWith("user-1");
  });
});

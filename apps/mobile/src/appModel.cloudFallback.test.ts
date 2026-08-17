import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppModel } from "./appModel";
import type { TaskAgentSubscription } from "./lib/api/client";
import type { TaskSummary } from "./lib/api/types";
import {
  createStaticBonjourBrowser,
  type BonjourBrowser,
  type BonjourService
} from "./lib/discovery/bonjour";
import type { MobileAuthSession, MobileAuthState } from "./lib/firebase/auth";
import type {
  CloudTaskIndex,
  CloudTaskIndexError,
  CloudTaskSummary
} from "./lib/firebase/taskIndex";
import type { FetchLike } from "./lib/transports/lanTransport";
import type { RelayDesktopClient } from "./lib/transports/relayClient";
import { buildCreatingTaskUiSlot } from "./state/taskUiSlots";

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
  listRecentTasks: () => Promise<TaskSummary[]>,
  displayName = "LAN Mac",
  kspStreamVersion?: 1 | 2
): { bonjourBrowser: ReturnType<typeof createStaticBonjourBrowser>; fetchImpl: FetchLike } {
  const bonjourBrowser = createStaticBonjourBrowser([
    {
      name: "desktop-lan",
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
        desktopName: displayName,
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null,
        ...(kspStreamVersion ? { kspStreamVersion } : {})
      });
    }
    if (url.endsWith("/v1/desktops")) {
      return response([
        { id: "desktop-lan", name: displayName, online: true, mode: "lan" }
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
    if (/\/v1\/tasks\/[^/]+\/input$/.test(url)) {
      return response(undefined);
    }
    throw new Error(`Unexpected LAN request: ${url}`);
  }) as FetchLike;
  return { bonjourBrowser, fetchImpl };
}

function createMutableBonjourBrowser(initialServices: BonjourService[] = []): {
  browser: BonjourBrowser;
  setServices(services: BonjourService[]): void;
} {
  let services = initialServices;
  const listeners = new Set<() => void>();
  return {
    browser: {
      getServices: () => services,
      start: vi.fn(),
      stop: vi.fn(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    setServices(nextServices) {
      services = nextServices;
      for (const listener of listeners) listener();
    }
  };
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
      return response(
        desktopId === "desktop-a"
          ? [{ id: "repo-a", name: "Repository A" }]
          : []
      );
    }
    if (url.endsWith("/v1/repos/repo-a/commands")) {
      return response({
        repoId: "repo-a",
        revision: "repo-a-v1",
        commands: [{
          id: "factory:create-agent",
          label: "Create Agent",
          description: "Create a repository agent",
          group: "configure"
        }]
      });
    }
    if (url.endsWith("/v1/repos/repo-a/commands/factory%3Acreate-agent/run")) {
      return response({ taskId: "task-command-a", reused: false });
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

async function createCloudRecoveryHarness(
  options: { failListenersSynchronously?: boolean } = {}
) {
  const auth = createMutableAuthSession(signedInState());
  const recoveryReads: Array<ReturnType<typeof deferred<CloudTaskSummary[]>>> = [];
  const subscriptions: Array<{
    onUpdate: (tasks: CloudTaskSummary[]) => void;
    onError: (error: CloudTaskIndexError) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const taskIndex: CloudTaskIndex = {
    listDesktops: vi.fn().mockResolvedValue([]),
    listRecentTasks: vi.fn(() => {
      const read = deferred<CloudTaskSummary[]>();
      recoveryReads.push(read);
      return read.promise;
    }),
    subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
      const unsubscribe = vi.fn();
      subscriptions.push({
        onUpdate,
        onError: onError ?? (() => undefined),
        unsubscribe
      });
      if (options.failListenersSynchronously) {
        onError?.({
          scope: "root",
          error: new Error(`listener failure ${subscriptions.length}`)
        });
      }
      return unsubscribe;
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
  return { app, auth, recoveryReads, subscriptions, taskIndex };
}

async function rejectCloudRecovery(
  harness: Awaited<ReturnType<typeof createCloudRecoveryHarness>>,
  subscriptionIndex: number
): Promise<void> {
  harness.subscriptions[subscriptionIndex]!.onError({
    scope: "root",
    error: new Error(`listener failure ${subscriptionIndex + 1}`)
  });
  expect(harness.recoveryReads).toHaveLength(subscriptionIndex + 1);
  harness.recoveryReads[subscriptionIndex]!.reject(
    new Error(`one-shot failure ${subscriptionIndex + 1}`)
  );
  await vi.advanceTimersByTimeAsync(0);
}

describe("createAppModel cloud routing", () => {
  it.each([
    ["current", 2 as const, "ws://desktop.lan:48120/v2/stream"],
    ["previous", undefined, "ws://desktop.lan:48120/v1/stream"],
  ])("reuses the %s server KSP negotiation for app-model LAN streams", async (
    _server,
    kspStreamVersion,
    expectedUrl,
  ) => {
    const lan = createLanFixture(async () => [], "LAN Mac", kspStreamVersion);
    const { authSession } = createMutableAuthSession({ status: "signedOut" });
    const socketUrls: string[] = [];
    class TestWebSocket {
      close = vi.fn();
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      send = vi.fn();

      constructor(url: string) {
        socketUrls.push(url);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        bonjourBrowser: lan.bonjourBrowser,
      },
    });

    await app.initialize();
    await app.client.getStatus();
    const subscription = app.client.observeTaskTerminal("task-1", () => {});

    expect(socketUrls.at(-1)).toBe(expectedUrl);
    subscription.close();
    app.controller.dispose();
  });

  it("uses account-known machines over LAN without a manual trust record", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const service: BonjourService = {
      name: "Owner Mac",
      type: "_kanna-mobile._tcp.",
      host: "owner.local",
      port: 48120,
      txt: { desktopId: "desktop-owner" }
    };
    let lanTaskCreated = false;
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/v1/status") {
        return response({
          state: "running",
          desktopId: "desktop-owner",
          desktopName: "Owner Mac",
          lanHost: "owner.local",
          lanPort: 48120,
          pairingCode: null
        });
      }
      if (url.pathname === "/v1/desktops") {
        return response([
          {
            id: "desktop-owner",
            name: "Owner Mac",
            connectionMode: "local"
          }
        ]);
      }
      if (url.pathname === "/v1/repos") {
        return response([{ id: "repo-1", name: "Repo One" }]);
      }
      if (
        url.pathname === "/v1/tasks/recent" ||
        url.pathname === "/v1/repos/repo-1/tasks"
      ) {
        return response(
          lanTaskCreated
            ? [
                {
                  id: "task-created",
                  repoId: "repo-1",
                  repoName: "Repo One",
                  title: "Created task",
                  stage: "in progress",
                  agentType: "pty"
                }
              ]
            : []
        );
      }
      if (
        /^\/v1\/tasks\/[0-9a-f]{32}$/.test(url.pathname) &&
        init?.method === "PUT"
      ) {
        lanTaskCreated = true;
        return response({
          taskId: "task-created",
          repoId: "repo-1",
          title: "Created task",
          stage: "in progress",
          agentType: "pty"
        });
      }
      throw new Error(`Unexpected LAN request: ${input}`);
    });
    const sockets: MockLanWebSocket[] = [];
    class MockLanWebSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor(readonly url: string) {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", MockLanWebSocket);
    const relayClient = createRelayClientMock(
      vi.fn().mockResolvedValue(new Set(["desktop-owner"]))
    );
    const app = createAppModel({
      fetchImpl,
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-owner",
          selectedRepoId: "repo-1",
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [],
          repoCreationProfiles: [
            {
              repoId: "repo-1",
              desktopId: "desktop-owner",
              agentProvider: "claude",
              updatedAt: "2026-07-11T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([service]),
        createRelayClient: () => relayClient
      }
    });

    await app.initialize();
    expect(taskIndex.subscribeRecentTasks).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
      expect.any(Function)
    );
    pushCloudTasks?.([]);
    app.controller.openComposer();
    app.controller.updateComposerPrompt("Create from mobile");
    await app.controller.createTask();
    const canonicalTaskId = "cloud:desktop-owner:repo-1:task-created";
    const stableSlotId = app.sessionStore.getState().taskUiSlots[0]?.slotId;
    expect(app.sessionStore.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskTerminalTaskId: canonicalTaskId,
      activeView: "tasks"
    });
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      socket.onopen?.();
      socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    }
    const terminalSocket = sockets.find((socket) =>
      socket.send.mock.calls.some(([frame]) =>
        JSON.parse(frame).kind === "terminal"
      )
    );
    expect(terminalSocket).toBeDefined();

    pushCloudTasks?.([]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().selectedTaskId).toBe(stableSlotId);
    });
    expect(terminalSocket.close).not.toHaveBeenCalled();

    pushCloudTasks?.([
      {
        id: canonicalTaskId,
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Created task",
        stage: "in progress",
        agentType: "pty",
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-1",
        ownerLocalTaskId: "task-created",
        ownerOnline: true
      }
    ]);
    await vi.waitFor(() => {
      expect(
        app.sessionStore.getState().recentTasks.find(
          (task) => task.id === canonicalTaskId
        )?.title
      ).toBe("Created task");
    });

    expect(app.sessionStore.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskTerminalTaskId: canonicalTaskId,
      activeView: "tasks"
    });
    expect(terminalSocket.close).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/owner\.local:48120\/v1\/tasks\/[0-9a-f]{32}$/
      ),
      expect.objectContaining({ method: "PUT" })
    );
    expect(terminalSocket.send.mock.calls.map(([frame]) => JSON.parse(frame))).toContainEqual({
      type: "attach",
      task_id: "task-created",
      kind: "terminal",
      from_seq: 0
    });
    expect(relayClient.invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/tasks" })
    );
  });

  it("keeps a canonical merge action and agent stream stable through relay publication", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const terminalSubscription = { close: vi.fn() };
    const mergeAgentSubscription: TaskAgentSubscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskTerminal = vi.fn(() => terminalSubscription);
    const observeTaskAgent = vi.fn(() => mergeAgentSubscription);
    const invokeDesktop = vi.fn<RelayDesktopClient["invokeDesktop"]>(
      async (request) => {
        if (
          request.method === "PUT" &&
          /^\/v1\/tasks\/[0-9a-f]{32}$/.test(request.path)
        ) {
          return {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Created task",
            stage: "in progress",
            agentType: "pty"
          };
        }
        if (
          request.method === "POST" &&
          request.path === "/v1/tasks/task-created/actions/run-merge-agent"
        ) {
          return { taskId: "task-merge", followTask: true };
        }
        if (request.method === "GET" && request.path === "/v1/tasks/recent") {
          return [
            {
              id: "task-merge",
              repoId: "repo-1",
              title: "Merge task",
              stage: "merge",
              agentType: "agent"
            }
          ];
        }
        return null;
      }
    );
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop,
      observeTaskTerminal,
      observeTaskAgent,
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi
        .fn()
        .mockResolvedValue(new Set(["desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-owner",
          selectedRepoId: "repo-1",
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [],
          repoCreationProfiles: [
            {
              repoId: "repo-1",
              desktopId: "desktop-owner",
              agentProvider: "claude",
              updatedAt: "2026-07-11T00:00:00.000Z"
            }
          ]
        }),
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

    await app.initialize();
    const existingTask: CloudTaskSummary = {
      id: "cloud:desktop-owner:repo-1:task-existing",
      repoId: "repo-1",
      repoName: "Repo One",
      title: "Existing task",
      stage: "in progress",
      agentType: "pty",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-1",
      ownerLocalTaskId: "task-existing",
      ownerOnline: true
    };
    pushCloudTasks?.([existingTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toContainEqual(
        expect.objectContaining({ id: existingTask.id })
      );
    });

    app.controller.openComposer();
    app.controller.updateComposerPrompt("Create from mobile");
    await app.controller.createTask();
    const canonicalTaskId = "cloud:desktop-owner:repo-1:task-created";
    const stableSlotId = app.sessionStore.getState().taskUiSlots[0]?.slotId;
    expect(app.sessionStore.getState()).toMatchObject({
      selectedTaskId: stableSlotId,
      taskTerminalTaskId: canonicalTaskId,
      activeView: "tasks"
    });

    pushCloudTasks?.([
      existingTask,
      {
        id: canonicalTaskId,
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Created task",
        stage: "in progress",
        agentType: "pty",
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-1",
        ownerLocalTaskId: "task-created",
        ownerOnline: true
      }
    ]);
    await app.controller.runMergeAgent(canonicalTaskId);

    const canonicalMergeTaskId = "cloud:desktop-owner:repo-1:task-merge";
    expect(app.sessionStore.getState()).toMatchObject({
      selectedTaskId: canonicalMergeTaskId,
      taskAgentTaskId: canonicalMergeTaskId,
      activeView: "tasks"
    });
    expect(observeTaskAgent).toHaveBeenCalledWith(
      { desktopId: "desktop-owner", taskId: "task-merge" },
      expect.any(Function)
    );
    expect(terminalSubscription.close).toHaveBeenCalledTimes(1);
    expect(mergeAgentSubscription.close).not.toHaveBeenCalled();

    pushCloudTasks?.([{ ...existingTask, title: "Updated existing task" }]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().selectedTaskId).toBe(
        canonicalMergeTaskId
      );
    });
    expect(mergeAgentSubscription.close).not.toHaveBeenCalled();

    pushCloudTasks?.([
      existingTask,
      {
        id: canonicalMergeTaskId,
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Merge task",
        stage: "merge",
        agentType: "agent",
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-1",
        ownerLocalTaskId: "task-merge",
        ownerOnline: true
      }
    ]);
    await vi.waitFor(() => {
      expect(
        app.sessionStore.getState().recentTasks.find(
          (task) => task.id === canonicalMergeTaskId
        )?.title
      ).toBe("Merge task");
    });
    expect(app.sessionStore.getState()).toMatchObject({
      selectedTaskId: canonicalMergeTaskId,
      taskAgentTaskId: canonicalMergeTaskId,
      activeView: "tasks"
    });
    expect(mergeAgentSubscription.close).not.toHaveBeenCalled();
  });

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
    expect(app.sessionStore.getState().liveLanDesktops.map(({ id }) => id).sort()).toEqual([
      "desktop-a",
      "desktop-b"
    ]);
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

  it("pins taskless repository commands to the desktop that listed the repository", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        onUpdate([]);
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
    await expect(app.client.listRepos()).resolves.toContainEqual({
      id: "repo-a",
      name: "Repository A",
      registeredDesktopIds: ["desktop-a"]
    });
    app.sessionStore.selectDesktop("desktop-b");
    await expect(app.client.listRepoCommands("repo-a")).resolves.toMatchObject({
      repoId: "repo-a",
      revision: "repo-a-v1"
    });
    await expect(
      app.client.runRepoCommand(
        "repo-a",
        "factory:create-agent",
        "repo-a-v1"
      )
    ).resolves.toMatchObject({
      taskId: "cloud:desktop-a:repo-a:task-command-a",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-a",
      ownerLocalTaskId: "task-command-a"
    });
    expect(
      lan.requests.filter(({ url }) => url.includes("/v1/repos/repo-a/commands"))
    ).toEqual([
      {
        method: "GET",
        url: `${lan.baseUrls["desktop-a"]}/v1/repos/repo-a/commands`
      },
      {
        method: "POST",
        url:
          `${lan.baseUrls["desktop-a"]}` +
          "/v1/repos/repo-a/commands/factory%3Acreate-agent/run"
      }
    ]);
  });

  it("surfaces a task-less repo from a relay-reachable desktop and creates its first task", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const invokeDesktop = vi.fn<RelayDesktopClient["invokeDesktop"]>(
      async (request) => {
        if (request.method === "GET" && request.path === "/v1/repos") {
          return [{ id: "repo-fresh", name: "Fresh Repo" }];
        }
        if (
          request.method === "PUT" &&
          /^\/v1\/tasks\/[0-9a-f]{32}$/.test(request.path)
        ) {
          return {
            taskId: "task-first",
            repoId: "repo-fresh",
            title: "First task",
            stage: "in progress",
            agentType: "pty"
          };
        }
        return null;
      }
    );
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop,
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent: vi.fn(() => ({
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      })),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi
        .fn()
        .mockResolvedValue(new Set(["desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-owner",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: []
        }),
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

    await app.initialize();
    pushCloudTasks?.([]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().repos).toContainEqual({
        id: "repo-fresh",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      });
    });

    app.sessionStore.selectRepo("repo-fresh");
    app.controller.openComposer();
    expect(app.sessionStore.getState().composerDesktopId).toBe("desktop-owner");
    app.controller.updateComposerPrompt("Bootstrap the repo");
    await app.controller.createTask();

    expect(invokeDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-owner",
        method: "PUT",
        body: expect.objectContaining({
          repoId: "repo-fresh",
          prompt: "Bootstrap the repo"
        })
      })
    );
    expect(app.sessionStore.getState().recentTasks).toContainEqual(
      expect.objectContaining({
        id: "cloud:desktop-owner:repo-fresh:task-first",
        repoId: "repo-fresh"
      })
    );
  });

  it("fetches a task-less repo when its desktop becomes relay-reachable after the first repo read", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const presence = deferred<Set<string>>();
    const invokeDesktop = vi.fn<RelayDesktopClient["invokeDesktop"]>(
      async (request) => {
        if (request.method === "GET" && request.path === "/v1/repos") {
          return [{ id: "repo-fresh", name: "Fresh Repo" }];
        }
        if (
          request.method === "PUT" &&
          /^\/v1\/tasks\/[0-9a-f]{32}$/.test(request.path)
        ) {
          return {
            taskId: "task-first",
            repoId: "repo-fresh",
            title: "First task",
            stage: "in progress",
            agentType: "pty"
          };
        }
        return null;
      }
    );
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop,
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent: vi.fn(() => ({
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      })),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi
        .fn<RelayDesktopClient["listActiveDesktopIds"]>()
        .mockReturnValueOnce(presence.promise)
        .mockResolvedValue(new Set(["desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-owner",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: []
        }),
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

    await app.initialize();
    pushCloudTasks?.([]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().taskCollectionStatus).toBe("ready");
    });
    await flushAsyncWork();

    // The initial repo supplement ran while relay presence was still
    // unresolved, so the desktop looked offline and no repo read happened.
    expect(invokeDesktop).not.toHaveBeenCalled();
    expect(app.sessionStore.getState().repos).not.toContainEqual(
      expect.objectContaining({ id: "repo-fresh" })
    );

    presence.resolve(new Set(["desktop-owner"]));

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().repos).toContainEqual({
        id: "repo-fresh",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      });
    });
    expect(invokeDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-owner",
        method: "GET",
        path: "/v1/repos"
      })
    );

    app.sessionStore.selectRepo("repo-fresh");
    app.controller.openComposer();
    expect(app.sessionStore.getState().composerDesktopId).toBe("desktop-owner");
    app.controller.updateComposerPrompt("Bootstrap the repo");
    await app.controller.createTask();

    expect(invokeDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-owner",
        method: "PUT",
        body: expect.objectContaining({
          repoId: "repo-fresh",
          prompt: "Bootstrap the repo"
        })
      })
    );
    expect(app.sessionStore.getState().recentTasks).toContainEqual(
      expect.objectContaining({
        id: "cloud:desktop-owner:repo-fresh:task-first",
        repoId: "repo-fresh"
      })
    );
  });

  it("supplements repos from a desktop that comes online while another desktop's repo read hangs", async () => {
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-hung",
          displayName: "Hung Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        },
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const invokeDesktop = vi.fn<RelayDesktopClient["invokeDesktop"]>(
      (request) => {
        if (request.desktopId === "desktop-hung") {
          return new Promise(() => {});
        }
        if (request.method === "GET" && request.path === "/v1/repos") {
          return Promise.resolve([{ id: "repo-fresh", name: "Fresh Repo" }]);
        }
        if (
          request.method === "PUT" &&
          /^\/v1\/tasks\/[0-9a-f]{32}$/.test(request.path)
        ) {
          return Promise.resolve({
            taskId: "task-first",
            repoId: "repo-fresh",
            title: "First task",
            stage: "in progress",
            agentType: "pty"
          });
        }
        return Promise.resolve(null);
      }
    );
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop,
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent: vi.fn(() => ({
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      })),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi
        .fn<RelayDesktopClient["listActiveDesktopIds"]>()
        .mockResolvedValueOnce(new Set(["desktop-hung"]))
        .mockResolvedValue(new Set(["desktop-hung", "desktop-owner"]))
    };
    const app = createAppModel({
      authSession,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-owner",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: []
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: () => relayClient,
        desktopRepoWaitMs: 25
      }
    });

    await app.initialize();
    pushCloudTasks?.([]);

    // The hung desktop is online first: its /v1/repos read starts and never
    // settles. When presence later marks desktop-owner online, the next repo
    // supplement must still query it and surface its task-less repo.
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().repos).toContainEqual({
        id: "repo-fresh",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      });
    });

    const hungRepoReads = invokeDesktop.mock.calls.filter(
      ([request]) =>
        request.desktopId === "desktop-hung" && request.path === "/v1/repos"
    );
    expect(hungRepoReads).toHaveLength(1);

    app.sessionStore.selectRepo("repo-fresh");
    app.controller.openComposer();
    expect(app.sessionStore.getState().composerDesktopId).toBe("desktop-owner");
    app.controller.updateComposerPrompt("Bootstrap the repo");
    await app.controller.createTask();

    expect(invokeDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-owner",
        method: "PUT",
        body: expect.objectContaining({
          repoId: "repo-fresh",
          prompt: "Bootstrap the repo"
        })
      })
    );
    expect(app.sessionStore.getState().recentTasks).toContainEqual(
      expect.objectContaining({
        id: "cloud:desktop-owner:repo-fresh:task-first",
        repoId: "repo-fresh"
      })
    );
  });

  it("reconnects a signed-out app when a trusted desktop appears on Bonjour", async () => {
    const mutableBonjour = createMutableBonjourBrowser();
    const lan = createLanFixture(async () => [], "Gu’s MacBook Pro");
    const { authSession } = createMutableAuthSession({ status: "signedOut" });
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        bonjourBrowser: mutableBonjour.browser,
        forceCloud: false,
        relayUrl: null
      }
    });

    await app.initialize();
    expect(app.sessionStore.getState().connectionState).toBe("idle");

    mutableBonjour.setServices([{
      name: "desktop-lan",
      type: "_kanna-mobile._tcp.",
      host: "desktop.lan",
      port: 48120,
      txt: { desktopId: "desktop-lan" }
    }]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().connectionState).toBe("connected");
      expect(app.sessionStore.getState().liveLanDesktops).toEqual([
        expect.objectContaining({
          id: "desktop-lan",
          name: "Gu’s MacBook Pro",
          online: true
        })
      ]);
    });
  });

  it("recovers a signed-in app over trusted LAN when cloud bootstrap fails and Bonjour appears", async () => {
    const mutableBonjour = createMutableBonjourBrowser();
    const lan = createLanFixture(async () => []);
    const { authSession } = createMutableAuthSession(signedInState());
    const cloudFailure = new Error("cloud unavailable");
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockRejectedValue(cloudFailure),
      listRecentTasks: vi.fn().mockRejectedValue(cloudFailure),
      subscribeRecentTasks: vi.fn(() => {
        throw cloudFailure;
      })
    };
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        bonjourBrowser: mutableBonjour.browser,
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        createRelayClient: () => createRelayClientMock()
      }
    });

    await app.initialize();
    expect(app.sessionStore.getState().liveLanDesktops).toEqual([]);

    mutableBonjour.setServices([{
      name: "LAN Mac",
      type: "_kanna-mobile._tcp.",
      host: "desktop.lan",
      port: 48120,
      txt: { desktopId: "desktop-lan" }
    }]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().liveLanDesktops).toEqual([
        expect.objectContaining({ id: "desktop-lan", online: true })
      ]);
      expect(app.sessionStore.getState().machineSourceWarnings.local).toBeNull();
    });
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

  it("publishes a complete one-shot recovery when an initial child listener fails", async () => {
    vi.useFakeTimers();
    try {
      const { authSession } = createMutableAuthSession(signedInState());
      const subscriptions: Array<{
        onUpdate: (tasks: CloudTaskSummary[]) => void;
        onError: (error: CloudTaskIndexError) => void;
        unsubscribe: ReturnType<typeof vi.fn>;
      }> = [];
      const taskA = cloudTask({
        id: "cloud:task-a",
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-a"
      });
      const recoveredTaskB = cloudTask({
        id: "cloud:task-b",
        ownerDesktopId: "desktop-b",
        ownerLocalTaskId: "task-b"
      });
      const taskIndex: CloudTaskIndex = {
        listDesktops: vi.fn().mockResolvedValue([]),
        listRecentTasks: vi.fn().mockResolvedValue([taskA, recoveredTaskB]),
        subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
          const unsubscribe = vi.fn();
          subscriptions.push({
            onUpdate,
            onError: onError ?? (() => undefined),
            unsubscribe
          });
          return unsubscribe;
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
      expect(subscriptions).toHaveLength(1);

      subscriptions[0].onError({
        scope: "desktop",
        desktopId: "desktop-b",
        error: new Error("desktop-b initial read failed")
      });
      subscriptions[0].onUpdate([taskA]);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks.map(({ id }) => id)).toEqual([
        taskA.id,
        recoveredTaskB.id
      ]);
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
      expect(subscriptions).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(subscriptions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriptions).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("publishes independent LAN recovery without clearing the cloud listener error", async () => {
    vi.useFakeTimers();
    try {
      const { authSession } = createMutableAuthSession(signedInState());
      const recovery = deferred<CloudTaskSummary[]>();
      const subscriptions: Array<{
        onUpdate: (tasks: CloudTaskSummary[]) => void;
        onError: (error: CloudTaskIndexError) => void;
        unsubscribe: ReturnType<typeof vi.fn>;
      }> = [];
      const cloudFailure = new Error("cloud unavailable");
      const recoveredCloudTask = cloudTask({
        id: "cloud:recovered",
        title: "Recovered cloud task",
        ownerDesktopId: "desktop-cloud",
        ownerLocalTaskId: "recovered"
      });
      const lanTask: TaskSummary = {
        id: "lan-only",
        repoId: "repo-lan",
        repoName: "LAN Repo",
        title: "LAN-only task",
        stage: "in progress"
      };
      const taskIndex: CloudTaskIndex = {
        listDesktops: vi.fn().mockResolvedValue([]),
        listRecentTasks: vi.fn(() => recovery.promise),
        subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
          const unsubscribe = vi.fn();
          subscriptions.push({
            onUpdate,
            onError: onError ?? (() => undefined),
            unsubscribe
          });
          return unsubscribe;
        })
      };
      const lanRead = vi.fn().mockResolvedValue([lanTask]);
      const lan = createLanFixture(lanRead);
      const app = createAppModel({
        authSession,
        fetchImpl: lan.fetchImpl,
        persistence: createTrustedPersistence(),
        options: {
          relayUrl: "wss://relay.test",
          taskIndex,
          bonjourBrowser: lan.bonjourBrowser,
          createRelayClient: () => createRelayClientMock()
        }
      });

      await app.initialize();
      expect(subscriptions).toHaveLength(1);
      const setRecentTasks = vi.spyOn(app.sessionStore, "setRecentTasks");

      subscriptions[0]!.onError({ scope: "root", error: cloudFailure });
      recovery.reject(cloudFailure);
      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => {
        expect(setRecentTasks).toHaveBeenCalledTimes(1);
      });

      expect(app.sessionStore.getState().recentTasks.map(({ id }) => id)).toEqual([
        lanTask.id
      ]);
      expect(app.sessionStore.getState().errorMessage).toBe(
        "Cloud task index root: cloud unavailable"
      );
      expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce();
      expect(
        setRecentTasks.mock.calls.map(([tasks]) => tasks.map(({ id }) => id))
      ).toEqual([[lanTask.id]]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscriptions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks.map(({ id }) => id)).toEqual([
        lanTask.id
      ]);
      expect(app.sessionStore.getState().errorMessage).toBe(
        "Cloud task index root: cloud unavailable"
      );
      expect(
        setRecentTasks.mock.calls.map(([tasks]) => tasks.map(({ id }) => id))
      ).toEqual([[lanTask.id]]);

      subscriptions[1]!.onUpdate([recoveredCloudTask]);
      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => {
        expect(setRecentTasks).toHaveBeenCalledTimes(2);
      });

      expect(app.sessionStore.getState().recentTasks.map(({ id }) => id)).toEqual([
        recoveredCloudTask.id,
        lanTask.id
      ]);
      expect(app.sessionStore.getState().errorMessage).toBeNull();
      expect(
        setRecentTasks.mock.calls.map(([tasks]) => tasks.map(({ id }) => id))
      ).toEqual([
        [lanTask.id],
        [recoveredCloudTask.id, lanTask.id]
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reports malformed documents without restarting a healthy listener generation", async () => {
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
    vi.mocked(taskIndex.listRecentTasks).mockClear();
    const validPeer = cloudTask({ id: "cloud:valid-peer" });

    pushCloudError?.({
      scope: "document",
      desktopId: "desktop-a",
      error: new Error("malformed task document")
    });
    pushCloudTasks?.([validPeer]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: validPeer.id })
      ]);
    });
    expect(taskIndex.subscribeRecentTasks).toHaveBeenCalledOnce();
    expect(taskIndex.listRecentTasks).not.toHaveBeenCalled();
  });

  it("does not let a healthy sibling callback restore an errored child's stale slice", async () => {
    vi.useFakeTimers();
    try {
    const { authSession } = createMutableAuthSession(signedInState());
    const subscriptions: Array<{
      onUpdate: (tasks: CloudTaskSummary[]) => void;
      onError: (error: CloudTaskIndexError) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const staleTaskA = cloudTask({
      id: "cloud:task-a",
      title: "Stale A",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "task-a"
    });
    const freshTaskA = { ...staleTaskA, title: "Fresh A" };
    const taskB = cloudTask({
      id: "cloud:task-b",
      title: "B before sibling update",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "task-b"
    });
    const freshTaskB = { ...taskB, title: "B after sibling update" };
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([freshTaskA, taskB]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
        const unsubscribe = vi.fn();
        subscriptions.push({
          onUpdate,
          onError: onError ?? (() => undefined),
          unsubscribe
        });
        return unsubscribe;
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
    subscriptions[0].onUpdate([staleTaskA, taskB]);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.sessionStore.getState().recentTasks[0]?.title).toBe("Stale A");

    subscriptions[0].onError({
      scope: "desktop",
      desktopId: "desktop-a",
      error: new Error("desktop-a listener failed")
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.sessionStore.getState().recentTasks[0]?.title).toBe("Fresh A");
    expect(subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscriptions).toHaveLength(2);

    subscriptions[0].onUpdate([staleTaskA, freshTaskB]);
    await flushAsyncWork(12);
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: freshTaskA.id, title: "Fresh A" }),
      expect.objectContaining({ id: taskB.id, title: taskB.title })
    ]);

    subscriptions[1].onUpdate([freshTaskA, freshTaskB]);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: freshTaskA.id, title: "Fresh A" }),
      expect.objectContaining({ id: freshTaskB.id, title: "B after sibling update" })
    ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

  it("shares a pending LAN probe and publishes the newest trailing merged callback", async () => {
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
    await flushAsyncWork();
    expect(lanRead).toHaveBeenCalledTimes(1);

    mergeA.resolve([lanTaskA]);
    await vi.waitFor(() => expect(lanRead).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud-b", title: "Cloud B" }),
        lanTaskB
      ]);
    });
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([
      expect.objectContaining({ id: "cloud-b", title: "Cloud B" }),
      lanTaskB
    ]);
  });

  it("coalesces rapid cloud callbacks into the newest trailing complete snapshot", async () => {
    vi.useFakeTimers();
    try {
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
      const hangingLanRead = vi.fn(
        () => new Promise<TaskSummary[]>(() => undefined)
      );
      const lan = createLanFixture(hangingLanRead);
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

      pushCloudTasks?.([cloudTask({ id: "cloud:first", title: "First" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks).toEqual([]);

      pushCloudTasks?.([cloudTask({ id: "cloud:second", title: "Second" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:second", title: "Second" })
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:second", title: "Second" })
      ]);
      expect(hangingLanRead).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("starts a fresh authoritative merge when a cloud callback lands during an incidental task read", async () => {
    vi.useFakeTimers();
    try {
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
      const incidentalLanRead = deferred<TaskSummary[]>();
      const lanOnlyTask: TaskSummary = {
        id: "lan-only",
        repoId: "repo-lan",
        title: "LAN-only task",
        stage: "review"
      };
      const lanRead = vi
        .fn<() => Promise<TaskSummary[]>>()
        .mockResolvedValueOnce([lanOnlyTask])
        .mockImplementationOnce(() => incidentalLanRead.promise)
        .mockImplementationOnce(
          () => new Promise<TaskSummary[]>(() => undefined)
        );
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
      const firstCloudTask = cloudTask({
        id: "cloud:first",
        title: "First cloud snapshot"
      });
      const secondCloudTask = cloudTask({
        id: "cloud:second",
        title: "Second cloud snapshot"
      });

      pushCloudTasks?.([firstCloudTask]);
      await vi.waitFor(() => {
        expect(app.sessionStore.getState().recentTasks).toEqual([
          expect.objectContaining({ id: firstCloudTask.id }),
          lanOnlyTask
        ]);
      });

      const incidentalSearch = app.client.searchTasks("cloud snapshot");
      await vi.waitFor(() => expect(lanRead).toHaveBeenCalledTimes(2));
      pushCloudTasks?.([secondCloudTask]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(lanRead).toHaveBeenCalledTimes(2);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: secondCloudTask.id,
          title: secondCloudTask.title
        }),
        lanOnlyTask
      ]);

      incidentalLanRead.resolve([lanOnlyTask]);
      await incidentalSearch;
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: secondCloudTask.id }),
        lanOnlyTask
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("restarts the publication drain when a callback lands during settlement", async () => {
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
    const firstPublication = deferred<void>();
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
        createRelayClient: () =>
          createRelayClientMock(
            vi.fn(() => new Promise<Set<string>>(() => undefined))
          )
      }
    });
    app.sessionStore.subscribe(() => {
      if (
        app.sessionStore.getState().recentTasks.some(
          (task) => task.id === "cloud:first"
        )
      ) {
        firstPublication.resolve();
      }
    });
    void firstPublication.promise.then(() => {
      // This extra microtask runs after the worker observes an empty queue but
      // before its promise finalizer releases ownership.
      void Promise.resolve().then(() => {
        pushCloudTasks?.([cloudTask({ id: "cloud:second", title: "Second" })]);
      });
    });
    await app.initialize();

    pushCloudTasks?.([cloudTask({ id: "cloud:first", title: "First" })]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:second", title: "Second" })
      ]);
    });
  });

  it("publishes the newest complete snapshot without starvation while cloud callbacks keep arriving", async () => {
    vi.useFakeTimers();
    try {
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
      const hangingLanRead = vi.fn(
        () => new Promise<TaskSummary[]>(() => undefined)
      );
      const lan = createLanFixture(hangingLanRead);
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

      pushCloudTasks?.([cloudTask({ id: "cloud:first", title: "First" })]);
      await vi.advanceTimersByTimeAsync(400);
      pushCloudTasks?.([cloudTask({ id: "cloud:second", title: "Second" })]);
      await vi.advanceTimersByTimeAsync(400);
      pushCloudTasks?.([cloudTask({ id: "cloud:third", title: "Third" })]);
      await vi.advanceTimersByTimeAsync(200);

      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:third", title: "Third" })
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud:third", title: "Third" })
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("publishes a guarded LAN supplement when the probe succeeds after the optional timeout", async () => {
    vi.useFakeTimers();
    try {
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
      const lateLanRead = deferred<TaskSummary[]>();
      const lan = createLanFixture(() => lateLanRead.promise);
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
      const createdSlot = buildCreatingTaskUiSlot({
        slotId: "create:late-supplement",
        repoId: "repo-lan",
        prompt: "Created during publication gap",
        desktopId: "desktop-lan",
        agentProvider: "claude"
      });
      app.sessionStore.addTaskUiSlot(createdSlot);
      app.sessionStore.acknowledgeTaskUiSlot(createdSlot.slotId, {
        id: "created-during-gap",
        repoId: "repo-lan",
        title: "Created during publication gap",
        stage: "in progress"
      });
      const duplicate = cloudTask({
        id: "cloud:duplicate",
        title: "Cloud duplicate",
        ownerDesktopId: "desktop-lan",
        ownerLocalRepoId: "repo-lan",
        ownerLocalTaskId: "local-duplicate"
      });

      pushCloudTasks?.([duplicate]);
      await vi.advanceTimersByTimeAsync(0);
      expect(app.sessionStore.getState().recentTasks).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: duplicate.id,
          title: "Cloud duplicate"
        })
      ]);
      expect(app.sessionStore.getState().taskUiSlots).toEqual([
        expect.objectContaining({
          slotId: createdSlot.slotId,
          authoritativeMissGraceRemaining: 0
        })
      ]);
      lateLanRead.resolve([
        {
          id: "local-duplicate",
          repoId: "repo-lan",
          title: "Fresh LAN duplicate",
          stage: "review"
        },
        {
          id: "lan-only",
          repoId: "repo-lan",
          title: "Late LAN-only task",
          stage: "in progress"
        }
      ]);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: duplicate.id,
          title: "Fresh LAN duplicate",
          stage: "review"
        }),
        expect.objectContaining({
          id: "lan-only",
          title: "Late LAN-only task"
        })
      ]);
      expect(app.sessionStore.getState().taskUiSlots).toEqual([
        expect.objectContaining({
          slotId: createdSlot.slotId,
          authoritativeMissGraceRemaining: 0
        })
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("republishes the complete workspace when trusted LAN discovery arrives after cloud", async () => {
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
    const mutableBonjour = createMutableBonjourBrowser();
    const lan = createLanFixture(async () => [
      {
        id: "local-duplicate",
        repoId: "repo-lan",
        title: "LAN duplicate",
        stage: "review"
      },
      {
        id: "lan-only",
        repoId: "repo-lan",
        title: "LAN-only task",
        stage: "in progress"
      }
    ]);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: mutableBonjour.browser,
        createRelayClient: () =>
          createRelayClientMock(
            vi.fn().mockResolvedValue(new Set(["desktop-lan"]))
          )
      }
    });
    await app.initialize();
    const duplicate = cloudTask({
      id: "cloud:duplicate",
      title: "Cloud duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloudOnly = cloudTask({
      id: "cloud:only",
      title: "Cloud-only task",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-only"
    });

    pushCloudTasks?.([duplicate, cloudOnly]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: duplicate.id, title: "Cloud duplicate" }),
        expect.objectContaining({ id: cloudOnly.id, title: "Cloud-only task" })
      ]);
    });

    mutableBonjour.setServices([
      {
        name: "LAN Mac",
        type: "_kanna-mobile._tcp.",
        host: "desktop.lan",
        port: 48120,
        txt: { desktopId: "desktop-lan" }
      }
    ]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: duplicate.id, title: "LAN duplicate" }),
        expect.objectContaining({ id: cloudOnly.id, title: "Cloud-only task" }),
        expect.objectContaining({ id: "lan-only", title: "LAN-only task" })
      ]);
    });
  });

  it("uses the endpoint validated by LAN status for the rest of the snapshot", async () => {
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
    const service: BonjourService = {
      name: "LAN Mac",
      type: "_kanna-mobile._tcp.",
      host: "desktop.lan",
      port: 48120,
      txt: { desktopId: "desktop-lan" }
    };
    let exposeOneServiceRead = false;
    let serviceReads = 0;
    const bonjourBrowser: BonjourBrowser = {
      getServices: () =>
        exposeOneServiceRead && serviceReads++ === 0 ? [service] : [],
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: () => vi.fn()
    };
    const lan = createLanFixture(async () => [
      {
        id: "local-duplicate",
        repoId: "repo-lan",
        title: "LAN duplicate",
        stage: "review"
      },
      {
        id: "lan-only",
        repoId: "repo-lan",
        title: "LAN-only task",
        stage: "in progress"
      }
    ]);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: createTrustedPersistence(),
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser,
        createRelayClient: () =>
          createRelayClientMock(
            vi.fn(() => new Promise<Set<string>>(() => undefined))
          )
      }
    });
    await app.initialize();
    exposeOneServiceRead = true;
    const duplicate = cloudTask({
      id: "cloud:duplicate",
      title: "Cloud duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-duplicate"
    });

    pushCloudTasks?.([
      duplicate,
      cloudTask({
        id: "cloud:only",
        title: "Cloud-only task",
        ownerDesktopId: "desktop-cloud",
        ownerLocalTaskId: "cloud-only"
      })
    ]);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: duplicate.id, title: "LAN duplicate" }),
        expect.objectContaining({ id: "cloud:only", title: "Cloud-only task" }),
        expect.objectContaining({ id: "lan-only", title: "LAN-only task" })
      ]);
    });
  });

  it("keeps the last complete hybrid workspace authoritative while a newer LAN probe is pending", async () => {
    const auth = createMutableAuthSession(signedInState());
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const nextLanRead = deferred<TaskSummary[]>();
    const presenceLanRead = deferred<TaskSummary[]>();
    const duplicateLanTask: TaskSummary = {
      id: "local-duplicate",
      repoId: "repo-lan",
      title: "LAN duplicate",
      stage: "review",
      agentType: "pty"
    };
    const lanOnlyTask: TaskSummary = {
      id: "lan-only",
      repoId: "repo-lan",
      title: "LAN-only task",
      stage: "in progress",
      agentType: "agent"
    };
    const lanRead = vi
      .fn<() => Promise<TaskSummary[]>>()
      .mockResolvedValueOnce([duplicateLanTask, lanOnlyTask])
      .mockImplementationOnce(() => nextLanRead.promise)
      .mockImplementationOnce(() => presenceLanRead.promise);
    const lan = createLanFixture(lanRead);
    const pendingPresence = deferred<Set<string>>();
    const relayClient = createRelayClientMock(() => pendingPresence.promise);
    const sockets: Array<{
      close: ReturnType<typeof vi.fn>;
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      send: ReturnType<typeof vi.fn>;
    }> = [];
    class TestWebSocket {
      close = vi.fn();
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      send = vi.fn();

      constructor(_url: string) {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);

    try {
      const app = createAppModel({
        authSession: auth.authSession,
        fetchImpl: lan.fetchImpl,
        persistence: createTrustedPersistence(),
        options: {
          forceCloud: false,
          relayUrl: "wss://relay.test",
          taskIndex,
          bonjourBrowser: lan.bonjourBrowser,
          createRelayClient: () => relayClient
        }
      });
      await app.initialize();
      const duplicateCloudTask = cloudTask({
        id: "cloud:duplicate",
        title: "Cloud duplicate",
        ownerDesktopId: "desktop-lan",
        ownerLocalRepoId: "repo-lan",
        ownerLocalTaskId: duplicateLanTask.id,
        agentType: "pty"
      });
      const cloudOnlyTask = cloudTask({
        id: "cloud:only",
        title: "Cloud-only task"
      });

      pushCloudTasks?.([duplicateCloudTask, cloudOnlyTask]);
      await vi.waitFor(() => {
        expect(app.sessionStore.getState().recentTasks).toEqual([
          expect.objectContaining({
            id: duplicateCloudTask.id,
            title: duplicateLanTask.title
          }),
          expect.objectContaining({ id: cloudOnlyTask.id }),
          lanOnlyTask
        ]);
      });

      app.controller.openTask(lanOnlyTask.id);
      expect(sockets).toHaveLength(2);
      for (const socket of sockets) {
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
      }
      const agentSocket = sockets.find((socket) =>
        socket.send.mock.calls.some(([frame]) => JSON.parse(frame).kind === "agent")
      );
      expect(agentSocket).toBeDefined();
      agentSocket!.onmessage?.({
        data: JSON.stringify({
          type: "agent_snapshot",
          task_id: lanOnlyTask.id,
          events: [],
          next_seq: 0
        })
      });
      expect(app.sessionStore.getState()).toMatchObject({
        selectedTaskId: lanOnlyTask.id,
        taskAgentTaskId: lanOnlyTask.id,
        taskAgentStatus: "live"
      });

      const updatedCloudOnlyTask = {
        ...cloudOnlyTask,
        title: "Cloud-only task after refresh"
      };
      pushCloudTasks?.([updatedCloudOnlyTask]);
      await vi.waitFor(() => expect(lanRead).toHaveBeenCalledTimes(2));
      pendingPresence.resolve(new Set(["desktop-lan"]));
      await flushAsyncWork(12);

      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: duplicateCloudTask.id,
          title: duplicateLanTask.title
        }),
        expect.objectContaining({ id: cloudOnlyTask.id }),
        lanOnlyTask
      ]);
      expect(app.client.getTaskRouteIdentity?.(lanOnlyTask.id)).toBe(
        JSON.stringify(["lan", "desktop-lan", lanOnlyTask.id])
      );
      expect(app.sessionStore.getState()).toMatchObject({
        selectedTaskId: lanOnlyTask.id,
        taskAgentTaskId: lanOnlyTask.id,
        taskAgentStatus: "live"
      });
      expect(sockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

      await app.client.sendTaskInput(duplicateCloudTask.id, "keep using LAN");
      expect(lan.fetchImpl).toHaveBeenCalledWith(
        "http://desktop.lan:48120/v1/tasks/local-duplicate/input",
        expect.objectContaining({ method: "POST" })
      );
      expect(relayClient.sendTaskInput).not.toHaveBeenCalled();

      nextLanRead.reject(new Error("LAN reprobe failed"));
      await vi.waitFor(() => expect(lanRead).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => {
        expect(app.sessionStore.getState().recentTasks).toEqual([
          expect.objectContaining({
            id: updatedCloudOnlyTask.id,
            title: updatedCloudOnlyTask.title
          }),
          expect.objectContaining({
            id: duplicateCloudTask.id,
            title: duplicateLanTask.title
          }),
          lanOnlyTask
        ]);
      });
      expect(app.sessionStore.getState()).toMatchObject({
        selectedTaskId: lanOnlyTask.id,
        taskAgentTaskId: lanOnlyTask.id,
        taskAgentStatus: "live"
      });
      expect(sockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

      await app.client.sendTaskInput(
        duplicateCloudTask.id,
        "keep using LAN after failure"
      );
      expect(lan.fetchImpl).toHaveBeenCalledWith(
        "http://desktop.lan:48120/v1/tasks/local-duplicate/input",
        expect.objectContaining({ method: "POST" })
      );
      expect(relayClient.sendTaskInput).not.toHaveBeenCalled();

      presenceLanRead.resolve([
        { ...duplicateLanTask, title: "LAN duplicate after refresh" },
        lanOnlyTask
      ]);
      await vi.waitFor(() => {
        expect(app.sessionStore.getState().recentTasks).toEqual([
          expect.objectContaining({
            id: updatedCloudOnlyTask.id,
            title: updatedCloudOnlyTask.title
          }),
          expect.objectContaining({
            id: duplicateLanTask.id,
            title: "LAN duplicate after refresh"
          }),
          lanOnlyTask
        ]);
      });
      expect(app.sessionStore.getState()).toMatchObject({
        selectedTaskId: lanOnlyTask.id,
        taskAgentTaskId: lanOnlyTask.id,
        taskAgentStatus: "live"
      });
      expect(sockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);

      auth.setState({ status: "signedOut" });
      expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(app.sessionStore.getState().recentTasks).toEqual([]);
    const publicationsBeforeForce = emittedTaskIds.length;
    app.setForceCloud(true);
    staleLanRead.resolve([
      { id: "lan-after-force", repoId: "repo-lan", title: "Late LAN", stage: "review" }
    ]);
    await flushAsyncWork(12);
    expect(emittedTaskIds).toHaveLength(publicationsBeforeForce);
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
    await flushAsyncWork(12);
    expect(app.sessionStore.getState().recentTasks).toEqual([]);
    expect(emittedTaskIds.flat()).not.toContain(currentTask.id);
    expect(lanRead).not.toHaveBeenCalled();
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

  it("ignores callbacks from the failed listener generation while recovery is pending", async () => {
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
    await flushAsyncWork();
    expect(app.sessionStore.getState().recentTasks).toEqual([]);

    const recoveredTask = cloudTask({
      id: "cloud:recovered-snapshot",
      title: "Recovered snapshot"
    });
    recovery.resolve([recoveredTask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: recoveredTask.id })
      ]);
    });
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

  it("backs off permanent cloud listener failures exponentially and caps retries", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createCloudRecoveryHarness();
      const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      expect(harness.subscriptions).toHaveLength(1);

      for (const [subscriptionIndex, retryDelay] of retryDelays.entries()) {
        await rejectCloudRecovery(harness, subscriptionIndex);
        expect(harness.subscriptions).toHaveLength(subscriptionIndex + 1);

        await vi.advanceTimersByTimeAsync(retryDelay - 1);
        expect(harness.subscriptions).toHaveLength(subscriptionIndex + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.subscriptions).toHaveLength(subscriptionIndex + 2);
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("resets cloud listener backoff after a successful listener callback", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createCloudRecoveryHarness();

      await rejectCloudRecovery(harness, 0);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejectCloudRecovery(harness, 1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.subscriptions).toHaveLength(3);

      harness.subscriptions[2]!.onUpdate([
        cloudTask({ id: "cloud:backoff-reset-by-listener" })
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await rejectCloudRecovery(harness, 2);

      await vi.advanceTimersByTimeAsync(999);
      expect(harness.subscriptions).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.subscriptions).toHaveLength(4);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps backing off a permanently failing listener after successful one-shot reads", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createCloudRecoveryHarness({
        failListenersSynchronously: true
      });
      expect(harness.subscriptions).toHaveLength(1);
      expect(harness.recoveryReads).toHaveLength(1);

      const firstRecovery = cloudTask({ id: "cloud:first-one-shot-recovery" });
      harness.recoveryReads[0]!.resolve([firstRecovery]);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: firstRecovery.id })
      ]);
      expect(harness.subscriptions).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(harness.subscriptions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.subscriptions).toHaveLength(2);
      expect(harness.recoveryReads).toHaveLength(2);

      const secondRecovery = cloudTask({ id: "cloud:second-one-shot-recovery" });
      harness.recoveryReads[1]!.resolve([secondRecovery]);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: secondRecovery.id })
      ]);
      expect(harness.subscriptions).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.subscriptions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.subscriptions).toHaveLength(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ["sign-out", "pending"],
    ["sign-out", "scheduled"],
    ["client replacement", "pending"],
    ["client replacement", "scheduled"]
  ] as const)(
    "does not restart cloud listeners after %s invalidates a %s recovery",
    async (invalidation, recoveryState) => {
      vi.useFakeTimers();
      try {
        const harness = await createCloudRecoveryHarness();
        harness.subscriptions[0]!.onError({
          scope: "root",
          error: new Error("listener failed before invalidation")
        });
        expect(harness.recoveryReads).toHaveLength(1);

        if (recoveryState === "scheduled") {
          harness.recoveryReads[0]!.reject(
            new Error("one-shot failed before invalidation")
          );
          await vi.advanceTimersByTimeAsync(0);
        }

        if (invalidation === "sign-out") {
          harness.auth.setState({ status: "signedOut" });
        } else {
          harness.app.setForceCloud(true);
        }

        if (recoveryState === "pending") {
          harness.recoveryReads[0]!.reject(
            new Error("one-shot settled after invalidation")
          );
          await vi.advanceTimersByTimeAsync(0);
        }

        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.subscriptions).toHaveLength(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

  it("restarts the live subscription after a transient recovery read failure", async () => {
    vi.useFakeTimers();
    try {
      const auth = createMutableAuthSession(signedInState());
      const subscriptions: Array<{
        onUpdate: (tasks: CloudTaskSummary[]) => void;
        onError: (error: CloudTaskIndexError) => void;
      }> = [];
      const taskIndex: CloudTaskIndex = {
        listDesktops: vi.fn().mockResolvedValue([]),
        listRecentTasks: vi.fn().mockRejectedValue(
          new Error("transient recovery failure")
        ),
        subscribeRecentTasks: vi.fn((_uid, onUpdate, onError) => {
          subscriptions.push({
            onUpdate,
            onError: onError ?? (() => undefined)
          });
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
      expect(subscriptions).toHaveLength(1);

      subscriptions[0]!.onError({
        scope: "root",
        error: new Error("snapshot failed")
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(taskIndex.listRecentTasks).toHaveBeenCalledOnce();
      expect(subscriptions).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(subscriptions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriptions).toHaveLength(2);

      const recovered = cloudTask({
        id: "cloud:listener-recovered",
        title: "Listener recovered"
      });
      subscriptions[1]!.onUpdate([recovered]);
      await vi.advanceTimersByTimeAsync(0);

      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: recovered.id,
          title: recovered.title
        })
      ]);

      subscriptions[1]!.onError({
        scope: "root",
        error: new Error("snapshot failed again")
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(taskIndex.listRecentTasks).toHaveBeenCalledTimes(2);

      auth.setState({ status: "signedOut" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscriptions).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
    expect(app.sessionStore.getState().recentTasks).toEqual([]);
    const publicationsBeforeForce = emittedTaskIds.length;
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

    expect(emittedTaskIds).toHaveLength(publicationsBeforeForce);
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

  it("hydrates a cloud-only terminal prompt through its relay owner detail route", async () => {
    const fullPrompt = `${"p".repeat(520)}END-OF-CANONICAL-PROMPT`;
    const promptSnippet = fullPrompt.slice(0, 500);
    const taskId = "cloud:desktop-owner:repo-cloud:task-long";
    const { authSession } = createMutableAuthSession(signedInState());
    let pushCloudTasks:
      | ((tasks: Awaited<ReturnType<CloudTaskIndex["listRecentTasks"]>>) => void)
      | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const invokeDesktop = vi.fn<RelayDesktopClient["invokeDesktop"]>(
      async (request) => {
        if (
          request.method === "GET" &&
          request.path === "/v1/tasks/task-long"
        ) {
          return {
            id: "task-long",
            repoId: "repo-local",
            title: "Long cloud task",
            prompt: fullPrompt,
            stage: "in progress",
            agentType: "pty"
          };
        }
        throw new Error(`Unexpected relay invocation: ${request.path}`);
      }
    );
    const observeTaskTerminal = vi.fn(() => ({ close: vi.fn() }));
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop,
      observeTaskTerminal,
      observeTaskAgent: vi.fn(() => ({
        close: vi.fn(),
        sendInput: vi.fn(),
        sendPermission: vi.fn(),
        interrupt: vi.fn()
      })),
      listActiveDesktopIds: vi.fn().mockResolvedValue(
        new Set(["desktop-owner"])
      )
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

    await app.initialize();
    pushCloudTasks?.([cloudTask({
      id: taskId,
      repoId: "repo-cloud",
      title: "Long cloud task",
      prompt: promptSnippet,
      agentType: "pty",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-long"
    })]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks[0]?.prompt).toBe(
        promptSnippet
      );
    });

    app.controller.openTask(taskId);

    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks[0]?.prompt).toBe(
        fullPrompt
      );
    });
    expect(promptSnippet).toHaveLength(500);
    expect(promptSnippet).not.toContain("END-OF-CANONICAL-PROMPT");
    expect(app.sessionStore.getState().recentTasks[0]?.prompt).toContain(
      "END-OF-CANONICAL-PROMPT"
    );
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/tasks/task-long",
      body: null
    });
    expect(observeTaskTerminal).toHaveBeenCalledWith(
      { desktopId: "desktop-owner", taskId: "task-long" },
      expect.any(Function)
    );

    pushCloudTasks?.([cloudTask({
      id: taskId,
      repoId: "repo-cloud",
      title: "Long cloud task",
      prompt: promptSnippet,
      activity: "working",
      agentType: "pty",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-long"
    })]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks[0]?.activity).toBe(
        "working"
      );
    });
    expect(app.sessionStore.getState().recentTasks[0]?.prompt).toBe(fullPrompt);
  });

  it("rebinds an open agent exactly once when a live task keeps its display id but changes owner route", async () => {
    const { authSession } = createMutableAuthSession({
      status: "signedIn",
      user: { uid: "user-1", email: "dev@example.com", displayName: null }
    });
    let pushCloudTasks:
      | ((tasks: Awaited<ReturnType<CloudTaskIndex["listRecentTasks"]>>) => void)
      | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const ownerASubscription: TaskAgentSubscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const ownerBSubscription: TaskAgentSubscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskAgent = vi.fn((route: { desktopId: string }) =>
      route.desktopId === "desktop-a"
        ? ownerASubscription
        : ownerBSubscription
    );
    const relayClient: RelayDesktopClient = {
      close: vi.fn(),
      invokeDesktop: vi.fn().mockResolvedValue(null),
      observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
      observeTaskAgent,
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      listActiveDesktopIds: vi.fn().mockResolvedValue(
        new Set(["desktop-a", "desktop-b"])
      )
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
    const taskId = "cloud:stable-display-id";
    const ownerATask = cloudTask({
      id: taskId,
      title: "Owner A task",
      agentType: "agent",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "local-a"
    });

    await app.initialize();
    pushCloudTasks?.([ownerATask]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: taskId,
          ownerDesktopId: "desktop-a",
          ownerLocalTaskId: "local-a"
        })
      ]);
    });
    app.controller.openTask(taskId);

    expect(observeTaskAgent).toHaveBeenCalledWith(
      { desktopId: "desktop-a", taskId: "local-a" },
      expect.any(Function)
    );

    const ownerBTask = {
      ...ownerATask,
      title: "Owner B task",
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "local-b"
    };
    pushCloudTasks?.([ownerBTask]);

    await vi.waitFor(() => {
      expect(observeTaskAgent).toHaveBeenCalledTimes(2);
    });
    expect(ownerASubscription.close).toHaveBeenCalledOnce();
    expect(observeTaskAgent).toHaveBeenLastCalledWith(
      { desktopId: "desktop-b", taskId: "local-b" },
      expect.any(Function)
    );

    await app.controller.sendTaskInput(taskId, "continue on B");
    app.controller.sendTaskAgentPermission(
      taskId,
      "permission-1",
      { kind: "allow" }
    );
    app.controller.interruptTaskAgent(taskId);

    expect(ownerASubscription.sendInput).not.toHaveBeenCalled();
    expect(ownerASubscription.sendPermission).not.toHaveBeenCalled();
    expect(ownerASubscription.interrupt).not.toHaveBeenCalled();
    expect(ownerBSubscription.sendInput).toHaveBeenCalledWith("continue on B");
    expect(ownerBSubscription.sendPermission).toHaveBeenCalledWith(
      "permission-1",
      { kind: "allow" }
    );
    expect(ownerBSubscription.interrupt).toHaveBeenCalledOnce();

    pushCloudTasks?.([{ ...ownerBTask, title: "Owner B metadata refresh" }]);
    await vi.waitFor(() => {
      expect(app.sessionStore.getState().recentTasks[0]?.title).toBe(
        "Owner B metadata refresh"
      );
    });

    expect(observeTaskAgent).toHaveBeenCalledTimes(2);
    expect(ownerASubscription.close).toHaveBeenCalledOnce();
    expect(ownerBSubscription.close).not.toHaveBeenCalled();
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
    expect(app.sessionStore.getState().accountDesktops).toEqual(
      app.sessionStore.getState().desktops
    );
    expect(app.sessionStore.getState().liveLanDesktops).toEqual([]);

    app.setForceCloud(false);

    expect(app.sessionStore.getState().accountDesktops).toEqual([
      expect.objectContaining({ id: "desktop-owner", mode: "remote" })
    ]);
    expect(app.sessionStore.getState().liveLanDesktops).toEqual([]);
    expect(taskIndex.listDesktops).toHaveBeenCalledWith("user-1");
  });

  it("keeps an unpaired account task stream on relay when its LAN projection is available", async () => {
    const accountTask = cloudTask({
      id: "cloud:desktop-lan:repo-lan:local-task",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-task",
      agentType: "pty"
    });
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-lan",
          displayName: "LAN Mac",
          updatedAt: "2026-07-20T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([accountTask]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lan = createLanFixture(async () => [
      {
        id: "local-task",
        repoId: "repo-lan",
        title: "LAN task",
        stage: "in progress",
        agentType: "pty"
      }
    ]);
    const { authSession } = createMutableAuthSession(signedInState());
    const relayClient = createRelayClientMock(
      vi.fn().mockResolvedValue(new Set(["desktop-lan"]))
    );
    const socketUrls: string[] = [];
    class TestWebSocket {
      close = vi.fn();
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      send = vi.fn();

      constructor(url: string) {
        socketUrls.push(url);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    const app = createAppModel({
      authSession,
      fetchImpl: lan.fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-lan",
          trustedDesktops: [],
          repoCreationProfiles: []
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: lan.bonjourBrowser,
        createRelayClient: () => relayClient
      }
    });

    try {
      await app.initialize();
      pushCloudTasks?.([accountTask]);
      await flushAsyncWork(40);

      app.controller.openTask(accountTask.id);

      expect(relayClient.observeTaskTerminal).toHaveBeenCalledWith(
        { desktopId: "desktop-lan", taskId: "local-task" },
        expect.any(Function)
      );
      expect(socketUrls).toEqual([]);
    } finally {
      app.controller.dispose();
    }
  });

  it("migrates an open account task to relay when LAN validation times out", async () => {
    vi.useFakeTimers();
    const accountTask = cloudTask({
      id: "cloud:desktop-lan:repo-lan:local-task",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-lan",
      ownerLocalTaskId: "local-task",
      agentType: "pty"
    });
    let pushCloudTasks: ((tasks: CloudTaskSummary[]) => void) | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([
        {
          desktopId: "desktop-lan",
          displayName: "LAN Mac",
          updatedAt: "2026-07-20T00:00:00.000Z"
        }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([accountTask]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const lan = createLanFixture(async () => [
      {
        id: "local-task",
        repoId: "repo-lan",
        title: "LAN task",
        stage: "in progress",
        agentType: "pty"
      }
    ]);
    const services = lan.bonjourBrowser.getServices();
    const bonjour = createMutableBonjourBrowser([...services]);
    const hangingStatusProbe = deferred<Response>();
    let statusProbeShouldHang = false;
    const fetchImpl = vi.fn((url: string, init?: Parameters<FetchLike>[1]) => {
      if (statusProbeShouldHang && url.endsWith("/v1/status")) {
        return hangingStatusProbe.promise;
      }
      return lan.fetchImpl(url, init);
    }) as FetchLike;
    const { authSession } = createMutableAuthSession(signedInState());
    const relayClient = createRelayClientMock(
      vi.fn().mockResolvedValue(new Set(["desktop-lan"]))
    );
    const sockets: Array<{
      close: ReturnType<typeof vi.fn>;
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      send: ReturnType<typeof vi.fn>;
    }> = [];
    class TestWebSocket {
      close = vi.fn();
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      send = vi.fn();

      constructor(_url: string) {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    const app = createAppModel({
      authSession,
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-lan",
          mobileDeviceId: "mobile-paired",
          trustedDesktops: [
            {
              desktopId: "desktop-lan",
              displayName: "LAN Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://desktop.lan:48120",
                  lastSeenAt: "2026-07-20T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-07-20T00:00:00.000Z",
              deviceSecret: "paired-device-secret"
            }
          ],
          repoCreationProfiles: []
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.test",
        taskIndex,
        bonjourBrowser: bonjour.browser,
        createRelayClient: () => relayClient
      }
    });

    try {
      await app.initialize();
      expect(pushCloudTasks).not.toBeNull();
      pushCloudTasks?.([accountTask]);
      await vi.advanceTimersByTimeAsync(0);
      await flushAsyncWork(40);
      expect(app.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: accountTask.id, title: "LAN task" })
      ]);

      app.controller.openTask(accountTask.id);
      for (const socket of sockets) {
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
      }
      const lanTerminalSocket = sockets.find((socket) =>
        socket.send.mock.calls.some(
          ([frame]) => JSON.parse(frame).kind === "terminal"
        )
      );
      expect(lanTerminalSocket).toBeDefined();
      expect(relayClient.observeTaskTerminal).not.toHaveBeenCalled();

      statusProbeShouldHang = true;
      bonjour.setServices([...services]);
      await flushAsyncWork(6);
      await vi.advanceTimersByTimeAsync(999);
      expect(relayClient.observeTaskTerminal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushAsyncWork(12);

      expect(lanTerminalSocket!.close).toHaveBeenCalledOnce();
      expect(relayClient.observeTaskTerminal).toHaveBeenCalledWith(
        { desktopId: "desktop-lan", taskId: "local-task" },
        expect.any(Function)
      );
      expect(app.sessionStore.getState()).toMatchObject({
        selectedTaskId: accountTask.id,
        taskTerminalTaskId: accountTask.id
      });
      expect(app.sessionStore.getState().auth.status).toBe("signedIn");
      expect(app.sessionStore.getState().accountDesktops).toEqual([
        expect.objectContaining({ id: "desktop-lan", mode: "remote" })
      ]);
    } finally {
      app.controller.dispose();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

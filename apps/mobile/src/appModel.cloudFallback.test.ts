import { describe, expect, it, vi } from "vitest";
import {
  createAppModel,
  createCloudWithLanFallbackClient,
  type CloudWithLanFallbackOptions
} from "./appModel";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskTerminalSubscription
} from "./lib/api/client";
import type { MobileAuthSession, MobileAuthState } from "./lib/firebase/auth";
import type { CloudTaskIndex } from "./lib/firebase/taskIndex";
import type { RelayDesktopClient } from "./lib/transports/relayClient";

function createClientMock(): KannaClient {
  const terminalSubscription: TaskTerminalSubscription = { close: vi.fn() };
  const agentSubscription: TaskAgentSubscription = {
    close: vi.fn(),
    sendInput: vi.fn(),
    sendPermission: vi.fn(),
    interrupt: vi.fn()
  };

  return {
    getStatus: vi.fn().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Desktop",
      lanHost: "cloud",
      lanPort: 0,
      pairingCode: null
    }),
    listDesktops: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
    listRepoTasks: vi.fn().mockResolvedValue([]),
    listRecentTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Created",
      stage: "in progress"
    }),
    runMergeAgent: vi.fn().mockResolvedValue({ taskId: "task-merge" }),
    advanceTaskStage: vi.fn().mockResolvedValue({ taskId: "task-pr" }),
    closeTask: vi.fn().mockResolvedValue(undefined),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn(() => terminalSubscription),
    observeTaskAgent: vi.fn(() => agentSubscription),
    createPairingSession: vi.fn().mockResolvedValue({
      code: "ABC123",
      desktopId: "desktop-1",
      desktopName: "Desktop",
      lanHost: "127.0.0.1",
      lanPort: 48120,
      expiresAtUnixMs: 1
    })
  };
}

describe("createCloudWithLanFallbackClient", () => {
  it("routes task connections to cloud when live Firestore tasks have arrived", () => {
    const cloudClient = createClientMock();
    const lanClient = createClientMock();
    const liveCloudTasks = [
      {
        id: "cloud:task-1",
        repoId: "repo-cloud",
        repoName: "Cloud Repo",
        title: "Cloud task",
        stage: "in progress"
      }
    ];
    let liveCloudHasTasks = false;
    const options: CloudWithLanFallbackOptions = {
      getLiveCloudTasks: () => (liveCloudHasTasks ? liveCloudTasks : []),
      isLanFallbackEnabled: () => true,
      hasLiveCloudTasks: () => liveCloudHasTasks
    };
    const client = createCloudWithLanFallbackClient(cloudClient, lanClient, options);

    expect(client.observeTaskTerminal("task-lan", vi.fn())).toBeDefined();
    expect(lanClient.observeTaskTerminal).toHaveBeenCalledWith("task-lan", expect.any(Function));

    liveCloudHasTasks = true;
    client.observeTaskTerminal("cloud:task-1", vi.fn());
    void client.sendTaskInput("cloud:task-1", "continue");

    expect(cloudClient.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud:task-1",
      expect.any(Function)
    );
    expect(cloudClient.sendTaskInput).toHaveBeenCalledWith("cloud:task-1", "continue");
  });

  it("serves live cloud task lists from subscription cache without Firestore list reads", async () => {
    const cloudClient = createClientMock();
    const lanClient = createClientMock();
    const liveCloudTasks = [
      {
        id: "cloud:task-1",
        repoId: "repo-cloud",
        repoName: "Cloud Repo",
        title: "Cloud task",
        stage: "in progress"
      }
    ];
    const client = createCloudWithLanFallbackClient(cloudClient, lanClient, {
      getLiveCloudTasks: () => liveCloudTasks,
      isLanFallbackEnabled: () => true
    });

    await expect(client.listRecentTasks()).resolves.toEqual(liveCloudTasks);
    await expect(client.listRepos()).resolves.toEqual([
      { id: "repo-cloud", name: "Cloud Repo" }
    ]);
    await expect(client.listRepoTasks("repo-cloud")).resolves.toEqual(liveCloudTasks);
    await expect(client.getStatus()).resolves.toMatchObject({ lanHost: "cloud" });

    expect(cloudClient.listRecentTasks).not.toHaveBeenCalled();
    expect(cloudClient.listRepos).not.toHaveBeenCalled();
    expect(cloudClient.listRepoTasks).not.toHaveBeenCalled();
    expect(lanClient.listRecentTasks).not.toHaveBeenCalled();
  });

  it("creates new tasks on the LAN desktop when cloud tasks are visible and LAN fallback is enabled", async () => {
    const cloudClient = createClientMock();
    const lanClient = createClientMock();
    const liveCloudTasks = [
      {
        id: "cloud:task-1",
        repoId: "repo-cloud",
        repoName: "Cloud Repo",
        title: "Cloud task",
        stage: "in progress"
      }
    ];
    const client = createCloudWithLanFallbackClient(cloudClient, lanClient, {
      getLiveCloudTasks: () => liveCloudTasks,
      isLanFallbackEnabled: () => true,
      hasLiveCloudTasks: () => true
    });

    await client.createTask({
      repoId: "repo-cloud",
      prompt: "Create from mobile",
      agentProvider: "claude"
    });

    expect(lanClient.createTask).toHaveBeenCalledWith({
      repoId: "repo-cloud",
      prompt: "Create from mobile",
      agentProvider: "claude"
    });
    expect(cloudClient.createTask).not.toHaveBeenCalled();
  });
});

describe("createAppModel cloud routing", () => {
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

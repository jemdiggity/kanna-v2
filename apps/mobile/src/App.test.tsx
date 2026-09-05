import { describe, expect, it, vi } from "vitest";
import {
  createAppModel,
  resolveForceCloud,
  resolveRelayUrl
} from "./appModel";
import { createStaticBonjourBrowser } from "./lib/discovery/bonjour";
import {
  createMobileAuthSession,
  type MobileAuthSdk,
  type MobileAuthSession,
  type MobileAuthUser
} from "./lib/firebase/auth";
import type { CloudTaskIndex } from "./lib/firebase/taskIndex";
import type { FetchLike } from "./lib/transports/lanTransport";
import type { RelayDesktopClient } from "./lib/transports/relayClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFetchMock(): FetchLike {
  return vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/v1/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "running",
          desktopId: "desktop-1",
          desktopName: "Studio Mac",
          lanHost: "0.0.0.0",
          lanPort: 48120,
          pairingCode: null
        })
      } as Response;
    }

    if (url.endsWith("/v1/desktops")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" },
          { id: "desktop-2", name: "Laptop", online: true, mode: "remote" }
        ]
      } as Response;
    }

    if (url.endsWith("/v1/repos")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "repo-1", name: "Repo One" },
          { id: "repo-2", name: "Repo Two" }
        ]
      } as Response;
    }

    if (url.endsWith("/v1/tasks/recent")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "task-1",
            repoId: "repo-1",
            title: "Refactor mobile shell",
            stage: "in progress"
          },
          {
            id: "task-2",
            repoId: "repo-2",
            title: "Review shell polish",
            stage: "pr"
          }
        ]
      } as Response;
    }

    if (
      url.endsWith(
        "/v1/tasks/task%2Fread/files/content?path=docs%2Fspec%20one.md"
      )
    ) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          path: "docs/spec one.md",
          content: "# Spec"
        })
      } as Response;
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;
}

function createTrustedDesktopFetchMock(
  recentTasks = [
    {
      id: "task-trusted",
      repoId: "repo-trusted",
      title: "Trusted LAN task",
      stage: "in progress"
    }
  ]
): FetchLike {
  return vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();

    if (!url.startsWith("http://trusted.lan:48120")) {
      throw new Error(`Unexpected request: ${url}`);
    }

    if (url.endsWith("/v1/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "running",
          desktopId: "desktop-trusted",
          desktopName: "Trusted Mac",
          lanHost: "0.0.0.0",
          lanPort: 48120,
          pairingCode: null
        })
      } as Response;
    }

    if (url.endsWith("/v1/desktops")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "desktop-trusted", name: "Trusted Mac", connectionMode: "lan" }
        ]
      } as Response;
    }

    if (url.endsWith("/v1/repos")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "repo-trusted", name: "Trusted Repo" }]
      } as Response;
    }

    if (url.endsWith("/v1/tasks/recent")) {
      return {
        ok: true,
        status: 200,
        json: async () => recentTasks
      } as Response;
    }

    if (url.endsWith("/v1/repos/repo-trusted/tasks")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "task-trusted",
            repoId: "repo-trusted",
            title: "Trusted LAN task",
            stage: "in progress"
          }
        ]
      } as Response;
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;
}

function createSignedInAuthSession(): MobileAuthSession {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => ({
      status: "signedIn",
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    })),
    subscribe: vi.fn((listener) => {
      listener({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      });
      return () => undefined;
    }),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue("id-token-1"),
    notifyAuthExpired: vi.fn()
  };
}

function createSignedOutAuthSession(): MobileAuthSession {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => ({ status: "signedOut" })),
    subscribe: vi.fn(() => () => undefined),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
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

function createTrustedDesktopContext(
  desktopId = "desktop-1",
  displayName = "Studio Mac"
) {
  return {
    selectedDesktopId: desktopId,
    selectedRepoId: null,
    selectedTaskId: null,
    activeView: "tasks" as const,
    trustedDesktops: [
      {
        desktopId,
        displayName,
        lanEndpoints: [],
        lastSeenAt: "2026-06-01T00:00:00.000Z"
      }
    ]
  };
}

function createBonjourForDesktop(
  desktopId = "desktop-1",
  name = "Studio Mac",
  host = "desktop.test",
  port = 48120
) {
  return createStaticBonjourBrowser([
    {
      name,
      type: "_kanna-mobile._tcp.",
      host,
      port,
      txt: { desktopId }
    }
  ]);
}

describe("createAppModel", () => {
  it("resolves the relay URL from Expo public env", () => {
    expect(
      resolveRelayUrl({ EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.example" })
    ).toBe("wss://relay.example");
    expect(resolveRelayUrl({ EXPO_PUBLIC_KANNA_RELAY_URL: "   " })).toBeNull();
  });

  it("uses the production relay URL when no Expo public relay URL is provided", () => {
    expect(resolveRelayUrl({})).toBe("wss://relay.kanna.build");
  });

  it("does not use the production relay URL in dev mode without an explicit override", () => {
    expect(resolveRelayUrl({}, { dev: true })).toBeNull();
    expect(resolveRelayUrl({ EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.example" }, { dev: true })).toBe("wss://relay.example");
  });

  it("resolves relay URL from Expo extra before production defaults", () => {
    expect(resolveRelayUrl({}, { extraRelayUrl: "wss://relay-staging.kanna.build" }))
      .toBe("wss://relay-staging.kanna.build");
  });

  it("lets Expo public relay URL override Expo extra", () => {
    expect(
      resolveRelayUrl(
        { EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.env.example" },
        { extraRelayUrl: "wss://relay-extra.example" }
      )
    ).toBe("wss://relay.env.example");
  });

  it("closes and replaces relay clients when the persisted endpoint changes", async () => {
    const relayClients: Array<{ relayUrl: string; client: RelayDesktopClient }> = [];
    const save = vi.fn().mockResolvedValue(undefined);
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence: {
        load: vi.fn().mockResolvedValue({
          mobileDeviceId: null,
          customRelayUrl: "wss://relay.home.example",
          selectedDesktopId: null,
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks"
        }),
        save
      },
      authSession: createSignedInAuthSession(),
      options: {
        customRelayControlEnabled: true,
        relayUrl: "wss://relay.default.example",
        taskIndex: {
          listDesktops: vi.fn().mockResolvedValue([]),
          listRecentTasks: vi.fn().mockResolvedValue([]),
          subscribeRecentTasks: vi.fn(() => () => undefined)
        },
        createRelayClient: ({ relayUrl }) => {
          const client = createRelayClientMock();
          relayClients.push({ relayUrl, client });
          return client;
        },
        bonjourBrowser: createStaticBonjourBrowser([])
      }
    });

    await model.initialize();
    expect(relayClients.map(({ relayUrl }) => relayUrl)).toEqual([
      "wss://relay.default.example",
      "wss://relay.home.example"
    ]);
    expect(relayClients[0]?.client.close).toHaveBeenCalledOnce();

    await model.setCustomRelayUrl("wss://relay.changed.example/socket");
    expect(relayClients.at(-1)?.relayUrl)
      .toBe("wss://relay.changed.example/socket");
    expect(relayClients[1]?.client.close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      customRelayUrl: "wss://relay.changed.example/socket"
    }));

    await model.setCustomRelayUrl(null);
    expect(relayClients.at(-1)?.relayUrl).toBe("wss://relay.default.example");
    expect(relayClients[2]?.client.close).toHaveBeenCalledOnce();
  });

  it("ignores a stored custom endpoint in a build where the control is hidden", async () => {
    const relayClients: Array<{ relayUrl: string; client: RelayDesktopClient }> = [];
    const save = vi.fn().mockResolvedValue(undefined);
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence: {
        load: vi.fn().mockResolvedValue({
          mobileDeviceId: null,
          customRelayUrl: "wss://relay.home.example",
          selectedDesktopId: null,
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks"
        }),
        save
      },
      authSession: createSignedInAuthSession(),
      options: {
        customRelayControlEnabled: false,
        relayUrl: "wss://relay.default.example",
        taskIndex: {
          listDesktops: vi.fn().mockResolvedValue([]),
          listRecentTasks: vi.fn().mockResolvedValue([]),
          subscribeRecentTasks: vi.fn(() => () => undefined)
        },
        createRelayClient: ({ relayUrl }) => {
          const client = createRelayClientMock();
          relayClients.push({ relayUrl, client });
          return client;
        },
        bonjourBrowser: createStaticBonjourBrowser([])
      }
    });

    await model.initialize();

    expect(model.customRelayControlEnabled).toBe(false);
    // The stored endpoint never routes traffic...
    expect(relayClients.length).toBeGreaterThan(0);
    expect(new Set(relayClients.map(({ relayUrl }) => relayUrl)))
      .toEqual(new Set(["wss://relay.default.example"]));
    // ...but it stays on the device, so re-enabling the control restores it.
    expect(model.sessionStore.getState().customRelayUrl)
      .toBe("wss://relay.home.example");
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({
      customRelayUrl: null
    }));
  });

  it("parses the force-cloud override from Expo public env", () => {
    expect(resolveForceCloud({ EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1" })).toBe(true);
    expect(resolveForceCloud({ EXPO_PUBLIC_KANNA_FORCE_CLOUD: "false" })).toBe(false);
  });

  it("creates an app model with business state and a LAN client", async () => {
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence: {
        load: vi.fn().mockResolvedValue(createTrustedDesktopContext()),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createBonjourForDesktop() }
    });

    expect("navigator" in model).toBe(false);
    expect(typeof model.controller.bootstrap).toBe("function");
    await model.initialize();
    expect((await model.client.getStatus()).desktopName).toBe("Studio Mac");
    await expect(
      model.client.readTaskFile("task/read", "docs/spec one.md")
    ).rejects.toThrow(/authenticated relay/i);
    await expect(model.client.readTaskDiff("task/read")).rejects.toThrow(
      /authenticated relay/i
    );
  });

  it("uses cloud task index for a signed-in model with relay config", async () => {
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      })),
      subscribe: vi.fn((listener) => {
        listener({
          status: "signedIn",
          user: { uid: "user-1", email: "u@example.com", displayName: null }
        });
        return () => undefined;
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue("id-token-1"),
      notifyAuthExpired: vi.fn()
    };
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-1",
          ownerLocalTaskId: "task-1",
          ownerOnline: false
        }
      ]),
      subscribeRecentTasks: vi.fn(() => () => {})
    };

    const model = createAppModel({
      fetchImpl: createFetchMock(),
      authSession,
      options: { relayUrl: "wss://relay.example", taskIndex }
    });

    await expect(model.client.getStatus()).resolves.toMatchObject({
      desktopId: "cloud",
      desktopName: "Kanna Cloud"
    });
    await expect(model.client.listRecentTasks()).resolves.toEqual([
      expect.objectContaining({ id: "cloud-task-1", title: "Cloud task" })
    ]);
    expect(taskIndex.listRecentTasks).toHaveBeenCalledWith("user-1");
  });

  it("combines one-shot cloud and trusted LAN tasks before live snapshots exist", async () => {
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      })),
      subscribe: vi.fn((listener) => {
        listener({
          status: "signedIn",
          user: { uid: "user-1", email: "u@example.com", displayName: null }
        });
        return () => undefined;
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue("id-token-1"),
      notifyAuthExpired: vi.fn()
    };
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => [
        {
          id: "cloud-task-before-live",
          repoId: "repo-cloud",
          repoName: "Cloud Repo",
          title: "Cloud task before live",
          stage: "in progress",
          ownerDesktopId: "desktop-cloud",
          ownerLocalTaskId: "task-cloud",
          ownerOnline: false
        }
      ]),
      subscribeRecentTasks: vi.fn(() => () => {})
    };
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence: {
        load: vi.fn().mockResolvedValue(createTrustedDesktopContext()),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession,
      options: {
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createBonjourForDesktop()
      }
    });

    await model.initialize();

    await expect(model.client.listRecentTasks()).resolves.toEqual([
      expect.objectContaining({
        id: "cloud-task-before-live",
        title: "Cloud task before live"
      }),
      expect.objectContaining({ id: "task-1", title: "Refactor mobile shell" }),
      expect.objectContaining({ id: "task-2", title: "Review shell polish" })
    ]);
  });

  it("does not call localhost when signed out with no trusted desktops", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("runtime URL fallback must not be used");
    }) as FetchLike;
    const model = createAppModel({
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: null,
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: []
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createStaticBonjourBrowser([]) }
    });

    await model.initialize();

    expect(model.sessionStore.getState()).toMatchObject({
      connectionState: "idle",
      recentTasks: [],
      repoTasks: []
    });
    await expect(model.client.getStatus()).resolves.toMatchObject({
      desktopId: "none",
      writePathHealth: {
        healthy: false,
        status: "unavailable",
        activeWorkspaceCommands: 0,
        maxWorkspaceCommands: 0,
        longRunningWorkspaceCommands: 0,
        oldestWorkspaceCommandSeconds: null
      }
    });
    await expect(
      model.client.readTaskFile("task-1", "README.md")
    ).rejects.toThrow("No trusted desktop is available");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to loopback LAN when signed-in production cloud has no tasks yet", async () => {
    const authSession: MobileAuthSession = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(() => ({
        status: "signedIn",
        user: { uid: "user-1", email: "u@example.com", displayName: null }
      })),
      subscribe: vi.fn((listener) => {
        listener({
          status: "signedIn",
          user: { uid: "user-1", email: "u@example.com", displayName: null }
        });
        return () => undefined;
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue("id-token-1"),
      notifyAuthExpired: vi.fn()
    };
    const fetchImpl = vi.fn(async () => {
      throw new Error("LAN should not be called for standalone production cloud");
    }) as FetchLike;
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => []),
      subscribeRecentTasks: vi.fn(() => () => {})
    };
    const model = createAppModel({
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession,
      options: { relayUrl: "wss://relay.example", taskIndex }
    });

    await model.initialize();

    expect(model.sessionStore.getState().errorMessage).toBeNull();
    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud",
      recentTasks: []
    });
    await expect(model.client.listDesktops()).resolves.toEqual([]);
    await expect(model.client.listRepos()).resolves.toEqual([]);
    await expect(model.client.listRecentTasks()).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("composes live cloud and trusted Bonjour LAN tasks for signed-in users", async () => {
    const authSession = createSignedInAuthSession();
    let pushCloudTasks:
      | ((tasks: Awaited<ReturnType<CloudTaskIndex["listRecentTasks"]>>) => void)
      | null = null;
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => []),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return () => {};
      })
    };
    const fetchImpl = createTrustedDesktopFetchMock([
      {
        id: "task-trusted",
        repoId: "repo-trusted",
        title: "Trusted LAN task",
        stage: "in progress"
      },
      {
        id: "task-lan-only",
        repoId: "repo-trusted",
        title: "LAN-only task",
        stage: "review"
      }
    ]);
    const model = createAppModel({
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-trusted",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [
            {
              desktopId: "desktop-trusted",
              displayName: "Trusted Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://trusted.lan:48120",
                  lastSeenAt: "2026-05-31T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-05-31T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession,
      options: {
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createBonjourForDesktop(
          "desktop-trusted",
          "Trusted Mac",
          "trusted.lan",
          48120
        )
      }
    });

    await model.initialize();

    expect(pushCloudTasks).not.toBeNull();
    pushCloudTasks?.([
      {
        id: "cloud:task-trusted",
        repoId: "cloud-repo-trusted",
        repoName: "Trusted Repo",
        title: "Stale cloud title",
        stage: "pr",
        ownerDesktopId: "desktop-trusted",
        ownerLocalRepoId: "repo-trusted",
        ownerLocalTaskId: "task-trusted",
        ownerOnline: true
      },
      {
        id: "cloud:task-cloud-only",
        repoId: "repo-cloud-only",
        repoName: "Cloud-only Repo",
        title: "Cloud-only task",
        stage: "in progress",
        ownerDesktopId: "desktop-cloud-only",
        ownerLocalTaskId: "task-cloud-only",
        ownerOnline: true
      }
    ]);

    await vi.waitFor(() => {
      expect(model.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({
          id: "cloud:task-trusted",
          title: "Trusted LAN task",
          stage: "in progress"
        }),
        expect.objectContaining({
          id: "cloud:task-cloud-only",
          title: "Cloud-only task"
        }),
        expect.objectContaining({
          id: "task-lan-only",
          title: "LAN-only task"
        })
      ]);
    });

    expect(model.sessionStore.getState().errorMessage).toBeNull();
    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud"
    });
  });

  it("waits for restored auth before publishing one complete hybrid task snapshot", async () => {
    const restoredUser: MobileAuthUser = {
      uid: "restored-user",
      email: "restored@kanna.test",
      displayName: null
    };
    let observeAuthState: ((user: MobileAuthUser | null) => void) | null = null;
    const authObserverRegistered = deferred<void>();
    const sdk: MobileAuthSdk = {
      getCurrentUser: vi.fn(() => null),
      onAuthStateChanged: vi.fn((listener) => {
        observeAuthState = listener;
        authObserverRegistered.resolve(undefined);
        return vi.fn();
      }),
      signInWithEmailPassword: vi.fn().mockResolvedValue(restoredUser),
      signOut: vi.fn().mockResolvedValue(undefined),
      getIdToken: vi.fn().mockResolvedValue("restored-id-token")
    };
    const authSession = createMobileAuthSession({ sdk });
    let pushCloudTasks:
      | Parameters<CloudTaskIndex["subscribeRecentTasks"]>[1]
      | null = null;
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        pushCloudTasks = onUpdate;
        return vi.fn();
      })
    };
    const fetchImpl = createTrustedDesktopFetchMock([
      {
        id: "local-duplicate",
        repoId: "repo-trusted",
        title: "Fresh LAN duplicate",
        stage: "review"
      },
      {
        id: "lan-only",
        repoId: "repo-trusted",
        title: "LAN-only task",
        stage: "in progress"
      }
    ]);
    const model = createAppModel({
      authSession,
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-trusted",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [
            {
              desktopId: "desktop-trusted",
              displayName: "Trusted Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://trusted.lan:48120",
                  lastSeenAt: "2026-07-10T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-07-10T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        relayUrl: "wss://relay.example",
        taskIndex,
        createRelayClient: () => createRelayClientMock(),
        bonjourBrowser: createBonjourForDesktop(
          "desktop-trusted",
          "Trusted Mac",
          "trusted.lan",
          48120
        )
      }
    });
    const acceptedTaskHistory: Array<Array<{ id: string; title: string }>> = [
      []
    ];
    const firstNonEmptyPublication = deferred<void>();
    let previousTasks = model.sessionStore.getState().recentTasks;
    model.sessionStore.subscribe(() => {
      const tasks = model.sessionStore.getState().recentTasks;
      if (tasks === previousTasks) return;
      previousTasks = tasks;
      acceptedTaskHistory.push(
        tasks.map(({ id, title }) => ({ id, title }))
      );
      if (tasks.length > 0) {
        firstNonEmptyPublication.resolve(undefined);
      }
    });

    const initialization = model.initialize();
    await authObserverRegistered.promise;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(taskIndex.subscribeRecentTasks).not.toHaveBeenCalled();
    expect(acceptedTaskHistory).toEqual([[]]);

    observeAuthState?.(restoredUser);
    await initialization;
    expect(taskIndex.subscribeRecentTasks).toHaveBeenCalledWith(
      restoredUser.uid,
      expect.any(Function),
      expect.any(Function)
    );
    expect(acceptedTaskHistory).toEqual([[]]);

    pushCloudTasks?.([
      {
        id: "cloud-duplicate",
        repoId: "repo-cloud-duplicate",
        repoName: "Duplicate Repo",
        title: "Stale cloud duplicate",
        stage: "pr",
        ownerDesktopId: "desktop-trusted",
        ownerLocalRepoId: "repo-trusted",
        ownerLocalTaskId: "local-duplicate",
        ownerOnline: true
      },
      {
        id: "cloud-only",
        repoId: "repo-cloud-only",
        repoName: "Cloud-only Repo",
        title: "Cloud-only task",
        stage: "in progress",
        ownerDesktopId: "desktop-cloud",
        ownerLocalTaskId: "local-cloud-only",
        ownerOnline: true
      }
    ]);

    await firstNonEmptyPublication.promise;
    expect(acceptedTaskHistory).toEqual([
      [],
      [
        { id: "cloud-duplicate", title: "Fresh LAN duplicate" },
        { id: "cloud-only", title: "Cloud-only task" },
        { id: "lan-only", title: "LAN-only task" }
      ]
    ]);
    expect(taskIndex.listRecentTasks).not.toHaveBeenCalled();
  });

  it("uses cloud instead of trusted LAN fallback when force-cloud is enabled", async () => {
    const authSession = createSignedInAuthSession();
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => []),
      subscribeRecentTasks: vi.fn(() => () => {})
    };
    const fetchImpl = createTrustedDesktopFetchMock();
    const model = createAppModel({
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-trusted",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [
            {
              desktopId: "desktop-trusted",
              displayName: "Trusted Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://trusted.lan:48120",
                  lastSeenAt: "2026-05-31T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-05-31T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession,
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createBonjourForDesktop(
          "desktop-trusted",
          "Trusted Mac",
          "trusted.lan",
          48120
        )
      }
    });

    await model.initialize();

    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      desktopName: "Kanna Cloud",
      recentTasks: []
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips Bonjour LAN endpoints whose status belongs to a different desktop", async () => {
    const authSession = createSignedInAuthSession();
    const taskIndex = {
      listDesktops: vi.fn(async () => []),
      listRecentTasks: vi.fn(async () => []),
      subscribeRecentTasks: vi.fn(() => () => {})
    };
    const fetchImpl = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "http://right.lan:48120/v1/status") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "running",
            desktopId: "desktop-trusted",
            desktopName: "Trusted Mac",
            lanHost: "0.0.0.0",
            lanPort: 48120,
            pairingCode: null
          })
        } as Response;
      }

      if (url === "http://right.lan:48120/v1/tasks/recent") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "task-trusted",
              repoId: "repo-trusted",
              title: "Trusted LAN task",
              stage: "in progress"
            }
          ]
        } as Response;
      }

      throw new Error(`Unexpected request: ${url}`);
    }) as FetchLike;
    const model = createAppModel({
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-trusted",
          selectedRepoId: null,
          selectedTaskId: null,
          activeView: "tasks",
          trustedDesktops: [
            {
              desktopId: "desktop-trusted",
              displayName: "Trusted Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://wrong.lan:48120",
                  lastSeenAt: "2026-05-31T00:00:00.000Z"
                },
                {
                  baseUrl: "http://right.lan:48120",
                  lastSeenAt: "2026-05-31T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-05-31T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession,
      options: {
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createStaticBonjourBrowser([
          {
            name: "Wrong Mac",
            type: "_kanna-mobile._tcp.",
            host: "wrong.lan",
            port: 48120,
            txt: { desktopId: "desktop-other" }
          },
          {
            name: "Trusted Mac",
            type: "_kanna-mobile._tcp.",
            host: "right.lan",
            port: 48120,
            txt: { desktopId: "desktop-trusted" }
          }
        ])
      }
    });

    await model.initialize();

    await expect(model.client.listRecentTasks()).resolves.toEqual([
      expect.objectContaining({ id: "task-trusted", title: "Trusted LAN task" })
    ]);
    const requestedUrls = fetchImpl.mock.calls.map(([url]) => url);
    expect(requestedUrls).not.toContain("http://wrong.lan:48120/v1/status");
    expect(requestedUrls).toContain("http://right.lan:48120/v1/status");
  });

  it("hydrates persisted mobile context before bootstrap", async () => {
    const persistence = {
      load: vi.fn().mockResolvedValue({
        selectedDesktopId: "desktop-2",
        selectedRepoId: "repo-2",
        selectedTaskId: "task-2",
        activeView: "more"
      }),
      save: vi.fn().mockResolvedValue(undefined)
    };
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence,
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createStaticBonjourBrowser([]) }
    });

    await model.initialize();

    expect(model.sessionStore.getState()).toMatchObject({
      selectedDesktopId: "desktop-2",
      selectedRepoId: "repo-2",
      selectedTaskId: "task-2",
      activeView: "more"
    });
  });

  it("preserves selected task detail state until the user routes back to the shell", async () => {
    const persistence = {
      load: vi.fn().mockResolvedValue({
        selectedDesktopId: "desktop-1",
        selectedRepoId: "repo-1",
        selectedTaskId: "task-1",
        activeView: "tasks"
      }),
      save: vi.fn().mockResolvedValue(undefined)
    };
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence,
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createStaticBonjourBrowser([]) }
    });

    await model.initialize();

    expect(model.sessionStore.getState()).toMatchObject({
      selectedTaskId: "task-1",
      activeView: "tasks"
    });

    model.controller.setNavigationView("more");

    expect(model.sessionStore.getState()).toMatchObject({
      selectedTaskId: "task-1",
      activeView: "more"
    });
  });

  it("persists desktop context whenever the user changes it", async () => {
    const persistence = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined)
    };
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence,
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createStaticBonjourBrowser([]) }
    });

    await model.initialize();
    await model.controller.selectDesktop("desktop-2");
    await model.controller.selectRepo("repo-2");
    model.controller.openTask("task-2");
    model.controller.setNavigationView("more");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persistence.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedDesktopId: "desktop-2",
        selectedRepoId: "repo-2",
        selectedTaskId: "task-2",
        activeView: "more",
        authUser: null
      })
    );
  });

  it("hydrates the full hybrid model and rejects obsolete startup composition work", async () => {
    const authSession = createSignedInAuthSession();
    const subscriptions: Array<{
      onUpdate: Parameters<CloudTaskIndex["subscribeRecentTasks"]>[1];
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const taskIndex: CloudTaskIndex = {
      listDesktops: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      subscribeRecentTasks: vi.fn((_uid, onUpdate) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ onUpdate, unsubscribe });
        return unsubscribe;
      })
    };
    const obsoleteLanRead = deferred<
      Array<{ id: string; repoId: string; title: string; stage: string }>
    >();
    let recentTaskReadCount = 0;
    const freshLanTasks = [
      {
        id: "local-duplicate",
        repoId: "repo-trusted",
        title: "Fresh LAN duplicate",
        stage: "review"
      },
      {
        id: "lan-only",
        repoId: "repo-trusted",
        title: "LAN-only task",
        stage: "in progress"
      }
    ];
    const fetchImpl = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/status")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "running",
            desktopId: "desktop-trusted",
            desktopName: "Trusted Mac",
            lanHost: "0.0.0.0",
            lanPort: 48120,
            pairingCode: null
          })
        } as Response;
      }
      if (url.endsWith("/v1/desktops")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "desktop-trusted",
              name: "Trusted Mac",
              online: true,
              mode: "lan"
            }
          ]
        } as Response;
      }
      if (url.endsWith("/v1/repos")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "repo-trusted", name: "Trusted Repo" }]
        } as Response;
      }
      if (url.endsWith("/v1/tasks/recent")) {
        recentTaskReadCount += 1;
        const tasks = recentTaskReadCount === 1
          ? await obsoleteLanRead.promise
          : freshLanTasks;
        return { ok: true, status: 200, json: async () => tasks } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as FetchLike;
    const model = createAppModel({
      authSession,
      fetchImpl,
      persistence: {
        load: vi.fn().mockResolvedValue({
          selectedDesktopId: "desktop-trusted",
          selectedRepoId: "repo-trusted",
          selectedTaskId: "stale-persisted-task",
          activeView: "tasks",
          trustedDesktops: [
            {
              desktopId: "desktop-trusted",
              displayName: "Trusted Mac",
              lanEndpoints: [
                {
                  baseUrl: "http://trusted.lan:48120",
                  lastSeenAt: "2026-07-10T00:00:00.000Z"
                }
              ],
              lastSeenAt: "2026-07-10T00:00:00.000Z"
            }
          ]
        }),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: false,
        relayUrl: "wss://relay.example",
        taskIndex,
        bonjourBrowser: createBonjourForDesktop(
          "desktop-trusted",
          "Trusted Mac",
          "trusted.lan",
          48120
        )
      }
    });

    await model.initialize();
    expect(subscriptions).toHaveLength(1);
    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      selectedRepoId: "repo-trusted",
      selectedTaskId: "stale-persisted-task"
    });

    subscriptions[0].onUpdate([
      {
        id: "cloud-obsolete",
        repoId: "repo-obsolete",
        repoName: "Obsolete Repo",
        title: "Obsolete cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-other",
        ownerLocalTaskId: "obsolete-local",
        ownerOnline: true
      }
    ]);
    await vi.waitFor(() => expect(recentTaskReadCount).toBe(1));

    await model.controller.refresh();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    const currentCloudTasks = [
      {
        id: "cloud-only",
        repoId: "repo-cloud-only",
        repoName: "Cloud-only Repo",
        title: "Cloud-only task",
        stage: "in progress",
        ownerDesktopId: "desktop-cloud",
        ownerLocalTaskId: "local-cloud-only",
        ownerOnline: true
      },
      {
        id: "cloud-duplicate",
        repoId: "repo-cloud-duplicate",
        repoName: "Duplicate Repo",
        title: "Stale cloud duplicate",
        stage: "pr",
        ownerDesktopId: "desktop-trusted",
        ownerLocalRepoId: "repo-trusted",
        ownerLocalTaskId: "local-duplicate",
        ownerOnline: true
      }
    ];
    subscriptions[1].onUpdate(currentCloudTasks);

    await vi.waitFor(() => {
      expect(model.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud-only" }),
        expect.objectContaining({
          id: "cloud-duplicate",
          title: "Stale cloud duplicate",
          stage: "pr"
        })
      ]);
    });
    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "remote",
      connectionState: "connected",
      selectedRepoId: "repo-trusted",
      selectedTaskId: null
    });
    const acceptedState = model.sessionStore.getState();

    obsoleteLanRead.resolve([
      {
        id: "obsolete-lan-only",
        repoId: "repo-obsolete",
        title: "Obsolete LAN task",
        stage: "review"
      }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(model.sessionStore.getState()).toEqual(acceptedState);

    subscriptions[1].onUpdate(currentCloudTasks);
    await vi.waitFor(() => {
      expect(model.sessionStore.getState().recentTasks).toEqual([
        expect.objectContaining({ id: "cloud-only" }),
        expect.objectContaining({
          id: "cloud-duplicate",
          title: "Fresh LAN duplicate",
          stage: "review"
        }),
        expect.objectContaining({ id: "lan-only" })
      ]);
    });
    expect(recentTaskReadCount).toBe(2);
  });
});

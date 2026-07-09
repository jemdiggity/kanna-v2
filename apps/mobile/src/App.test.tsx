import { describe, expect, it, vi } from "vitest";
import {
  createAppModel,
  resolveForceCloud,
  resolveRelayUrl
} from "./appModel";
import { createStaticBonjourBrowser } from "./lib/discovery/bonjour";
import type { MobileAuthSession } from "./lib/firebase/auth";
import type { FetchLike } from "./lib/transports/lanTransport";

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

    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;
}

function createTrustedDesktopFetchMock(): FetchLike {
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

  it("parses the force-cloud override from Expo public env", () => {
    expect(resolveForceCloud({ EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1" })).toBe(true);
    expect(resolveForceCloud({ EXPO_PUBLIC_KANNA_FORCE_CLOUD: "false" })).toBe(false);
  });

  it("creates an app model with desktop navigation and a LAN client", async () => {
    const model = createAppModel({
      fetchImpl: createFetchMock(),
      persistence: {
        load: vi.fn().mockResolvedValue(createTrustedDesktopContext()),
        save: vi.fn().mockResolvedValue(undefined)
      },
      authSession: createSignedOutAuthSession(),
      options: { bonjourBrowser: createBonjourForDesktop() }
    });

    expect(model.navigator.tabs.map((tab) => tab.label)).toEqual([
      "Tasks",
      "Activity",
      "More"
    ]);
    expect(model.navigator.utilityActions.map((action) => action.label)).toEqual([
      "Search",
      "Add task"
    ]);
    expect(typeof model.controller.bootstrap).toBe("function");
    await model.initialize();
    expect((await model.client.getStatus()).desktopName).toBe("Studio Mac");
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

  it("falls back to LAN tasks for signed-in users before cloud snapshots exist", async () => {
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
      listRecentTasks: vi.fn(async () => []),
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

  it("falls back to a trusted Bonjour LAN endpoint when signed-in cloud has no tasks", async () => {
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

    expect(model.sessionStore.getState().errorMessage).toBeNull();
    expect(model.sessionStore.getState()).toMatchObject({
      connectionMode: "lan",
      connectionState: "connected",
      desktopName: "Trusted Mac",
      recentTasks: [
        expect.objectContaining({ id: "task-trusted", title: "Trusted LAN task" })
      ]
    });
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
    expect(fetchImpl).not.toHaveBeenCalledWith("http://wrong.lan:48120/v1/status");
    expect(fetchImpl).toHaveBeenCalledWith("http://right.lan:48120/v1/status");
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

    model.controller.showView("more");

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
    model.controller.showView("more");
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
});

import { describe, expect, it, vi } from "vitest";
import { createAppModel, resolveRelayUrl, resolveServerBaseUrl } from "./appModel";
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

describe("createAppModel", () => {
  it("resolves the mobile server URL from Expo public env", () => {
    vi.stubEnv("EXPO_PUBLIC_KANNA_SERVER_URL", "http://desktop.lan:48120");

    expect(resolveServerBaseUrl()).toBe("http://desktop.lan:48120");

    vi.unstubAllEnvs();
  });

  it("infers the mobile server host from the Metro bundle URL when no Expo public server URL is provided", () => {
    vi.unstubAllEnvs();

    expect(
      resolveServerBaseUrl(
        {},
        "http://192.168.68.56:8081/.expo/.virtual-metro-entry.bundle?platform=ios"
      )
    ).toBe("http://192.168.68.56:48120");
  });

  it("prefers the Metro-derived LAN host over a loopback Expo public server URL", () => {
    vi.unstubAllEnvs();

    expect(
      resolveServerBaseUrl(
        { EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120" },
        "http://192.168.68.56:8081/.expo/.virtual-metro-entry.bundle?platform=ios"
      )
    ).toBe("http://192.168.68.56:48120");
  });

  it("falls back to localhost when no Expo public server URL is provided", () => {
    vi.unstubAllEnvs();

    expect(resolveServerBaseUrl({}, null)).toBe("http://127.0.0.1:48120");
  });

  it("resolves the relay URL from Expo public env", () => {
    expect(
      resolveRelayUrl({ EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.example" })
    ).toBe("wss://relay.example");
    expect(resolveRelayUrl({ EXPO_PUBLIC_KANNA_RELAY_URL: "   " })).toBeNull();
  });

  it("creates an app model with desktop navigation and a LAN client", async () => {
    const model = createAppModel("http://desktop.test", createFetchMock());

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
      getIdToken: vi.fn().mockResolvedValue("id-token-1")
    };
    const taskIndex = {
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
      ])
    };

    const model = createAppModel(
      "http://desktop.test",
      createFetchMock(),
      undefined,
      authSession,
      { relayUrl: "wss://relay.example", taskIndex }
    );

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
      getIdToken: vi.fn().mockResolvedValue("id-token-1")
    };
    const taskIndex = {
      listRecentTasks: vi.fn(async () => [])
    };
    const model = createAppModel(
      "http://desktop.test",
      createFetchMock(),
      undefined,
      authSession,
      { relayUrl: "wss://relay.example", taskIndex }
    );

    await expect(model.client.listRecentTasks()).resolves.toEqual([
      expect.objectContaining({ id: "task-1", title: "Refactor mobile shell" }),
      expect.objectContaining({ id: "task-2", title: "Review shell polish" })
    ]);
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
    const model = createAppModel(
      "http://desktop.test",
      createFetchMock(),
      persistence
    );

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
    const model = createAppModel(
      "http://desktop.test",
      createFetchMock(),
      persistence
    );

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
    const model = createAppModel(
      "http://desktop.test",
      createFetchMock(),
      persistence
    );

    await model.initialize();
    await model.controller.selectDesktop("desktop-2");
    await model.controller.selectRepo("repo-2");
    model.controller.openTask("task-2");
    model.controller.showView("more");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persistence.save).toHaveBeenLastCalledWith({
      selectedDesktopId: "desktop-2",
      selectedRepoId: "repo-2",
      selectedTaskId: "task-2",
      activeView: "more",
      authUser: null
    });
  });
});

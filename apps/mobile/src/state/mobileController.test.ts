import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./sessionStore";
import { createMobileController } from "./mobileController";
import type { MobileAuthSession } from "../lib/firebase/auth";
import type {
  KannaClient,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../lib/api/client";

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

function createClientMock(): ClientMock {
  const terminalStream = createTerminalSubscriptionMock();

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
      stage: "in progress"
    }),
    runMergeAgent: vi.fn().mockResolvedValue({
      taskId: "task-merge"
    }),
    advanceTaskStage: vi.fn().mockResolvedValue({
      taskId: "task-pr"
    }),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    closeTask: vi.fn().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn().mockImplementation((_taskId, listener) => {
      terminalStream.subscription.setListener(listener);
      return terminalStream.subscription;
    }),
    createPairingSession: vi.fn().mockResolvedValue({
      code: "ABC123",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      expiresAtUnixMs: 1
    }),
    __terminalStream: terminalStream
  };
}

function createAuthSessionMock(): MobileAuthSession {
  return {
    getState: vi.fn(() => ({ status: "signedOut" })),
    subscribe: vi.fn(() => () => undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null)
  };
}

describe("createMobileController", () => {
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
    store.setComposerState(true, "Ship mobile shell");

    await controller.createTask();

    expect(store.getState().recentTasks[0]).toMatchObject({
      id: "task-3",
      repoId: "repo-2",
      title: "Ship mobile shell"
    });
    expect(store.getState().selectedTaskId).toBe("task-3");
    expect(store.getState().isComposerOpen).toBe(false);
    expect(store.getState().composerPrompt).toBe("");
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
    store.setComposerState(true, "Ship mobile shell");

    await controller.createTask();

    expect(client.createTask).toHaveBeenCalledWith({
      repoId: "repo-2",
      prompt: "Ship mobile shell"
    });
    expect(store.getState()).toMatchObject({
      connectionState: "connected",
      selectedTaskId: "task-3",
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

  it("creates a pairing session and refreshes the desktop state", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.connectLocal();

    expect(client.createPairingSession).toHaveBeenCalledTimes(1);
    expect(store.getState().pairingCode).toBe("ABC123");
    expect(store.getState().connectionState).toBe("connected");
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

  it("opens a task terminal stream and accumulates live output", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    controller.openTask("task-1");
    client.__terminalStream.emit({
      type: "ready",
      taskId: "task-1"
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      text: "First line\n"
    });
    client.__terminalStream.emit({
      type: "output",
      taskId: "task-1",
      text: "Second line"
    });

    expect(client.observeTaskTerminal).toHaveBeenCalledWith(
      "task-1",
      expect.any(Function)
    );
    expect(store.getState()).toMatchObject({
      selectedTaskId: "task-1",
      taskTerminalStatus: "live"
    });
    expect(store.getState().taskTerminalOutput).toContain("First line");
    expect(store.getState().taskTerminalOutput).toContain("Second line");
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

  it("sends task input as a bracketed paste and Claude Kitty enter sequence", async () => {
    const store = createSessionStore();
    const client = createClientMock();
    const controller = createMobileController(client, store);

    await controller.bootstrap();
    await controller.sendTaskInput("task-1", "continue");

    expect(client.sendTaskInput).toHaveBeenCalledWith(
      "task-1",
      "\x1b[200~continue\x1b[201~\x1b[13u"
    );
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
}

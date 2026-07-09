import { describe, expect, it, vi } from "vitest";
import {
  createRemoteTransport,
  RemoteTransportError,
  type RemoteDesktopInvoker,
  type RemoteTaskAgentObserver,
  type RemoteTaskInputSender,
  type RemoteTaskTerminalObserver
} from "./remoteTransport";

describe("remote transport", () => {
  it("maps cloud desktop records into the mobile desktop summary shape", async () => {
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-1",
          displayName: "Studio Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "both",
          lastSeenAt: "2026-05-08T12:00:00.000Z"
        },
        {
          desktopId: "desktop-2",
          displayName: "Travel Mac",
          online: false,
          reachableViaRelay: false,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop: async () => ({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
    });

    await expect(transport.listDesktops()).resolves.toEqual([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "both",
        lastSeenAt: "2026-05-08T12:00:00.000Z"
      },
      {
        id: "desktop-2",
        name: "Travel Mac",
        online: false,
        mode: "remote",
        reachableViaRelay: false,
        connectionMode: "internet",
        lastSeenAt: null
      }
    ]);
  });

  it("fetches minimal status for the selected desktop through the remote invocation envelope", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "10.0.0.2",
      lanPort: 48120,
      pairingCode: null
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await expect(transport.getStatus()).resolves.toEqual({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "10.0.0.2",
      lanPort: 48120,
      pairingCode: null
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/status",
      body: null
    });
  });

  it("throws a typed error when status is requested without a selected desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>();
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop
    });

    await expect(transport.getStatus()).rejects.toMatchObject({
      code: "no_selected_desktop",
      message: "Select a desktop before connecting remotely."
    });
    await expect(transport.getStatus()).rejects.toBeInstanceOf(RemoteTransportError);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("wraps remote invocation failures with a typed displayable error", async () => {
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-offline",
      invokeDesktop: async () => {
        throw new Error("relay unavailable");
      }
    });

    await expect(transport.getStatus()).rejects.toMatchObject({
      code: "remote_invocation_failed",
      message: "Remote desktop request failed: relay unavailable"
    });
  });

  it("calls shared mobile API routes for remote task collections and actions", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>()
      .mockResolvedValueOnce([{ id: "repo-1", name: "Repo One" }])
      .mockResolvedValueOnce([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Remote task",
          stage: "in progress",
          snippet: "remote output"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-repo-1",
          repoId: "repo-1",
          title: "Repo task",
          stage: "pr"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "task-search-1",
          repoId: "repo-1",
          title: "Search task",
          stage: "in progress"
        }
      ])
      .mockResolvedValueOnce({
        taskId: "task-created",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress"
      })
      .mockResolvedValueOnce({ taskId: "task-merge" })
      .mockResolvedValueOnce({ taskId: "task-pr" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await expect(transport.listRepos()).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
    await expect(transport.listRecentTasks()).resolves.toEqual([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Remote task",
        stage: "in progress",
        snippet: "remote output"
      }
    ]);
    await expect(transport.listRepoTasks("repo-1")).resolves.toEqual([
      {
        id: "task-repo-1",
        repoId: "repo-1",
        title: "Repo task",
        stage: "pr"
      }
    ]);
    await expect(transport.searchTasks("remote prompt")).resolves.toEqual([
      {
        id: "task-search-1",
        repoId: "repo-1",
        title: "Search task",
        stage: "in progress"
      }
    ]);
    await expect(
      transport.createTask({
        repoId: "repo-1",
        prompt: "Ship it"
      })
    ).resolves.toEqual({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    await expect(transport.runMergeAgent("task-1")).resolves.toEqual({
      taskId: "task-merge"
    });
    await expect(transport.advanceTaskStage("task-1")).resolves.toEqual({
      taskId: "task-pr"
    });
    await expect(transport.closeTask("task-1")).resolves.toBeUndefined();
    await expect(transport.sendTaskInput("task-1", "continue")).resolves.toBeUndefined();

    expect(invokeDesktop).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/tasks/recent",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(3, {
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/repos/repo-1/tasks",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(4, {
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/tasks/search?query=remote%20prompt",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(5, {
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-1",
        prompt: "Ship it"
      }
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(6, {
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task-1/actions/run-merge-agent",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(7, {
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task-1/actions/advance-stage",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(8, {
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task-1/actions/close",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(9, {
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task-1/input",
      body: { input: "continue" }
    });
  });

  it("uses the cloud task index for recent tasks when provided", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>();
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress"
        }
      ]
    });

    await expect(transport.listRecentTasks()).resolves.toEqual([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress"
      }
    ]);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("creates tasks on an explicit desktop without forwarding the routing field", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await expect(
      transport.createTask({
        repoId: "repo-1",
        prompt: "Ship it",
        desktopId: "desktop-2",
        agentProvider: "codex"
      })
    ).resolves.toEqual({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-2",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-1",
        prompt: "Ship it",
        agentProvider: "codex"
      }
    });
  });

  it("keeps Firestore cloud tasks visible even when the owner desktop recent-task relay is stale", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue([
      {
        id: "local-task-open",
        repoId: "repo-1",
        title: "Still open",
        stage: "in progress"
      }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "repo-1:local-task-stale",
          repoId: "repo-1",
          repoName: "Repo One",
          title: "Closed but stale",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-stale",
          ownerOnline: true
        },
        {
          id: "repo-1:local-task-open",
          repoId: "repo-1",
          repoName: "Repo One",
          title: "Still open",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-open",
          ownerOnline: true
        }
      ]
    });

    await expect(transport.listRecentTasks()).resolves.toEqual([
      {
        id: "repo-1:local-task-stale",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Closed but stale",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-stale",
        ownerOnline: true
      },
      {
        id: "repo-1:local-task-open",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Still open",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-open",
        ownerOnline: true
      }
    ]);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("creates cloud-indexed repo tasks on the repo owner desktop without a selected desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud:desktop-owner:repo-1:task-existing",
          repoId: "repo-1",
          repoName: "Repo One",
          title: "Existing task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "task-existing"
        }
      ]
    });

    await expect(
      transport.createTask({
        repoId: "repo-1",
        prompt: "Ship it",
        agentProvider: "claude"
      })
    ).resolves.toEqual({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-1",
        prompt: "Ship it",
        agentProvider: "claude"
      }
    });
  });

  it("routes cloud task actions to the owner desktop and local task id", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const subscription = { close: vi.fn() };
    const observeTaskTerminal = vi.fn<RemoteTaskTerminalObserver>(() => subscription);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      observeTaskTerminal,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-1",
          ownerOnline: true
        }
      ]
    });
    const listener = vi.fn();

    await transport.listRecentTasks();
    invokeDesktop.mockClear();
    expect(transport.observeTaskTerminal("cloud-task-1", listener)).toBe(subscription);
    await expect(transport.sendTaskInput("cloud-task-1", "continue")).resolves.toBeUndefined();
    await expect(transport.closeTask("cloud-task-1")).resolves.toBeUndefined();
    await expect(transport.runMergeAgent("cloud-task-1")).resolves.toBeNull();
    await expect(transport.advanceTaskStage("cloud-task-1")).resolves.toBeNull();

    expect(observeTaskTerminal).toHaveBeenCalledWith(
      {
        desktopId: "desktop-owner",
        taskId: "local-task-1"
      },
      listener
    );
    expect(invokeDesktop).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/input",
      body: { input: "continue" }
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/close",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(3, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/run-merge-agent",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(4, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/advance-stage",
      body: null
    });
  });

  it("sends cloud task input through the owner terminal command channel", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const sendTaskInput = vi.fn<RemoteTaskInputSender>().mockResolvedValue(undefined);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      sendTaskInput,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-1",
          ownerOnline: true
        }
      ]
    });

    await transport.listRecentTasks();
    invokeDesktop.mockClear();
    await expect(transport.sendTaskInput("cloud-task-1", "continue\n")).resolves.toBeUndefined();

    expect(sendTaskInput).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "local-task-1",
      data: "continue\n"
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/tasks/local-task-1/input"
      })
    );
  });

  it("resolves a cloud task route before observing an uncached terminal", async () => {
    const subscription = { close: vi.fn() };
    const observeTaskTerminal = vi.fn<RemoteTaskTerminalObserver>(() => subscription);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop: async () => null,
      observeTaskTerminal,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-1",
          ownerOnline: true
        }
      ]
    });
    const listener = vi.fn();

    const returnedSubscription = transport.observeTaskTerminal("cloud-task-1", listener);
    await vi.waitFor(() => {
      expect(observeTaskTerminal).toHaveBeenCalledWith(
        {
          desktopId: "desktop-owner",
          taskId: "local-task-1"
        },
        listener
      );
    });

    returnedSubscription.close();
    expect(subscription.close).toHaveBeenCalled();
  });

  it("resolves a cloud task route before observing an uncached agent stream", async () => {
    const subscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskAgent = vi.fn<RemoteTaskAgentObserver>(() => subscription);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop: async () => null,
      observeTaskAgent,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-1",
          ownerOnline: true
        }
      ]
    });
    const listener = vi.fn();

    const returnedSubscription = transport.observeTaskAgent("cloud-task-1", listener);
    await vi.waitFor(() => {
      expect(observeTaskAgent).toHaveBeenCalledWith(
        {
          desktopId: "desktop-owner",
          taskId: "local-task-1"
        },
        listener
      );
    });

    returnedSubscription.close();
    expect(subscription.close).toHaveBeenCalled();
  });

  it("serves cloud status and repo task collections without selecting a desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>();
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          repoName: "Repo One",
          title: "Cloud task",
          stage: "in progress"
        }
      ]
    });

    await expect(transport.getStatus()).resolves.toMatchObject({
      desktopId: "cloud",
      desktopName: "Kanna Cloud",
      lanHost: "cloud"
    });
    await expect(transport.listRepos()).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
    await expect(transport.listRepoTasks("repo-1")).resolves.toEqual([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        repoName: "Repo One",
        title: "Cloud task",
        stage: "in progress"
      }
    ]);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("delegates remote terminal observation to the relay observer dependency", () => {
    const subscription = { close: vi.fn() };
    const observeTaskTerminal = vi.fn<RemoteTaskTerminalObserver>(() => subscription);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop: async () => null,
      observeTaskTerminal
    });
    const listener = vi.fn();

    expect(transport.observeTaskTerminal("task-1", listener)).toBe(subscription);

    expect(observeTaskTerminal).toHaveBeenCalledWith(
      {
        desktopId: "desktop-1",
        taskId: "task-1"
      },
      listener
    );
  });

  it("delegates remote agent observation to the relay stream observer dependency", () => {
    const subscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskAgent = vi.fn<RemoteTaskAgentObserver>(() => subscription);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop: async () => null,
      observeTaskAgent
    });
    const listener = vi.fn();

    expect(transport.observeTaskAgent("task-1", listener)).toBe(subscription);

    expect(observeTaskAgent).toHaveBeenCalledWith(
      {
        desktopId: "desktop-1",
        taskId: "task-1"
      },
      listener
    );
  });
});

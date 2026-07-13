import { describe, expect, it, vi } from "vitest";
import {
  createRemoteTransport,
  RemoteTransportError,
  type RemoteDesktopInvoker,
  type RemoteTaskAgentObserver,
  type RemoteTaskTerminalObserver
} from "./remoteTransport";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("remote transport", () => {
  it("posts mark-read to the selected remote desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task/read",
      activity: "idle"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await expect(transport.markTaskRead("task/read")).resolves.toEqual({
      taskId: "task/read",
      activity: "idle"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task%2Fread/actions/mark-read",
      body: null
    });
  });

  it("routes cloud mark-read to the owner desktop and local task id", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "local-task-1",
      activity: "idle"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [{
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }]
    });

    await expect(transport.markTaskRead("cloud-task-1")).resolves.toEqual({
      taskId: "local-task-1",
      activity: "idle"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/mark-read",
      body: null
    });
  });

  it("refreshes a cached cloud route before marking a task read", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "local-task-b",
      activity: "idle"
    });
    let cloudTasks = [{
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Cloud task",
      stage: "in progress",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "local-task-a",
      ownerOnline: true
    }];
    const listCloudTasks = vi.fn(async () => cloudTasks);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks
    });
    await transport.listRecentTasks();
    cloudTasks = [{
      ...cloudTasks[0],
      ownerDesktopId: "desktop-b",
      ownerLocalTaskId: "local-task-b"
    }];

    await transport.markTaskRead("cloud-task-1");

    expect(listCloudTasks).toHaveBeenCalledTimes(2);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-b",
      method: "POST",
      path: "/v1/tasks/local-task-b/actions/mark-read",
      body: null
    });
  });

  it("falls back to the selected desktop when a cached cloud route disappears", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "cloud-task-1",
      activity: "idle"
    });
    let cloudTasks = [{
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Cloud task",
      stage: "in progress",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "local-task-a",
      ownerOnline: true
    }];
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected",
      invokeDesktop,
      listCloudTasks: async () => cloudTasks
    });
    await transport.listRecentTasks();
    cloudTasks = [];

    await transport.markTaskRead("cloud-task-1");

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected",
      method: "POST",
      path: "/v1/tasks/cloud-task-1/actions/mark-read",
      body: null
    });
  });

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

  it("removes omitted cloud task routes when a fresh snapshot replaces the index", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const listCloudTasks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-old-owner",
          ownerLocalTaskId: "local-task-old"
        }
      ])
      .mockResolvedValue([]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected",
      invokeDesktop,
      listCloudTasks
    });

    await transport.listRecentTasks();
    await transport.listRecentTasks();
    await transport.closeTask("cloud-task-1");

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected",
      method: "POST",
      path: "/v1/tasks/cloud-task-1/actions/close",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-old-owner",
        path: "/v1/tasks/local-task-old/actions/close"
      })
    );
  });

  it("replaces a cloud task route when a fresh snapshot changes its owner", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const listCloudTasks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-old-owner",
          ownerLocalTaskId: "local-task-old"
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "cloud-task-1",
          repoId: "repo-1",
          title: "Cloud task",
          stage: "review",
          ownerDesktopId: "desktop-new-owner",
          ownerLocalTaskId: "local-task-new"
        }
      ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected",
      invokeDesktop,
      listCloudTasks
    });

    expect(JSON.parse(transport.getTaskRouteIdentity!("cloud-task-1"))).toEqual([
      "remote",
      "desktop-selected",
      "cloud-task-1"
    ]);
    await transport.listRecentTasks();
    expect(JSON.parse(transport.getTaskRouteIdentity!("cloud-task-1"))).toEqual([
      "remote",
      "desktop-old-owner",
      "local-task-old"
    ]);
    await transport.listRecentTasks();
    expect(JSON.parse(transport.getTaskRouteIdentity!("cloud-task-1"))).toEqual([
      "remote",
      "desktop-new-owner",
      "local-task-new"
    ]);
    await transport.advanceTaskStage("cloud-task-1");

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-new-owner",
      method: "POST",
      path: "/v1/tasks/local-task-new/actions/advance-stage",
      body: null
    });
  });

  it("keeps the newest requested cloud route when an older resolver finishes last", async () => {
    const olderTasks = deferred<
      Array<{
        id: string;
        repoId: string;
        title: string;
        stage: string;
        ownerDesktopId: string;
        ownerLocalTaskId: string;
      }>
    >();
    const newerTasks = deferred<
      Array<{
        id: string;
        repoId: string;
        title: string;
        stage: string;
        ownerDesktopId: string;
        ownerLocalTaskId: string;
      }>
    >();
    const listCloudTasks = vi
      .fn()
      .mockReturnValueOnce(olderTasks.promise)
      .mockReturnValueOnce(newerTasks.promise);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks
    });

    const pendingOlderAction = transport.closeTask("cloud-task-1");
    const pendingNewerList = transport.listRecentTasks();

    newerTasks.resolve([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "New owner",
        stage: "review",
        ownerDesktopId: "desktop-new-owner",
        ownerLocalTaskId: "local-task-new"
      }
    ]);
    await pendingNewerList;
    olderTasks.resolve([
      {
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Old owner",
        stage: "in progress",
        ownerDesktopId: "desktop-old-owner",
        ownerLocalTaskId: "local-task-old"
      }
    ]);
    await pendingOlderAction;

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-new-owner",
      method: "POST",
      path: "/v1/tasks/local-task-new/actions/close",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-old-owner",
        path: "/v1/tasks/local-task-old/actions/close"
      })
    );
  });

  it("searches a fresh cloud snapshot without invoking a selected desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>();
    const listCloudTasks = vi.fn().mockResolvedValue([
      {
        id: "cloud-title-match",
        repoId: "repo-1",
        title: "Needle in title",
        stage: "in progress"
      },
      {
        id: "cloud-snippet-match",
        repoId: "repo-2",
        title: "Other task",
        stage: "review",
        snippet: "Contains NEEDLE in output"
      },
      {
        id: "cloud-no-match",
        repoId: "repo-3",
        title: "Unrelated task",
        stage: "pr",
        snippet: "Nothing relevant"
      }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks
    });

    await expect(transport.searchTasks("nEeDlE")).resolves.toEqual([
      {
        id: "cloud-title-match",
        repoId: "repo-1",
        title: "Needle in title",
        stage: "in progress"
      },
      {
        id: "cloud-snippet-match",
        repoId: "repo-2",
        title: "Other task",
        stage: "review",
        snippet: "Contains NEEDLE in output"
      }
    ]);
    expect(listCloudTasks).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("maps a cloud repo to its owner-local repo on an explicit desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-local",
      title: "Ship it",
      stage: "in progress"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-existing",
          repoId: "repo-cloud",
          title: "Existing task",
          stage: "in progress",
          ownerDesktopId: "desktop-2",
          ownerLocalRepoId: "repo-local",
          ownerLocalTaskId: "task-existing"
        }
      ]
    });

    await expect(
      transport.createTask({
        repoId: "repo-cloud",
        prompt: "Ship it",
        desktopId: "desktop-2",
        agentProvider: "codex"
      })
    ).resolves.toEqual({
      taskId: "cloud:desktop-2:repo-local:task-created",
      repoId: "repo-cloud",
      title: "Ship it",
      stage: "in progress",
      ownerDesktopId: "desktop-2",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-created"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-2",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-local",
        prompt: "Ship it",
        agentProvider: "codex"
      }
    });
  });

  it("falls back to the selected desktop when a cloud repo has no owner mapping", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-cloud",
      title: "Ship it",
      stage: "in progress"
    });
    const listCloudTasks = vi.fn().mockResolvedValue([
      {
        id: "other-desktop-task",
        repoId: "repo-1",
        title: "Other desktop task",
        stage: "in progress",
        ownerDesktopId: "desktop-other",
        ownerLocalRepoId: "repo-local-other",
        ownerLocalTaskId: "task-other"
      }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected",
      invokeDesktop,
      listCloudTasks
    });

    await expect(
      transport.createTask({
        repoId: "repo-cloud",
        prompt: "Ship it",
        agentProvider: "codex"
      })
    ).resolves.toEqual({
      taskId: "task-created",
      repoId: "repo-cloud",
      title: "Ship it",
      stage: "in progress"
    });
    expect(listCloudTasks).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-cloud",
        prompt: "Ship it",
        agentProvider: "codex"
      }
    });
  });

  it("routes an explicitly targeted created task before its cloud snapshot arrives", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Ship it",
            stage: "in progress"
          }
        : null
    );
    const terminalSubscription = { close: vi.fn() };
    const agentSubscription = {
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    };
    const observeTaskTerminal = vi.fn<RemoteTaskTerminalObserver>(
      () => terminalSubscription
    );
    const observeTaskAgent = vi.fn<RemoteTaskAgentObserver>(
      () => agentSubscription
    );
    const listCloudTasks = vi.fn().mockResolvedValue([]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      observeTaskTerminal,
      observeTaskAgent,
      listCloudTasks
    });

    const created = await transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    expect(created.taskId).toBe(
      "cloud:desktop-created-here:repo-1:task-created"
    );
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-1",
        prompt: "Ship it",
        agentProvider: "codex"
      }
    });
    invokeDesktop.mockClear();
    const listener = vi.fn();

    transport.observeTaskTerminal(created.taskId, listener);
    transport.observeTaskAgent(created.taskId, listener);
    await transport.sendTaskInput(created.taskId, "continue");
    await transport.advanceTaskStage(created.taskId);

    const createdRoute = {
      desktopId: "desktop-created-here",
      taskId: "task-created"
    };
    expect(observeTaskTerminal).toHaveBeenCalledWith(createdRoute, listener);
    expect(observeTaskAgent).toHaveBeenCalledWith(createdRoute, listener);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks/task-created/input",
      body: { input: "continue" }
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks/task-created/actions/advance-stage",
      body: null
    });
    expect(listCloudTasks).toHaveBeenCalledTimes(1);
  });

  it("preserves a created task route across absent and obsolete cloud snapshots", async () => {
    const olderTasks = deferred<
      Array<{
        id: string;
        repoId: string;
        title: string;
        stage: string;
        ownerDesktopId: string;
        ownerLocalTaskId: string;
      }>
    >();
    const listCloudTasks = vi
      .fn()
      .mockReturnValueOnce(olderTasks.promise)
      .mockResolvedValue([]);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Ship it",
            stage: "in progress"
          }
        : null
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks
    });

    const pendingOlderSnapshot = transport.listRecentTasks();
    const created = await transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    await transport.listRecentTasks();
    olderTasks.resolve([
      {
        id: "task-created",
        repoId: "repo-1",
        title: "Obsolete owner",
        stage: "in progress",
        ownerDesktopId: "desktop-obsolete",
        ownerLocalTaskId: "task-obsolete"
      }
    ]);
    await pendingOlderSnapshot;
    invokeDesktop.mockClear();

    await transport.advanceTaskStage(created.taskId);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks/task-created/actions/advance-stage",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-selected-elsewhere" })
    );
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-obsolete" })
    );
  });

  it("replaces a provisional created route with its canonical cloud route", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Ship it",
            stage: "in progress"
          }
        : null
    );
    const listCloudTasks = vi.fn().mockResolvedValue([
      {
        id: "cloud:desktop-created-here:repo-1:task-created",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress",
        ownerDesktopId: "desktop-created-here",
        ownerLocalTaskId: "task-created"
      }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks
    });

    const created = await transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    await transport.listRecentTasks();
    invokeDesktop.mockClear();

    await transport.advanceTaskStage(created.taskId);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks/task-created/actions/advance-stage",
      body: null
    });
  });

  it("retires a provisional alias when its explicit cloud identity is published", async () => {
    let cloudTasks: Array<{
      id: string;
      repoId: string;
      title: string;
      stage: string;
      ownerDesktopId: string;
      ownerLocalRepoId: string;
      ownerLocalTaskId: string;
    }> = [
      {
        id: "existing-cloud-task",
        repoId: "repo-cloud",
        title: "Existing task",
        stage: "in progress",
        ownerDesktopId: "desktop-created-here",
        ownerLocalRepoId: "repo-local",
        ownerLocalTaskId: "task-existing"
      }
    ];
    const listCloudTasks = vi.fn(async () => cloudTasks);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-local",
            title: "Ship it",
            stage: "in progress"
          }
        : { taskId: "task-created" }
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks
    });

    const created = await transport.createTask({
      repoId: "repo-cloud",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    cloudTasks = [
      {
        id: "explicit-cloud-task-id",
        repoId: "repo-cloud",
        title: "Ship it",
        stage: "in progress",
        ownerDesktopId: "desktop-created-here",
        ownerLocalRepoId: "repo-local",
        ownerLocalTaskId: "task-created"
      }
    ];
    await transport.listRecentTasks();
    invokeDesktop.mockClear();

    await transport.advanceTaskStage(created.taskId);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected-elsewhere",
      method: "POST",
      path:
        "/v1/tasks/cloud%3Adesktop-created-here%3Arepo-local%3Atask-created/actions/advance-stage",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-created-here" })
    );
  });

  it("retires a created task route after successfully closing it", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Ship it",
            stage: "in progress"
          }
        : null
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks: async () => []
    });

    const created = await transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    await transport.closeTask(created.taskId);
    invokeDesktop.mockClear();

    await transport.advanceTaskStage(created.taskId);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected-elsewhere",
      method: "POST",
      path:
        "/v1/tasks/cloud%3Adesktop-created-here%3Arepo-1%3Atask-created/actions/advance-stage",
      body: null
    });
  });

  it("retires a created task alias when its canonical identity is closed", async () => {
    const cloudTaskId = "cloud:desktop-created-here:repo-1:task-created";
    const listCloudTasks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: cloudTaskId,
          repoId: "repo-1",
          title: "Ship it",
          stage: "in progress",
          ownerDesktopId: "desktop-created-here",
          ownerLocalTaskId: "task-created"
        }
      ])
      .mockResolvedValue([]);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-1",
            title: "Ship it",
            stage: "in progress"
          }
        : null
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks
    });

    await transport.listRecentTasks();
    await transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-created-here",
      agentProvider: "codex"
    });
    await transport.closeTask(cloudTaskId);
    invokeDesktop.mockClear();

    await transport.advanceTaskStage("task-created");

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected-elsewhere",
      method: "POST",
      path: "/v1/tasks/task-created/actions/advance-stage",
      body: null
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
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/tasks"
        ? {
            taskId: "task-created",
            repoId: "repo-local",
            title: "Ship it",
            stage: "in progress"
          }
        : { taskId: "task-created" }
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-existing",
          repoId: "repo-cloud",
          repoName: "Repo One",
          title: "Existing task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-local",
          ownerLocalTaskId: "task-existing"
        }
      ]
    });

    const created = await transport.createTask({
      repoId: "repo-cloud",
      prompt: "Ship it",
      agentProvider: "claude"
    });
    expect(created).toEqual({
      taskId: "cloud:desktop-owner:repo-local:task-created",
      repoId: "repo-cloud",
      title: "Ship it",
      stage: "in progress",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-created"
    });
    await expect(
      transport.advanceTaskStage(created.taskId)
    ).resolves.toEqual({
      taskId: "cloud:desktop-owner:repo-local:task-created"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-local",
        prompt: "Ship it",
        agentProvider: "claude"
      }
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/task-created/actions/advance-stage",
      body: null
    });
  });

  it("creates on the latest accepted repo owner when an older owner read finishes last", async () => {
    const olderTasks = deferred<
      Array<{
        id: string;
        repoId: string;
        title: string;
        stage: string;
        ownerDesktopId: string;
        ownerLocalRepoId: string;
        ownerLocalTaskId: string;
      }>
    >();
    const newerTasks = deferred<
      Array<{
        id: string;
        repoId: string;
        title: string;
        stage: string;
        ownerDesktopId: string;
        ownerLocalRepoId: string;
        ownerLocalTaskId: string;
      }>
    >();
    const listCloudTasks = vi
      .fn()
      .mockReturnValueOnce(olderTasks.promise)
      .mockReturnValueOnce(newerTasks.promise);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-local-new",
      title: "Ship it",
      stage: "in progress"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks
    });

    const pendingCreate = transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      agentProvider: "claude"
    });
    const pendingNewerList = transport.listRecentTasks();

    newerTasks.resolve([
      {
        id: "cloud:new-owner:repo-1:task-existing",
        repoId: "repo-1",
        title: "New owner task",
        stage: "review",
        ownerDesktopId: "desktop-new-owner",
        ownerLocalRepoId: "repo-local-new",
        ownerLocalTaskId: "task-new-owner"
      }
    ]);
    await pendingNewerList;
    olderTasks.resolve([
      {
        id: "cloud:old-owner:repo-1:task-existing",
        repoId: "repo-1",
        title: "Old owner task",
        stage: "in progress",
        ownerDesktopId: "desktop-old-owner",
        ownerLocalRepoId: "repo-local-old",
        ownerLocalTaskId: "task-old-owner"
      }
    ]);
    await pendingCreate;

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-new-owner",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-local-new",
        prompt: "Ship it",
        agentProvider: "claude"
      }
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-old-owner" })
    );
  });

  it("routes cloud task actions to the owner desktop and local task id", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockImplementation(
      async ({ path }) =>
        path.endsWith("/actions/run-merge-agent")
          ? { taskId: "local-task-1", followTask: true }
          : path.endsWith("/actions/advance-stage")
            ? { taskId: "local-task-1" }
            : null
    );
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
    await expect(transport.runMergeAgent("cloud-task-1")).resolves.toEqual({
      taskId: "cloud-task-1",
      followTask: true
    });
    await expect(transport.advanceTaskStage("cloud-task-1")).resolves.toEqual({
      taskId: "cloud-task-1"
    });

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

  it("canonicalizes a genuinely new action response on the same owner desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/tasks/recent") {
        return [
          {
            id: "local-next",
            repoId: "repo-local",
            title: "Next task",
            stage: "merge",
            agentType: "agent"
          }
        ];
      }
      return { taskId: "local-next" };
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-cloud",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-local",
          ownerLocalTaskId: "local-task-1",
          ownerOnline: true
        }
      ]
    });
    await transport.listRecentTasks();

    const canonicalNextTaskId =
      "cloud:desktop-owner:repo-local:local-next";
    await expect(transport.advanceTaskStage("cloud-task-1")).resolves.toEqual({
      taskId: canonicalNextTaskId,
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "local-next",
      task: {
        id: canonicalNextTaskId,
        repoId: "repo-cloud",
        title: "Next task",
        stage: "merge",
        agentType: "agent"
      }
    });
    await transport.advanceTaskStage(canonicalNextTaskId);

    expect(invokeDesktop).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/advance-stage",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/tasks/recent",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(3, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-next/actions/advance-stage",
      body: null
    });
  });

  it("keeps a canonical action route when exact metadata lookup rejects", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/tasks/recent") {
        throw new Error("recent tasks unavailable");
      }
      return { taskId: "local-next" };
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "repo-cloud",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-local",
          ownerLocalTaskId: "local-task-1"
        }
      ]
    });
    await transport.listRecentTasks();

    const canonicalNextTaskId =
      "cloud:desktop-owner:repo-local:local-next";
    await expect(transport.advanceTaskStage("cloud-task-1")).resolves.toEqual({
      taskId: canonicalNextTaskId,
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "local-next"
    });
    await transport.advanceTaskStage(canonicalNextTaskId);

    expect(invokeDesktop).toHaveBeenLastCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-next/actions/advance-stage",
      body: null
    });
  });

  it("routes cloud task input through the owner server submission endpoint", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
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
    await expect(transport.sendTaskInput("cloud-task-1", "1")).resolves.toBeUndefined();

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/input",
      body: { input: "1" }
    });
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

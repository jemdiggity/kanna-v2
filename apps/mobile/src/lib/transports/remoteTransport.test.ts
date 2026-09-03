import { describe, expect, it, vi } from "vitest";
import { RepoNotRegisteredError } from "../api/client";
import {
  createRemoteTransport,
  RemoteTransportError,
  type RemoteDesktopInvoker,
  type RemoteTaskAgentObserver,
  type RemoteTaskCompanionObserver,
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
  it("routes missing-session recovery through the task owner over the relay", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "local-task-1"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [{
        id: "cloud-task-1",
        repoId: "cloud-repo-1",
        title: "Recover me",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "local-repo-1",
        ownerLocalTaskId: "local-task-1"
      }]
    });

    await expect(transport.resumeTask?.("cloud-task-1")).resolves.toEqual({
      taskId: "cloud-task-1"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/resume",
      body: null
    });
  });

  it("propagates an advance-stage conflict from the owning desktop without retrying", async () => {
    const held = new RemoteTransportError(
      "remote_invocation_failed",
      "Remote desktop request failed (409): stage conflict"
    );
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockRejectedValue(held);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await expect(transport.advanceTaskStage("task-1")).rejects.toBe(held);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      method: "POST",
      path: "/v1/tasks/task-1/actions/advance-stage",
      body: { source: "operator" }
    });
  });

  it("routes repository command catalog and runs through the owning desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>()
      .mockResolvedValueOnce({
        repoId: "local-repo-1",
        revision: "catalog-v1",
        commands: []
      })
      .mockResolvedValueOnce({ taskId: "local-command-task", reused: false });
    const listCloudTasks = vi.fn(async () => [{
      id: "cloud-task-1",
      repoId: "cloud-repo-1",
      title: "Cloud task",
      stage: "in progress",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "local-repo-1",
      ownerLocalTaskId: "local-task-1",
      ownerOnline: true
    }]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks
    });

    await expect(transport.listRepoCommands("cloud-repo-1")).resolves.toEqual({
      repoId: "cloud-repo-1",
      revision: "catalog-v1",
      commands: []
    });
    await expect(
      transport.runRepoCommand(
        "cloud-repo-1",
        "factory:create-agent",
        "catalog-v1"
      )
    ).resolves.toMatchObject({
      reused: false,
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "local-repo-1",
      ownerLocalTaskId: "local-command-task"
    });

    expect(invokeDesktop).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/repos/local-repo-1/commands",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/repos/local-repo-1/commands/factory%3Acreate-agent/run",
      body: { catalogRevision: "catalog-v1" }
    });
  });

  it("resolves an uncached cloud companion route without queueing selections", async () => {
    const subscription = { close: vi.fn(), sendEvent: vi.fn(() => true) };
    let remoteListener: ((event: any) => void) | undefined;
    const observeTaskCompanion = vi.fn<RemoteTaskCompanionObserver>((_route, listener) => {
      remoteListener = listener;
      return subscription;
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop: async () => null,
      observeTaskCompanion,
      listCloudTasks: async () => [{
        id: "cloud-task-1",
        repoId: "repo-1",
        title: "Cloud task",
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1"
      }]
    });
    const listener = vi.fn();
    const returned = transport.observeTaskCompanion("cloud-task-1", listener);
    const event = {
      event_id: "event-1",
      type: "click" as const,
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    };
    expect(returned.sendEvent("123-456", "rev-1", event)).toBe(false);

    await vi.waitFor(() =>
      expect(observeTaskCompanion).toHaveBeenCalledWith(
        { desktopId: "desktop-owner", taskId: "local-task-1" },
        expect.any(Function)
      )
    );
    expect(subscription.sendEvent).not.toHaveBeenCalled();
    expect(returned.sendEvent("123-456", "rev-1", event)).toBe(true);
    expect(subscription.sendEvent).toHaveBeenCalledWith("123-456", "rev-1", event);
    remoteListener?.({ type: "unavailable", taskId: "local-task-1" });
    expect(listener).toHaveBeenCalledWith({
      type: "unavailable",
      taskId: "cloud-task-1"
    });
    returned.close();
    expect(subscription.close).toHaveBeenCalled();
  });

  it("routes cloud task file reads to the owner desktop and encoded local task id", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      path: "docs/spec one.md",
      content: "# Spec"
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
        ownerLocalTaskId: "local/task-1",
        ownerOnline: true
      }]
    });

    await expect(
      transport.readTaskFile("cloud-task-1", "docs/spec one.md")
    ).resolves.toEqual({
      path: "docs/spec one.md",
      content: "# Spec"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/tasks/local%2Ftask-1/files/content?path=docs%2Fspec%20one.md",
      body: null
    });
  });

  it("routes mentioned-file resolution to the owner desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      mentions: [{
        path: "TaskScreen.tsx",
        line: 42,
        matches: [{ path: "apps/mobile/src/screens/TaskScreen.tsx" }],
        truncated: false
      }]
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
        ownerLocalTaskId: "local/task-1",
        ownerOnline: true
      }]
    });

    await transport.resolveTaskFileMentions("cloud-task-1", [
      { path: "TaskScreen.tsx", line: 42 }
    ]);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local%2Ftask-1/files/resolve-mentions",
      body: { mentions: [{ path: "TaskScreen.tsx", line: 42 }] }
    });
  });

  it("routes cloud task diff reads to the owner desktop and encoded local task id", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "local/task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "diff --git a/x b/x",
      truncated: false
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
        ownerLocalTaskId: "local/task-1",
        ownerOnline: true
      }]
    });

    await expect(transport.readTaskDiff("cloud-task-1")).resolves.toEqual({
      taskId: "local/task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "diff --git a/x b/x",
      truncated: false
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/tasks/local%2Ftask-1/diff",
      body: null
    });
  });

  it("reads task files from the selected desktop when no cloud route exists", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      path: "README.md",
      content: "Read me"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected",
      invokeDesktop
    });

    await expect(
      transport.readTaskFile("task/read", "README.md")
    ).resolves.toEqual({
      path: "README.md",
      content: "Read me"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-selected",
      method: "GET",
      path: "/v1/tasks/task%2Fread/files/content?path=README.md",
      body: null
    });
  });

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

  it("routes revision-fenced dismissal to the cloud task owner", async () => {
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
        activity: "unread",
        activityRevision: 12,
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }]
    });

    await transport.markTaskRead("cloud-task-1", 12);

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/actions/mark-read",
      body: { expectedActivityRevision: 12 }
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
          lastSeenAt: "2026-05-08T12:00:00.000Z",
          agentProviders: ["opencode"]
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
        lastSeenAt: "2026-05-08T12:00:00.000Z",
        agentProviders: ["opencode"]
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

  it("preserves canonical status identity through the remote invocation envelope", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      version: "0.0.69-staging.1",
      environment: "staging",
      serverVersion: "0.0.69-staging.1",
      writePathHealth: {
        healthy: true,
        status: "healthy",
        activeWorkspaceCommands: 0,
        maxWorkspaceCommands: 4,
        longRunningWorkspaceCommands: 0,
        oldestWorkspaceCommandSeconds: null
      },
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
      version: "0.0.69-staging.1",
      environment: "staging",
      serverVersion: "0.0.69-staging.1",
      writePathHealth: {
        healthy: true,
        status: "healthy",
        activeWorkspaceCommands: 0,
        maxWorkspaceCommands: 4,
        longRunningWorkspaceCommands: 0,
        oldestWorkspaceCommandSeconds: null
      },
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

  it("parses status from legacy desktops that omit writePathHealth", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      version: "0.0.68",
      environment: "production",
      serverVersion: "0.0.68",
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
      version: "0.0.68",
      environment: "production",
      serverVersion: "0.0.68",
      lanHost: "10.0.0.2",
      lanPort: 48120,
      pairingCode: null
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
          waitingPromptSnippet: "remote output"
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
      .mockResolvedValueOnce({ taskId: "task-1" })
      .mockResolvedValueOnce({ taskId: "task-1" })
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
        waitingPromptSnippet: "remote output"
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
    await expect(transport.sendTaskInput("task-1", "continue")).resolves.toEqual({
      status: "delivered"
    });

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
      body: { source: "operator" }
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
      body: { source: "operator" }
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
        waitingPromptSnippet: "Contains NEEDLE in output"
      },
      {
        id: "cloud-no-match",
        repoId: "repo-3",
        title: "Unrelated task",
        stage: "pr",
        waitingPromptSnippet: "Nothing relevant"
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
        waitingPromptSnippet: "Contains NEEDLE in output"
      }
    ]);
    expect(listCloudTasks).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  it("maps a cloud repo to its owner-local repo on an explicit desktop", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/repos"
        ? [{ id: "repo-local", name: "Cloud Repo" }]
        : {
            taskId: "task-created",
            repoId: "repo-local",
            title: "Ship it",
            stage: "in progress"
          }
    );
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

  it("puts an identified task through the selected desktop without the identity in the body", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      taskId: "a1b2/c3d4",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await transport.createTask({
      taskId: "a1b2/c3d4",
      repoId: "repo-1",
      prompt: "Ship it"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      method: "PUT",
      path: "/v1/tasks/a1b2%2Fc3d4",
      body: {
        repoId: "repo-1",
        prompt: "Ship it"
      }
    });
  });

  it("never downgrades a present but invalid task identity to legacy POST", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockRejectedValue(
      new Error("route not found")
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    await expect(transport.createTask({
      taskId: "",
      repoId: "repo-1",
      prompt: "Ship it"
    })).rejects.toThrow("route not found");

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      method: "PUT",
      path: "/v1/tasks/",
      body: {
        repoId: "repo-1",
        prompt: "Ship it"
      }
    });
  });

  it("preserves an identified task while mapping a cloud repo to its owner", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/repos"
        ? [{ id: "repo-local", name: "Cloud Repo" }]
        : {
            taskId: "a1b2c3d4",
            repoId: "repo-local",
            title: "Ship it",
            stage: "in progress"
          }
    );
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

    await expect(transport.createTask({
      taskId: "a1b2c3d4",
      repoId: "repo-cloud",
      prompt: "Ship it",
      desktopId: "desktop-2",
      agentProvider: "codex"
    })).resolves.toMatchObject({
      taskId: "cloud:desktop-2:repo-local:a1b2c3d4",
      ownerLocalTaskId: "a1b2c3d4"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-2",
      method: "PUT",
      path: "/v1/tasks/a1b2c3d4",
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
      request.path === "/v1/repos"
        ? [{ id: "repo-1", name: "Repo One" }]
        : request.path === "/v1/tasks"
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
      agentProvider: "codex",
      terminalCols: 80,
      terminalRows: 48
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
        agentProvider: "codex",
        terminalCols: 80,
        terminalRows: 48
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
      body: { source: "operator" }
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
      request.path === "/v1/repos"
        ? [{ id: "repo-1", name: "Repo One" }]
        : request.path === "/v1/tasks"
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
      body: { source: "operator" }
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
      request.path === "/v1/repos"
        ? [{ id: "repo-1", name: "Repo One" }]
        : request.path === "/v1/tasks"
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
      body: { source: "operator" }
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
      request.path === "/v1/repos"
        ? [{ id: "repo-local", name: "Cloud Repo" }]
        : request.path === "/v1/tasks"
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
      body: { source: "operator" }
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-created-here" })
    );
  });

  it("retires a created task route after successfully closing it", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) =>
      request.path === "/v1/repos"
        ? [{ id: "repo-1", name: "Repo One" }]
        : request.path === "/v1/tasks"
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
      body: { source: "operator" }
    });
  });

  it("routes creation abort to the frozen desktop without a published task route", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue(null);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-selected-elsewhere",
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await transport.abortTaskCreation({
      taskId: "a1b2c3d4",
      desktopId: "desktop-created-here"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-created-here",
      method: "POST",
      path: "/v1/tasks/a1b2c3d4/actions/abort-creation",
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
      request.path === "/v1/repos"
        ? [{ id: "repo-1", name: "Repo One" }]
        : request.path === "/v1/tasks"
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
      body: { source: "operator" }
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
      body: { source: "operator" }
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
    await expect(transport.sendTaskInput("cloud-task-1", "continue")).resolves.toEqual({
      status: "delivered"
    });
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
      body: { source: "operator" }
    });
  });

  it("loads full cloud task detail from the routed owner desktop without widening the cloud summary", async () => {
    const fullPrompt = `${"p".repeat(520)}END-OF-CANONICAL-PROMPT`;
    const cloudPromptSnippet = fullPrompt.slice(0, 500);
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (
        request.method === "GET" &&
        request.path === "/v1/tasks/local-task-1"
      ) {
        return {
          id: "local-task-1",
          repoId: "local-repo-1",
          title: "Long cloud task",
          prompt: fullPrompt,
          stage: "in progress"
        };
      }
      throw new Error(`Unexpected remote invocation: ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [{
        id: "cloud-task-1",
        repoId: "cloud-repo-1",
        title: "Long cloud task",
        prompt: cloudPromptSnippet,
        stage: "in progress",
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "local-repo-1",
        ownerLocalTaskId: "local-task-1",
        ownerOnline: true
      }]
    });

    const published = await transport.listRecentTasks();
    expect(published[0]?.prompt).toHaveLength(500);
    expect(published[0]?.prompt).not.toContain("END-OF-CANONICAL-PROMPT");
    await expect(transport.getTask?.("cloud-task-1")).resolves.toEqual(
      expect.objectContaining({
        id: "cloud-task-1",
        repoId: "cloud-repo-1",
        prompt: fullPrompt,
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "local-repo-1",
        ownerLocalTaskId: "local-task-1"
      })
    );
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/tasks/local-task-1",
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
      body: { source: "operator" }
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
      body: { source: "operator" }
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
      body: { source: "operator" }
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
    await expect(transport.sendTaskInput("cloud-task-1", "1")).resolves.toEqual({
      status: "delivered"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/input",
      body: { input: "1" }
    });
  });

  it("carries the attachment capability marker through the relayed status", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      version: "0.0.69",
      environment: "production",
      serverVersion: "0.0.69",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null,
      taskInputAttachmentVersion: 1
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    // The relayed status is rebuilt field by field, so a capability dropped
    // here would make every relay-connected desktop read as too old.
    await expect(transport.getStatus()).resolves.toMatchObject({
      taskInputAttachmentVersion: 1
    });
  });

  it("reports no attachment capability for a desktop that predates it", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      version: "0.0.60",
      environment: "production",
      serverVersion: "0.0.60",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => "desktop-1",
      invokeDesktop
    });

    const status = await transport.getStatus();

    // Absent, not false: that older desktop would accept the attachment field,
    // ignore it, and still answer 204.
    expect(status.taskInputAttachmentVersion).toBeUndefined();
    expect("taskInputAttachmentVersion" in status).toBe(false);
  });

  it("asks the task's owner desktop about attachments, not the synthetic cloud status", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-owner",
      desktopName: "Studio Mac",
      version: "0.0.69",
      environment: "production",
      serverVersion: "0.0.69",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null,
      taskInputAttachmentVersion: 1
    });
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

    await expect(
      transport.supportsTaskInputAttachments("cloud-task-1")
    ).resolves.toBe(true);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/status",
      body: null
    });

    // And `getStatus()` on this same transport is the synthetic cloud record
    // that carries no marker — which is exactly why the capability must not be
    // read from it.
    await expect(transport.getStatus()).resolves.toMatchObject({
      desktopId: "cloud"
    });
    expect(
      (await transport.getStatus()).taskInputAttachmentVersion
    ).toBeUndefined();
  });

  it("carries a photo attachment to the owner desktop in the same relayed body", async () => {
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
    await expect(
      transport.sendTaskInput("cloud-task-1", "look at this", {
        fileName: "IMG_4821.jpg",
        mediaType: "image/jpeg",
        dataBase64: "AQID"
      })
    ).resolves.toEqual({ status: "delivered" });

    // The relay tunnels a desktop invocation as JSON, so the image travels
    // base64-in-body — the same shape the LAN transport posts.
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks/local-task-1/input",
      body: {
        input: "look at this",
        attachment: {
          fileName: "IMG_4821.jpg",
          mediaType: "image/jpeg",
          dataBase64: "AQID"
        }
      }
    });
  });

  it("resolves a cloud task route before observing an uncached terminal", async () => {
    const subscription = {
      close: vi.fn(),
      resize: vi.fn(),
      sendInput: vi.fn()
    };
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
    returnedSubscription.resize?.(80, 48);
    returnedSubscription.sendInput?.("aGVsbG8=");
    await vi.waitFor(() => {
      expect(observeTaskTerminal).toHaveBeenCalledWith(
        {
          desktopId: "desktop-owner",
          taskId: "local-task-1"
        },
        listener
      );
    });
    expect(subscription.resize).toHaveBeenCalledWith(80, 48);
    expect(subscription.sendInput).toHaveBeenCalledWith("aGVsbG8=");

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

  it("includes task-less repos from reachable desktops in cloud repo listings", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue([
      { id: "local-repo-1", name: "Repo One" },
      { id: "repo-empty", name: "Fresh Repo" }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        },
        {
          desktopId: "desktop-offline",
          displayName: "Offline Mac",
          online: false,
          reachableViaRelay: false,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-1",
          repoId: "local-repo-1",
          repoName: "Repo One",
          title: "Cloud task",
          stage: "in progress",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "local-task-1"
        }
      ]
    });

    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "local-repo-1",
        name: "Repo One",
        registeredDesktopIds: ["desktop-owner"]
      },
      {
        id: "repo-empty",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);

    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
  });

  it("merges the same repository from two desktops by remote url hash", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return request.desktopId === "desktop-a"
          ? [{ id: "repo-a", name: "kanna", remoteUrlHash: "hash-kanna" }]
          : [{ id: "repo-b", name: "kanna", remoteUrlHash: "hash-kanna" }];
      }
      if (request.method === "POST" && request.path === "/v1/tasks") {
        return {
          taskId: "local-task-created",
          repoId: (request.body as { repoId: string }).repoId,
          title: "Created",
          stage: "in progress"
        };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-a",
          displayName: "Mac A",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        },
        {
          desktopId: "desktop-b",
          displayName: "Mac B",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "git:hash-kanna",
        name: "kanna",
        remoteUrlHash: "hash-kanna",
        registeredDesktopIds: ["desktop-a", "desktop-b"]
      }
    ]);
    invokeDesktop.mockClear();

    // Creating a task under the canonical repo id targets the requested
    // desktop's own local repo id.
    const created = await transport.createTask({
      repoId: "git:hash-kanna",
      prompt: "Fix bug",
      desktopId: "desktop-b"
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-b",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-b",
      method: "POST",
      path: "/v1/tasks",
      body: { prompt: "Fix bug", repoId: "repo-b" }
    });
    expect(created).toMatchObject({
      taskId: "cloud:desktop-b:repo-b:local-task-created",
      repoId: "git:hash-kanna",
      ownerDesktopId: "desktop-b",
      ownerLocalRepoId: "repo-b",
      ownerLocalTaskId: "local-task-created"
    });
  });

  it("rejects a stale task-snapshot repo removed from the requested desktop without creating", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return request.desktopId === "desktop-macbook"
          ? [
              {
                id: "repo-macbook",
                name: "kanji-kongbu",
                remoteUrlHash: "hash-kanji"
              }
            ]
          : [{ id: "repo-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }];
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-macbook",
          displayName: "MacBook Pro",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        },
        {
          desktopId: "desktop-studio",
          displayName: "Mac Studio",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud:desktop-studio:repo-studio:task-old",
          repoId: "git:hash-kanji",
          repoName: "kanji-kongbu",
          title: "Old kanji task",
          stage: "in progress",
          ownerDesktopId: "desktop-studio",
          ownerLocalRepoId: "repo-studio",
          ownerLocalTaskId: "task-old"
        }
      ]
    });

    await transport.listRepos();
    invokeDesktop.mockClear();

    const creation = transport.createTask({
      repoId: "git:hash-kanji",
      prompt: "Study kanji",
      desktopId: "desktop-studio"
    });

    await expect(creation).rejects.toEqual(
      new RepoNotRegisteredError("kanji-kongbu", "Mac Studio")
    );
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-studio",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" })
    );
  });

  it("runs a repo command on its current inventory owner instead of a stale task owner", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return request.desktopId === "desktop-macbook"
          ? [{
              id: "repo-macbook",
              name: "kanji-kongbu",
              remoteUrlHash: "hash-kanji"
            }]
          : [{ id: "repo-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }];
      }
      if (
        request.desktopId === "desktop-macbook" &&
        request.method === "GET" &&
        request.path === "/v1/repos/repo-macbook/commands"
      ) {
        return {
          repoId: "repo-macbook",
          revision: "catalog-v1",
          commands: []
        };
      }
      if (
        request.desktopId === "desktop-macbook" &&
        request.method === "POST" &&
        request.path === "/v1/repos/repo-macbook/commands/custom%3Atask-manager/run"
      ) {
        return { taskId: "task-manager", reused: false };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-macbook",
          displayName: "MacBook Pro",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        },
        {
          desktopId: "desktop-studio",
          displayName: "Mac Studio",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => "desktop-studio",
      invokeDesktop,
      listCloudTasks: async () => [{
        id: "cloud:desktop-studio:repo-old:task-old",
        repoId: "git:hash-kanji",
        repoName: "kanji-kongbu",
        title: "Old kanji task",
        stage: "in progress",
        ownerDesktopId: "desktop-studio",
        ownerLocalRepoId: "repo-old",
        ownerLocalTaskId: "task-old"
      }]
    });

    await transport.listRepos();
    invokeDesktop.mockClear();
    await transport.listRepoCommands("git:hash-kanji");
    await transport.runRepoCommand(
      "git:hash-kanji",
      "custom:task-manager",
      "catalog-v1"
    );

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-macbook",
      method: "POST",
      path: "/v1/repos/repo-macbook/commands/custom%3Atask-manager/run",
      body: { catalogRevision: "catalog-v1" }
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-studio" })
    );
  });

  it("loads a command-created task from the desktop that launched it when two desktops share a repo", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return request.desktopId === "desktop-macbook"
          ? [{
              id: "repo-aminiti",
              name: "aminiti",
              remoteUrlHash: "hash-aminiti"
            }]
          : [{
              id: "repo-aminiti-2",
              name: "aminiti-2",
              remoteUrlHash: "hash-aminiti"
            }];
      }
      if (
        request.desktopId === "desktop-studio" &&
        request.method === "POST" &&
        request.path === "/v1/repos/repo-aminiti-2/commands/custom%3Atask-manager/run"
      ) {
        return {
          taskId: "task-manager",
          reused: false,
          ownerDesktopId: "desktop-studio",
          ownerLocalRepoId: "repo-aminiti-2",
          ownerLocalTaskId: "task-manager"
        };
      }
      if (
        request.desktopId === "desktop-studio" &&
        request.method === "GET" &&
        request.path === "/v1/tasks/task-manager"
      ) {
        return {
          id: "task-manager",
          repoId: "repo-aminiti-2",
          title: "Kanna Task Manager",
          stage: "in progress"
        };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-macbook",
          displayName: "MacBook",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        },
        {
          desktopId: "desktop-studio",
          displayName: "Mac Studio",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await transport.listRepos();
    const launch = await transport.runRepoCommand(
      "git:hash-aminiti",
      "custom:task-manager",
      "catalog-v1"
    );
    const task = await transport.getTask?.(launch.taskId);

    expect(launch).toMatchObject({
      ownerDesktopId: "desktop-studio",
      ownerLocalRepoId: "repo-aminiti-2",
      ownerLocalTaskId: "task-manager"
    });
    expect(task).toMatchObject({
      id: launch.taskId,
      ownerDesktopId: "desktop-studio",
      ownerLocalRepoId: "repo-aminiti-2",
      ownerLocalTaskId: "task-manager"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-studio",
      method: "GET",
      path: "/v1/tasks/task-manager",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: "desktop-macbook",
        path: "/v1/tasks/task-manager"
      })
    );
  });

  it("rejects a requested-desktop snapshot without an owner-local repo id after a fresh read", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return [];
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-studio",
          displayName: "Mac Studio",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [
        {
          id: "cloud-task-old",
          repoId: "git:hash-kanji",
          repoName: "kanji-kongbu",
          title: "Old kanji task",
          stage: "in progress",
          ownerDesktopId: "desktop-studio",
          ownerLocalTaskId: "task-old"
        }
      ]
    });

    await expect(
      transport.createTask({
        repoId: "git:hash-kanji",
        prompt: "Study kanji",
        desktopId: "desktop-studio"
      })
    ).rejects.toEqual(
      new RepoNotRegisteredError("kanji-kongbu", "Mac Studio")
    );
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-studio",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
    expect(invokeDesktop).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" })
    );
  });

  it("lists tasks from both machines under the canonical repo id and routes through the owner", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.method === "GET" && request.path === "/v1/repos") {
        return [];
      }
      if (request.method === "POST" && request.path === "/v1/tasks") {
        return {
          taskId: "local-task-created",
          repoId: (request.body as { repoId: string }).repoId,
          title: "Created",
          stage: "in progress"
        };
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });
    const taskOnA = {
      id: "cloud:desktop-a:repo-a:local-task-a",
      repoId: "git:hash-kanna",
      repoName: "kanna",
      title: "Task on machine A",
      stage: "in progress",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-a",
      ownerLocalTaskId: "local-task-a"
    };
    const taskOnB = {
      id: "cloud:desktop-b:repo-b:local-task-b",
      repoId: "git:hash-kanna",
      repoName: "kanna",
      title: "Task on machine B",
      stage: "in progress",
      ownerDesktopId: "desktop-b",
      ownerLocalRepoId: "repo-b",
      ownerLocalTaskId: "local-task-b"
    };
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [taskOnA, taskOnB]
    });

    await expect(transport.listRepoTasks("git:hash-kanna")).resolves.toEqual([
      taskOnA,
      taskOnB
    ]);

    await transport.createTask({
      repoId: "git:hash-kanna",
      prompt: "Fix bug"
    });
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-a",
      method: "POST",
      path: "/v1/tasks",
      body: { prompt: "Fix bug", repoId: "repo-a" }
    });
  });

  it("reuses the desktop repo snapshot within the refresh interval", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue([
      {
        id: "repo-empty",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "repo-empty",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);
    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "repo-empty",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);

    expect(invokeDesktop).toHaveBeenCalledTimes(1);
  });

  it("fetches repos from a desktop that becomes reachable after the first listing", async () => {
    let online = false;
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>().mockResolvedValue([
      { id: "repo-empty", name: "Fresh Repo" }
    ]);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online,
          reachableViaRelay: online,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await expect(transport.listRepos()).resolves.toEqual([]);
    expect(invokeDesktop).not.toHaveBeenCalled();

    online = true;
    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "repo-empty",
        name: "Fresh Repo",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
  });

  it("queries a newly reachable desktop while another desktop's repo read hangs", async () => {
    const records = [
      {
        desktopId: "desktop-hung",
        displayName: "Hung Mac",
        online: true,
        reachableViaRelay: true,
        connectionMode: "internet" as const
      }
    ];
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>((request) => {
      if (request.desktopId === "desktop-hung") {
        return new Promise(() => {});
      }
      return Promise.resolve([{ id: "repo-healthy", name: "Healthy Repo" }]);
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => records,
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => [],
      desktopRepoWaitMs: 20
    });

    await expect(transport.listRepos()).resolves.toEqual([]);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);

    records.push({
      desktopId: "desktop-healthy",
      displayName: "Healthy Mac",
      online: true,
      reachableViaRelay: true,
      connectionMode: "internet" as const
    });

    await expect(transport.listRepos()).resolves.toEqual([
      {
        id: "repo-healthy",
        name: "Healthy Repo",
        registeredDesktopIds: ["desktop-healthy"]
      }
    ]);
    expect(invokeDesktop).toHaveBeenCalledTimes(2);
    expect(invokeDesktop).toHaveBeenLastCalledWith({
      desktopId: "desktop-healthy",
      method: "GET",
      path: "/v1/repos",
      body: null
    });
  });

  it("routes task creation for a task-less repo to the desktop that owns it", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(async (request) => {
      if (request.path === "/v1/repos") {
        return [{ id: "repo-empty", name: "Fresh Repo" }];
      }
      return { taskId: "local-task-9" };
    });
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
      getSelectedDesktopId: () => null,
      invokeDesktop,
      listCloudTasks: async () => []
    });

    await expect(
      transport.createTask({ repoId: "repo-empty", prompt: "Ship it" })
    ).resolves.toMatchObject({
      taskId: "cloud:desktop-owner:repo-empty:local-task-9",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-empty",
      ownerLocalTaskId: "local-task-9"
    });

    expect(invokeDesktop).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      method: "POST",
      path: "/v1/tasks",
      body: {
        repoId: "repo-empty",
        prompt: "Ship it"
      }
    });
  });

  it("keeps task-derived repos when desktop repo reads fail", async () => {
    const invokeDesktop = vi
      .fn<RemoteDesktopInvoker>()
      .mockRejectedValue(new Error("desktop unreachable"));
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
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

    await expect(transport.listRepos()).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
  });

  it("answers repo listings without waiting for a hung desktop repo read", async () => {
    const invokeDesktop = vi.fn<RemoteDesktopInvoker>(
      () => new Promise(() => {})
    );
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: "desktop-owner",
          displayName: "Owner Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet"
        }
      ],
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
      ],
      desktopRepoWaitMs: 5
    });

    await expect(transport.listRepos()).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
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
      lanHost: "cloud",
      writePathHealth: {
        healthy: true,
        status: "healthy",
        activeWorkspaceCommands: 0,
        maxWorkspaceCommands: 0,
        longRunningWorkspaceCommands: 0,
        oldestWorkspaceCommandSeconds: null
      }
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

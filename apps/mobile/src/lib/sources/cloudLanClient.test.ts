import { describe, expect, it, vi } from "vitest";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskCompanionSubscription,
  TaskTerminalSubscription
} from "../api/client";
import { RepoNotRegisteredError } from "../api/client";
import type {
  DesktopSummary,
  MobileServerStatus,
  TaskSummary
} from "../api/types";
import {
  createCloudLanClient,
  mergeCloudAndLanTasks
} from "./cloudLanClient";

function runningStatus(desktopId = "desktop-lan"): MobileServerStatus {
  return {
    state: "running",
    desktopId,
    desktopName: "LAN Desktop",
    version: "test",
    environment: "test",
    serverVersion: "test",
    lanHost: "192.168.1.10",
    lanPort: 48120,
    pairingCode: null,
    writePathHealth: {
      healthy: true,
      status: "healthy",
      activeWorkspaceCommands: 0,
      maxWorkspaceCommands: 4,
      longRunningWorkspaceCommands: 0,
      oldestWorkspaceCommandSeconds: null
    }
  };
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    repoId: "repo-1",
    title: "Task",
    stage: "in progress",
    ...overrides
  };
}

function agentSubscription(): TaskAgentSubscription {
  return {
    close: vi.fn(),
    sendInput: vi.fn(),
    sendPermission: vi.fn(),
    interrupt: vi.fn()
  };
}

function companionSubscription(): TaskCompanionSubscription {
  return { close: vi.fn(), sendEvent: vi.fn() };
}

function createClientMock(overrides: Partial<KannaClient> = {}): KannaClient {
  return {
    getStatus: vi.fn().mockResolvedValue(runningStatus()),
    listDesktops: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
    listRepoTasks: vi.fn().mockResolvedValue([]),
    listRepoCommands: vi.fn().mockResolvedValue({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: []
    }),
    runRepoCommand: vi.fn().mockResolvedValue({
      taskId: "task-command",
      reused: false
    }),
    listRecentTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockImplementation(async (taskId: string) => ({
      ...task({ id: taskId }),
      prompt: "Full canonical prompt"
    })),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({
      taskId: "task-created",
      repoId: "repo-1",
      title: "Created",
      stage: "in progress"
    }),
    runMergeAgent: vi.fn().mockResolvedValue({ taskId: "task-merge" }),
    advanceTaskStage: vi.fn().mockResolvedValue({ taskId: "task-advanced" }),
    markTaskRead: vi.fn().mockResolvedValue({ taskId: "task-1", activity: "idle" }),
    pinTask: vi.fn().mockResolvedValue(undefined),
    unpinTask: vi.fn().mockResolvedValue(undefined),
    abortTaskCreation: vi.fn().mockResolvedValue(undefined),
    closeTask: vi.fn().mockResolvedValue(undefined),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    readTaskFile: vi.fn().mockResolvedValue({
      path: "docs/spec.md",
      content: "# Spec"
    }),
    resolveTaskFileMentions: vi.fn().mockResolvedValue({
      mentions: []
    }),
    readTaskDiff: vi.fn().mockResolvedValue({
      taskId: "task-1",
      baseRef: "main",
      mergeBase: "abc123",
      patch: "diff --git a/x b/x",
      truncated: false
    }),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskAgent: vi.fn(() => agentSubscription()),
    observeTaskCompanion: vi.fn(() => companionSubscription()),
    ...overrides
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("mergeCloudAndLanTasks", () => {
  it("keeps cloud identity and metadata while applying LAN mutable fields and routing", () => {
    const cloudTask = {
      ...task({
      id: "cloud-X",
      repoId: "cloud-repo",
      repoName: "Cloud Repo",
      title: "Cloud title",
      stage: "review",
      waitingPromptSnippet: "cloud snippet",
      agentProvider: "claude",
      agentType: "pty",
      activity: "unread",
      activityRevision: 4,
      pinned: false,
      pinOrder: null,
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-task",
      ownerOnline: false
      }),
      prompt: "Cloud prompt snippet"
    };
    const lanTask = {
      ...task({
      id: "local-task",
      repoId: "local-repo",
      repoName: "LAN Repo",
      title: "LAN title",
      stage: "pr",
      waitingPromptSnippet: "LAN snippet",
      agentProvider: "codex",
      agentType: "agent",
      activity: "idle",
      activityRevision: 5,
      pinned: true,
      pinOrder: 3
      }),
      prompt:
        "First line of the canonical task prompt.\nSecond line.\nPROMPT_END_SENTINEL"
    };

    const result = mergeCloudAndLanTasks({
      cloudTasks: [cloudTask],
      lan: { desktopId: "desktop-lan", tasks: [lanTask] }
    });

    expect(result.tasks).toEqual([
      {
        ...cloudTask,
        title: "LAN title",
        prompt:
          "First line of the canonical task prompt.\nSecond line.\nPROMPT_END_SENTINEL",
        stage: "pr",
        waitingPromptSnippet: "LAN snippet",
        agentType: "agent",
        activity: "idle",
        activityRevision: 5,
        pinned: true,
        pinOrder: 3
      }
    ]);
    expect(result.routes.get("cloud-X")).toEqual({
      source: "lan",
      taskId: "local-task",
      desktopId: "desktop-lan",
      cloudFallbackTaskId: "cloud-X"
    });
  });

  it("prefers the LAN parent task id, including a null detachment", () => {
    const cloudTask = task({
      id: "cloud-X",
      repoId: "cloud-repo",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-task"
    });

    const nested = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, parentTaskId: null }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          {
            ...task({ id: "local-task", repoId: "local-repo" }),
            parentTaskId: "local-parent"
          }
        ]
      }
    });
    expect(nested.tasks[0]?.parentTaskId).toBe("local-parent");

    const detached = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, parentTaskId: "local-parent" }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          {
            ...task({ id: "local-task", repoId: "local-repo" }),
            parentTaskId: null
          }
        ]
      }
    });
    expect(detached.tasks[0]?.parentTaskId).toBeNull();

    const legacyLan = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, parentTaskId: "local-parent" }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [task({ id: "local-task", repoId: "local-repo" })]
      }
    });
    expect(legacyLan.tasks[0]?.parentTaskId).toBe("local-parent");
  });

  it("prefers the LAN blocker list, including an empty resolution", () => {
    const cloudTask = task({
      id: "cloud-X",
      repoId: "cloud-repo",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-task"
    });

    const blocked = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, blockedByTaskIds: [] }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          {
            ...task({ id: "local-task", repoId: "local-repo" }),
            blockedByTaskIds: ["local-blocker"]
          }
        ]
      }
    });
    expect(blocked.tasks[0]?.blockedByTaskIds).toEqual(["local-blocker"]);

    const unblocked = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, blockedByTaskIds: ["local-blocker"] }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          {
            ...task({ id: "local-task", repoId: "local-repo" }),
            blockedByTaskIds: []
          }
        ]
      }
    });
    expect(unblocked.tasks[0]?.blockedByTaskIds).toEqual([]);

    const legacyLan = mergeCloudAndLanTasks({
      cloudTasks: [{ ...cloudTask, blockedByTaskIds: ["local-blocker"] }],
      lan: {
        desktopId: "desktop-lan",
        tasks: [task({ id: "local-task", repoId: "local-repo" })]
      }
    });
    expect(legacyLan.tasks[0]?.blockedByTaskIds).toEqual(["local-blocker"]);
  });

  it("does not deduplicate the same local task id from another desktop", () => {
    const result = mergeCloudAndLanTasks({
      cloudTasks: [
        task({
          id: "cloud-X",
          ownerDesktopId: "desktop-other",
          ownerLocalTaskId: "shared-local-id"
        })
      ],
      lan: {
        desktopId: "desktop-lan",
        tasks: [task({ id: "shared-local-id", title: "LAN task" })]
      }
    });

    expect(result.tasks.map(({ id }) => id)).toEqual([
      "cloud-X",
      "shared-local-id"
    ]);
    expect(result.routes.get("cloud-X")).toEqual({
      source: "cloud",
      taskId: "cloud-X"
    });
    expect(result.routes.get("shared-local-id")).toEqual({
      source: "lan",
      taskId: "shared-local-id",
      desktopId: "desktop-lan"
    });
  });

  it("requires the owner-local repository id to match when cloud supplies it", () => {
    const result = mergeCloudAndLanTasks({
      cloudTasks: [
        task({
          id: "cloud-X",
          repoId: "cloud-repo",
          ownerDesktopId: "desktop-lan",
          ownerLocalRepoId: "expected-local-repo",
          ownerLocalTaskId: "local-task"
        })
      ],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          task({
            id: "local-task",
            repoId: "different-local-repo",
            title: "Different task"
          })
        ]
      }
    });

    expect(result.tasks.map(({ id }) => id)).toEqual(["local-task"]);
    expect(result.routes.has("cloud-X")).toBe(false);
  });

  it("preserves cloud order, replaces duplicates in place, and appends unused LAN tasks", () => {
    const result = mergeCloudAndLanTasks({
      cloudTasks: [
        task({
          id: "cloud-duplicate",
          repoId: "cloud-repo",
          ownerDesktopId: "desktop-lan",
          ownerLocalRepoId: "local-repo",
          ownerLocalTaskId: "local-duplicate"
        }),
        task({
          id: "cloud-only",
          repoId: "cloud-only-repo",
          ownerDesktopId: "desktop-other",
          ownerLocalTaskId: "other-local-task"
        })
      ],
      lan: {
        desktopId: "desktop-lan",
        tasks: [
          task({
            id: "local-duplicate",
            repoId: "local-repo",
            title: "Fresh duplicate"
          }),
          task({ id: "lan-only", repoId: "lan-repo", title: "LAN only" })
        ]
      }
    });

    expect(result.tasks.map(({ id }) => id)).toEqual([
      "cloud-duplicate",
      "cloud-only",
      "lan-only"
    ]);
    expect(Array.from(result.routes.entries())).toEqual([
      [
        "cloud-duplicate",
        {
          source: "lan",
          taskId: "local-duplicate",
          desktopId: "desktop-lan",
          cloudFallbackTaskId: "cloud-duplicate"
        }
      ],
      ["cloud-only", { source: "cloud", taskId: "cloud-only" }],
      [
        "lan-only",
        { source: "lan", taskId: "lan-only", desktopId: "desktop-lan" }
      ]
    ]);
  });

  it("suppresses stale same-owner cloud rows only after a successful LAN snapshot", () => {
    const cloudTasks = [
      task({
        id: "stale-cloud",
        ownerDesktopId: "desktop-lan",
        ownerLocalTaskId: "closed-local-task"
      }),
      task({
        id: "other-cloud",
        ownerDesktopId: "desktop-other",
        ownerLocalTaskId: "other-task"
      })
    ];

    expect(
      mergeCloudAndLanTasks({
        cloudTasks,
        lan: { desktopId: "desktop-lan", tasks: [] }
      }).tasks.map(({ id }) => id)
    ).toEqual(["other-cloud"]);
    expect(
      mergeCloudAndLanTasks({ cloudTasks, lan: null }).tasks.map(({ id }) => id)
    ).toEqual(["stale-cloud", "other-cloud"]);
  });
});

describe("createCloudLanClient", () => {
  it("routes commands for a taskless LAN repository through its owning desktop", async () => {
    const cloud = createClientMock({
      listRepos: vi.fn().mockResolvedValue([]),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const lan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-owner")),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-empty", name: "Empty repository" }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const ownerLan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-empty", name: "Empty repository" }
      ]),
      listRepoCommands: vi.fn().mockResolvedValue({
        repoId: "repo-empty",
        revision: "catalog-empty-v1",
        commands: []
      }),
      runRepoCommand: vi.fn().mockResolvedValue({
        taskId: "local-command-task",
        reused: false
      })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-owner" ? ownerLan : null
    });

    await expect(client.listRepos()).resolves.toEqual([
      {
        id: "repo-empty",
        name: "Empty repository",
        registeredDesktopIds: ["desktop-owner"]
      }
    ]);
    await expect(client.listRepoCommands("repo-empty")).resolves.toEqual({
      repoId: "repo-empty",
      revision: "catalog-empty-v1",
      commands: []
    });
    await expect(
      client.runRepoCommand(
        "repo-empty",
        "factory:create-agent",
        "catalog-empty-v1"
      )
    ).resolves.toMatchObject({
      taskId: "cloud:desktop-owner:repo-empty:local-command-task",
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "repo-empty",
      ownerLocalTaskId: "local-command-task"
    });
    expect(ownerLan.listRepoCommands).toHaveBeenCalledWith("repo-empty");
    expect(ownerLan.runRepoCommand).toHaveBeenCalledWith(
      "repo-empty",
      "factory:create-agent",
      "catalog-empty-v1"
    );
    expect(cloud.listRepoCommands).not.toHaveBeenCalled();
    expect(cloud.runRepoCommand).not.toHaveBeenCalled();
  });

  it("uses the accepted LAN owner route for repository commands", async () => {
    const cloudTask = task({
      id: "cloud-task",
      repoId: "cloud-repo",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-task"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-task", repoId: "local-repo" })
      ]),
      listRepoCommands: vi.fn().mockResolvedValue({
        repoId: "local-repo",
        revision: "catalog-v1",
        commands: []
      }),
      runRepoCommand: vi.fn().mockResolvedValue({
        taskId: "local-command-task",
        reused: false
      })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    await client.listRecentTasks();

    await expect(client.listRepoCommands("cloud-repo")).resolves.toEqual({
      repoId: "cloud-repo",
      revision: "catalog-v1",
      commands: []
    });
    await expect(
      client.runRepoCommand(
        "cloud-repo",
        "factory:create-agent",
        "catalog-v1"
      )
    ).resolves.toMatchObject({
      reused: false,
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-command-task"
    });
    expect(lan.listRepoCommands).toHaveBeenCalledWith("local-repo");
    expect(lan.runRepoCommand).toHaveBeenCalledWith(
      "local-repo",
      "factory:create-agent",
      "catalog-v1"
    );
    expect(cloud.listRepoCommands).not.toHaveBeenCalled();
  });

  it("retains cloud tasks after a rejected LAN read and returns LAN tasks after a cloud failure", async () => {
    const cloudTask = task({ id: "cloud-only" });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
    });
    const unavailableLan = createClientMock({
      listRecentTasks: vi.fn().mockRejectedValue(new Error("LAN unavailable"))
    });
    const cloudWithUnavailableLan = createCloudLanClient(cloud, unavailableLan, {
      isLanEnabled: () => true
    });

    await expect(cloudWithUnavailableLan.listRecentTasks()).resolves.toEqual([
      cloudTask
    ]);

    const lanTask = task({ id: "lan-only" });
    const unavailableCloud = createClientMock({
      listRecentTasks: vi.fn().mockRejectedValue(new Error("cloud unavailable"))
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([lanTask])
    });
    const cloudFailureClient = createCloudLanClient(unavailableCloud, lan, {
      isLanEnabled: () => true
    });

    await expect(cloudFailureClient.listRecentTasks()).resolves.toEqual([lanTask]);
  });

  it("rejects a recent-task read when both cloud and LAN fail", async () => {
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockRejectedValue(new Error("cloud unavailable"))
    });
    const lan = createClientMock({
      getStatus: vi.fn().mockRejectedValue(new Error("LAN unavailable"))
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listRecentTasks()).rejects.toBeDefined();
  });

  it("returns the last-good merged task snapshot when both sources later fail", async () => {
    const cloudTask = task({
      id: "cloud-cached",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const lanTask = task({ id: "lan-cached" });
    const cloud = createClientMock({
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([cloudTask])
        .mockRejectedValueOnce(new Error("cloud unavailable"))
    });
    const lan = createClientMock({
      getStatus: vi
        .fn<KannaClient["getStatus"]>()
        .mockResolvedValueOnce(runningStatus())
        .mockRejectedValueOnce(new Error("LAN unavailable")),
      listRecentTasks: vi.fn().mockResolvedValueOnce([lanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listRecentTasks()).resolves.toEqual([cloudTask, lanTask]);
    await expect(client.listRecentTasks()).resolves.toEqual([cloudTask, lanTask]);
  });

  it("keeps fresh same-owner cloud tasks when failed LAN contributes cached rows", async () => {
    const newCloudTask = task({
      id: "cloud-new",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "new-local-task"
    });
    const cachedLanTask = task({ id: "old-local-task" });
    const cloud = createClientMock({
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([newCloudTask])
    });
    const lan = createClientMock({
      getStatus: vi
        .fn<KannaClient["getStatus"]>()
        .mockResolvedValueOnce(runningStatus())
        .mockRejectedValueOnce(new Error("LAN unavailable")),
      listRecentTasks: vi.fn().mockResolvedValueOnce([cachedLanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.listRecentTasks()).resolves.toEqual([
      newCloudTask,
      cachedLanTask
    ]);
  });

  it("retains failed cloud rows from cache while fresh LAN replaces its cache", async () => {
    const cachedCloudTask = task({
      id: "cloud-cached",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const firstLanTask = task({ id: "lan-old" });
    const replacementLanTask = task({ id: "lan-new" });
    const cloud = createClientMock({
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([cachedCloudTask])
        .mockRejectedValueOnce(new Error("cloud unavailable"))
    });
    const lan = createClientMock({
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([firstLanTask])
        .mockResolvedValueOnce([replacementLanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.listRecentTasks()).resolves.toEqual([
      cachedCloudTask,
      replacementLanTask
    ]);
  });

  it("treats a successful empty task snapshot as last-good data", async () => {
    const cloud = createClientMock({
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("cloud unavailable"))
    });
    const lan = createClientMock();
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => false
    });

    await expect(client.listRecentTasks()).resolves.toEqual([]);
    await expect(client.listRecentTasks()).resolves.toEqual([]);
  });

  it("returns cloud tasks after the optional LAN wait and defers late LAN routes until the next read", async () => {
    vi.useFakeTimers();
    try {
      const pendingLanStatus = deferred<MobileServerStatus>();
      const cloudTask = task({
        id: "cloud-only",
        ownerDesktopId: "desktop-cloud",
        ownerLocalTaskId: "cloud-local-task"
      });
      const lanTask = task({ id: "lan-only" });
      const cloud = createClientMock({
        listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
      });
      const lan = createClientMock({
        getStatus: vi
          .fn<KannaClient["getStatus"]>()
          .mockReturnValueOnce(pendingLanStatus.promise)
          .mockImplementation(() => new Promise<MobileServerStatus>(() => {})),
        listRecentTasks: vi.fn().mockResolvedValue([lanTask])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      let firstReadSettled = false;
      const firstRead = client.listRecentTasks().then((tasks) => {
        firstReadSettled = true;
        return tasks;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(firstReadSettled).toBe(true);
      await expect(firstRead).resolves.toEqual([cloudTask]);

      pendingLanStatus.resolve(runningStatus());
      await vi.advanceTimersByTimeAsync(0);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(1);

      await client.closeTask("lan-only");
      expect(cloud.closeTask).toHaveBeenCalledWith("lan-only");
      expect(lan.closeTask).not.toHaveBeenCalled();

      const secondRead = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      await expect(secondRead).resolves.toEqual([cloudTask, lanTask]);

      await client.closeTask("lan-only");
      expect(lan.closeTask).toHaveBeenCalledWith("lan-only");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("expires LAN routability when the optional task read times out", async () => {
    vi.useFakeTimers();
    try {
      const cloudTask = task({ id: "cloud-only" });
      const cloud = createClientMock({
        listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
      });
      const lan = createClientMock({
        getStatus: vi.fn(() => new Promise<MobileServerStatus>(() => {}))
      });
      const onLanReadUnavailable = vi.fn();
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 1_000,
        onLanReadUnavailable
      });

      const result = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(999);
      expect(onLanReadUnavailable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual([cloudTask]);
      expect(onLanReadUnavailable).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shares an unresolved optional LAN task probe across timeout reads and refreshes after settlement", async () => {
    vi.useFakeTimers();
    try {
      const firstLanTasks = deferred<TaskSummary[]>();
      const secondLanTasks = deferred<TaskSummary[]>();
      const cloudTask = task({ id: "cloud-only" });
      const cloud = createClientMock({
        listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
      });
      const lan = createClientMock({
        getStatus: vi.fn().mockResolvedValue(runningStatus()),
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockReturnValueOnce(firstLanTasks.promise)
          .mockReturnValueOnce(secondLanTasks.promise)
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      const firstRead = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      await expect(firstRead).resolves.toEqual([cloudTask]);

      const repeatedRead = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedRead).resolves.toEqual([cloudTask]);
      expect(lan.getStatus).toHaveBeenCalledTimes(1);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(1);

      firstLanTasks.resolve([]);
      await vi.advanceTimersByTimeAsync(0);

      const freshRead = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      await expect(freshRead).resolves.toEqual([cloudTask]);
      expect(lan.getStatus).toHaveBeenCalledTimes(2);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(2);

      const repeatedFreshRead = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedFreshRead).resolves.toEqual([cloudTask]);
      expect(lan.getStatus).toHaveBeenCalledTimes(2);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(2);

      secondLanTasks.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not adopt a shared stale LAN probe as a later authoritative supplement", async () => {
    vi.useFakeTimers();
    try {
      const staleLanTasks = deferred<TaskSummary[]>();
      const freshLanTask = task({ id: "fresh-lan-only" });
      const cloudTask = task({ id: "cloud-only" });
      const cloud = createClientMock({
        listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
      });
      const lan = createClientMock({
        getStatus: vi.fn().mockResolvedValue(runningStatus()),
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockReturnValueOnce(staleLanTasks.promise)
          .mockResolvedValueOnce([freshLanTask])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });
      const staleSupplement = vi.fn();
      const currentSupplement = vi.fn();

      const staleRead = client.listRecentTasksWithSupplement(staleSupplement);
      await vi.advanceTimersByTimeAsync(25);
      await expect(staleRead).resolves.toEqual([cloudTask]);

      await expect(
        client.listRecentTasksWithSupplement(currentSupplement)
      ).resolves.toEqual([cloudTask]);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(1);

      staleLanTasks.resolve([task({ id: "stale-lan-only" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(staleSupplement).not.toHaveBeenCalled();
      expect(currentSupplement).not.toHaveBeenCalled();

      await expect(client.listRecentTasks()).resolves.toEqual([
        cloudTask,
        freshLanTask
      ]);
      expect(lan.listRecentTasks).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a late successful LAN snapshot when the cloud read settles afterward", async () => {
    vi.useFakeTimers();
    try {
      const pendingCloud = deferred<TaskSummary[]>();
      const pendingLan = deferred<TaskSummary[]>();
      const staleCloudTask = task({
        id: "cloud-stale",
        ownerDesktopId: "desktop-lan",
        ownerLocalTaskId: "local-closed"
      });
      const cloud = createClientMock({
        listRecentTasks: vi.fn(() => pendingCloud.promise)
      });
      const lan = createClientMock({
        listRecentTasks: vi.fn(() => pendingLan.promise)
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });
      const onSupplement = vi.fn();

      const read = client.listRecentTasksWithSupplement(onSupplement);
      await vi.advanceTimersByTimeAsync(25);
      pendingLan.resolve([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSupplement).not.toHaveBeenCalled();

      pendingCloud.resolve([staleCloudTask]);
      await expect(read).resolves.toEqual([]);
      expect(onSupplement).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the last-good LAN snapshot and routes when the next probe times out", async () => {
    vi.useFakeTimers();
    try {
      const duplicate = task({
        id: "cloud-duplicate",
        title: "Cloud duplicate",
        ownerDesktopId: "desktop-lan",
        ownerLocalTaskId: "local-duplicate"
      });
      const updatedDuplicate = {
        ...duplicate,
        title: "Newer cloud duplicate"
      };
      const localDuplicate = task({
        id: "local-duplicate",
        title: "Fresh LAN duplicate"
      });
      const lanOnly = task({ id: "lan-only", title: "LAN-only task" });
      const cloud = createClientMock({
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockResolvedValueOnce([duplicate])
          .mockResolvedValueOnce([updatedDuplicate])
      });
      const hangingStatus = new Promise<MobileServerStatus>(() => undefined);
      const lan = createClientMock({
        getStatus: vi
          .fn<KannaClient["getStatus"]>()
          .mockResolvedValueOnce(runningStatus())
          .mockReturnValueOnce(hangingStatus),
        listRecentTasks: vi.fn().mockResolvedValue([localDuplicate, lanOnly])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      await client.listRecentTasks();
      const replacement = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(0);

      await client.sendTaskInput("cloud-duplicate", "during pending probe");
      await client.sendTaskInput("lan-only", "during pending probe");
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "local-duplicate",
        "during pending probe"
      );
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "lan-only",
        "during pending probe"
      );
      expect(cloud.sendTaskInput).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      await expect(replacement).resolves.toEqual([
        {
          ...updatedDuplicate,
          ownerLocalRepoId: localDuplicate.repoId,
          title: localDuplicate.title,
          stage: localDuplicate.stage
        },
        lanOnly
      ]);

      await client.sendTaskInput("cloud-duplicate", "after timed-out probe");
      await client.sendTaskInput("lan-only", "after timed-out probe");
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "local-duplicate",
        "after timed-out probe"
      );
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "lan-only",
        "after timed-out probe"
      );
      expect(cloud.sendTaskInput).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves last-good LAN-backed display ids and routes when cloud membership changes during a timed-out probe", async () => {
    vi.useFakeTimers();
    try {
      const duplicate = task({
        id: "cloud-duplicate",
        title: "Cloud duplicate",
        ownerDesktopId: "desktop-lan",
        ownerLocalTaskId: "local-duplicate"
      });
      const collidingCloudTask = task({
        id: "shared-id",
        title: "Cloud collision",
        ownerDesktopId: "desktop-other",
        ownerLocalTaskId: "other-shared-id"
      });
      const newCloudTask = task({
        id: "cloud-new",
        title: "New cloud task",
        ownerDesktopId: "desktop-other",
        ownerLocalTaskId: "new-local-task"
      });
      const localDuplicate = task({
        id: "local-duplicate",
        title: "LAN duplicate"
      });
      const collidingLanTask = task({
        id: "shared-id",
        title: "LAN collision"
      });
      const cloud = createClientMock({
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockResolvedValueOnce([duplicate, collidingCloudTask])
          .mockResolvedValueOnce([newCloudTask])
      });
      const hangingStatus = new Promise<MobileServerStatus>(() => undefined);
      const lan = createClientMock({
        getStatus: vi
          .fn<KannaClient["getStatus"]>()
          .mockResolvedValueOnce(runningStatus())
          .mockReturnValueOnce(hangingStatus),
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockResolvedValueOnce([localDuplicate, collidingLanTask])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      const initial = await client.listRecentTasks();
      expect(initial.map(({ id }) => id)).toEqual([
        "cloud-duplicate",
        "shared-id",
        "lan:desktop-lan:shared-id"
      ]);

      const replacement = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);
      const tasks = await replacement;

      expect(tasks).toEqual([
        newCloudTask,
        expect.objectContaining({
          id: "cloud-duplicate",
          title: "LAN duplicate"
        }),
        expect.objectContaining({
          id: "lan:desktop-lan:shared-id",
          title: "LAN collision"
        })
      ]);

      await client.sendTaskInput("cloud-duplicate", "duplicate input");
      await client.sendTaskInput(
        "lan:desktop-lan:shared-id",
        "collision input"
      );
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "local-duplicate",
        "duplicate input"
      );
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "shared-id",
        "collision input"
      );
      expect(cloud.sendTaskInput).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a different-repository cloud task when a timed-out probe preserves the old LAN projection", async () => {
    vi.useFakeTimers();
    try {
      const originalDuplicate = task({
        id: "cloud-repo-a",
        repoId: "cloud-repo-a",
        title: "Cloud repo A",
        ownerDesktopId: "desktop-lan",
        ownerLocalRepoId: "local-repo-a",
        ownerLocalTaskId: "shared-local-task"
      });
      const differentRepoCloudTask = task({
        id: "cloud-repo-b",
        repoId: "cloud-repo-b",
        title: "Cloud repo B",
        ownerDesktopId: "desktop-lan",
        ownerLocalRepoId: "local-repo-b",
        ownerLocalTaskId: "shared-local-task"
      });
      const localTask = task({
        id: "shared-local-task",
        repoId: "local-repo-a",
        title: "LAN repo A"
      });
      const cloud = createClientMock({
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockResolvedValueOnce([originalDuplicate])
          .mockResolvedValueOnce([differentRepoCloudTask])
      });
      const hangingStatus = new Promise<MobileServerStatus>(() => undefined);
      const lan = createClientMock({
        getStatus: vi
          .fn<KannaClient["getStatus"]>()
          .mockResolvedValueOnce(runningStatus())
          .mockReturnValueOnce(hangingStatus),
        listRecentTasks: vi.fn().mockResolvedValueOnce([localTask])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      await expect(client.listRecentTasks()).resolves.toEqual([
        expect.objectContaining({
          id: "cloud-repo-a",
          title: "LAN repo A"
        })
      ]);

      const replacement = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);

      await expect(replacement).resolves.toEqual([
        differentRepoCloudTask,
        expect.objectContaining({
          id: "cloud-repo-a",
          title: "LAN repo A"
        })
      ]);

      await client.sendTaskInput("cloud-repo-a", "use preserved LAN route");
      await client.sendTaskInput("cloud-repo-b", "use fresh cloud route");
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "shared-local-task",
        "use preserved LAN route"
      );
      expect(cloud.sendTaskInput).toHaveBeenCalledWith(
        "cloud-repo-b",
        "use fresh cloud route"
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("matches an enriched owner repository to a preserved LAN projection after a timed-out probe", async () => {
    vi.useFakeTimers();
    try {
      const duplicateWithoutOwnerRepo = task({
        id: "cloud-duplicate",
        repoId: "cloud-repo",
        title: "Cloud duplicate",
        ownerDesktopId: "desktop-lan",
        ownerLocalTaskId: "local-duplicate"
      });
      const enrichedDuplicate = {
        ...duplicateWithoutOwnerRepo,
        ownerLocalRepoId: "local-repo"
      };
      const localDuplicate = task({
        id: "local-duplicate",
        repoId: "local-repo",
        title: "LAN duplicate"
      });
      const cloud = createClientMock({
        listRecentTasks: vi
          .fn<KannaClient["listRecentTasks"]>()
          .mockResolvedValueOnce([duplicateWithoutOwnerRepo])
          .mockResolvedValueOnce([enrichedDuplicate])
      });
      const hangingStatus = new Promise<MobileServerStatus>(() => undefined);
      const lan = createClientMock({
        getStatus: vi
          .fn<KannaClient["getStatus"]>()
          .mockResolvedValueOnce(runningStatus())
          .mockReturnValueOnce(hangingStatus),
        listRecentTasks: vi.fn().mockResolvedValueOnce([localDuplicate])
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      await client.listRecentTasks();
      const replacement = client.listRecentTasks();
      await vi.advanceTimersByTimeAsync(25);

      await expect(replacement).resolves.toEqual([
        expect.objectContaining({
          id: "cloud-duplicate",
          ownerLocalRepoId: "local-repo",
          title: "LAN duplicate"
        })
      ]);

      await client.sendTaskInput("cloud-duplicate", "use preserved LAN route");
      expect(lan.sendTaskInput).toHaveBeenCalledWith(
        "local-duplicate",
        "use preserved LAN route"
      );
      expect(cloud.sendTaskInput).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("routes mixed task streams and mutations to the correct client and raw id", async () => {
    const duplicate = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloudOnly = task({
      id: "cloud-only",
      ownerDesktopId: "desktop-other",
      ownerLocalTaskId: "other-local-id"
    });
    const localDuplicate = task({ id: "local-duplicate" });
    const lanOnly = task({ id: "lan-only" });
    const cloudTerminalSubscription: TaskTerminalSubscription = {
      close: vi.fn()
    };
    const lanTerminalSubscription: TaskTerminalSubscription = { close: vi.fn() };
    const cloudAgentSubscription = agentSubscription();
    const lanAgentSubscription = agentSubscription();
    const cloudCompanionSubscription = companionSubscription();
    const lanCompanionSubscription = companionSubscription();
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([duplicate, cloudOnly]),
      observeTaskTerminal: vi.fn(() => cloudTerminalSubscription),
      observeTaskAgent: vi.fn(() => cloudAgentSubscription),
      observeTaskCompanion: vi.fn(() => cloudCompanionSubscription)
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([localDuplicate, lanOnly]),
      observeTaskTerminal: vi.fn(() => lanTerminalSubscription),
      observeTaskAgent: vi.fn(() => lanAgentSubscription),
      observeTaskCompanion: vi.fn(() => lanCompanionSubscription)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const agentListener = vi.fn();
    const terminalListener = vi.fn();
    const companionListener = vi.fn();

    await client.listRecentTasks();

    expect(client.observeTaskAgent("cloud-duplicate", agentListener)).toBe(
      lanAgentSubscription
    );
    expect(client.observeTaskTerminal("lan-only", terminalListener)).toBe(
      lanTerminalSubscription
    );
    expect(client.observeTaskAgent("cloud-only", agentListener)).toBe(
      cloudAgentSubscription
    );
    expect(client.observeTaskTerminal("cloud-only", terminalListener)).toBe(
      cloudTerminalSubscription
    );
    expect(client.observeTaskCompanion("cloud-duplicate", companionListener)).toBe(
      lanCompanionSubscription
    );
    expect(client.observeTaskCompanion("cloud-only", companionListener)).toBe(
      cloudCompanionSubscription
    );
    await client.sendTaskInput("cloud-duplicate", "continue");
    await client.closeTask("lan-only");
    await client.advanceTaskStage("cloud-only");
    await client.runMergeAgent("cloud-duplicate");
    await client.markTaskRead("cloud-duplicate", 7);
    await client.pinTask("cloud-duplicate");
    await client.unpinTask("cloud-only");
    await client.getTask?.("cloud-duplicate");
    await client.getTask?.("cloud-only");

    expect(lan.observeTaskAgent).toHaveBeenCalledWith(
      "local-duplicate",
      agentListener
    );
    expect(lan.observeTaskTerminal).toHaveBeenCalledWith(
      "lan-only",
      terminalListener
    );
    expect(cloud.observeTaskAgent).toHaveBeenCalledWith(
      "cloud-only",
      agentListener
    );
    expect(cloud.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud-only",
      terminalListener
    );
    expect(lan.observeTaskCompanion).toHaveBeenCalledWith(
      "local-duplicate",
      expect.any(Function)
    );
    expect(cloud.observeTaskCompanion).toHaveBeenCalledWith(
      "cloud-only",
      expect.any(Function)
    );
    expect(lan.sendTaskInput).toHaveBeenCalledWith(
      "local-duplicate",
      "continue"
    );
    expect(lan.closeTask).toHaveBeenCalledWith("lan-only");
    expect(cloud.advanceTaskStage).toHaveBeenCalledWith("cloud-only");
    expect(lan.runMergeAgent).toHaveBeenCalledWith("local-duplicate");
    expect(lan.markTaskRead).toHaveBeenCalledWith("local-duplicate", 7);
    expect(cloud.markTaskRead).not.toHaveBeenCalled();
    expect(lan.pinTask).toHaveBeenCalledWith("local-duplicate");
    expect(cloud.pinTask).not.toHaveBeenCalled();
    expect(cloud.unpinTask).toHaveBeenCalledWith("cloud-only");
    expect(lan.getTask).toHaveBeenCalledWith("local-duplicate");
    expect(cloud.getTask).toHaveBeenCalledWith("cloud-only");
  });

  it("keeps cloud-backed streams on cloud when the LAN route cannot authenticate them", async () => {
    const duplicate = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const localDuplicate = task({ id: "local-duplicate" });
    const cloudTerminalSubscription: TaskTerminalSubscription = {
      close: vi.fn()
    };
    const cloudAgentSubscription = agentSubscription();
    const cloudCompanionSubscription = companionSubscription();
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([duplicate]),
      observeTaskTerminal: vi.fn(() => cloudTerminalSubscription),
      observeTaskAgent: vi.fn(() => cloudAgentSubscription),
      observeTaskCompanion: vi.fn(() => cloudCompanionSubscription)
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([localDuplicate])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true,
      canUseLanTaskStreams: () => false
    });
    const agentListener = vi.fn();
    const terminalListener = vi.fn();
    const companionListener = vi.fn();

    await client.listRecentTasks();

    expect(client.getTaskRouteIdentity?.("cloud-duplicate")).toBe(
      JSON.stringify(["cloud", "cloud-duplicate"])
    );
    expect(client.observeTaskAgent("cloud-duplicate", agentListener)).toBe(
      cloudAgentSubscription
    );
    expect(
      client.observeTaskTerminal("cloud-duplicate", terminalListener)
    ).toBe(cloudTerminalSubscription);
    expect(
      client.observeTaskCompanion("cloud-duplicate", companionListener)
    ).toBe(cloudCompanionSubscription);
    await client.sendTaskInput("cloud-duplicate", "continue");

    expect(cloud.observeTaskAgent).toHaveBeenCalledWith(
      "cloud-duplicate",
      agentListener
    );
    expect(cloud.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud-duplicate",
      terminalListener
    );
    expect(cloud.observeTaskCompanion).toHaveBeenCalledWith(
      "cloud-duplicate",
      expect.any(Function)
    );
    expect(lan.observeTaskAgent).not.toHaveBeenCalled();
    expect(lan.observeTaskTerminal).not.toHaveBeenCalled();
    expect(lan.observeTaskCompanion).not.toHaveBeenCalled();
    expect(lan.sendTaskInput).toHaveBeenCalledWith(
      "local-duplicate",
      "continue"
    );
  });

  it("keeps a pre-capability-routing account client on relay when LAN status requires pairing", async () => {
    const cloudTask = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloudSubscription: TaskTerminalSubscription = { close: vi.fn() };
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask]),
      observeTaskTerminal: vi.fn(() => cloudSubscription)
    });
    const lan = createClientMock({
      getStatus: vi.fn().mockResolvedValue({
        ...runningStatus(),
        state: "pairing_required",
        kspStreamVersion: undefined
      }),
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ])
    });
    // Omitting canUseLanTaskStreams models the signed-in mobile bundle that
    // predates client-side stream-route capability checks.
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const listener = vi.fn();

    await expect(client.listRecentTasks()).resolves.toEqual([cloudTask]);

    expect(client.observeTaskTerminal("cloud-duplicate", listener)).toBe(
      cloudSubscription
    );
    expect(cloud.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud-duplicate",
      listener
    );
    expect(lan.listRecentTasks).not.toHaveBeenCalled();
    expect(lan.observeTaskTerminal).not.toHaveBeenCalled();
  });

  it("uses the authenticated cloud route for file content even when a LAN projection is selected", async () => {
    let lanEnabled = true;
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-duplicate"
        })
      ]),
      readTaskFile: vi.fn().mockResolvedValue({
        path: "docs/spec.md",
        content: "cloud"
      })
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ]),
      readTaskFile: vi.fn().mockResolvedValue({
        path: "docs/spec.md",
        content: "lan"
      })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });

    await client.listRecentTasks();
    await expect(
      client.readTaskFile("cloud-duplicate", "docs/spec.md")
    ).resolves.toEqual({
      path: "docs/spec.md",
      content: "cloud"
    });
    expect(lan.readTaskFile).not.toHaveBeenCalled();
    expect(cloud.readTaskFile).toHaveBeenCalledWith(
      "cloud-duplicate",
      "docs/spec.md"
    );

    lanEnabled = false;
    await expect(
      client.readTaskFile("cloud-duplicate", "docs/spec.md")
    ).resolves.toEqual({
      path: "docs/spec.md",
      content: "cloud"
    });
    expect(cloud.readTaskFile).toHaveBeenLastCalledWith(
      "cloud-duplicate",
      "docs/spec.md"
    );
  });

  it("uses the authenticated cloud route for mentioned-file resolution", async () => {
    const resolution = {
      mentions: [{
        path: "TaskScreen.tsx",
        line: 42,
        matches: [{ path: "apps/mobile/src/screens/TaskScreen.tsx" }],
        truncated: false
      }]
    };
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-duplicate"
        })
      ]),
      resolveTaskFileMentions: vi.fn().mockResolvedValue(resolution)
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(
      client.resolveTaskFileMentions("cloud-duplicate", [
        { path: "TaskScreen.tsx", line: 42 }
      ])
    ).resolves.toEqual(resolution);
    expect(lan.resolveTaskFileMentions).not.toHaveBeenCalled();
    expect(cloud.resolveTaskFileMentions).toHaveBeenCalledWith(
      "cloud-duplicate",
      [{ path: "TaskScreen.tsx", line: 42 }]
    );
  });

  it("prefers the paired LAN route for the task diff over the cloud fallback", async () => {
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-duplicate"
        })
      ])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ]),
      readTaskDiff: vi.fn().mockResolvedValue({
        taskId: "local-duplicate",
        baseRef: "main",
        mergeBase: "abc123",
        patch: "lan patch",
        truncated: false
      })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.readTaskDiff("cloud-duplicate")).resolves.toMatchObject({
      patch: "lan patch"
    });
    expect(lan.readTaskDiff).toHaveBeenCalledWith("local-duplicate", undefined);
    expect(cloud.readTaskDiff).not.toHaveBeenCalled();
  });

  it("falls back to the authenticated cloud route when the LAN diff read fails", async () => {
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-duplicate"
        })
      ]),
      readTaskDiff: vi.fn().mockResolvedValue({
        taskId: "local-duplicate",
        baseRef: "main",
        mergeBase: "abc123",
        patch: "cloud patch",
        truncated: false
      })
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ]),
      readTaskDiff: vi.fn().mockRejectedValue(
        new Error("Task diff requires a paired device or an authenticated relay connection.")
      )
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.readTaskDiff("cloud-duplicate")).resolves.toMatchObject({
      patch: "cloud patch"
    });
    expect(cloud.readTaskDiff).toHaveBeenCalledWith("cloud-duplicate", undefined);
  });

  it("fails closed for a LAN-only task-diff route when the device is not paired for LAN reads", async () => {
    const cloud = createClientMock();
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "lan-only" })]),
      readTaskDiff: vi.fn().mockRejectedValue(
        new Error("Task diff requires a paired device or an authenticated relay connection.")
      )
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.readTaskDiff("lan-only")).rejects.toThrow(
      /paired device|authenticated relay/i
    );
    expect(cloud.readTaskDiff).not.toHaveBeenCalled();
  });

  it("fails closed for a LAN-only task-file route without an authenticated cloud capability", async () => {
    let lanEnabled = true;
    const cloud = createClientMock();
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "lan-only" })])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });

    await client.listRecentTasks();
    await expect(
      client.readTaskFile("lan-only", "docs/spec.md")
    ).rejects.toThrow(/lan-only.*authenticated relay/i);
    expect(cloud.readTaskFile).not.toHaveBeenCalled();
    expect(lan.readTaskFile).not.toHaveBeenCalled();
  });

  it("fails closed for a LAN-only mentioned-file resolution route", async () => {
    const cloud = createClientMock();
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "lan-only" })])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(
      client.resolveTaskFileMentions("lan-only", [{ path: "TaskScreen.tsx" }])
    ).rejects.toThrow(/lan-only.*authenticated relay/i);
    expect(cloud.resolveTaskFileMentions).not.toHaveBeenCalled();
    expect(lan.resolveTaskFileMentions).not.toHaveBeenCalled();
  });

  it("translates routed action responses back to the displayed task identity", async () => {
    const duplicate = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([duplicate])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ]),
      runMergeAgent: vi.fn().mockResolvedValue({
        taskId: "local-duplicate",
        followTask: true
      }),
      advanceTaskStage: vi.fn().mockResolvedValue({
        taskId: "local-duplicate"
      })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    await client.listRecentTasks();

    await expect(client.runMergeAgent("cloud-duplicate")).resolves.toEqual({
      taskId: "cloud-duplicate",
      followTask: true
    });
    await expect(client.advanceTaskStage("cloud-duplicate")).resolves.toEqual({
      taskId: "cloud-duplicate"
    });
  });

  it("pins a genuinely new routed action identity to the same LAN desktop", async () => {
    const canonicalNextTaskId =
      "cloud:desktop-lan:repo-1:local-next";
    const duplicate = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([duplicate])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({ id: "local-duplicate" })
      ]),
      advanceTaskStage: vi
        .fn()
        .mockResolvedValueOnce({ taskId: "local-next" })
        .mockResolvedValueOnce({ taskId: "local-next" })
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    await client.listRecentTasks();

    await expect(client.advanceTaskStage("cloud-duplicate")).resolves.toEqual({
      taskId: canonicalNextTaskId,
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "repo-1",
      ownerLocalTaskId: "local-next"
    });
    await client.advanceTaskStage(canonicalNextTaskId);

    expect(lan.advanceTaskStage).toHaveBeenNthCalledWith(1, "local-duplicate");
    expect(lan.advanceTaskStage).toHaveBeenNthCalledWith(2, "local-next");
    expect(cloud.advanceTaskStage).not.toHaveBeenCalled();
  });

  it("pins every learned LAN route to the client for its owner desktop", async () => {
    const duplicate = task({
      id: "cloud-duplicate",
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId: "local-task"
    });
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a")),
      listRecentTasks: vi
        .fn()
        .mockRejectedValue(new Error("generic endpoint switched to desktop B"))
    });
    const terminalSubscription: TaskTerminalSubscription = { close: vi.fn() };
    const agentStreamSubscription = agentSubscription();
    const desktopALan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "local-task" })]),
      observeTaskTerminal: vi.fn(() => terminalSubscription),
      observeTaskAgent: vi.fn(() => agentStreamSubscription)
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([duplicate])
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });
    const terminalListener = vi.fn();
    const agentListener = vi.fn();

    await client.listRecentTasks();
    await client.runMergeAgent("cloud-duplicate");
    await client.advanceTaskStage("cloud-duplicate");
    await client.closeTask("cloud-duplicate");
    await client.sendTaskInput("cloud-duplicate", "continue");
    expect(
      client.observeTaskTerminal("cloud-duplicate", terminalListener)
    ).toBe(terminalSubscription);
    expect(client.observeTaskAgent("cloud-duplicate", agentListener)).toBe(
      agentStreamSubscription
    );

    expect(desktopALan.runMergeAgent).toHaveBeenCalledWith("local-task");
    expect(desktopALan.advanceTaskStage).toHaveBeenCalledWith("local-task");
    expect(desktopALan.closeTask).toHaveBeenCalledWith("local-task");
    expect(desktopALan.sendTaskInput).toHaveBeenCalledWith(
      "local-task",
      "continue"
    );
    expect(desktopALan.observeTaskTerminal).toHaveBeenCalledWith(
      "local-task",
      terminalListener
    );
    expect(desktopALan.observeTaskAgent).toHaveBeenCalledWith(
      "local-task",
      agentListener
    );
    expect(probeLan.runMergeAgent).not.toHaveBeenCalled();
    expect(probeLan.advanceTaskStage).not.toHaveBeenCalled();
    expect(probeLan.closeTask).not.toHaveBeenCalled();
    expect(probeLan.sendTaskInput).not.toHaveBeenCalled();
    expect(probeLan.observeTaskTerminal).not.toHaveBeenCalled();
    expect(probeLan.observeTaskAgent).not.toHaveBeenCalled();
    expect(probeLan.listRecentTasks).not.toHaveBeenCalled();
    expect(desktopALan.listRecentTasks).toHaveBeenCalledTimes(3);
  });

  it("keeps unrelated equal cloud and LAN ids visible and independently routed", async () => {
    const sharedId = "shared-task-id";
    const cloudTask = task({
      id: sharedId,
      title: "Cloud task",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const lanTask = task({ id: sharedId, title: "LAN task" });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([lanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    const firstTasks = await client.listRecentTasks();
    const secondTasks = await client.listRecentTasks();
    const lanDisplayId = firstTasks[1]?.id;

    expect(firstTasks).toHaveLength(2);
    expect(firstTasks[0]).toEqual(cloudTask);
    expect(firstTasks[1]).toEqual({
      ...lanTask,
      id: expect.not.stringMatching(/^shared-task-id$/)
    });
    expect(secondTasks.map(({ id }) => id)).toEqual(
      firstTasks.map(({ id }) => id)
    );
    expect(lanDisplayId).toBeTruthy();

    await client.closeTask(sharedId);
    await client.sendTaskInput(lanDisplayId!, "route locally");

    expect(cloud.closeTask).toHaveBeenCalledWith(sharedId);
    expect(lan.closeTask).not.toHaveBeenCalled();
    expect(lan.sendTaskInput).toHaveBeenCalledWith(sharedId, "route locally");
    expect(cloud.sendTaskInput).not.toHaveBeenCalled();
  });

  it("does not retry a failed LAN mutation through cloud", async () => {
    const failure = new Error("uncertain LAN close");
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-task"
        })
      ])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "local-task" })]),
      closeTask: vi.fn().mockRejectedValue(failure)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRecentTasks();
    await expect(client.closeTask("cloud-duplicate")).rejects.toBe(failure);

    expect(lan.closeTask).toHaveBeenCalledWith("local-task");
    expect(cloud.closeTask).not.toHaveBeenCalled();
  });

  it("shares one route-backed snapshot across overlapping task collection reads", async () => {
    const firstCloudRead = deferred<TaskSummary[]>();
    const firstLanStatus = deferred<MobileServerStatus>();
    const firstCloudTask = task({
      id: "cloud-old",
      title: "First cloud task",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-old"
    });
    const secondCloudTask = task({
      id: "cloud-new",
      title: "Second cloud task",
      ownerDesktopId: "desktop-lan",
      ownerLocalTaskId: "local-new"
    });
    const firstLanTask = task({
      id: "local-old",
      title: "First LAN task",
      stage: "review"
    });
    const secondLanTask = task({
      id: "local-new",
      title: "Second LAN task",
      stage: "pr"
    });
    const cloudLists = vi
      .fn<KannaClient["listRecentTasks"]>()
      .mockReturnValueOnce(firstCloudRead.promise)
      .mockResolvedValueOnce([secondCloudTask]);
    const cloud = createClientMock({ listRecentTasks: cloudLists });
    const lanStatuses = vi
      .fn<KannaClient["getStatus"]>()
      .mockReturnValueOnce(firstLanStatus.promise)
      .mockResolvedValueOnce(runningStatus());
    const lan = createClientMock({
      getStatus: lanStatuses,
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([firstLanTask])
        .mockResolvedValueOnce([secondLanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    const recentRead = client.listRecentTasks();
    const searchRead = client.searchTasks("");

    expect(cloudLists).toHaveBeenCalledTimes(1);
    expect(lanStatuses).toHaveBeenCalledTimes(1);

    firstCloudRead.resolve([firstCloudTask]);
    firstLanStatus.resolve(runningStatus());
    const firstTasks = [
      {
        ...firstCloudTask,
        ownerLocalRepoId: firstLanTask.repoId,
        title: firstLanTask.title,
        stage: firstLanTask.stage
      }
    ];

    await expect(recentRead).resolves.toEqual(firstTasks);
    await expect(searchRead).resolves.toEqual(firstTasks);

    const secondTasks = [
      {
        ...secondCloudTask,
        ownerLocalRepoId: secondLanTask.repoId,
        title: secondLanTask.title,
        stage: secondLanTask.stage
      }
    ];
    await expect(client.listRecentTasks()).resolves.toEqual(secondTasks);

    await client.sendTaskInput("cloud-new", "route through accepted snapshot");
    expect(lan.sendTaskInput).toHaveBeenCalledWith(
      "local-new",
      "route through accepted snapshot"
    );
    expect(cloud.sendTaskInput).not.toHaveBeenCalled();
  });

  it("lets an authoritative publication bypass a hung incidental cloud read", async () => {
    const incidentalCloudRead = deferred<TaskSummary[]>();
    const initialTask = task({ id: "cloud-initial", title: "Initial" });
    const staleIncidentalTask = task({ id: "cloud-stale", title: "Stale" });
    const freshPublishedTask = task({ id: "cloud-fresh", title: "Fresh" });
    const cloudLists = vi
      .fn<KannaClient["listRecentTasks"]>()
      .mockResolvedValueOnce([initialTask])
      .mockReturnValueOnce(incidentalCloudRead.promise)
      .mockResolvedValueOnce([freshPublishedTask]);
    const cloud = createClientMock({ listRecentTasks: cloudLists });
    const client = createCloudLanClient(cloud, createClientMock(), {
      isLanEnabled: () => false
    });

    await expect(client.listRecentTasks()).resolves.toEqual([initialTask]);
    const incidentalRead = client.searchTasks("");
    const authoritativeRead = client.listRecentTasksWithSupplement(vi.fn());

    expect(cloudLists).toHaveBeenCalledTimes(3);
    await expect(authoritativeRead).resolves.toEqual([freshPublishedTask]);

    incidentalCloudRead.resolve([staleIncidentalTask]);
    await expect(incidentalRead).resolves.toEqual([freshPublishedTask]);
    await client.sendTaskInput("cloud-fresh", "use fresh route");
    expect(cloud.sendTaskInput).toHaveBeenCalledWith(
      "cloud-fresh",
      "use fresh route"
    );
  });

  it("routes task creation to LAN only for its currently reachable desktop", async () => {
    const cloud = createClientMock();
    const lan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-lan")),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const matchingInput = {
      repoId: "repo-1",
      prompt: "Create nearby",
      desktopId: "desktop-lan"
    };
    const nonmatchingInput = {
      repoId: "repo-2",
      prompt: "Create remotely",
      desktopId: "desktop-cloud"
    };

    await client.createTask(matchingInput);
    await client.createTask(nonmatchingInput);

    expect(lan.getStatus).toHaveBeenCalledTimes(2);
    expect(lan.createTask).toHaveBeenCalledWith(matchingInput);
    expect(cloud.createTask).toHaveBeenCalledWith(nonmatchingInput);
    expect(lan.createTask).toHaveBeenCalledTimes(1);
    expect(cloud.createTask).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected LAN task creation through cloud", async () => {
    const failure = new Error("uncertain LAN create");
    const cloud = createClientMock();
    const lan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-lan")),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      createTask: vi.fn().mockRejectedValue(failure)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    const input = {
      repoId: "repo-1",
      prompt: "Create on LAN",
      desktopId: "desktop-lan"
    };

    await expect(client.createTask(input)).rejects.toBe(failure);
    expect(lan.createTask).toHaveBeenCalledWith(input);
    expect(cloud.createTask).not.toHaveBeenCalled();
  });

  it("rejects a repo absent from the LAN destination without sending create", async () => {
    const cloud = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        {
          id: "git:hash-kanji",
          name: "kanji-kongbu",
          remoteUrlHash: "hash-kanji",
          registeredDesktopIds: ["desktop-macbook"]
        }
      ])
    });
    const destinationLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue({
        ...runningStatus("desktop-studio"),
        desktopName: "Mac Studio"
      }),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    });
    const client = createCloudLanClient(cloud, destinationLan, {
      isLanEnabled: () => true
    });

    await client.listRepos();
    vi.mocked(destinationLan.listRepos).mockClear();

    await expect(client.createTask({
      repoId: "git:hash-kanji",
      prompt: "Study kanji",
      desktopId: "desktop-studio"
    })).rejects.toEqual(
      new RepoNotRegisteredError("kanji-kongbu", "Mac Studio")
    );
    expect(destinationLan.listRepos).toHaveBeenCalledTimes(1);
    expect(destinationLan.createTask).not.toHaveBeenCalled();
    expect(cloud.createTask).not.toHaveBeenCalled();
  });

  it("uses the destination desktop client for LAN creation and immediately routes the created task", async () => {
    const cloud = createClientMock();
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const createdAgentSubscription = agentSubscription();
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "created-on-a",
        repoId: "repo-1",
        title: "Created on A",
        stage: "in progress"
      }),
      observeTaskAgent: vi.fn(() => createdAgentSubscription)
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });
    const input = {
      repoId: "repo-1",
      prompt: "Create on desktop A",
      desktopId: "desktop-a"
    };
    const listener = vi.fn();

    const created = await client.createTask(input);
    expect(client.observeTaskAgent(created.taskId, listener)).toBe(
      createdAgentSubscription
    );
    await client.closeTask(created.taskId);

    expect(desktopALan.createTask).toHaveBeenCalledWith(input);
    expect(desktopALan.observeTaskAgent).toHaveBeenCalledWith(
      "created-on-a",
      listener
    );
    expect(desktopALan.closeTask).toHaveBeenCalledWith("created-on-a");
    expect(probeLan.createTask).not.toHaveBeenCalled();
    expect(probeLan.observeTaskAgent).not.toHaveBeenCalled();
    expect(probeLan.closeTask).not.toHaveBeenCalled();
    expect(cloud.createTask).not.toHaveBeenCalled();
    expect(cloud.observeTaskAgent).not.toHaveBeenCalled();
    expect(cloud.closeTask).not.toHaveBeenCalled();
  });

  it("routes creation abort to the frozen destination without a task snapshot", async () => {
    const request = {
      taskId: "a1b2c3d4",
      desktopId: "desktop-a"
    };
    const cloud = createClientMock();
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const desktopALan = createClientMock();
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });

    await client.abortTaskCreation(request);

    expect(desktopALan.abortTaskCreation).toHaveBeenCalledWith(request);
    expect(probeLan.abortTaskCreation).not.toHaveBeenCalled();
    expect(cloud.abortTaskCreation).not.toHaveBeenCalled();
  });

  it("falls back to cloud creation abort when the frozen LAN destination is unavailable", async () => {
    const request = {
      taskId: "a1b2c3d4",
      desktopId: "desktop-a"
    };
    const cloud = createClientMock();
    const lan = createClientMock();
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true,
      lanClientForDesktop: () => null
    });

    await client.abortTaskCreation(request);

    expect(cloud.abortTaskCreation).toHaveBeenCalledWith(request);
    expect(lan.abortTaskCreation).not.toHaveBeenCalled();
  });

  it("returns and preserves a canonical identity for a LAN-created task before cloud publication", async () => {
    let created = false;
    const existingCloudTask = task({
      id: "cloud-existing",
      repoId: "repo-cloud",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "existing-on-a"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([existingCloudTask])
    });
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const terminalSubscription: TaskTerminalSubscription = { close: vi.fn() };
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-local", name: "Cloud Repo" }
      ]),
      createTask: vi.fn().mockImplementation(async () => {
        created = true;
        return {
          taskId: "created-on-a",
          repoId: "repo-local",
          title: "Created on A",
          stage: "in progress",
          agentType: "pty" as const
        };
      }),
      listRecentTasks: vi.fn().mockImplementation(async () =>
        created
          ? [
              task({
                id: "created-on-a",
                repoId: "repo-local",
                title: "Created on A",
                agentType: "pty"
              })
            ]
          : []
      ),
      observeTaskTerminal: vi.fn(() => terminalSubscription)
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });
    const canonicalTaskId =
      "cloud:desktop-a:repo-local:created-on-a";

    await client.listRecentTasks();
    const response = await client.createTask({
      repoId: "repo-cloud",
      prompt: "Create on desktop A",
      desktopId: "desktop-a"
    });

    expect(response.taskId).toBe(canonicalTaskId);
    expect(desktopALan.createTask).toHaveBeenCalledWith({
      repoId: "repo-local",
      prompt: "Create on desktop A",
      desktopId: "desktop-a"
    });
    await expect(client.listRecentTasks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: canonicalTaskId,
          repoId: "repo-cloud",
          agentType: "pty"
        })
      ])
    );
    await expect(client.advanceTaskStage(canonicalTaskId)).resolves.toEqual({
      taskId: "cloud:desktop-a:repo-local:task-advanced",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "task-advanced"
    });
    expect(desktopALan.advanceTaskStage).toHaveBeenCalledWith("created-on-a");
    expect(
      client.observeTaskTerminal(canonicalTaskId, vi.fn())
    ).toBe(terminalSubscription);
    expect(desktopALan.observeTaskTerminal).toHaveBeenCalledWith(
      "created-on-a",
      expect.any(Function)
    );
  });

  it("canonicalizes a new LAN action task with its exact session metadata", async () => {
    let mergeCreated = false;
    const sourceTask = task({
      id: "cloud:desktop-a:repo-local:source-task",
      repoId: "repo-cloud",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "source-task",
      agentType: "pty"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([sourceTask])
    });
    const mergeAgentSubscription = agentSubscription();
    const lan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a")),
      listRecentTasks: vi.fn().mockImplementation(async () => [
        task({ id: "source-task", repoId: "repo-local", agentType: "pty" }),
        ...(mergeCreated
          ? [
              task({
                id: "merge-task",
                repoId: "repo-local",
                title: "Merge task",
                stage: "merge",
                agentType: "agent"
              })
            ]
          : [])
      ]),
      runMergeAgent: vi.fn().mockImplementation(async () => {
        mergeCreated = true;
        return { taskId: "merge-task", followTask: true };
      }),
      observeTaskAgent: vi.fn(() => mergeAgentSubscription)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });
    await client.listRecentTasks();
    const canonicalMergeTaskId =
      "cloud:desktop-a:repo-local:merge-task";

    await expect(client.runMergeAgent(sourceTask.id)).resolves.toEqual({
      taskId: canonicalMergeTaskId,
      followTask: true,
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "merge-task",
      task: expect.objectContaining({
        id: canonicalMergeTaskId,
        repoId: "repo-cloud",
        title: "Merge task",
        agentType: "agent"
      })
    });
    await expect(client.listRecentTasks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: canonicalMergeTaskId,
          agentType: "agent"
        })
      ])
    );
    expect(
      client.observeTaskAgent(canonicalMergeTaskId, vi.fn())
    ).toBe(mergeAgentSubscription);
    expect(lan.observeTaskAgent).toHaveBeenCalledWith(
      "merge-task",
      expect.any(Function)
    );
  });

  it("does not let a task snapshot started before LAN creation erase its provisional route", async () => {
    const pendingOldStatus = deferred<MobileServerStatus>();
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const probeLan = createClientMock({
      getStatus: vi
        .fn<KannaClient["getStatus"]>()
        .mockReturnValueOnce(pendingOldStatus.promise)
        .mockResolvedValueOnce(runningStatus("desktop-a"))
    });
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "created-on-a",
        repoId: "repo-1",
        title: "Created on A",
        stage: "in progress"
      })
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });
    const olderRead = client.listRecentTasks();

    const created = await client.createTask({
      repoId: "repo-1",
      prompt: "Create while an old read is pending",
      desktopId: "desktop-a"
    });
    pendingOldStatus.resolve(runningStatus("desktop-a"));
    await expect(olderRead).resolves.toEqual([]);

    await client.closeTask(created.taskId);
    expect(desktopALan.closeTask).toHaveBeenCalledWith("created-on-a");
    expect(cloud.closeTask).not.toHaveBeenCalled();
    expect(probeLan.closeTask).not.toHaveBeenCalled();
  });

  it("removes a successfully closed provisional route without removing its cloud snapshot route", async () => {
    const sharedTaskId = "shared-task-id";
    const cloudTask = task({
      id: sharedTaskId,
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
    });
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      listRecentTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({
        taskId: sharedTaskId,
        repoId: "repo-1",
        title: "Created on A",
        stage: "in progress"
      })
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });

    const created = await client.createTask({
      repoId: "repo-1",
      prompt: "Create with a future cloud ID collision",
      desktopId: "desktop-a"
    });
    await expect(client.listRecentTasks()).resolves.toEqual([cloudTask]);

    await client.closeTask(created.taskId);
    await client.closeTask(sharedTaskId);

    expect(desktopALan.closeTask).toHaveBeenCalledTimes(1);
    expect(desktopALan.closeTask).toHaveBeenCalledWith(sharedTaskId);
    expect(cloud.closeTask).toHaveBeenCalledTimes(1);
    expect(cloud.closeTask).toHaveBeenCalledWith(sharedTaskId);
    expect(probeLan.closeTask).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "the deterministic identity",
      publishedTaskId: "cloud:desktop-a:repo-local:created-on-a"
    },
    {
      description: "a different explicit identity",
      publishedTaskId: "explicit-cloud-task"
    }
  ])("replaces a provisional LAN alias when $description publishes during a failed LAN read", async ({ publishedTaskId }) => {
    let lanEnabled = true;
    let cloudTasks: TaskSummary[] = [];
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockImplementation(async () => cloudTasks)
    });
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-local", name: "Local Repo" }
      ]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "created-on-a",
        repoId: "repo-local",
        title: "Created on A",
        stage: "in progress",
        agentType: "pty"
      }),
      listRecentTasks: vi
        .fn<KannaClient["listRecentTasks"]>()
        .mockResolvedValueOnce([
          task({ id: "created-on-a", repoId: "repo-local" })
        ])
        .mockRejectedValueOnce(new Error("LAN snapshot unavailable")),
      advanceTaskStage: vi.fn().mockResolvedValue({ taskId: "created-on-a" })
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => lanEnabled,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });
    const created = await client.createTask({
      repoId: "repo-local",
      prompt: "Create before explicit publication",
      desktopId: "desktop-a"
    });
    await client.listRecentTasks();

    const publishedTask = task({
      id: publishedTaskId,
      repoId: "repo-local",
      ownerDesktopId: "desktop-a",
      ownerLocalRepoId: "repo-local",
      ownerLocalTaskId: "created-on-a"
    });
    cloudTasks = [publishedTask];

    await expect(client.listRecentTasks()).resolves.toEqual([publishedTask]);
    await expect(
      client.advanceTaskStage(publishedTask.id)
    ).resolves.toEqual({ taskId: publishedTask.id });
    expect(desktopALan.advanceTaskStage).toHaveBeenCalledWith("created-on-a");
    vi.mocked(desktopALan.advanceTaskStage).mockClear();

    lanEnabled = false;
    await client.advanceTaskStage(created.taskId);

    expect(cloud.advanceTaskStage).toHaveBeenCalledWith(created.taskId);
    expect(desktopALan.advanceTaskStage).not.toHaveBeenCalled();
  });

  it("retains a provisional LAN route when close fails so retry cannot cross-route", async () => {
    const failure = new Error("uncertain provisional close");
    const cloud = createClientMock();
    const probeLan = createClientMock({
      getStatus: vi.fn().mockResolvedValue(runningStatus("desktop-a"))
    });
    const desktopALan = createClientMock({
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "created-on-a",
        repoId: "repo-1",
        title: "Created on A",
        stage: "in progress"
      }),
      closeTask: vi
        .fn<KannaClient["closeTask"]>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined)
    });
    const client = createCloudLanClient(cloud, probeLan, {
      isLanEnabled: () => true,
      lanClientForDesktop: (desktopId) =>
        desktopId === "desktop-a" ? desktopALan : null
    });

    const created = await client.createTask({
      repoId: "repo-1",
      prompt: "Retry a failed close on the same route",
      desktopId: "desktop-a"
    });

    await expect(client.closeTask(created.taskId)).rejects.toBe(failure);
    await expect(client.closeTask(created.taskId)).resolves.toBeUndefined();

    expect(desktopALan.closeTask).toHaveBeenNthCalledWith(1, "created-on-a");
    expect(desktopALan.closeTask).toHaveBeenNthCalledWith(2, "created-on-a");
    expect(cloud.closeTask).not.toHaveBeenCalled();
    expect(probeLan.closeTask).not.toHaveBeenCalled();
  });

  it("keeps disabled composition entirely off LAN", async () => {
    const cloud = createClientMock();
    const lan = createClientMock();
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => false
    });

    await client.getStatus();
    await client.listRecentTasks();
    await client.listRepoTasks("repo-1");
    await client.searchTasks("task");
    await client.listRepos();
    await client.listDesktops();
    await client.createTask({
      repoId: "repo-1",
      prompt: "Cloud only",
      desktopId: "desktop-lan"
    });
    await client.sendTaskInput("cloud-task", "continue");
    await client.closeTask("cloud-task");
    await client.advanceTaskStage("cloud-task");
    await client.runMergeAgent("cloud-task");
    client.observeTaskTerminal("cloud-task", vi.fn());
    client.observeTaskAgent("cloud-task", vi.fn());

    for (const method of Object.values(lan)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("stops using previously learned LAN routes when LAN becomes disabled", async () => {
    let lanEnabled = true;
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([
        task({
          id: "cloud-duplicate",
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "local-task"
        })
      ])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "local-task" })])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });
    const listener = vi.fn();

    await client.listRecentTasks();
    expect(JSON.parse(client.getTaskRouteIdentity!("cloud-duplicate"))).toEqual([
      "lan",
      "desktop-lan",
      "local-task"
    ]);
    lanEnabled = false;
    expect(JSON.parse(client.getTaskRouteIdentity!("cloud-duplicate"))).toEqual([
      "cloud",
      "cloud-duplicate"
    ]);
    await client.closeTask("cloud-duplicate");
    client.observeTaskTerminal("cloud-duplicate", listener);

    expect(cloud.closeTask).toHaveBeenCalledWith("cloud-duplicate");
    expect(cloud.observeTaskTerminal).toHaveBeenCalledWith(
      "cloud-duplicate",
      listener
    );
    expect(lan.closeTask).not.toHaveBeenCalled();
    expect(lan.observeTaskTerminal).not.toHaveBeenCalled();
  });

  it("makes a learned LAN-only route unavailable when LAN becomes disabled", async () => {
    let lanEnabled = true;
    const cloud = createClientMock();
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([task({ id: "lan-only" })])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });
    const terminalListener = vi.fn();
    const agentListener = vi.fn();

    await client.listRecentTasks();
    lanEnabled = false;
    expect(JSON.parse(client.getTaskRouteIdentity!("lan-only"))).toEqual([
      "unavailable",
      "desktop-lan",
      "lan-only"
    ]);

    await expect(client.runMergeAgent("lan-only")).rejects.toThrow(
      /LAN route.*lan-only.*unavailable/i
    );
    await expect(client.advanceTaskStage("lan-only")).rejects.toThrow(
      /LAN route.*lan-only.*unavailable/i
    );
    await expect(client.closeTask("lan-only")).rejects.toThrow(
      /LAN route.*lan-only.*unavailable/i
    );
    await expect(client.sendTaskInput("lan-only", "continue")).rejects.toThrow(
      /LAN route.*lan-only.*unavailable/i
    );
    client.observeTaskTerminal("lan-only", terminalListener);
    client.observeTaskAgent("lan-only", agentListener);

    expect(terminalListener).toHaveBeenCalledWith({
      type: "error",
      taskId: "lan-only",
      message: expect.stringMatching(/LAN route.*lan-only.*unavailable/i)
    });
    expect(agentListener).toHaveBeenCalledWith({
      type: "error",
      taskId: "lan-only",
      message: expect.stringMatching(/LAN route.*lan-only.*unavailable/i)
    });
    for (const method of [
      cloud.runMergeAgent,
      cloud.advanceTaskStage,
      cloud.closeTask,
      cloud.sendTaskInput,
      cloud.observeTaskTerminal,
      cloud.observeTaskAgent,
      lan.runMergeAgent,
      lan.advanceTaskStage,
      lan.closeTask,
      lan.sendTaskInput,
      lan.observeTaskTerminal,
      lan.observeTaskAgent
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("ignores and does not cache a LAN task snapshot that finishes after disable", async () => {
    let lanEnabled = true;
    const pendingStatus = deferred<MobileServerStatus>();
    const cloudTask = task({
      id: "cloud-only",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const lanTask = task({ id: "lan-only" });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask])
    });
    const lan = createClientMock({
      getStatus: vi
        .fn<KannaClient["getStatus"]>()
        .mockReturnValueOnce(pendingStatus.promise)
        .mockRejectedValueOnce(new Error("LAN unavailable")),
      listRecentTasks: vi.fn().mockResolvedValueOnce([lanTask])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });

    const pendingRead = client.listRecentTasks();
    lanEnabled = false;
    pendingStatus.resolve(runningStatus());

    await expect(pendingRead).resolves.toEqual([cloudTask]);

    lanEnabled = true;
    await expect(client.listRecentTasks()).resolves.toEqual([cloudTask]);
  });

  it("rechecks LAN enablement after create reachability resolves", async () => {
    let lanEnabled = true;
    const pendingStatus = deferred<MobileServerStatus>();
    const cloud = createClientMock();
    const lan = createClientMock({
      getStatus: vi.fn().mockReturnValue(pendingStatus.promise)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });
    const input = {
      repoId: "repo-1",
      prompt: "Create after route changes",
      desktopId: "desktop-lan"
    };

    const pendingCreate = client.createTask(input);
    lanEnabled = false;
    pendingStatus.resolve(runningStatus("desktop-lan"));
    await pendingCreate;

    expect(cloud.createTask).toHaveBeenCalledWith(input);
    expect(lan.createTask).not.toHaveBeenCalled();
  });

  it("merges repositories and desktops and searches the merged task snapshot", async () => {
    const cloudDuplicate = task({
      id: "cloud-duplicate",
      repoId: "cloud-repo",
      repoName: "Cloud Repo From Task",
      title: "Cloud duplicate",
      ownerDesktopId: "desktop-lan",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "local-duplicate"
    });
    const cloudOnly = task({
      id: "cloud-only",
      repoId: "cloud-only-repo",
      repoName: "Cloud Only Repo",
      title: "Cloud only",
      waitingPromptSnippet: "Contains NEEDLE in output",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const localDuplicate = task({
      id: "local-duplicate",
      repoId: "local-repo",
      title: "Needle from LAN"
    });
    const lanOnly = task({
      id: "lan-only",
      repoId: "lan-only-repo",
      repoName: "LAN Only Repo",
      title: "Unrelated LAN task"
    });
    const cloudDesktops: DesktopSummary[] = [
      {
        id: "desktop-lan",
        name: "Cloud Desktop Name",
        online: false,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet",
        lastSeenAt: "2026-07-10T00:00:00.000Z"
      },
      {
        id: "desktop-cloud",
        name: "Cloud Only Desktop",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet"
      }
    ];
    const lanDesktops: DesktopSummary[] = [
      {
        id: "desktop-lan",
        name: "LAN Desktop Name",
        online: true,
        mode: "lan",
        connectionMode: "lan"
      },
      {
        id: "desktop-lan-only",
        name: "LAN Only Desktop",
        online: true,
        mode: "lan",
        connectionMode: "lan"
      }
    ];
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudDuplicate, cloudOnly]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "cloud-explicit", name: "Cloud Explicit" },
        { id: "cloud-repo", name: "Cloud Repo Explicit" }
      ]),
      listDesktops: vi.fn().mockResolvedValue(cloudDesktops)
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([localDuplicate, lanOnly]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "lan-explicit", name: "LAN Explicit" },
        { id: "local-repo", name: "Local Repo Explicit" }
      ]),
      listDesktops: vi.fn().mockResolvedValue(lanDesktops)
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listRepos()).resolves.toEqual([
      { id: "cloud-explicit", name: "Cloud Explicit" },
      {
        id: "cloud-repo",
        name: "Cloud Repo Explicit",
        registeredDesktopIds: ["desktop-lan"]
      },
      {
        id: "lan-explicit",
        name: "LAN Explicit",
        registeredDesktopIds: ["desktop-lan"]
      },
      {
        id: "local-repo",
        name: "Local Repo Explicit",
        registeredDesktopIds: ["desktop-lan"]
      },
      {
        id: "cloud-only-repo",
        name: "Cloud Only Repo",
        registeredDesktopIds: ["desktop-cloud"]
      },
      { id: "lan-only-repo", name: "LAN Only Repo" }
    ]);
    await expect(client.listRepoTasks("cloud-repo")).resolves.toEqual([
      {
        ...cloudDuplicate,
        title: "Needle from LAN",
        stage: localDuplicate.stage
      }
    ]);
    await expect(client.searchTasks("nEeDlE")).resolves.toEqual([
      {
        ...cloudDuplicate,
        title: "Needle from LAN",
        stage: localDuplicate.stage
      },
      cloudOnly
    ]);
    await expect(client.listDesktops()).resolves.toEqual([
      {
        ...cloudDesktops[0],
        online: true,
        connectionMode: "both"
      },
      cloudDesktops[1],
      lanDesktops[1]
    ]);

    expect(cloud.listRepoTasks).not.toHaveBeenCalled();
    expect(lan.listRepoTasks).not.toHaveBeenCalled();
    expect(cloud.searchTasks).not.toHaveBeenCalled();
    expect(lan.searchTasks).not.toHaveBeenCalled();
  });

  it("merges the same repository from cloud and LAN machines by remote url hash", async () => {
    const cloudTask = task({
      id: "cloud:desktop-cloud:repo-cloud:cloud-local-task",
      repoId: "git:hash-kanna",
      repoName: "kanna",
      title: "Task on the other machine",
      ownerDesktopId: "desktop-cloud",
      ownerLocalRepoId: "repo-cloud",
      ownerLocalTaskId: "cloud-local-task"
    });
    const lanOnlyTask = task({
      id: "lan-only-task",
      repoId: "repo-lan",
      title: "Unpublished LAN task"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([cloudTask]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "git:hash-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([lanOnlyTask]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-lan", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listRepos()).resolves.toEqual([
      {
        id: "git:hash-kanna",
        name: "kanna",
        remoteUrlHash: "hash-kanna",
        registeredDesktopIds: ["desktop-lan", "desktop-cloud"]
      }
    ]);

    // The LAN-only task lists under the canonical repo entry while keeping
    // its desktop-local repo id for routing.
    await expect(client.listRepoTasks("git:hash-kanna")).resolves.toEqual([
      cloudTask,
      {
        ...lanOnlyTask,
        repoId: "git:hash-kanna",
        ownerLocalRepoId: "repo-lan"
      }
    ]);
  });

  it("canonicalizes a concurrent bootstrap even when the cloud repo read resolves last", async () => {
    const lanTask = task({
      id: "lan-only-task",
      repoId: "repo-lan",
      title: "Unpublished LAN task"
    });
    const cloudRepoRead = deferred<Array<{ id: string; name: string; remoteUrlHash?: string }>>();
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockReturnValue(cloudRepoRead.promise)
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([lanTask]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-lan", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    // Bootstrap issues both reads concurrently. The LAN repo/task reads and
    // the cloud task read settle first; the cloud repo read is still pending
    // when the task list is returned — the ordering that used to leak the
    // desktop-local repo id and recreate the duplicate repo entry.
    const repoRead = client.listRepos();
    const taskRead = client.listRecentTasks();
    const tasks = await taskRead;
    cloudRepoRead.resolve([
      {
        id: "git:hash-kanna",
        name: "kanna",
        remoteUrlHash: "hash-kanna",
        registeredDesktopIds: ["desktop-lan"]
      }
    ]);
    const repos = await repoRead;

    expect(tasks).toEqual([
      { ...lanTask, repoId: "git:hash-kanna", ownerLocalRepoId: "repo-lan" }
    ]);
    expect(repos).toEqual([
      {
        id: "git:hash-kanna",
        name: "kanna",
        remoteUrlHash: "hash-kanna",
        registeredDesktopIds: ["desktop-lan"]
      }
    ]);
    // The canonical repo id still routes to the LAN task.
    await expect(client.listRepoTasks("git:hash-kanna")).resolves.toEqual([
      { ...lanTask, repoId: "git:hash-kanna", ownerLocalRepoId: "repo-lan" }
    ]);
  });

  it("reprojects an accepted task snapshot when LAN repo identity arrives later", async () => {
    const lanTask = task({
      id: "lan-only-task",
      repoId: "repo-lan",
      title: "Unpublished LAN task"
    });
    const cloud = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "git:hash-kanna", name: "kanna", remoteUrlHash: "hash-kanna" }
      ])
    });
    const lan = createClientMock({
      listRecentTasks: vi.fn().mockResolvedValue([lanTask]),
      listRepos: vi
        .fn<KannaClient["listRepos"]>()
        .mockRejectedValueOnce(new Error("repo read unavailable"))
        .mockResolvedValue([
          { id: "repo-lan", name: "kanna", remoteUrlHash: "hash-kanna" }
        ])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    // The identity fetch attached to the task read fails, so the snapshot is
    // accepted with the desktop-local repo id.
    const tasks = await client.listRecentTasks();
    expect(tasks).toEqual([lanTask]);

    // A later successful repo read merges the entries and reprojects the
    // accepted snapshot in place — the derived duplicate never surfaces.
    await expect(client.listRepos()).resolves.toEqual([
      {
        id: "git:hash-kanna",
        name: "kanna",
        remoteUrlHash: "hash-kanna",
        registeredDesktopIds: ["desktop-lan"]
      }
    ]);
    await expect(client.getTask("lan-only-task")).resolves.toMatchObject({
      repoId: "git:hash-kanna",
      ownerLocalRepoId: "repo-lan"
    });
  });

  it("uses last-good repository source data when a later explicit read fails", async () => {
    const cloud = createClientMock({
      listRepos: vi
        .fn<KannaClient["listRepos"]>()
        .mockResolvedValueOnce([{ id: "cloud-repo", name: "Cloud Repo" }])
        .mockRejectedValueOnce(new Error("cloud repos unavailable")),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const lan = createClientMock({
      listRepos: vi
        .fn<KannaClient["listRepos"]>()
        .mockResolvedValueOnce([{ id: "lan-old", name: "LAN Old" }])
        .mockResolvedValueOnce([{ id: "lan-new", name: "LAN New" }]),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listRepos();
    await expect(client.listRepos()).resolves.toEqual([
      { id: "cloud-repo", name: "Cloud Repo" },
      {
        id: "lan-new",
        name: "LAN New",
        registeredDesktopIds: ["desktop-lan"]
      }
    ]);
  });

  it("returns cloud repositories after the optional LAN wait expires", async () => {
    vi.useFakeTimers();
    try {
      const cloudRepo = { id: "cloud-repo", name: "Cloud Repo" };
      const cloud = createClientMock({
        listRepos: vi.fn().mockResolvedValue([cloudRepo]),
        listRecentTasks: vi.fn().mockResolvedValue([])
      });
      const lan = createClientMock({
        getStatus: vi.fn(() => new Promise<MobileServerStatus>(() => {})),
        listRepos: vi.fn(
          () => new Promise<Array<{ id: string; name: string }>>(() => {})
        )
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      let readSettled = false;
      const read = client.listRepos().then((repos) => {
        readSettled = true;
        return repos;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(readSettled).toBe(true);
      await expect(read).resolves.toEqual([cloudRepo]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shares an unresolved optional LAN repository probe across timeout reads and refreshes after settlement", async () => {
    vi.useFakeTimers();
    try {
      const firstLanRepos = deferred<Array<{ id: string; name: string }>>();
      const secondLanRepos = deferred<Array<{ id: string; name: string }>>();
      const cloudRepo = { id: "cloud-repo", name: "Cloud Repo" };
      const cloud = createClientMock({
        listRepos: vi.fn().mockResolvedValue([cloudRepo]),
        listRecentTasks: vi.fn().mockResolvedValue([])
      });
      const lan = createClientMock({
        listRepos: vi
          .fn<KannaClient["listRepos"]>()
          .mockReturnValueOnce(firstLanRepos.promise)
          .mockReturnValueOnce(secondLanRepos.promise)
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      const firstRead = client.listRepos();
      await vi.advanceTimersByTimeAsync(25);
      await expect(firstRead).resolves.toEqual([cloudRepo]);

      const repeatedRead = client.listRepos();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedRead).resolves.toEqual([cloudRepo]);
      expect(lan.listRepos).toHaveBeenCalledTimes(1);

      firstLanRepos.resolve([]);
      await vi.advanceTimersByTimeAsync(0);

      const freshRead = client.listRepos();
      await vi.advanceTimersByTimeAsync(25);
      await expect(freshRead).resolves.toEqual([cloudRepo]);
      expect(lan.listRepos).toHaveBeenCalledTimes(2);

      const repeatedFreshRead = client.listRepos();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedFreshRead).resolves.toEqual([cloudRepo]);
      expect(lan.listRepos).toHaveBeenCalledTimes(2);

      secondLanRepos.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("ignores and does not cache LAN repositories that finish after disable", async () => {
    let lanEnabled = true;
    const pendingLanRepos = deferred<Array<{ id: string; name: string }>>();
    const cloudRepo = { id: "cloud-repo", name: "Cloud Repo" };
    const lanRepo = { id: "lan-repo", name: "LAN Repo" };
    const cloud = createClientMock({
      listRepos: vi.fn().mockResolvedValue([cloudRepo]),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const lan = createClientMock({
      listRepos: vi
        .fn<KannaClient["listRepos"]>()
        .mockReturnValueOnce(pendingLanRepos.promise)
        .mockRejectedValueOnce(new Error("LAN repos unavailable")),
      listRecentTasks: vi.fn().mockResolvedValue([])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });

    const pendingRead = client.listRepos();
    lanEnabled = false;
    pendingLanRepos.resolve([lanRepo]);
    await expect(pendingRead).resolves.toEqual([cloudRepo]);

    lanEnabled = true;
    await expect(client.listRepos()).resolves.toEqual([cloudRepo]);
  });

  it("rejects repository reads when no source or task snapshot has data", async () => {
    const cloud = createClientMock({
      listRepos: vi.fn().mockRejectedValue(new Error("cloud repos unavailable")),
      listRecentTasks: vi.fn().mockRejectedValue(new Error("cloud unavailable"))
    });
    const lan = createClientMock({
      getStatus: vi.fn().mockRejectedValue(new Error("LAN unavailable")),
      listRepos: vi.fn().mockRejectedValue(new Error("LAN repos unavailable"))
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listRepos()).rejects.toBeDefined();
  });

  it("uses last-good desktop source data when a later explicit read fails", async () => {
    const cloudDesktop: DesktopSummary = {
      id: "desktop-cloud",
      name: "Cloud Desktop",
      online: true,
      mode: "remote",
      reachableViaRelay: true,
      connectionMode: "internet"
    };
    const firstLanDesktop: DesktopSummary = {
      id: "desktop-lan-old",
      name: "LAN Old",
      online: true,
      mode: "lan",
      connectionMode: "lan"
    };
    const replacementLanDesktop: DesktopSummary = {
      id: "desktop-lan-new",
      name: "LAN New",
      online: true,
      mode: "lan",
      connectionMode: "lan"
    };
    const cloud = createClientMock({
      listDesktops: vi
        .fn<KannaClient["listDesktops"]>()
        .mockResolvedValueOnce([cloudDesktop])
        .mockRejectedValueOnce(new Error("cloud desktops unavailable"))
    });
    const lan = createClientMock({
      listDesktops: vi
        .fn<KannaClient["listDesktops"]>()
        .mockResolvedValueOnce([firstLanDesktop])
        .mockResolvedValueOnce([replacementLanDesktop])
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await client.listDesktops();
    await expect(client.listDesktops()).resolves.toEqual([
      cloudDesktop,
      replacementLanDesktop
    ]);
  });

  it("reports per-source desktop warnings while preserving last-good records", async () => {
    const cloudDesktop: DesktopSummary = {
      id: "desktop-cloud",
      name: "Cloud Desktop",
      online: true,
      mode: "remote"
    };
    const lanDesktop: DesktopSummary = {
      id: "desktop-lan",
      name: "LAN Desktop",
      online: true,
      mode: "lan"
    };
    const cloud = createClientMock({
      listDesktops: vi
        .fn<KannaClient["listDesktops"]>()
        .mockResolvedValueOnce([cloudDesktop])
        .mockRejectedValueOnce(new Error("cloud desktops unavailable"))
        .mockResolvedValueOnce([cloudDesktop])
    });
    const lan = createClientMock({
      listDesktops: vi
        .fn<KannaClient["listDesktops"]>()
        .mockResolvedValueOnce([lanDesktop])
        .mockResolvedValueOnce([lanDesktop])
        .mockRejectedValueOnce(new Error("LAN desktops unavailable"))
    });
    const onDesktopSourceWarnings = vi.fn();
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true,
      onDesktopSourceWarnings
    });

    await client.listDesktops();
    await expect(client.listDesktops()).resolves.toEqual([cloudDesktop, lanDesktop]);
    expect(onDesktopSourceWarnings).toHaveBeenLastCalledWith({
      account: "cloud desktops unavailable",
      local: null
    });

    await expect(client.listDesktops()).resolves.toEqual([cloudDesktop, lanDesktop]);
    expect(onDesktopSourceWarnings).toHaveBeenLastCalledWith({
      account: null,
      local: "LAN desktops unavailable"
    });
  });

  it("preserves and republishes separate source inventories across client replacement", async () => {
    const accountDesktop: DesktopSummary = {
      id: "desktop-account",
      name: "Account Mac",
      online: true,
      mode: "remote"
    };
    const localDesktop: DesktopSummary = {
      id: "desktop-local",
      name: "Nearby Mac",
      online: true,
      mode: "lan"
    };
    const onDesktopSourcesChanged = vi.fn();
    const client = createCloudLanClient(
      createClientMock({
        listDesktops: vi.fn().mockRejectedValue(new Error("account unavailable"))
      }),
      createClientMock({
        listDesktops: vi.fn().mockRejectedValue(new Error("LAN unavailable"))
      }),
      {
        isLanEnabled: () => true,
        initialDesktopSources: {
          account: [accountDesktop],
          local: [localDesktop]
        },
        onDesktopSourcesChanged
      }
    );

    await expect(client.listDesktops()).resolves.toEqual([
      accountDesktop,
      localDesktop
    ]);
    expect(onDesktopSourcesChanged).toHaveBeenLastCalledWith({
      account: [accountDesktop],
      local: [localDesktop]
    });
  });

  it("returns cloud desktops after the optional LAN wait expires", async () => {
    vi.useFakeTimers();
    try {
      const cloudDesktop: DesktopSummary = {
        id: "desktop-cloud",
        name: "Cloud Desktop",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet"
      };
      const cloud = createClientMock({
        listDesktops: vi.fn().mockResolvedValue([cloudDesktop])
      });
      const lan = createClientMock({
        listDesktops: vi.fn(() => new Promise<DesktopSummary[]>(() => {}))
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      let readSettled = false;
      const read = client.listDesktops().then((desktops) => {
        readSettled = true;
        return desktops;
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(readSettled).toBe(true);
      await expect(read).resolves.toEqual([cloudDesktop]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("expires LAN routability when the optional desktop read times out", async () => {
    vi.useFakeTimers();
    try {
      const pendingLanDesktops = deferred<DesktopSummary[]>();
      const cloudDesktop: DesktopSummary = {
        id: "desktop-a",
        name: "Desktop A",
        online: true,
        mode: "remote"
      };
      const cloud = createClientMock({
        listDesktops: vi.fn().mockResolvedValue([cloudDesktop])
      });
      const lan = createClientMock({
        listDesktops: vi.fn().mockReturnValue(pendingLanDesktops.promise)
      });
      const onLanReadUnavailable = vi.fn();
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 1_000,
        onLanReadUnavailable
      });

      const result = client.listDesktops();
      await vi.advanceTimersByTimeAsync(999);
      expect(onLanReadUnavailable).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual([cloudDesktop]);
      expect(onLanReadUnavailable).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shares an unresolved optional LAN desktop probe across timeout reads and refreshes after settlement", async () => {
    vi.useFakeTimers();
    try {
      const firstLanDesktops = deferred<DesktopSummary[]>();
      const secondLanDesktops = deferred<DesktopSummary[]>();
      const cloudDesktop: DesktopSummary = {
        id: "desktop-cloud",
        name: "Cloud Desktop",
        online: true,
        mode: "remote",
        reachableViaRelay: true,
        connectionMode: "internet"
      };
      const cloud = createClientMock({
        listDesktops: vi.fn().mockResolvedValue([cloudDesktop])
      });
      const lan = createClientMock({
        listDesktops: vi
          .fn<KannaClient["listDesktops"]>()
          .mockReturnValueOnce(firstLanDesktops.promise)
          .mockReturnValueOnce(secondLanDesktops.promise)
      });
      const client = createCloudLanClient(cloud, lan, {
        isLanEnabled: () => true,
        optionalLanWaitMs: 25
      });

      const firstRead = client.listDesktops();
      await vi.advanceTimersByTimeAsync(25);
      await expect(firstRead).resolves.toEqual([cloudDesktop]);

      const repeatedRead = client.listDesktops();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedRead).resolves.toEqual([cloudDesktop]);
      expect(lan.listDesktops).toHaveBeenCalledTimes(1);

      firstLanDesktops.resolve([]);
      await vi.advanceTimersByTimeAsync(0);

      const freshRead = client.listDesktops();
      await vi.advanceTimersByTimeAsync(25);
      await expect(freshRead).resolves.toEqual([cloudDesktop]);
      expect(lan.listDesktops).toHaveBeenCalledTimes(2);

      const repeatedFreshRead = client.listDesktops();
      await vi.advanceTimersByTimeAsync(25);
      await expect(repeatedFreshRead).resolves.toEqual([cloudDesktop]);
      expect(lan.listDesktops).toHaveBeenCalledTimes(2);

      secondLanDesktops.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("ignores and does not cache LAN desktops that finish after disable", async () => {
    let lanEnabled = true;
    const pendingLanDesktops = deferred<DesktopSummary[]>();
    const cloudDesktop: DesktopSummary = {
      id: "desktop-cloud",
      name: "Cloud Desktop",
      online: true,
      mode: "remote",
      reachableViaRelay: true,
      connectionMode: "internet"
    };
    const lanDesktop: DesktopSummary = {
      id: "desktop-lan",
      name: "LAN Desktop",
      online: true,
      mode: "lan",
      connectionMode: "lan"
    };
    const cloud = createClientMock({
      listDesktops: vi.fn().mockResolvedValue([cloudDesktop])
    });
    const lan = createClientMock({
      listDesktops: vi
        .fn<KannaClient["listDesktops"]>()
        .mockReturnValueOnce(pendingLanDesktops.promise)
        .mockRejectedValueOnce(new Error("LAN desktops unavailable"))
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => lanEnabled
    });

    const pendingRead = client.listDesktops();
    lanEnabled = false;
    pendingLanDesktops.resolve([lanDesktop]);
    await expect(pendingRead).resolves.toEqual([cloudDesktop]);

    lanEnabled = true;
    await expect(client.listDesktops()).resolves.toEqual([cloudDesktop]);
  });

  it("rejects desktop reads when neither source has data", async () => {
    const cloud = createClientMock({
      listDesktops: vi
        .fn()
        .mockRejectedValue(new Error("cloud desktops unavailable"))
    });
    const lan = createClientMock({
      listDesktops: vi
        .fn()
        .mockRejectedValue(new Error("LAN desktops unavailable"))
    });
    const client = createCloudLanClient(cloud, lan, {
      isLanEnabled: () => true
    });

    await expect(client.listDesktops()).rejects.toBeDefined();
  });
});

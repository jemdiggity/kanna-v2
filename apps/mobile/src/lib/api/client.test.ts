import { describe, expect, it, vi } from "vitest";
import { createKannaClient, TaskCreationError } from "./client";
import type { KannaTransport } from "./client";

describe("createKannaClient", () => {
  it("classifies an untyped create rejection as an unknown result", async () => {
    const cause = new Error("lost create response");
    const transport = {
      createTask: vi.fn().mockRejectedValue(cause)
    } as unknown as KannaTransport;
    const client = createKannaClient(transport);

    await expect(client.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      taskId: "a1b2c3d4"
    } as Parameters<typeof client.createTask>[0])).rejects.toMatchObject({
      name: "TaskCreationError",
      outcome: "unknown",
      message: "lost create response",
      cause
    });
  });

  it("preserves a typed task creation outcome from the transport", async () => {
    const failure = new TaskCreationError(
      "not-created",
      "request did not leave the device"
    );
    const transport = {
      createTask: vi.fn().mockRejectedValue(failure)
    } as unknown as KannaTransport;
    const client = createKannaClient(transport);

    await expect(client.createTask({
      repoId: "repo-1",
      prompt: "Ship it"
    })).rejects.toBe(failure);
  });

  it("forwards desktop and task queries to the transport", async () => {
    const transport: KannaTransport = {
      getStatus: vi.fn().mockResolvedValue({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      }),
      listDesktops: vi.fn().mockResolvedValue([
        { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }
      ]),
      listRepos: vi.fn().mockResolvedValue([
        { id: "repo-1", name: "Repo One" }
      ]),
      listRepoTasks: vi.fn().mockResolvedValue([
        {
          id: "task-repo-1",
          repoId: "repo-1",
          title: "Repo task",
          stage: "in progress"
        }
      ]),
      listRepoCommands: vi.fn().mockResolvedValue({
        repoId: "repo-1",
        revision: "catalog-v1",
        commands: []
      }),
      runRepoCommand: vi.fn().mockResolvedValue({
        taskId: "task-command",
        reused: false
      }),
      listRecentTasks: vi.fn().mockResolvedValue([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile client",
          stage: "in progress",
          waitingPromptSnippet: "Latest agent output preview"
        }
      ]),
      getTask: vi.fn().mockResolvedValue({
        id: "task-1",
        repoId: "repo-1",
        title: "Refactor mobile client",
        prompt: "Full canonical prompt",
        stage: "in progress"
      }),
      searchTasks: vi.fn().mockResolvedValue([
        { id: "task-2", repoId: "repo-1", title: "Search result", stage: "pr" }
      ]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "task-3",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress"
      }),
      abortTaskCreation: vi.fn().mockResolvedValue(undefined),
      runMergeAgent: vi.fn().mockResolvedValue({
        taskId: "task-4"
      }),
      advanceTaskStage: vi.fn().mockResolvedValue({
        taskId: "task-5"
      }),
      markTaskRead: vi.fn().mockResolvedValue({
        taskId: "task-1",
        activity: "idle"
      }),
      closeTask: vi.fn().mockResolvedValue(undefined),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      readTaskFile: vi.fn().mockResolvedValue({
        path: "docs/spec one.md",
        content: "# Spec"
      }),
      resolveTaskFileMentions: vi.fn().mockResolvedValue({
        mentions: [{
          path: "TaskScreen.tsx",
          line: 42,
          matches: [{ path: "src/screens/TaskScreen.tsx" }],
          truncated: false
        }]
      }),
      readTaskDiff: vi.fn().mockResolvedValue({
        taskId: "task-1",
        baseRef: "main",
        mergeBase: "abc123",
        patch: "diff --git a/x b/x",
        truncated: false
      }),
      observeTaskTerminal: vi.fn().mockReturnValue({
        close: vi.fn()
      }),
      observeTaskCompanion: vi.fn().mockReturnValue({
        close: vi.fn(),
        sendEvent: vi.fn()
      })
    };

    const client = createKannaClient(transport);

    expect(await client.listDesktops()).toHaveLength(1);
    expect(await client.listRepos()).toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
    expect(await client.listRepoTasks("repo-1")).toHaveLength(1);
    await expect(client.listRepoCommands("repo-1")).resolves.toMatchObject({
      revision: "catalog-v1"
    });
    await expect(
      client.runRepoCommand("repo-1", "custom:ship", "catalog-v1")
    ).resolves.toEqual({ taskId: "task-command", reused: false });
    expect(await client.listRecentTasks()).toHaveLength(1);
    expect((await client.listRecentTasks())[0]?.waitingPromptSnippet).toBe(
      "Latest agent output preview"
    );
    await expect(client.getTask?.("task-1")).resolves.toEqual(
      expect.objectContaining({ prompt: "Full canonical prompt" })
    );
    expect(await client.searchTasks("search")).toHaveLength(1);
    expect(await client.createTask({
      repoId: "repo-1",
      prompt: "Ship it"
    })).toEqual({
      taskId: "task-3",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    await expect(client.abortTaskCreation({
      taskId: "a1b2c3d4",
      desktopId: "desktop-owner"
    })).resolves.toBeUndefined();
    expect(transport.abortTaskCreation).toHaveBeenCalledWith({
      taskId: "a1b2c3d4",
      desktopId: "desktop-owner"
    });
    expect(await client.runMergeAgent("task-1")).toEqual({
      taskId: "task-4"
    });
    expect(await client.advanceTaskStage("task-1")).toEqual({
      taskId: "task-5"
    });
    expect(await client.markTaskRead("task-1")).toEqual({
      taskId: "task-1",
      activity: "idle"
    });
    expect(transport.markTaskRead).toHaveBeenCalledWith("task-1", undefined);
    expect(await client.markTaskRead("task-1", 7)).toEqual({
      taskId: "task-1",
      activity: "idle"
    });
    expect(transport.markTaskRead).toHaveBeenLastCalledWith("task-1", 7);
    await expect(client.closeTask("task-1")).resolves.toBeUndefined();
    await expect(client.sendTaskInput("task-1", "continue")).resolves.toBeUndefined();
    await expect(
      client.readTaskFile("task/read", "docs/spec one.md")
    ).resolves.toEqual({
      path: "docs/spec one.md",
      content: "# Spec"
    });
    expect(transport.readTaskFile).toHaveBeenCalledOnce();
    expect(transport.readTaskFile).toHaveBeenCalledWith(
      "task/read",
      "docs/spec one.md"
    );
    await expect(
      client.resolveTaskFileMentions("task/read", [
        { path: "TaskScreen.tsx", line: 42 }
      ])
    ).resolves.toMatchObject({
      mentions: [{ matches: [{ path: "src/screens/TaskScreen.tsx" }] }]
    });
    expect(transport.resolveTaskFileMentions).toHaveBeenCalledWith(
      "task/read",
      [{ path: "TaskScreen.tsx", line: 42 }]
    );
    await expect(client.readTaskDiff("task/diff")).resolves.toMatchObject({
      patch: "diff --git a/x b/x"
    });
    expect(transport.readTaskDiff).toHaveBeenCalledOnce();
    expect(transport.readTaskDiff).toHaveBeenCalledWith("task/diff", undefined);
    expect(typeof client.observeTaskTerminal("task-1", vi.fn()).close).toBe("function");
    expect(typeof client.observeTaskCompanion("task-1", vi.fn()).sendEvent).toBe(
      "function"
    );
  });
});

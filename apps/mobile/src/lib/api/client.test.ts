import { describe, expect, it, vi } from "vitest";
import { createKannaClient } from "./client";
import type { KannaTransport } from "./client";

describe("createKannaClient", () => {
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
      listRecentTasks: vi.fn().mockResolvedValue([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile client",
          stage: "in progress",
          waitingPromptSnippet: "Latest agent output preview"
        }
      ]),
      searchTasks: vi.fn().mockResolvedValue([
        { id: "task-2", repoId: "repo-1", title: "Search result", stage: "pr" }
      ]),
      createTask: vi.fn().mockResolvedValue({
        taskId: "task-3",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress"
      }),
      runMergeAgent: vi.fn().mockResolvedValue({
        taskId: "task-4"
      }),
      advanceTaskStage: vi.fn().mockResolvedValue({
        taskId: "task-5"
      }),
      closeTask: vi.fn().mockResolvedValue(undefined),
      sendTaskInput: vi.fn().mockResolvedValue(undefined),
      observeTaskTerminal: vi.fn().mockReturnValue({
        close: vi.fn()
      }),
      createPairingSession: vi.fn().mockResolvedValue({
        code: "ABC123",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        expiresAtUnixMs: 123
      })
    };

    const client = createKannaClient(transport);

    expect(await client.listDesktops()).toHaveLength(1);
    expect(await client.listRepos()).toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
    expect(await client.listRepoTasks("repo-1")).toHaveLength(1);
    expect(await client.listRecentTasks()).toHaveLength(1);
    expect((await client.listRecentTasks())[0]?.waitingPromptSnippet).toBe(
      "Latest agent output preview"
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
    expect(await client.runMergeAgent("task-1")).toEqual({
      taskId: "task-4"
    });
    expect(await client.advanceTaskStage("task-1")).toEqual({
      taskId: "task-5"
    });
    await expect(client.closeTask("task-1")).resolves.toBeUndefined();
    await expect(client.sendTaskInput("task-1", "continue")).resolves.toBeUndefined();
    expect(typeof client.observeTaskTerminal("task-1", vi.fn()).close).toBe("function");
    expect((await client.createPairingSession()).code).toBe("ABC123");
  });
});

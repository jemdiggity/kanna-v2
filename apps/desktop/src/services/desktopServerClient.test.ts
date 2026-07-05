import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockDesktopTask,
  closeDesktopTask,
  createDesktopTask,
  markDesktopTaskRead,
  reopenDesktopTask,
  setDesktopTaskActionForTests,
  setDesktopTaskCreatorForTests,
  unblockDesktopTask,
} from "./desktopServerClient";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

describe("desktopServerClient", () => {
  beforeEach(() => {
    setDesktopTaskActionForTests(null);
    setDesktopTaskCreatorForTests(null);
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") {
        return "48321";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "",
    })));
  });

  it("posts task close actions to the local kanna-server", async () => {
    await closeDesktopTask("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/close",
      { method: "POST" },
    );
  });

  it("posts task reopen actions to the local kanna-server", async () => {
    await reopenDesktopTask("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/reopen",
      { method: "POST" },
    );
  });

  it("posts task mark-read actions to the local kanna-server", async () => {
    await markDesktopTaskRead("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/mark-read",
      { method: "POST" },
    );
  });

  it("posts task block actions to the local kanna-server", async () => {
    await blockDesktopTask("task-1", ["blocker-1"]);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/block",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockerTaskIds: ["blocker-1"] }),
      },
    );
  });

  it("posts task unblock actions to the local kanna-server", async () => {
    await unblockDesktopTask("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/unblock",
      { method: "POST" },
    );
  });

  it("posts task creation to the local kanna-server", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        taskId: "task-1",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress",
        agentType: "pty",
        worktreePath: "/tmp/repo/.kanna-worktrees/task-1",
      }),
      text: async () => "",
    } as Response);

    await expect(createDesktopTask({
      repoId: "repo-1",
      prompt: "Ship it",
      baseRef: "origin/main",
      agentProvider: "claude",
      agentType: "pty",
      stage: "review",
      disallowedTools: ["WebFetch"],
      maxTurns: 7,
      maxBudgetUsd: 1.5,
      setupCmds: ["pnpm install"],
    })).resolves.toMatchObject({ taskId: "task-1" });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          prompt: "Ship it",
          baseRef: "origin/main",
          agentProvider: "claude",
          agentType: "pty",
          stage: "review",
          disallowedTools: ["WebFetch"],
          maxTurns: 7,
          maxBudgetUsd: 1.5,
          setupCmds: ["pnpm install"],
        }),
      },
    );
  });
});

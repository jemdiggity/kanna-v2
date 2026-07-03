import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callVueMethod: vi.fn(),
  execDb: vi.fn(),
  getVueState: vi.fn(),
  queryDb: vi.fn(),
  tauriInvoke: vi.fn(),
}));

vi.mock("./vue", () => ({
  callVueMethod: mocks.callVueMethod,
  execDb: mocks.execDb,
  getVueState: mocks.getVueState,
  queryDb: mocks.queryDb,
  tauriInvoke: mocks.tauriInvoke,
}));

describe("reset helpers", () => {
  const originalLiveRepoRoot = process.env.KANNA_E2E_LIVE_REPO_ROOT;

  function createImportClient(selectionStates: Array<{
    selectedRepoId: string | null;
    selectedRepoPath: string | null;
  }>) {
    return {
      clear: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      executeSync: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(() => Promise.resolve(
          selectionStates.shift() ?? { selectedRepoId: "repo-1", selectedRepoPath: "/repo" },
        )),
      findElements: vi.fn().mockImplementation((selector: string) => {
        if (selector === ".modal-overlay .text-input") {
          return Promise.resolve(["repo-path-input", "repo-name-input"]);
        }
        if (selector === ".repo-header") {
          return Promise.resolve(["repo-header"]);
        }
        return Promise.resolve([]);
      }),
      getText: vi.fn().mockResolvedValue("test-repo"),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      waitForElement: vi.fn().mockImplementation((selector: string) =>
        Promise.resolve(selector === ".modal-overlay .text-input" ? "repo-path-input" : selector),
      ),
      waitForNoElement: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    mocks.callVueMethod.mockReset();
    mocks.execDb.mockReset();
    mocks.getVueState.mockReset();
    mocks.queryDb.mockReset();
    mocks.tauriInvoke.mockReset();
    process.env.KANNA_E2E_LIVE_REPO_ROOT = originalLiveRepoRoot;
  });

  it("cleans up only task worktrees created after the imported repo baseline", async () => {
    const client = createImportClient([{ selectedRepoId: "repo-1", selectedRepoPath: "/repo" }]);

    mocks.tauriInvoke
      .mockResolvedValueOnce([
        { name: "task-existing", path: "/repo/.kanna-worktrees/task-existing" },
        { name: "scratch", path: "/repo/.kanna-worktrees/scratch" },
      ])
      .mockResolvedValue(undefined);
    mocks.queryDb
      .mockResolvedValueOnce([{ id: "repo-1", name: "test-repo" }])
      .mockResolvedValueOnce([
        { id: "task-created-by-test" },
        { id: "task-created-externally" },
      ])
      .mockResolvedValue([
        { closed_at: "2026-04-22T00:00:00.000Z" },
      ]);
    mocks.callVueMethod.mockResolvedValue(undefined);

    const { cleanupWorktrees, importTestRepo } = await import("./reset");

    await importTestRepo(client as never, "/repo", "test-repo");
    await cleanupWorktrees(client as never, "/repo");

    const closeCalls = mocks.callVueMethod.mock.calls.filter(
      ([, method]) => method === "store.closeTask",
    );

    expect(closeCalls).toEqual([
      [
        client,
        "store.closeTask",
        "task-created-by-test",
      ],
      [
        client,
        "store.closeTask",
        "task-created-externally",
      ],
    ]);
  });

  it("kills agent-backed task sessions before closing them during cleanup", async () => {
    const client = createImportClient([{ selectedRepoId: "repo-1", selectedRepoPath: "/repo" }]);

    mocks.tauriInvoke
      .mockResolvedValueOnce([])
      .mockResolvedValue(undefined);
    mocks.queryDb
      .mockResolvedValueOnce([{ id: "repo-1", name: "test-repo" }])
      .mockResolvedValueOnce([
        { id: "sdk-task", agent_type: "agent" },
        { id: "pty-task", agent_type: "pty" },
      ])
      .mockResolvedValue([
        { closed_at: "2026-04-22T00:00:00.000Z" },
      ]);
    mocks.callVueMethod.mockResolvedValue(undefined);

    const { cleanupWorktrees, importTestRepo } = await import("./reset");

    await importTestRepo(client as never, "/repo", "test-repo");
    await cleanupWorktrees(client as never, "/repo");

    expect(mocks.tauriInvoke).toHaveBeenCalledWith(
      client,
      "kill_session",
      { sessionId: "sdk-task" },
    );
    expect(mocks.tauriInvoke).not.toHaveBeenCalledWith(
      client,
      "kill_session",
      { sessionId: "pty-task" },
    );

    const killCallIndex = mocks.tauriInvoke.mock.calls.findIndex(
      ([, command, args]) => command === "kill_session" && args?.sessionId === "sdk-task",
    );
    const closeCallIndex = mocks.callVueMethod.mock.calls.findIndex(
      ([, method, taskId]) => method === "store.closeTask" && taskId === "sdk-task",
    );
    expect(killCallIndex).toBeGreaterThanOrEqual(0);
    expect(closeCallIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.tauriInvoke.mock.invocationCallOrder[killCallIndex]).toBeLessThan(
      mocks.callVueMethod.mock.invocationCallOrder[closeCallIndex],
    );
  });

  it("refuses to import repos from the live checkout", async () => {
    const client = {};

    process.env.KANNA_E2E_LIVE_REPO_ROOT = "/live/kanna";
    mocks.callVueMethod.mockResolvedValue(undefined);

    const { importTestRepo } = await import("./reset");

    await expect(importTestRepo(client as never, "/live/kanna/apps", "bad-repo")).rejects.toThrow(
      /fixture repo/i,
    );
    expect(mocks.callVueMethod).not.toHaveBeenCalled();
  });

  it("refuses to remove worktrees when no baseline was recorded for the repo", async () => {
    const client = {};

    const { cleanupWorktrees } = await import("./reset");

    await cleanupWorktrees(client as never, "/repo");

    expect(mocks.tauriInvoke).not.toHaveBeenCalled();
  });

  it("imports through the UI and waits for the imported repo to become selected", async () => {
    const client = createImportClient([
      { selectedRepoId: null, selectedRepoPath: null },
      { selectedRepoId: null, selectedRepoPath: null },
      { selectedRepoId: "repo-1", selectedRepoPath: "/repo" },
    ]);

    mocks.tauriInvoke.mockResolvedValueOnce([]);
    mocks.queryDb.mockResolvedValueOnce([{ id: "repo-1", name: "test-repo" }]);

    const { importTestRepo } = await import("./reset");

    await expect(importTestRepo(client as never, "/repo", "test-repo")).resolves.toBe("repo-1");
    expect(client.sendKeys).toHaveBeenCalledWith("repo-path-input", "/repo");
    expect(client.clear).toHaveBeenCalledWith("repo-name-input");
    expect(client.sendKeys).toHaveBeenCalledWith("repo-name-input", "test-repo");
    expect(client.click).toHaveBeenCalledWith(".modal-overlay .repo-name-change");
    expect(client.click).toHaveBeenCalledWith(".modal-overlay .btn-primary:not(:disabled)");
    expect(client.waitForNoElement).toHaveBeenCalledWith(".modal-overlay", 30_000);
    expect(client.executeSync).toHaveBeenCalled();
  });

  it("closes open tasks through the app before wiping the database", async () => {
    const client = {};
    mocks.getVueState.mockResolvedValue("kanna-test.db");
    mocks.queryDb
      .mockResolvedValueOnce([
        { id: "task-a" },
        { id: "task-b" },
      ])
      .mockResolvedValue([
        { closed_at: "2026-04-22T00:00:00.000Z" },
      ]);
    mocks.execDb.mockResolvedValue(undefined);
    mocks.callVueMethod.mockResolvedValue(undefined);
    mocks.tauriInvoke
      .mockResolvedValueOnce("/tmp/app-data")
      .mockResolvedValue(undefined);

    const { resetDatabase } = await import("./reset");

    await resetDatabase(client as never);

    expect(mocks.callVueMethod).toHaveBeenCalledWith(
      client,
      "store.closeTask",
      "task-a",
    );
    expect(mocks.callVueMethod).toHaveBeenCalledWith(
      client,
      "store.closeTask",
      "task-b",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishDesktopLanTaskSnapshot } from "./desktopLanTaskIndex";
import { setDesktopSnapshotFetcherForTests } from "./desktopServerClient";
import { __resetRepoRemoteUrlCacheForTests } from "./repoRemoteUrl";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listRepos: vi.fn(),
  listPipelineItems: vi.fn(),
  listBlockersForItem: vi.fn(),
  updateRepoRemoteMetadata: vi.fn(),
}));

vi.mock("@kanna/" + "db", () => ({
  listRepos: (...args: unknown[]) => mocks.listRepos(...args),
  listPipelineItems: (...args: unknown[]) => mocks.listPipelineItems(...args),
  listBlockersForItem: (...args: unknown[]) => mocks.listBlockersForItem(...args),
  updateRepoRemoteMetadata: (...args: unknown[]) => mocks.updateRepoRemoteMetadata(...args),
}));

vi.mock("../invoke", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

function repo() {
  return {
    id: "repo-1",
    name: "Repo One",
    path: "/repo",
    default_branch: "main",
    remote_url: "git@github.com:owner/repo.git",
    remote_url_hash: "b1cd17c6cfc6f18ca212b7e8ac47cfe7429102823006de2bc18203527bfb711e",
  };
}

function openItem(id: string) {
  return {
    id,
    repo_id: "repo-1",
    prompt: "Open task",
    stage: "in progress",
    activity: "working",
    branch: id,
    base_ref: "main",
    pr_number: null,
    pr_url: null,
    display_name: null,
    agent_provider: "claude",
    agent_type: "pty",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:01.000Z",
    closed_at: null,
  };
}

describe("desktop LAN task index publisher", () => {
  beforeEach(() => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [],
      taskBlockers: [],
      blockerTaskStates: {},
      worktreePaths: {},
      settings: {},
    }));
    __resetRepoRemoteUrlCacheForTests();
    mocks.invoke.mockReset();
    mocks.listRepos.mockReset();
    mocks.listPipelineItems.mockReset();
    mocks.listBlockersForItem.mockReset();
    mocks.updateRepoRemoteMetadata.mockReset();

    mocks.listRepos.mockResolvedValue([repo()]);
    mocks.listPipelineItems.mockResolvedValue([openItem("task-open")]);
    mocks.listBlockersForItem.mockResolvedValue([]);
    mocks.updateRepoRemoteMetadata.mockResolvedValue(undefined);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "read_env_var") return "";
      if (command === "mobile_server_status") return { desktopId: "desktop-owner" };
      if (command === "git_remote_url") return "git@github.com:owner/repo.git";
      if (command === "set_transfer_task_snapshot") return null;
      return null;
    });
  });

  it("uses persisted repo remote metadata during periodic publishes", async () => {
    await publishDesktopLanTaskSnapshot(null as never);
    await publishDesktopLanTaskSnapshot(null as never);

    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "git_remote_url"),
    ).toHaveLength(0);
  });

  it("omits resolved blockers from the published task snapshot", async () => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [{ repo: repo() as never, items: [openItem("task-open") as never] }],
      taskBlockers: [{ blocked_item_id: "task-open", blocker_item_id: "task-closed" }],
      blockerTaskStates: {
        "task-closed": {
          closed_at: "2026-07-19T22:49:04Z",
          stage: "pr",
          pr_url: "https://github.com/acme/repo/pull/7",
        },
      },
      worktreePaths: {},
      settings: {},
    }));

    await publishDesktopLanTaskSnapshot();

    const publishCall = mocks.invoke.mock.calls.find(
      ([command]) => command === "set_transfer_task_snapshot",
    );
    expect(publishCall?.[1].snapshot.tasks[0].blockedByTaskIds).toEqual([]);
  });
});

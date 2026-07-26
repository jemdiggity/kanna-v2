import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mapDesktopCloudTasks,
  type DesktopCloudTaskSnapshot,
} from "./desktopCloudTaskIndex";
import {
  listDesktopLanTasks,
  publishDesktopLanTaskSnapshot,
} from "./desktopLanTaskIndex";
import { setDesktopSnapshotFetcherForTests } from "./desktopServerClient";
import { __resetRepoRemoteUrlCacheForTests } from "./repoRemoteUrl";
import { buildWorkspace } from "../workspace/buildWorkspace";

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
    activity_revision: 5,
    blocker_revision: 11,
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

function remoteLanTaskSnapshot(
  overrides: Partial<DesktopCloudTaskSnapshot> = {},
): DesktopCloudTaskSnapshot {
  return {
    cloudTaskId: "spoofed-shared-id",
    localRepoId: "repo-1",
    ownerDesktopId: "spoofed-peer",
    ownerLocalTaskId: "task-a",
    title: "Remote LAN task",
    promptSnippet: "Remote LAN task prompt",
    waitingPromptSnippet: null,
    displayName: null,
    stage: "in progress",
    activity: "working",
    activityRevision: 4,
    status: "active",
    repo: {
      cloudRepoId: "repo-1",
      name: "Repo One",
      remoteUrl: "git@github.com:owner/repo.git",
      remoteUrlHash: "b1cd17c6cfc6f18ca212b7e8ac47cfe7429102823006de2bc18203527bfb711e",
      defaultBranch: "main",
    },
    branch: "task-task-a",
    baseRef: "main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:01:00.000Z",
    closedAt: null,
    ...overrides,
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

  it("publishes the owner activity revision in LAN task snapshots", async () => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [{ repo: repo() as never, items: [openItem("task-open") as never] }],
      taskBlockers: [],
      blockerTaskStates: {},
      worktreePaths: {},
      settings: {},
    }));

    await publishDesktopLanTaskSnapshot();

    const publishCall = mocks.invoke.mock.calls.find(
      ([command]) => command === "set_transfer_task_snapshot",
    );
    expect(publishCall?.[1].snapshot.tasks[0].activityRevision).toBe(5);
    expect(publishCall?.[1].snapshot.tasks[0].blockerRevision).toBe(11);
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

  it("falls back to visible task state when blocker task states are unavailable", async () => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [{
        repo: repo() as never,
        items: [
          openItem("task-open") as never,
          {
            ...openItem("task-blocker"),
            stage: "pr",
            pr_url: "https://github.com/acme/repo/pull/8",
          } as never,
        ],
      }],
      taskBlockers: [{ blocked_item_id: "task-open", blocker_item_id: "task-blocker" }],
      worktreePaths: {},
      settings: {},
    }));

    await publishDesktopLanTaskSnapshot();

    const publishCall = mocks.invoke.mock.calls.find(
      ([command]) => command === "set_transfer_task_snapshot",
    );
    const publishedTask = publishCall?.[1].snapshot.tasks.find(
      (task: { ownerLocalTaskId: string }) => task.ownerLocalTaskId === "task-open",
    );
    expect(publishedTask.blockedByTaskIds).toEqual([]);
  });
});

describe("desktop LAN task index reader", () => {
  it("lets a newer cleared LAN blocker revision supersede an equal-updatedAt stale cloud snapshot", async () => {
    const staleCloudTask = {
      ...remoteLanTaskSnapshot({
        cloudTaskId: "cloud-stale-task",
        ownerDesktopId: "peer-owner",
        blockedByTaskIds: ["task-blocker"],
        updatedAt: "2026-06-13T00:01:00.000Z",
      }),
      blockerRevision: 4,
    } as DesktopCloudTaskSnapshot;
    const newerLanTask = {
      ...remoteLanTaskSnapshot({
        blockedByTaskIds: [],
        updatedAt: staleCloudTask.updatedAt,
      }),
      blockerRevision: 5,
    } as DesktopCloudTaskSnapshot;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_transfer_task_snapshots") {
        return [{
          peer_id: "peer-owner",
          snapshot: {
            schemaVersion: 1,
            tasks: [newerLanTask],
            publishedAt: "2026-06-13T00:05:00.000Z",
          },
        }];
      }
      return null;
    });

    const cloudSnapshot = mapDesktopCloudTasks([staleCloudTask], {
      currentDesktopId: "peer-local",
    });
    const lanSnapshot = await listDesktopLanTasks({
      currentDesktopId: "peer-local",
    });
    const workspace = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot,
      lanSnapshot,
    });

    expect(workspace.tasks).toHaveLength(1);
    expect(workspace.tasks[0].item.updated_at).toBe(staleCloudTask.updatedAt);
    expect(workspace.tasks[0].blockedByTaskIds).toEqual([]);
  });

  it("keeps arbitrary canonical task identities paired with their terminal refs and activity revisions", async () => {
    const fallbackRepoTask = remoteLanTaskSnapshot({
      ownerDesktopId: "fourth-spoofed-peer",
      ownerLocalTaskId: "a:b",
      title: "Fallback repo LAN task",
      promptSnippet: "Fallback repo LAN task prompt",
      activityRevision: 15,
      repo: {
        cloudRepoId: "repo",
        name: "Fallback Repo",
        remoteUrl: "git@github.com:owner/fallback.git",
        remoteUrlHash: "63ce1a35c84d8028dffb2fb93c5997506e0f5e4f460319183666540103e4fc46",
        defaultBranch: "main",
      },
      branch: "task-a-b",
      updatedAt: "2026-06-13T00:04:00.000Z",
    });
    delete fallbackRepoTask.localRepoId;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_transfer_task_snapshots") {
        return [{
          peer_id: "peer-owner",
          snapshot: {
            schemaVersion: 1,
            tasks: [
              remoteLanTaskSnapshot(),
              remoteLanTaskSnapshot({
                ownerDesktopId: "other-spoofed-peer",
                ownerLocalTaskId: "task-b",
                title: "Second remote LAN task",
                promptSnippet: "Second remote LAN task prompt",
                activityRevision: 9,
                branch: "task-task-b",
                updatedAt: "2026-06-13T00:02:00.000Z",
              }),
              remoteLanTaskSnapshot({
                localRepoId: "repo:a",
                ownerDesktopId: "third-spoofed-peer",
                ownerLocalTaskId: "b",
                title: "Delimiter collision LAN task",
                promptSnippet: "Delimiter collision LAN task prompt",
                activityRevision: 12,
                branch: "task-b",
                updatedAt: "2026-06-13T00:03:00.000Z",
              }),
              fallbackRepoTask,
            ],
            publishedAt: "2026-06-13T00:05:00.000Z",
          },
        }];
      }
      return null;
    });

    const snapshot = await listDesktopLanTasks({
      currentDesktopId: "peer-local",
    });

    expect(snapshot.items).toHaveLength(4);
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(4);

    const expectedByPrompt = new Map([
      ["Remote LAN task prompt", {
        ownerLocalRepoId: "repo-1",
        ownerLocalTaskId: "task-a",
        activityRevision: 4,
      }],
      ["Second remote LAN task prompt", {
        ownerLocalRepoId: "repo-1",
        ownerLocalTaskId: "task-b",
        activityRevision: 9,
      }],
      ["Delimiter collision LAN task prompt", {
        ownerLocalRepoId: "repo:a",
        ownerLocalTaskId: "b",
        activityRevision: 12,
      }],
      ["Fallback repo LAN task prompt", {
        ownerLocalRepoId: "repo",
        ownerLocalTaskId: "a:b",
        activityRevision: 15,
      }],
    ]);
    for (const item of snapshot.items) {
      const expected = expectedByPrompt.get(item.prompt);
      expect(expected).toBeDefined();
      expect(item.activity_revision).toBe(expected?.activityRevision);
      expect(snapshot.terminalRefs[item.id]).toEqual({
        transport: "lan",
        ownerDesktopId: "peer-owner",
        ownerLocalRepoId: expected?.ownerLocalRepoId,
        ownerLocalTaskId: expected?.ownerLocalTaskId,
        transferPeerId: "peer-owner",
        preferredTransferTransport: "lan",
      });
    }
  });
});

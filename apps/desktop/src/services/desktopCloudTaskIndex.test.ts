import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(() => "tasks-ref"),
  connectFirestoreEmulator: vi.fn(),
  getDocs: vi.fn(),
  getFirestore: vi.fn(),
  query: vi.fn(() => "query-ref"),
  where: vi.fn(() => "where-ref"),
}));

vi.mock("./desktopRelayTerminal", () => ({
  listActiveDesktopIdsViaRelay: vi.fn(),
}));

import { getDocs } from "firebase/firestore";
import { listActiveDesktopIdsViaRelay } from "./desktopRelayTerminal";
import { listDesktopCloudTasks, mapDesktopCloudTasks, type DesktopCloudTaskSnapshot } from "./desktopCloudTaskIndex";

function remoteTaskSnapshot(overrides: Partial<DesktopCloudTaskSnapshot> = {}): DesktopCloudTaskSnapshot {
  return {
    cloudTaskId: "remote-repo-id:task-1",
    ownerDesktopId: "peer-primary",
    ownerLocalTaskId: "task-1",
    title: "Remote task",
    promptSnippet: "Remote task prompt",
    displayName: null,
    stage: "in progress",
    activity: "idle",
    status: "active",
    repo: {
      cloudRepoId: "remote-repo-id",
      name: "kanna",
      defaultBranch: "main",
      remoteUrlHash: "same-remote",
    },
    branch: "task-task-1",
    baseRef: "origin/main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:01:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getDocs).mockReset();
  vi.mocked(listActiveDesktopIdsViaRelay).mockReset();
});

describe("mapDesktopCloudTasks", () => {
  it("maps cloud snapshots into sidebar-compatible repos and tasks", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "repo-1:task-1",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        title: "Cloud task",
        promptSnippet: "Cloud task prompt",
        displayName: null,
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: {
          cloudRepoId: "repo-1",
          name: "kanna",
          remoteUrl: "git@github.com:jemdiggity/kanna.git",
          defaultBranch: "main",
        },
        branch: "task-task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "codex", type: "sdk" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ]);

    expect(snapshot.repos).toMatchObject([
      {
        id: "cloud:repo-1",
        name: "kanna",
        path: "cloud",
        remote_url: "git@github.com:jemdiggity/kanna.git",
      },
    ]);
    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:repo-1:task-1",
        repo_id: "cloud:repo-1",
        display_name: "Cloud task (peer-primary)",
        prompt: "Cloud task prompt",
        agent_provider: "codex",
        agent_type: "sdk",
      },
    ]);
    expect(snapshot.terminalRefs["cloud:repo-1:task-1"]).toEqual({
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: "task-1",
      transport: "cloud",
    });
  });

  it("preserves OpenCode as the cloud task agent provider", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "repo-1:task-opencode",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-opencode",
        title: "OpenCode cloud task",
        promptSnippet: "Cloud task prompt",
        displayName: null,
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: {
          cloudRepoId: "repo-1",
          name: "kanna",
          remoteUrl: "git@github.com:jemdiggity/kanna.git",
          defaultBranch: "main",
        },
        branch: "task-opencode",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "opencode", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ]);

    expect(snapshot.items[0]?.agent_provider).toBe("opencode");
  });

  it("groups cloud tasks under a local repo when the remote URL hash matches", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "remote-repo-id:task-1",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        title: "Remote task",
        promptSnippet: "Remote task prompt",
        displayName: null,
        stage: "in progress",
        activity: "idle",
        status: "active",
        repo: {
          cloudRepoId: "remote-repo-id",
          name: "kanna",
          defaultBranch: "main",
          remoteUrlHash: "same-remote",
        },
        branch: "task-task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "codex", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ], {
      localRepos: [{
        repo: {
          id: "local-repo",
          path: "/Users/test/kanna",
          name: "kanna",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-13T00:00:00.000Z",
          last_opened_at: "2026-05-13T00:00:00.000Z",
        },
        remoteUrlHash: "same-remote",
      }],
    });

    expect(snapshot.repos).toEqual([]);
    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:remote-repo-id:task-1",
        repo_id: "local-repo",
        display_name: "Remote task (peer-primary)",
      },
    ]);
  });

  it("prefers an exact local repo id over a duplicate remote URL hash match", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "kanna-local:task-1",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        title: "Remote task",
        promptSnippet: "Remote task prompt",
        displayName: null,
        stage: "in progress",
        activity: "idle",
        status: "active",
        repo: {
          cloudRepoId: "kanna-local",
          name: "kanna",
          defaultBranch: "main",
          remoteUrlHash: "same-remote",
        },
        branch: "task-task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "codex", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ], {
      localRepos: [
        {
          repo: {
            id: "kanna-local",
            path: "/Users/test/.kanna/repos/kanna",
            name: "kanna",
            default_branch: "main",
            hidden: 0,
            sort_order: 0,
            created_at: "2026-05-13T00:00:00.000Z",
            last_opened_at: "2026-05-13T00:00:00.000Z",
          },
          remoteUrlHash: "same-remote",
        },
        {
          repo: {
            id: "kanna-tauri-stale",
            path: "/Users/test/Documents/work/jemdiggity/kanna-tauri",
            name: "kanna-tauri",
            default_branch: "main",
            hidden: 0,
            sort_order: 3,
            created_at: "2026-03-21T00:00:00.000Z",
            last_opened_at: "2026-03-21T00:00:00.000Z",
          },
          remoteUrlHash: "same-remote",
        },
      ],
    });

    expect(snapshot.repos).toEqual([]);
    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:kanna-local:task-1",
        repo_id: "kanna-local",
        display_name: "Remote task (peer-primary)",
      },
    ]);
  });

  it("keeps the remote URL hash on unmatched remote repos for later workspace matching", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "remote-repo-id:task-1",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        title: "Remote task",
        promptSnippet: "Remote task prompt",
        displayName: null,
        stage: "in progress",
        activity: "idle",
        status: "active",
        repo: {
          cloudRepoId: "remote-repo-id",
          name: "kanna",
          remoteUrl: "git@github.com:jemdiggity/kanna.git",
          remoteUrlHash: "same-remote",
          defaultBranch: "main",
        },
        branch: "task-task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "codex", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ]);

    expect(snapshot.repos).toMatchObject([
      {
        id: "cloud:remote-repo-id",
        remoteUrlHash: "same-remote",
      },
    ]);
  });

  it("keeps inactive cloud tasks visible without a live terminal ref", () => {
    const snapshot = mapDesktopCloudTasks([remoteTaskSnapshot({
      ownerDesktopId: "peer-offline",
      title: "Offline remote task",
      promptSnippet: "Offline remote task prompt",
    })], {
      activeDesktopIds: new Set(["peer-online"]),
    });

    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:remote-repo-id:task-1",
        prompt: "Offline remote task prompt",
      },
    ]);
    expect(snapshot.terminalRefs).toEqual({});
  });

  it("does not remove cloud tasks when relay presence misses the owner", async () => {
    vi.mocked(getDocs).mockResolvedValue({
      docs: [{
        data: () => remoteTaskSnapshot({
          ownerDesktopId: "peer-offline",
          title: "Offline remote task",
          promptSnippet: "Offline remote task prompt",
        }),
      }],
    } as never);
    vi.mocked(listActiveDesktopIdsViaRelay).mockResolvedValue(new Set(["peer-online"]));

    const snapshot = await listDesktopCloudTasks("user-1", {} as never);

    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:remote-repo-id:task-1",
        prompt: "Offline remote task prompt",
      },
    ]);
    expect(snapshot.terminalRefs).toEqual({});
  });

  it("omits stale cloud tasks that match a locally closed task", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "remote-repo-id:task-closed",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-closed",
        title: "Closed remote task",
        promptSnippet: "Closed remote task prompt",
        displayName: null,
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: {
          cloudRepoId: "remote-repo-id",
          name: "kanna",
          defaultBranch: "main",
          remoteUrlHash: "same-remote",
        },
        branch: "task-task-closed",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "claude", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ], {
      localRepos: [{
        repo: {
          id: "local-repo",
          path: "/Users/test/kanna",
          name: "kanna",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-13T00:00:00.000Z",
          last_opened_at: "2026-05-13T00:00:00.000Z",
        },
        remoteUrlHash: "same-remote",
      }],
      localItems: [{
        id: "task-closed",
        repo_id: "local-repo",
        stage: "done",
        closed_at: "2026-05-14T00:02:00.000Z",
      }],
    });

    expect(snapshot.items).toEqual([]);
    expect(snapshot.terminalRefs).toEqual({});
  });

  it("keeps same-owner snapshots visible when no local task matches", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "remote-repo-id:task-own",
        ownerDesktopId: "desktop-current",
        ownerLocalTaskId: "task-own",
        title: "Own task",
        promptSnippet: "Own task prompt",
        displayName: null,
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: {
          cloudRepoId: "remote-repo-id",
          name: "kanna",
          defaultBranch: "main",
          remoteUrlHash: "same-remote",
        },
        branch: "task-task-own",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "claude", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ], {
      currentDesktopId: "desktop-current",
    });

    expect(snapshot.items).toMatchObject([
      {
        id: "cloud:remote-repo-id:task-own",
        prompt: "Own task prompt",
      },
    ]);
    expect(snapshot.terminalRefs["cloud:remote-repo-id:task-own"]).toEqual({
      ownerDesktopId: "desktop-current",
      ownerLocalTaskId: "task-own",
      transport: "cloud",
    });
  });
});

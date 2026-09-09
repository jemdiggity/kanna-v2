import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((...segments: unknown[]) => ({ kind: "collection", segments })),
  connectFirestoreEmulator: vi.fn(),
  getDocs: vi.fn(),
  getFirestore: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn((collectionRef: unknown, ...constraints: unknown[]) => ({ kind: "query", collectionRef, constraints })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ kind: "where", field, op, value })),
}));

vi.mock("firebase/app", () => ({
  getApps: vi.fn(() => [{ name: "test" }]),
  initializeApp: vi.fn(),
}));

vi.mock("./desktopFirebaseConfig", () => ({
  resolveDesktopFirebaseConfig: vi.fn(async () => ({
    app: {
      apiKey: "test",
      authDomain: "test",
      projectId: "test",
      appId: "test",
    },
    firestoreEmulator: null,
  })),
}));

vi.mock("./desktopRelayTerminal", () => ({
  listActiveDesktopIdsViaRelay: vi.fn(),
}));

import { getDocs, getFirestore, onSnapshot } from "firebase/firestore";
import { listActiveDesktopIdsViaRelay } from "./desktopRelayTerminal";
import {
  listDesktopCloudTasks,
  mapDesktopCloudTasks,
  subscribeDesktopCloudTasks,
  type DesktopCloudTaskSnapshot,
} from "./desktopCloudTaskIndex";

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
    transitionRevision: "run-1",
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
  vi.mocked(onSnapshot).mockReset();
  vi.mocked(getFirestore).mockReturnValue({} as never);
});

describe("subscribeDesktopCloudTasks", () => {
  it("discards an older async presence lookup that completes after a newer snapshot", async () => {
    const callbacks: Array<(snapshot: { docs: Array<Record<string, unknown>> }) => void> = [];
    vi.mocked(onSnapshot).mockImplementation(((_ref: unknown, callback: typeof callbacks[number]) => {
      callbacks.push(callback);
      return () => {};
    }) as never);

    const presenceResolvers: Array<(desktopIds: Set<string>) => void> = [];
    vi.mocked(listActiveDesktopIdsViaRelay).mockImplementation(() => new Promise((resolve) => {
      presenceResolvers.push(resolve);
    }));
    const updates: ReturnType<typeof mapDesktopCloudTasks>[] = [];
    subscribeDesktopCloudTasks("user-1", (snapshot) => updates.push(snapshot), {
      getOptions: () => ({ currentDesktopId: "desktop-local" }),
    });
    for (let attempt = 0; attempt < 10 && callbacks.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(callbacks).toHaveLength(1);

    const desktopRef = { kind: "desktop-ref" };
    callbacks[0]({
      docs: [{
        id: "desktop-remote",
        ref: desktopRef,
        data: () => ({ displayName: "Remote Mac" }),
      }],
    });
    callbacks[1]({ docs: [{ data: () => remoteTaskSnapshot({
      ownerDesktopId: "desktop-remote",
      title: "Older",
    }) }] });
    callbacks[1]({ docs: [{ data: () => remoteTaskSnapshot({
      ownerDesktopId: "desktop-remote",
      title: "Newer",
    }) }] });
    expect(presenceResolvers).toHaveLength(3);

    presenceResolvers[2](new Set(["desktop-remote"]));
    for (let attempt = 0; attempt < 10 && updates.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(updates).toHaveLength(1);
    expect(updates.at(-1)?.items[0]?.display_name).toBe("Newer (desktop-remote)");

    presenceResolvers[0](new Set());
    presenceResolvers[1](new Set());
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(updates[0].items[0]?.display_name).toBe("Newer (desktop-remote)");
  });
});

describe("mapDesktopCloudTasks", () => {
  it("keeps remote runtime and read state as independent dimensions", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        activity: "unread",
        runtimeState: "busy",
        readState: "unread",
      }),
    ]);

    expect(snapshot.items[0]).toMatchObject({
      activity: "unread",
      runtime_state: "busy",
      read_state: "unread",
    });
  });

  it("selects one destination authority during overlapping transfer publications", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        ownerDesktopId: "desktop-source",
        ownerLocalTaskId: "task-source",
        title: "Stale source title",
        blockedByTaskIds: ["source-blocker"],
        activityRevision: 99,
        updatedAt: "2026-07-27T00:02:00.000Z",
        transfer: {
          state: "outgoing",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-source",
          destinationDesktopId: "desktop-destination",
        },
      }),
      remoteTaskSnapshot({
        ownerDesktopId: "desktop-destination",
        ownerLocalTaskId: "task-destination",
        title: "Destination title",
        blockedByTaskIds: ["destination-blocker"],
        activityRevision: 12,
        transitionRevision: "destination-run",
        updatedAt: "2026-07-27T00:01:00.000Z",
        transfer: {
          state: "finalization_pending",
          transferId: "transfer-1",
          sourceDesktopId: "desktop-source",
          destinationDesktopId: "desktop-destination",
        },
      }),
    ]);

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      display_name: "Destination title (desktop-destination)",
      activity_revision: 12,
      transition_revision: "destination-run",
    });
    expect(snapshot.terminalRefs["cloud:remote-repo-id:task-1"]).toMatchObject({
      ownerDesktopId: "desktop-destination",
      ownerLocalTaskId: "task-destination",
    });
    expect(snapshot.blockedByTaskIds).toEqual({
      "cloud:remote-repo-id:task-1": ["destination-blocker"],
    });
  });

  it("preserves blocker task ids for workspace projection", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-blocked",
        ownerLocalTaskId: "task-blocked",
        blockedByTaskIds: ["task-one", "task-two", "task-one"],
      }),
    ]);

    expect(snapshot.blockedByTaskIds).toEqual({
      "cloud:remote-repo-id:task-blocked": ["task-one", "task-two"],
    });
  });

  it("carries the owner's singleton identity onto the presentation row", () => {
    // The presentation row cannot reproduce the owner's synthetic
    // `singleton-{agent}` workflow name, so singleton identity travels as its
    // own published field — it is what lets a viewing machine pin the
    // account-wide singleton by default.
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-merge",
        ownerLocalTaskId: "task-merge",
        singletonAgent: "merge",
      }),
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-ordinary",
        ownerLocalTaskId: "task-ordinary",
      }),
    ]);

    const singleton = snapshot.items.find((item) => item.id.endsWith("task-merge"));
    const ordinary = snapshot.items.find((item) => item.id.endsWith("task-ordinary"));
    expect(singleton?.singleton_agent).toBe("merge");
    expect(ordinary?.singleton_agent).toBeNull();
  });

  it("resolves an owner-published parent into the local presentation id", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-parent",
        ownerLocalTaskId: "task-parent",
      }),
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-child",
        ownerLocalTaskId: "task-child",
        parentTaskId: "task-parent",
      }),
      // Auto-id documents mint their id from the owner identity, so the parent
      // reference has to survive that spelling too.
      remoteTaskSnapshot({
        cloudTaskId: undefined,
        localRepoId: "remote-repo-id",
        ownerLocalTaskId: "task-auto-child",
        parentTaskId: "task-parent",
      }),
    ]);

    expect(snapshot.items.map((item) => [item.id, item.parent_task_id])).toEqual(
      expect.arrayContaining([
        ["cloud:remote-repo-id:task-parent", null],
        ["cloud:remote-repo-id:task-child", "cloud:remote-repo-id:task-parent"],
        ["cloud:peer-primary:remote-repo-id:task-auto-child", "cloud:remote-repo-id:task-parent"],
      ]),
    );
  });

  it("drops parent references the owner did not publish alongside the task", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-child",
        ownerLocalTaskId: "task-child",
        parentTaskId: "task-closed-parent",
      }),
      // Same owner-side task id, published by a different desktop: not this parent.
      remoteTaskSnapshot({
        cloudTaskId: "other-repo-id:task-closed-parent",
        ownerDesktopId: "peer-secondary",
        ownerLocalTaskId: "task-closed-parent",
      }),
    ]);

    expect(snapshot.items.find((item) => item.id === "cloud:remote-repo-id:task-child"))
      .toMatchObject({ parent_task_id: null });
  });

  it("attaches the reachable owner's transfer route to remote terminal refs", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({ ownerDesktopId: "desktop-owner" }),
    ], {
      activeDesktopIds: new Set(["desktop-owner"]),
    }, [{
      documentId: "desktop-owner",
      snapshot: {
        desktopId: "desktop-owner",
        displayName: "Owner Mac",
        transfer: {
          peerId: "peer-owner",
          publicKey: "owner-key",
          protocolVersion: 1,
          acceptingTransfers: true,
        },
      },
    }]);

    expect(snapshot.terminalRefs["cloud:remote-repo-id:task-1"]).toMatchObject({
      transferPeerId: "peer-owner",
      preferredTransferTransport: "cloud",
    });
  });

  it("maps cloud snapshots into sidebar-compatible repos and tasks", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "repo-1:task-1",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        title: "Cloud task",
        promptSnippet: "Cloud task prompt",
        waitingPromptSnippet: "Ready for review",
        displayName: null,
        stage: "in progress",
        activity: "working",
        activityRevision: 9,
        transitionRevision: "run-cloud-9",
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
        agent: { provider: "codex", type: "agent" },
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
        last_output_preview: "Ready for review",
        agent_provider: "codex",
        agent_type: "agent",
        activity_revision: 9,
        transition_revision: "run-cloud-9",
      },
    ]);
    expect(snapshot.terminalRefs["cloud:repo-1:task-1"]).toEqual({
      ownerDesktopId: "peer-primary",
      ownerLocalRepoId: "repo-1",
      ownerLocalTaskId: "task-1",
      transport: "cloud",
    });
  });

  it("maps the running-post flag so remote tasks show the transition-in-flight indicator", () => {
    const snapshot = mapDesktopCloudTasks([
      remoteTaskSnapshot({ hasRunningPost: true }),
      remoteTaskSnapshot({
        cloudTaskId: "remote-repo-id:task-2",
        ownerLocalTaskId: "task-2",
      }),
    ]);

    expect(snapshot.items).toMatchObject([
      { id: "cloud:remote-repo-id:task-1", has_running_post: 1 },
      { id: "cloud:remote-repo-id:task-2", has_running_post: 0 },
    ]);
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

  it("preserves Antigravity as the cloud task agent provider", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "repo-1:task-antigravity",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-antigravity",
        title: "Antigravity cloud task",
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
        branch: "task-antigravity",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "antigravity", type: "pty" },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      },
    ]);

    expect(snapshot.items[0]?.agent_provider).toBe("antigravity");
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

  it("maps auto-id cloud task documents by local repo and owner task fields", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        localRepoId: "local-repo",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-1",
        title: "Remote task",
        promptSnippet: "Remote task prompt",
        displayName: null,
        stage: "in progress",
        activity: "idle",
        status: "active",
        repo: {
          cloudRepoId: "legacy-repo",
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
        id: "cloud:desktop-owner:local-repo:task-1",
        repo_id: "local-repo",
        display_name: "Remote task (desktop-owner)",
      },
    ]);
    expect(snapshot.terminalRefs["cloud:desktop-owner:local-repo:task-1"]).toEqual({
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "local-repo",
      ownerLocalTaskId: "task-1",
      transport: "cloud",
    });
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

  it("derives transfer machines from the authenticated desktop documents", async () => {
    vi.mocked(getDocs)
      .mockResolvedValueOnce({
        docs: [{
          id: "desktop-doc-a",
          ref: { kind: "desktop-ref", id: "desktop-doc-a" },
          data: () => ({
            desktopId: "desktop-a",
            displayName: "Studio Mac",
            transfer: {
              peerId: "peer-a",
              publicKey: "base64-key",
              protocolVersion: 1,
              acceptingTransfers: true,
            },
          }),
        }],
      } as never)
      .mockResolvedValueOnce({ docs: [] } as never);
    vi.mocked(listActiveDesktopIdsViaRelay).mockResolvedValue(new Set(["desktop-a"]));

    const snapshot = await listDesktopCloudTasks("user-1", {} as never, {
      currentDesktopId: "desktop-current",
    });

    expect(snapshot).toMatchObject({
      transferMachines: [{
        desktopId: "desktop-a",
        displayName: "Studio Mac",
        online: true,
        peerId: "peer-a",
        publicKey: "base64-key",
        protocolVersion: 1,
        acceptingTransfers: true,
      }],
    });
  });

  it("does not remove cloud tasks when relay presence misses the owner", async () => {
    vi.mocked(getDocs)
      .mockResolvedValueOnce({
        docs: [{
          ref: { kind: "desktop-ref", id: "desktop-doc" },
          data: () => ({ desktopId: "peer-offline" }),
        }],
      } as never)
      .mockResolvedValueOnce({
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
    expect(vi.mocked(getDocs)).toHaveBeenCalledTimes(2);
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

  it("omits stale cloud tasks that match a separately loaded closed local identity", () => {
    const snapshot = mapDesktopCloudTasks([
      {
        cloudTaskId: "remote-repo-id:task-closed",
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-closed",
        title: "Closed review task",
        promptSnippet: "Closed review task prompt",
        displayName: null,
        stage: "review",
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
      localClosedItems: [{
        id: "task-closed",
        repo_id: "local-repo",
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
      ownerLocalRepoId: "remote-repo-id",
      ownerLocalTaskId: "task-own",
      transport: "cloud",
    });
  });
});

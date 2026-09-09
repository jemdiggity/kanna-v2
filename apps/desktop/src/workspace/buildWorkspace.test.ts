import { describe, expect, it } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import { DEFAULT_SINGLETON_PIN_ORDER } from "../utils/singletonTask";
import { buildWorkspace, workspaceTaskOwnerTaskId } from "./buildWorkspace";

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-local",
    path: "/repo",
    name: "kanna",
    default_branch: "main",
    hidden: 0,
    sort_order: 0,
    created_at: "2026-05-23T00:00:00.000Z",
    last_opened_at: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-local",
    repo_id: "repo-local",
    prompt: "Build workspace",
    workflow: "default",
    stage: "in progress",
    tags: "[\"in progress\"]",
    pr_number: null,
    pr_url: null,
    branch: "task-local",
    activity: "working",
    activity_changed_at: "2026-05-23T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    issue_number: null,
    issue_title: null,
    closed_at: null,
    agent_session_id: null,
    base_ref: "origin/main",
    agent_provider: "codex",
    agent_type: "agent",
    previous_stage: null,
    stage_result: null,
    teardown_started_at: null,
    last_output_preview: null,
    active_post_action: null,
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function emptySnapshot() {
  return {
    repos: [],
    items: [],
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

describe("buildWorkspace", () => {
  it("interleaves remote-only repos by durable hash order and preserves it after local import", () => {
    const remoteRepo = repo({
      id: "cloud:repo-remote",
      path: "cloud",
      name: "remote",
      remote_url_hash: "hash-remote",
      sort_order: 7,
    });
    const snapshots = {
      cloudSnapshot: {
        repos: [remoteRepo],
        items: [],
        terminalRefs: {},
        blockedByTaskIds: {},
        transferMachines: [],
      },
      lanSnapshot: {
        repos: [],
        items: [],
        terminalRefs: {},
        blockedByTaskIds: {},
        transferMachines: [],
      },
    };

    const remoteOnly = buildWorkspace({
      localRepos: [
        { repo: repo({ id: "repo-first", sort_order: 0 }), remoteUrlHash: null },
        { repo: repo({ id: "repo-last", sort_order: 2 }), remoteUrlHash: null },
      ],
      localItems: [],
      ...snapshots,
      repoSidebarOrder: new Map([["hash-remote", 1]]),
    });
    expect(remoteOnly.repos.map((entry) => [entry.key, entry.sortOrder])).toEqual([
      ["repo-first", 0],
      ["cloud:repo-remote", 1],
      ["repo-last", 2],
    ]);

    const imported = buildWorkspace({
      localRepos: [
        { repo: repo({ id: "repo-first", sort_order: 0 }), remoteUrlHash: null },
        {
          repo: repo({ id: "repo-imported", sort_order: 1, remote_url_hash: "hash-remote" }),
          remoteUrlHash: "hash-remote",
        },
        { repo: repo({ id: "repo-last", sort_order: 2 }), remoteUrlHash: null },
      ],
      localItems: [],
      ...snapshots,
      repoSidebarOrder: new Map([["hash-remote", 1]]),
    });
    expect(imported.repos.map((entry) => [entry.key, entry.sortOrder])).toEqual([
      ["repo-first", 0],
      ["repo-imported", 1],
      ["repo-last", 2],
    ]);
    expect(imported.repos[1]?.source).toBe("mixed");
  });

  it("deduplicates equally fresh remote blocker ids across cloud and LAN sources", () => {
    const cloudItem = item({
      id: "cloud:repo-remote:blocked-owner",
      repo_id: "cloud:repo-remote",
      updated_at: "2026-07-25T00:00:00.000Z",
    });
    const lanItem = { ...cloudItem };
    const terminalRef = {
      ownerDesktopId: "desktop-owner",
      ownerLocalTaskId: "blocked-owner",
    };

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          [cloudItem.id]: { ...terminalRef, transport: "cloud" },
        },
        blockedByTaskIds: {
          [cloudItem.id]: ["blocker-owner", "blocker-owner"],
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          [lanItem.id]: { ...terminalRef, transport: "lan" },
        },
        blockedByTaskIds: {
          [lanItem.id]: ["blocker-owner"],
        },
      },
    });

    expect(result.tasks[0].blockedByTaskIds).toEqual(["blocker-owner"]);
    expect(result.tasks[0].sources.map((source) => source.blockedByTaskIds))
      .toEqual([["blocker-owner", "blocker-owner"], ["blocker-owner"]]);
  });

  it("uses a newer remote source to clear stale blocker ids", () => {
    const cloudItem = item({
      id: "cloud:repo-remote:blocked-owner",
      repo_id: "cloud:repo-remote",
      updated_at: "2026-07-25T00:00:00.000Z",
    });
    const lanItem = item({
      id: cloudItem.id,
      repo_id: cloudItem.repo_id,
      updated_at: "2026-07-25T00:01:00.000Z",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          [cloudItem.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "blocked-owner",
            transport: "cloud",
          },
        },
        blockedByTaskIds: {
          [cloudItem.id]: ["blocker-owner"],
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          [lanItem.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "blocked-owner",
            transport: "lan",
          },
        },
        blockedByTaskIds: {},
      },
    });

    expect(result.tasks[0].blockedByTaskIds).toEqual([]);
  });

  it("selects all fields from the newer equal-precedence authority", () => {
    const firstCloudItem = item({
      id: "cloud:first:repo-remote:blocked-owner",
      repo_id: "cloud:repo-remote",
      prompt: "Selected cloud route",
      updated_at: "2026-07-25T00:00:00.000Z",
    });
    const newerCloudItem = item({
      id: "cloud:second:repo-remote:blocked-owner",
      repo_id: "cloud:repo-remote",
      prompt: "Newer owner metadata",
      updated_at: "2026-07-25T00:01:00.000Z",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [firstCloudItem, newerCloudItem],
        terminalRefs: {
          [firstCloudItem.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "blocked-owner",
            transport: "cloud",
          },
          [newerCloudItem.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "blocked-owner",
            transport: "cloud",
          },
        },
        blockedByTaskIds: {
          [firstCloudItem.id]: ["blocker-owner"],
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: newerCloudItem.id,
      item: {
        id: newerCloudItem.id,
        prompt: "Newer owner metadata",
      },
      blockedByTaskIds: [],
      terminal: {
        kind: "cloud",
        remoteRef: {
          ownerLocalTaskId: "blocked-owner",
          transport: "cloud",
        },
      },
    });
  });

  it("keeps local blocker state authoritative for a matching remote task", () => {
    const localItem = item({ id: "blocked-owner" });
    const cloudItem = item({
      id: "cloud:repo-local:blocked-owner",
      repo_id: "repo-local",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash" }],
      localItems: [localItem],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          [cloudItem.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: localItem.id,
            transport: "cloud",
          },
        },
        blockedByTaskIds: {
          [cloudItem.id]: ["remote-blocker"],
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks[0].owner.kind).toBe("local");
    expect(result.tasks[0].blockedByTaskIds).toEqual([]);
  });

  it("allows pull only when a reachable remote owner advertises a nonblank transfer peer", () => {
    const remote = item({
      id: "cloud:remote-repo:task-remote",
      repo_id: "cloud:remote-repo",
    });
    const build = (transferPeerId?: string) => buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [repo({ id: "cloud:remote-repo", path: "cloud" })],
        items: [remote],
        terminalRefs: {
          [remote.id]: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: "task-remote",
            transferPeerId,
            preferredTransferTransport: "cloud",
            transport: "cloud",
          },
        },
        transferMachines: [],
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(build(undefined).tasks[0]?.capabilities.canPullFromMachine).toBe(false);
    expect(build("   ").tasks[0]?.capabilities.canPullFromMachine).toBe(false);
    expect(build("peer-owner").tasks[0]?.capabilities.canPullFromMachine).toBe(true);
  });

  it("keeps a local task as a single local-owned workspace task", () => {
    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [item()],
      cloudSnapshot: emptySnapshot(),
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "local:task-local",
      localTaskId: "task-local",
      remoteTaskIds: [],
      repoKey: "repo-local",
      owner: { kind: "local" },
      reachability: "local",
      terminal: { kind: "local", localSessionId: "task-local" },
      capabilities: {
        canOpenTerminal: true,
        canClose: true,
        canPushToMachine: true,
        canPullFromMachine: false,
      },
    });
  });

  it("dedupes a cloud copy of a local task and keeps the local task identity", () => {
    const local = item({ id: "task-1", branch: "task-1" });
    const cloud = item({
      id: "cloud:repo-local:task-1",
      repo_id: "repo-local",
      branch: "task-1",
      display_name: "Build workspace (desktop-a)",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [local],
      cloudSnapshot: {
        repos: [],
        items: [cloud],
        terminalRefs: {
          "cloud:repo-local:task-1": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-1",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "local:task-1",
      localTaskId: "task-1",
      remoteTaskIds: ["cloud:repo-local:task-1"],
      terminal: { kind: "local", localSessionId: "task-1" },
    });
  });

  it("shows one remote task when LAN and cloud advertise the same owner task", () => {
    const cloudItem = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });
    const lanItem = item({ id: "cloud:lan:peer-a:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        }],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-2": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-2",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          "cloud:lan:peer-a:remote-repo:task-2": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-2",
            transport: "lan",
          },
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].remoteTaskIds.sort()).toEqual([
      "cloud:lan:peer-a:remote-repo:task-2",
      "cloud:remote-repo:task-2",
    ]);
    expect(result.tasks[0]).toMatchObject({
      reachability: "reachable",
      terminal: {
        kind: "lan",
        remoteRef: {
          ownerDesktopId: "desktop-a",
          ownerLocalTaskId: "task-2",
          transport: "lan",
        },
      },
    });
  });

  it("selects every routed task field from the exact reachable LAN advertisement", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-provenance",
      repo_id: "repo-local",
      prompt: "Cloud task copy",
      activity_revision: 7,
    });
    const lanItem = item({
      id: "cloud:lan:peer-lan:remote-repo:task-provenance",
      repo_id: "repo-local",
      prompt: "LAN task copy",
      activity_revision: 7,
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-provenance": {
            ownerDesktopId: "desktop-cloud",
            ownerLocalTaskId: "task-provenance",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          "cloud:lan:peer-lan:remote-repo:task-provenance": {
            ownerDesktopId: "desktop-lan",
            ownerLocalTaskId: "task-provenance",
            transport: "lan",
          },
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "cloud:lan:peer-lan:remote-repo:task-provenance",
      remoteTaskIds: [
        "cloud:remote-repo:task-provenance",
        "cloud:lan:peer-lan:remote-repo:task-provenance",
      ],
      item: {
        id: "cloud:lan:peer-lan:remote-repo:task-provenance",
        prompt: "LAN task copy",
        activity_revision: 7,
      },
      owner: { kind: "remote", id: "desktop-lan" },
      reachability: "reachable",
      terminal: {
        kind: "lan",
        remoteRef: {
          ownerDesktopId: "desktop-lan",
          ownerLocalTaskId: "task-provenance",
          transport: "lan",
        },
      },
      capabilities: {
        canOpenTerminal: true,
        canSendInput: true,
        canOpenDiff: true,
        canClose: true,
        canAdvanceStage: true,
      },
    });
  });

  it("replaces an equal-precedence advertisement when its authority is newer", () => {
    const firstCloudItem = item({
      id: "cloud:first:remote-repo:task-provenance",
      repo_id: "repo-local",
      prompt: "First cloud copy",
      activity_revision: 9,
    });
    const secondCloudItem = item({
      id: "cloud:second:remote-repo:task-provenance",
      repo_id: "repo-local",
      prompt: "Second cloud copy",
      activity_revision: 9,
      updated_at: "2026-05-23T00:01:00.000Z",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [firstCloudItem, secondCloudItem],
        terminalRefs: {
          "cloud:first:remote-repo:task-provenance": {
            ownerDesktopId: "desktop-first",
            ownerLocalTaskId: "task-provenance",
            transport: "cloud",
          },
          "cloud:second:remote-repo:task-provenance": {
            ownerDesktopId: "desktop-second",
            ownerLocalTaskId: "task-provenance",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "cloud:second:remote-repo:task-provenance",
      remoteTaskIds: [
        "cloud:first:remote-repo:task-provenance",
        "cloud:second:remote-repo:task-provenance",
      ],
      item: {
        id: "cloud:second:remote-repo:task-provenance",
        prompt: "Second cloud copy",
        activity_revision: 9,
      },
      owner: { kind: "remote", id: "desktop-second" },
      terminal: {
        kind: "cloud",
        remoteRef: {
          ownerDesktopId: "desktop-second",
          ownerLocalTaskId: "task-provenance",
          transport: "cloud",
        },
      },
    });
    expect(result.tasks[0].sources).toHaveLength(2);
  });

  it("keeps transfer-time item, owner, blocker, and route on one cloud authority", () => {
    const stableItemId = "cloud:remote-repo:stable-transfer-task";
    const destination = item({
      id: stableItemId,
      repo_id: "cloud:repo-remote",
      prompt: "Destination authority",
      updated_at: "2026-07-27T00:02:00.000Z",
      blocker_revision: 8,
      transition_revision: "destination-run",
    });
    const displacedLanOwner = item({
      id: stableItemId,
      repo_id: "cloud:repo-remote",
      prompt: "Displaced LAN owner",
      updated_at: "2026-07-27T00:01:00.000Z",
      blocker_revision: 99,
      transition_revision: "source-run",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        ...emptySnapshot(),
        items: [destination],
        terminalRefs: {
          [stableItemId]: {
            ownerDesktopId: "desktop-destination",
            ownerLocalTaskId: "task-destination",
            transport: "cloud",
          },
        },
        blockedByTaskIds: { [stableItemId]: ["destination-blocker"] },
      },
      lanSnapshot: {
        ...emptySnapshot(),
        items: [displacedLanOwner],
        terminalRefs: {
          [stableItemId]: {
            ownerDesktopId: "desktop-source",
            ownerLocalTaskId: "task-source",
            transport: "lan",
          },
        },
        blockedByTaskIds: { [stableItemId]: ["source-blocker"] },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      item: {
        prompt: "Destination authority",
        blocker_revision: 8,
        transition_revision: "destination-run",
      },
      owner: { kind: "remote", id: "desktop-destination" },
      blockedByTaskIds: ["destination-blocker"],
      terminal: {
        kind: "cloud",
        remoteRef: {
          ownerDesktopId: "desktop-destination",
          ownerLocalTaskId: "task-destination",
        },
      },
    });
  });

  it("reports cloud transport diagnostics for cloud-only tasks", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-cloud",
      repo_id: "cloud:remote-repo",
      prompt: "Cloud diagnostic task",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-06-01T00:00:00.000Z",
          last_opened_at: "2026-06-01T00:00:00.000Z",
        }],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-cloud": {
            ownerDesktopId: "desktop-cloud",
            ownerLocalTaskId: "task-cloud",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      itemId: "cloud:remote-repo:task-cloud",
      prompt: "Cloud diagnostic task",
      repoId: "cloud:remote-repo",
      sources: ["cloud"],
      selectedTerminalTransport: "cloud",
      ownerDesktopId: "desktop-cloud",
      ownerLocalTaskId: "task-cloud",
    }));
  });

  it("reports LAN as the selected transport when cloud and LAN advertise the same task", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-shared",
      repo_id: "repo-local",
      prompt: "Shared diagnostic task",
    });
    const lanItem = item({
      id: "cloud:lan:peer-primary:remote-repo:task-shared",
      repo_id: "repo-local",
      prompt: "Shared diagnostic task",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-shared": {
            ownerDesktopId: "desktop-cloud",
            ownerLocalTaskId: "task-shared",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          "cloud:lan:peer-primary:remote-repo:task-shared": {
            ownerDesktopId: "peer-primary",
            ownerLocalTaskId: "task-shared",
            transport: "lan",
          },
        },
      },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      prompt: "Shared diagnostic task",
      sources: ["cloud", "lan"],
      selectedTerminalTransport: "lan",
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: "task-shared",
    }));
  });

  it("dedupes cloud and LAN advertisements for the same local task even when transports use different owner ids", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-2",
      repo_id: "repo-local",
      prompt: "LAN visible task",
    });
    const lanItem = item({
      id: "cloud:lan:peer-primary:remote-repo:task-2",
      repo_id: "repo-local",
      prompt: "LAN visible task",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-2": {
            ownerDesktopId: "desktop-relay-id",
            ownerLocalTaskId: "task-2",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {
          "cloud:lan:peer-primary:remote-repo:task-2": {
            ownerDesktopId: "peer-primary",
            ownerLocalTaskId: "task-2",
            transport: "lan",
          },
        },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      repoKey: "repo-local",
      remoteTaskIds: [
        "cloud:remote-repo:task-2",
        "cloud:lan:peer-primary:remote-repo:task-2",
      ],
      terminal: {
        kind: "lan",
        remoteRef: {
          ownerDesktopId: "peer-primary",
          ownerLocalTaskId: "task-2",
          transport: "lan",
        },
      },
    });
  });

  it("keeps remote actions enabled when one source is reachable and another duplicate source has no terminal ref", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-2",
      repo_id: "repo-local",
      prompt: "Partially reachable task",
    });
    const lanItem = item({
      id: "cloud:lan:peer-primary:remote-repo:task-2",
      repo_id: "repo-local",
      prompt: "Partially reachable task",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-2": {
            ownerDesktopId: "desktop-relay-id",
            ownerLocalTaskId: "task-2",
            transport: "cloud",
          },
        },
        blockedByTaskIds: {},
      },
      lanSnapshot: {
        repos: [],
        items: [lanItem],
        terminalRefs: {},
        blockedByTaskIds: {},
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      reachability: "reachable",
      terminal: {
        kind: "cloud",
        remoteRef: {
          ownerDesktopId: "desktop-relay-id",
          ownerLocalTaskId: "task-2",
          transport: "cloud",
        },
      },
      capabilities: {
        canAdvanceStage: true,
        canClose: true,
        canSendInput: true,
      },
    });
  });

  it("marks reachable cloud tasks as remotely controllable without local-only actions", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-control",
      repo_id: "cloud:remote-repo",
      branch: "task-control",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        }],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-control": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-control",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks[0]?.capabilities).toMatchObject({
      canOpenTerminal: true,
      canSendInput: true,
      canResizeTerminal: true,
      canClose: true,
      canOpenDiff: true,
      canOpenInIde: false,
      canOpenShell: false,
      canAdvanceStage: true,
      canEditMetadata: true,
    });
  });

  it("marks unreachable remote tasks as visible but not controllable", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-offline",
      repo_id: "cloud:remote-repo",
      branch: "task-offline",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        }],
        items: [cloudItem],
        terminalRefs: {},
        blockedByTaskIds: {},
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks[0]?.reachability).toBe("unknown");
    expect(result.tasks[0]?.capabilities).toMatchObject({
      canOpenTerminal: false,
      canSendInput: false,
      canResizeTerminal: false,
      canClose: false,
      canOpenDiff: false,
      canOpenInIde: false,
      canOpenShell: false,
      canAdvanceStage: false,
      canEditMetadata: false,
    });
  });

  it("hides a stale remote task when the matching local task is closed", () => {
    const closed = item({
      id: "task-closed",
      branch: "task-closed",
      stage: "done",
      closed_at: "2026-05-23T00:10:00.000Z",
    });
    const staleCloud = item({
      id: "cloud:repo-local:task-closed",
      repo_id: "repo-local",
      branch: "task-closed",
      stage: "in progress",
      closed_at: null,
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash" }],
      localItems: [closed],
      cloudSnapshot: {
        repos: [],
        items: [staleCloud],
        terminalRefs: {
          "cloud:repo-local:task-closed": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-closed",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toEqual([]);
  });

  it("hides a stale remote task when only the closed local identity is loaded", () => {
    const staleCloud = item({
      id: "cloud:repo-local:task-closed",
      repo_id: "repo-local",
      branch: "task-closed",
      stage: "review",
      closed_at: null,
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash" }],
      localItems: [],
      localClosedItems: [{
        id: "task-closed",
        repo_id: "repo-local",
      }],
      cloudSnapshot: {
        repos: [],
        items: [staleCloud],
        terminalRefs: {
          "cloud:repo-local:task-closed": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-closed",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toEqual([]);
  });

  it("groups a remote task under a matching local repo by remote URL hash", () => {
    const cloudItem = item({
      id: "cloud:remote-repo:task-3",
      repo_id: "cloud:remote-repo",
      branch: "task-3",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo({ id: "repo-local" }), remoteUrlHash: "same-hash" }],
      localItems: [],
      cloudSnapshot: {
        repos: [{
          id: "cloud:remote-repo",
          path: "cloud",
          name: "kanna",
          remote_url: "git@example.com:kanna.git",
          remoteUrlHash: "same-hash",
          default_branch: "main",
          hidden: 0,
          sort_order: 0,
          created_at: "2026-05-23T00:00:00.000Z",
          last_opened_at: "2026-05-23T00:00:00.000Z",
        } as never],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-3": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-3",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({
      key: "repo-local",
      localRepoId: "repo-local",
      source: "mixed",
    });
    expect(result.tasks[0].repoKey).toBe("repo-local");
  });

  it("applies the viewer-local pin overlay to a remote-only task", () => {
    const cloudItem = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudItem],
        terminalRefs: {
          "cloud:remote-repo:task-2": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-2",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-2", 3]]),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].item).toMatchObject({ pinned: 1, pin_order: 3 });
  });

  it("applies the pin overlay to an unreachable remote task via its id suffix", () => {
    const cloudItem = item({ id: "cloud:remote-repo:task-9", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [cloudItem], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-9", 0]]),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].reachability).toBe("unknown");
    expect(result.tasks[0].item).toMatchObject({ pinned: 1, pin_order: 0 });
  });

  it("keeps local pin state authoritative when the task also exists locally", () => {
    const local = item({ id: "task-1", branch: "task-1", pinned: 0, pin_order: null });
    const cloud = item({ id: "cloud:repo-local:task-1", repo_id: "repo-local", branch: "task-1" });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [local],
      cloudSnapshot: {
        repos: [],
        items: [cloud],
        terminalRefs: {
          "cloud:repo-local:task-1": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-1",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-1", 5]]),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].localTaskId).toBe("task-1");
    expect(result.tasks[0].item).toMatchObject({ pinned: 0, pin_order: null });
  });

  it("leaves remote tasks unpinned without an overlay entry", () => {
    const cloudItem = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [cloudItem], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-other", 0]]),
    });

    expect(result.tasks[0].item).toMatchObject({ pinned: 0, pin_order: null });
  });

  it("pins a cross-machine directory singleton by default, above explicit pins", () => {
    const singleton = item({
      id: "cloud:remote-repo:task-merge",
      repo_id: "cloud:remote-repo",
      singleton_agent: "merge",
    });
    const ordinary = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [singleton, ordinary], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-2", 0]]),
    });

    const pinned = result.tasks.find((task) => task.item.id.endsWith("task-merge"));
    expect(pinned?.item).toMatchObject({ pinned: 1, pin_order: DEFAULT_SINGLETON_PIN_ORDER });
    // The operator's own pin keeps the order they gave it.
    expect(result.tasks.find((task) => task.item.id.endsWith("task-2"))?.item)
      .toMatchObject({ pinned: 1, pin_order: 0 });
  });

  it("keeps an explicit unpin of a cross-machine singleton off", () => {
    const singleton = item({
      id: "cloud:remote-repo:task-merge",
      repo_id: "cloud:remote-repo",
      singleton_agent: "merge",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [singleton], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-merge", null]]),
    });

    expect(result.tasks[0].item).toMatchObject({ pinned: 0, pin_order: null });
  });

  it("lets the operator pin a cross-machine singleton at their own position", () => {
    const singleton = item({
      id: "cloud:remote-repo:task-merge",
      repo_id: "cloud:remote-repo",
      singleton_agent: "merge",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [singleton], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      remoteTaskPins: new Map([["task-merge", 2]]),
    });

    expect(result.tasks[0].item).toMatchObject({ pinned: 1, pin_order: 2 });
  });

  it("leaves ordinary cross-machine rows unpinned while singletons default on", () => {
    // The negative half of the default. "Pinned by default" has to mean the
    // singleton and nothing else: if an ordinary row drifted into the pinned
    // group the feature would read as "everything remote is pinned", which is
    // a worse bug than the one the default fixes.
    const singleton = item({
      id: "cloud:remote-repo:task-merge",
      repo_id: "cloud:remote-repo",
      singleton_agent: "merge",
    });
    const ordinary = item({ id: "cloud:remote-repo:task-2", repo_id: "cloud:remote-repo" });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [singleton, ordinary], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
      // Nobody has pinned anything on this machine.
      remoteTaskPins: new Map(),
    });

    expect(result.tasks.find((task) => task.item.id.endsWith("task-merge"))?.item)
      .toMatchObject({ pinned: 1, pin_order: DEFAULT_SINGLETON_PIN_ORDER });
    expect(result.tasks.find((task) => task.item.id.endsWith("task-2"))?.item)
      .toMatchObject({ pinned: 0, pin_order: null });
  });

  it("pins each owner machine's singleton by default and unpins them independently", () => {
    // The whole point of the change is the cross-machine cell, so the default
    // must not be keyed to one publisher: two different owner desktops each
    // advertise a singleton here, and both pin without this machine pinning
    // either. An unpin is per-task, so turning one off leaves the other on.
    const singletonA = item({
      id: "cloud:repo-a:task-merge",
      repo_id: "cloud:repo-a",
      singleton_agent: "merge",
    });
    const ordinaryA = item({ id: "cloud:repo-a:task-a-work", repo_id: "cloud:repo-a" });
    const singletonB = item({
      id: "cloud:repo-b:task-manager",
      repo_id: "cloud:repo-b",
      singleton_agent: "task-manager",
    });
    const ordinaryB = item({ id: "cloud:repo-b:task-b-work", repo_id: "cloud:repo-b" });
    const terminalRefs = {
      "cloud:repo-a:task-merge": {
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-merge",
        transport: "cloud" as const,
      },
      "cloud:repo-a:task-a-work": {
        ownerDesktopId: "desktop-a",
        ownerLocalTaskId: "task-a-work",
        transport: "cloud" as const,
      },
      "cloud:repo-b:task-manager": {
        ownerDesktopId: "desktop-b",
        ownerLocalTaskId: "task-manager",
        transport: "cloud" as const,
      },
      "cloud:repo-b:task-b-work": {
        ownerDesktopId: "desktop-b",
        ownerLocalTaskId: "task-b-work",
        transport: "cloud" as const,
      },
    };
    const items = [singletonA, ordinaryA, singletonB, ordinaryB];

    const pinStateById = (remoteTaskPins: Map<string, number | null>) => {
      const result = buildWorkspace({
        localRepos: [],
        localItems: [],
        cloudSnapshot: { repos: [], items, terminalRefs },
        lanSnapshot: emptySnapshot(),
        remoteTaskPins,
      });
      return Object.fromEntries(
        result.tasks.map((task) => [task.item.id, task.item.pinned === 1]),
      );
    };

    expect(pinStateById(new Map())).toEqual({
      "cloud:repo-a:task-merge": true,
      "cloud:repo-a:task-a-work": false,
      "cloud:repo-b:task-manager": true,
      "cloud:repo-b:task-b-work": false,
    });

    // One machine's singleton turned off; the other machine's is untouched.
    expect(pinStateById(new Map([["task-merge", null]]))).toEqual({
      "cloud:repo-a:task-merge": false,
      "cloud:repo-a:task-a-work": false,
      "cloud:repo-b:task-manager": true,
      "cloud:repo-b:task-b-work": false,
    });
  });

  it("keeps a local singleton's durable unpin authoritative over the remote default", () => {
    const local = item({
      id: "task-merge",
      branch: "task-merge",
      pipeline: "singleton-merge",
      pinned: 0,
      pin_order: null,
    });
    const cloud = item({
      id: "cloud:repo-local:task-merge",
      repo_id: "repo-local",
      branch: "task-merge",
      singleton_agent: "merge",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: "remote-hash", remoteUrl: "git@example.com:kanna.git" }],
      localItems: [local],
      cloudSnapshot: {
        repos: [],
        items: [cloud],
        terminalRefs: {
          "cloud:repo-local:task-merge": {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-merge",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].item).toMatchObject({ pinned: 0, pin_order: null });
  });

  it("retargets a remote parent at the transport that wins the parent's presentation", () => {
    const terminalRef = (ownerLocalTaskId: string, transport: "cloud" | "lan") => ({
      ownerDesktopId: "desktop-a",
      ownerLocalTaskId,
      transport,
    });
    const cloudParent = item({
      id: "cloud:remote-repo:task-parent",
      repo_id: "cloud:remote-repo",
      updated_at: "2026-05-23T00:00:00.000Z",
    });
    const lanParent = item({
      id: "lan:peer-a:remote-repo:task-parent",
      repo_id: "cloud:remote-repo",
      updated_at: "2026-05-23T00:01:00.000Z",
    });
    const cloudChild = item({
      id: "cloud:remote-repo:task-child",
      repo_id: "cloud:remote-repo",
      parent_task_id: "cloud:remote-repo:task-parent",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: {
        repos: [],
        items: [cloudParent, cloudChild],
        terminalRefs: {
          [cloudParent.id]: terminalRef("task-parent", "cloud"),
          [cloudChild.id]: terminalRef("task-child", "cloud"),
        },
      },
      lanSnapshot: {
        repos: [],
        items: [lanParent],
        terminalRefs: {
          [lanParent.id]: terminalRef("task-parent", "lan"),
        },
      },
    });

    const parent = result.tasks.find((task) => task.logicalTaskKey.endsWith("task-parent"));
    const child = result.tasks.find((task) => task.logicalTaskKey.endsWith("task-child"));
    expect(parent?.item.id).toBe("lan:peer-a:remote-repo:task-parent");
    expect(child?.item.parent_task_id).toBe("lan:peer-a:remote-repo:task-parent");
  });

  it("retargets a remote parent at the viewer's own task when both name it", () => {
    const localParent = item({ id: "task-parent", repo_id: "repo-local" });
    const cloudParent = item({
      id: "cloud:remote-repo:task-parent",
      repo_id: "repo-local",
      updated_at: "2026-05-23T00:01:00.000Z",
    });
    const cloudChild = item({
      id: "cloud:remote-repo:task-child",
      repo_id: "repo-local",
      parent_task_id: "cloud:remote-repo:task-parent",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: null }],
      localItems: [localParent],
      cloudSnapshot: {
        repos: [],
        items: [cloudParent, cloudChild],
        terminalRefs: {
          [cloudParent.id]: {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-parent",
            transport: "cloud",
          },
          [cloudChild.id]: {
            ownerDesktopId: "desktop-a",
            ownerLocalTaskId: "task-child",
            transport: "cloud",
          },
        },
      },
      lanSnapshot: emptySnapshot(),
    });

    const child = result.tasks.find((task) => task.logicalTaskKey.endsWith("task-child"));
    expect(child?.item.parent_task_id).toBe("task-parent");
  });

  it("drops a remote parent reference that is not part of the workspace", () => {
    const cloudChild = item({
      id: "cloud:remote-repo:task-child",
      repo_id: "cloud:remote-repo",
      parent_task_id: "cloud:remote-repo:task-hidden-parent",
    });

    const result = buildWorkspace({
      localRepos: [],
      localItems: [],
      cloudSnapshot: { repos: [], items: [cloudChild], terminalRefs: {} },
      lanSnapshot: emptySnapshot(),
    });

    expect(result.tasks[0].item.parent_task_id).toBeNull();
  });

  it("keeps a local task's parent untouched", () => {
    const localParent = item({ id: "task-parent", repo_id: "repo-local" });
    const localChild = item({
      id: "task-child",
      repo_id: "repo-local",
      parent_task_id: "task-parent",
    });

    const result = buildWorkspace({
      localRepos: [{ repo: repo(), remoteUrlHash: null }],
      localItems: [localParent, localChild],
      cloudSnapshot: emptySnapshot(),
      lanSnapshot: emptySnapshot(),
    });

    const child = result.tasks.find((task) => task.localTaskId === "task-child");
    expect(child?.item.parent_task_id).toBe("task-parent");
  });
});

describe("workspaceTaskOwnerTaskId", () => {
  it("extracts the owner-side task id from the logical key", () => {
    expect(workspaceTaskOwnerTaskId({ logicalTaskKey: "repo-local:owner-local:task-1" }))
      .toBe("task-1");
  });

  it("returns null when no owner marker is present", () => {
    expect(workspaceTaskOwnerTaskId({ logicalTaskKey: "repo-local" })).toBeNull();
    expect(workspaceTaskOwnerTaskId({ logicalTaskKey: "repo-local:owner-local:" })).toBeNull();
  });
});

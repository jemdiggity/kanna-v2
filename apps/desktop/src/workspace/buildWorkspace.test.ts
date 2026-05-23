import { describe, expect, it } from "vitest";
import type { PipelineItem, Repo } from "@kanna/db";
import { buildWorkspace } from "./buildWorkspace";

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
    pipeline: "default",
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
    agent_type: "sdk",
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
  return { repos: [], items: [], terminalRefs: {} };
}

describe("buildWorkspace", () => {
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
      repoKey: "local:repo-local",
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
      key: "local:repo-local",
      localRepoId: "repo-local",
      source: "mixed",
    });
    expect(result.tasks[0].repoKey).toBe("local:repo-local");
  });
});

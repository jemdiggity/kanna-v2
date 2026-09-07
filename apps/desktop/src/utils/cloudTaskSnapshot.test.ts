import { describe, expect, it } from "vitest";
import { buildCloudTaskSnapshot, hashRemoteUrl } from "./cloudTaskSnapshot";

describe("cloud task snapshot mapper", () => {
  it("maps a local task and repo into a cloud-safe snapshot", async () => {
    await expect(hashRemoteUrl("git@github.com:jemdiggity/kanna.git")).resolves.toHaveLength(64);

    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-1",
        repo_id: "repo-1",
        prompt: "Fix cloud mobile task list",
        stage: "in progress",
        activity: "working",
        activity_revision: 12,
        runtime_state: "busy",
        read_state: "unread",
        transition_revision: "run-12",
        branch: "task-1",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: "Cloud mobile",
        last_output_preview: "Ready for review",
        agent_provider: "claude",
        agent_type: "pty",
        created_at: "2026-05-14T00:00:00.000Z",
        updated_at: "2026-05-14T00:01:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: "git@github.com:jemdiggity/kanna.git",
      },
      blockedByTaskIds: [],
    });

    expect(snapshot).toMatchObject({
      localRepoId: "repo-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      title: "Cloud mobile",
      promptSnippet: "Fix cloud mobile task list",
      waitingPromptSnippet: "Ready for review",
      activityRevision: 12,
      runtimeState: "busy",
      readState: "unread",
      transitionRevision: "run-12",
      repo: {
        cloudRepoId: "repo-1",
        name: "kanna",
        remoteUrl: "git@github.com:jemdiggity/kanna.git",
        defaultBranch: "main",
      },
      transfer: { state: "none" },
    });
    expect(snapshot).not.toHaveProperty("cloudTaskId");
    expect(snapshot.hasRunningPost).toBe(false);
    expect(snapshot.repo.remoteUrlHash).toHaveLength(64);
  });

  it("publishes the parent task id so viewers can rebuild the task hierarchy", async () => {
    const child = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-child",
        repo_id: "repo-1",
        prompt: "Review the parent's branch",
        stage: "in progress",
        activity: "idle",
        branch: "task-child",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: null,
        last_output_preview: null,
        agent_provider: "claude",
        agent_type: "pty",
        parent_task_id: "task-parent",
        created_at: "2026-08-04T00:00:00.000Z",
        updated_at: "2026-08-04T00:01:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: null,
      },
      blockedByTaskIds: [],
    });

    expect(child.parentTaskId).toBe("task-parent");
  });

  it("publishes the running-post flag that drives the transition-in-flight indicator", async () => {
    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-post",
        repo_id: "repo-1",
        prompt: "Commit the branch",
        stage: "in progress",
        activity: "working",
        branch: "task-post",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: null,
        last_output_preview: null,
        has_running_post: 1,
        agent_provider: "claude",
        agent_type: "pty",
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:01:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: null,
      },
      blockedByTaskIds: [],
    });

    expect(snapshot.hasRunningPost).toBe(true);
  });

  it("publishes OpenCode from the local task agent provider", async () => {
    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-opencode",
        repo_id: "repo-1",
        prompt: "Ship the OpenCode cloud snapshot",
        stage: "in progress",
        activity: "idle",
        branch: "task-opencode",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: null,
        last_output_preview: null,
        agent_provider: "opencode",
        agent_type: "pty",
        created_at: "2026-06-06T00:00:00.000Z",
        updated_at: "2026-06-06T00:00:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: null,
      },
      blockedByTaskIds: [],
    });

    expect(snapshot.agent).toEqual({
      provider: "opencode",
      type: "pty",
    });
  });

  it("publishes Antigravity from the local task agent provider", async () => {
    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-antigravity",
        repo_id: "repo-1",
        prompt: "Ship the Antigravity cloud snapshot",
        stage: "in progress",
        activity: "idle",
        branch: "task-antigravity",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: null,
        last_output_preview: null,
        agent_provider: "antigravity",
        agent_type: "pty",
        created_at: "2026-06-06T00:00:00.000Z",
        updated_at: "2026-06-06T00:00:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: null,
      },
      blockedByTaskIds: [],
    });

    expect(snapshot.agent).toEqual({
      provider: "antigravity",
      type: "pty",
    });
  });

  it("treats legacy merge stage as active status", async () => {
    const snapshot = await buildCloudTaskSnapshot({
      desktopId: "desktop-1",
      item: {
        id: "task-merge",
        repo_id: "repo-1",
        prompt: "Merge queued PRs",
        stage: "merge",
        activity: "working",
        branch: "task-merge",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: "Merge Master",
        last_output_preview: null,
        agent_provider: "claude",
        agent_type: "pty",
        created_at: "2026-06-07T00:00:00.000Z",
        updated_at: "2026-06-07T00:00:00.000Z",
        closed_at: null,
      },
      repo: {
        id: "repo-1",
        name: "kanna",
        path: "/Users/test/kanna",
        default_branch: "main",
        remote_url: null,
      },
      blockedByTaskIds: [],
    });

    expect(snapshot.stage).toBe("merge");
    expect(snapshot.status).toBe("active");
  });
});

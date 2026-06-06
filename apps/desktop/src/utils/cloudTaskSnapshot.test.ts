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
        branch: "task-1",
        base_ref: "origin/main",
        pr_number: null,
        pr_url: null,
        display_name: "Cloud mobile",
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
      cloudTaskId: "repo-1:task-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      title: "Cloud mobile",
      promptSnippet: "Fix cloud mobile task list",
      repo: {
        cloudRepoId: "repo-1",
        name: "kanna",
        remoteUrl: "git@github.com:jemdiggity/kanna.git",
        defaultBranch: "main",
      },
      transfer: { state: "none" },
    });
    expect(snapshot.repo.remoteUrlHash).toHaveLength(64);
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
});

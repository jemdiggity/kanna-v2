import { describe, expect, it } from "vitest";
import { mapDesktopCloudTasks } from "./desktopCloudTaskIndex";

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
        repo: { cloudRepoId: "repo-1", name: "kanna", defaultBranch: "main" },
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
      { id: "cloud:repo-1", name: "kanna", path: "cloud" },
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
  });
});

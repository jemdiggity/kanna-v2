import { describe, expect, it } from "vitest";
import { mapCloudTaskSnapshot, sortCloudTasks } from "./taskIndex";

describe("cloud task index", () => {
  it("maps cloud snapshots into mobile task summaries", () => {
    expect(
      mapCloudTaskSnapshot({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Fix mobile cloud",
        promptSnippet: "Fix mobile cloud",
        displayName: "Mobile cloud",
        stage: "in progress",
        activity: "working",
        status: "active",
        repo: {
          cloudRepoId: "repo-1",
          name: "kanna",
          remoteUrlHash: null,
          defaultBranch: "main",
        },
        branch: "task-1",
        baseRef: "origin/main",
        prNumber: null,
        prUrl: null,
        agent: { provider: "claude", type: "pty" },
        transfer: {
          state: "none",
          transferId: null,
          sourceDesktopId: null,
          destinationDesktopId: null,
        },
        blockedByTaskIds: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:01:00.000Z",
        closedAt: null,
      }),
    ).toEqual({
      id: "cloud-task-1",
      repoId: "repo-1",
      title: "Mobile cloud",
      stage: "in progress",
      snippet: "Fix mobile cloud",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      ownerOnline: false,
    });
  });

  it("sorts newest updated cloud tasks first", () => {
    const tasks = sortCloudTasks([
      { id: "old", updatedAt: "2026-05-14T00:00:00.000Z" },
      { id: "new", updatedAt: "2026-05-14T00:02:00.000Z" },
    ]);

    expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });
});

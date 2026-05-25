import { describe, expect, it } from "vitest";
import {
  buildTaskSnapshotWrite,
  validateTaskSnapshotInput,
} from "../src/taskSnapshots.js";

describe("task snapshot validation", () => {
  it("accepts a minimal owner-routable task snapshot", () => {
    const input = {
      cloudTaskId: "cloud-task-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1",
      title: "Fix mobile cloud",
      promptSnippet: "Fix mobile cloud",
      displayName: null,
      stage: "in progress",
      activity: "working",
      status: "active",
      repo: {
        cloudRepoId: "repo-hash-1",
        name: "kanna",
        remoteUrl: "git@github.com:jemdiggity/kanna.git",
        remoteUrlHash: "remote-hash-1",
        defaultBranch: "main",
      },
      branch: "task-1",
      baseRef: "origin/main",
      prNumber: null,
      prUrl: null,
      agent: {
        provider: "codex",
        type: "sdk",
      },
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
    };

    expect(validateTaskSnapshotInput(input)).toEqual(input);
    expect(buildTaskSnapshotWrite("user-1", input)).toMatchObject({
      path: "users/user-1/tasks/cloud-task-1",
      data: {
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Fix mobile cloud",
      },
    });
  });

  it("rejects snapshots that do not route to an owner desktop", () => {
    expect(() =>
      validateTaskSnapshotInput({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "",
        ownerLocalTaskId: "task-1",
      }),
    ).toThrow("ownerDesktopId is required");
  });

  it("rejects oversized prompt snippets", () => {
    expect(() =>
      validateTaskSnapshotInput({
        cloudTaskId: "cloud-task-1",
        ownerDesktopId: "desktop-1",
        ownerLocalTaskId: "task-1",
        title: "Task",
        promptSnippet: "x".repeat(501),
      }),
    ).toThrow("promptSnippet must be 500 characters or fewer");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildTaskSnapshotMutations,
  buildTaskSnapshotRequest,
  validateTaskSnapshotInput,
} from "../src/taskSnapshots.js";
import type { CloudTaskSnapshot } from "../src/types.js";

const baseSnapshot: CloudTaskSnapshot = {
  ownerDesktopId: "desktop-1",
  localRepoId: "repo-1",
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

describe("task snapshot validation", () => {
  it("accepts a minimal owner-routable task snapshot", () => {
    const input = {
      cloudTaskId: "cloud-task-1",
      ...baseSnapshot,
    };

    expect(validateTaskSnapshotInput(input)).toEqual(input);
    expect(buildTaskSnapshotRequest(input)).toEqual({
      action: "upsert",
      snapshot: input,
    });
  });

  it("does not require deterministic cloud task ids for new snapshots", () => {
    expect(validateTaskSnapshotInput(baseSnapshot)).toEqual(baseSnapshot);
    expect(buildTaskSnapshotRequest({ action: "upsert", snapshot: baseSnapshot })).toEqual({
      action: "upsert",
      snapshot: baseSnapshot,
    });
  });

  it("derives local repo identity for legacy snapshots", () => {
    const { localRepoId: _localRepoId, ...legacySnapshot } = {
      ...baseSnapshot,
      cloudTaskId: "repo-1:task-1",
    };

    expect(validateTaskSnapshotInput(legacySnapshot)).toEqual({
      ...legacySnapshot,
      localRepoId: "repo-hash-1",
    });
  });

  it("accepts delete requests by local owner identity", () => {
    expect(buildTaskSnapshotRequest({
      action: "delete",
      identity: {
        ownerDesktopId: "desktop-1",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-1",
      },
    })).toEqual({
      action: "delete",
      identity: {
        ownerDesktopId: "desktop-1",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-1",
      },
    });
  });

  it("accepts reconcile requests with the current open task set", () => {
    expect(buildTaskSnapshotRequest({
      action: "reconcile",
      ownerDesktopId: "desktop-1",
      snapshots: [baseSnapshot],
    })).toEqual({
      action: "reconcile",
      ownerDesktopId: "desktop-1",
      snapshots: [baseSnapshot],
    });
  });

  it("accepts an OpenCode agent task snapshot", () => {
    const input = {
      ...baseSnapshot,
      cloudTaskId: "repo-1:task-opencode",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-opencode",
      title: "OpenCode task",
      promptSnippet: null,
      activity: "idle",
      branch: "task-opencode",
      agent: {
        provider: "opencode",
        type: "pty",
      },
    };

    expect(validateTaskSnapshotInput(input).agent.provider).toBe("opencode");
  });

  it("rejects snapshots that do not route to an owner desktop", () => {
    expect(() =>
      validateTaskSnapshotInput({
        cloudTaskId: "cloud-task-1",
        localRepoId: "repo-1",
        ownerDesktopId: "",
        ownerLocalTaskId: "task-1",
        repo: baseSnapshot.repo,
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

describe("task snapshot mutations", () => {
  it("upserts open snapshots by local owner identity and deletes stale owned docs", () => {
    const mutations = buildTaskSnapshotMutations({
      existingDocs: [
        {
          id: "existing-new",
          data: {
            ownerDesktopId: "desktop-1",
            localRepoId: "repo-1",
            ownerLocalTaskId: "task-1",
            updatedAt: "2026-05-14T00:02:00.000Z",
          },
        },
        {
          id: "existing-old",
          data: {
            ownerDesktopId: "desktop-1",
            localRepoId: "repo-1",
            ownerLocalTaskId: "task-1",
            updatedAt: "2026-05-14T00:01:00.000Z",
          },
        },
        {
          id: "legacy-open-duplicate",
          data: {
            ownerDesktopId: "desktop-1",
            ownerLocalTaskId: "task-1",
            repo: { cloudRepoId: "repo-1" },
            updatedAt: "2026-05-14T00:00:30.000Z",
          },
        },
        {
          id: "stale-doc",
          data: {
            ownerDesktopId: "desktop-1",
            localRepoId: "repo-1",
            ownerLocalTaskId: "task-stale",
            updatedAt: "2026-05-14T00:00:00.000Z",
          },
        },
      ],
      snapshots: [baseSnapshot, { ...baseSnapshot, ownerLocalTaskId: "task-2" }],
    });

    expect(mutations).toHaveLength(5);
    expect(mutations).toEqual(expect.arrayContaining([
      { type: "update", docId: "existing-new", data: baseSnapshot },
      { type: "create", data: { ...baseSnapshot, ownerLocalTaskId: "task-2" } },
      { type: "delete", docId: "existing-old" },
      { type: "delete", docId: "legacy-open-duplicate" },
      { type: "delete", docId: "stale-doc" },
    ]));
  });
});

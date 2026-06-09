import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRemoteTaskSnapshots,
  publishDesktopTaskSnapshot,
  reconcileDesktopTaskSnapshots,
} from "./desktopCloudPublisher";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@kanna/db", () => ({
  getRepo: vi.fn(async () => repo()),
  listPipelineItems: vi.fn(async () => [openItem("task-open")]),
  listRepos: vi.fn(async () => [repo()]),
  listBlockersForItem: vi.fn(async () => []),
}));

vi.mock("../invoke", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("./cloudTaskPublisher", () => ({
  createCloudTaskPublisher: vi.fn(() => ({
    publish: (payload: unknown) => mocks.publish(payload),
  })),
}));

vi.mock("./desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    getState: () => ({
      status: "signedIn",
      user: { uid: "user-1", email: "user@example.com", displayName: null },
    }),
    getIdToken: vi.fn(async () => "id-token"),
  })),
}));

vi.mock("./desktopFirebaseConfig", () => ({
  resolveDesktopFirebaseConfig: vi.fn(async () => ({
    functionsEndpoint: "http://127.0.0.1:5001/upsertTaskSnapshot",
  })),
}));

function repo() {
  return {
    id: "repo-1",
    name: "Repo One",
    path: "/repo",
    default_branch: "main",
  };
}

function openItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    repo_id: "repo-1",
    prompt: "Open task",
    stage: "in progress",
    activity: "working",
    branch: id,
    base_ref: "main",
    pr_number: null,
    pr_url: null,
    display_name: null,
    agent_provider: "claude",
    agent_type: "pty",
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:01:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

function closedItem(id: string) {
  return openItem(id, {
    stage: "done",
    activity: "idle",
    closed_at: "2026-05-22T00:02:00.000Z",
    updated_at: "2026-05-22T00:02:00.000Z",
  });
}

describe("desktop cloud live task index publisher", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.publish.mockReset();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "mobile_server_status") {
        return { desktopId: "desktop-owner" };
      }
      if (command === "git_remote_url") {
        return "git@github.com:owner/repo.git";
      }
      return "";
    });
  });

  it("publishes open local task metadata as an upsert action", async () => {
    await publishDesktopTaskSnapshot(null as never, openItem("task-new") as never, repo() as never);

    expect(mocks.publish).toHaveBeenCalledWith({
      action: "upsert",
      snapshot: expect.objectContaining({
        localRepoId: "repo-1",
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-new",
        closedAt: null,
      }),
    });
  });

  it("deletes cloud metadata instead of publishing a closed task snapshot", async () => {
    await publishDesktopTaskSnapshot(null as never, closedItem("task-closed") as never, repo() as never);

    expect(mocks.publish).toHaveBeenCalledWith({
      action: "delete",
      identity: {
        ownerDesktopId: "desktop-owner",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-closed",
      },
    });
  });

  it("deletes remote task metadata by owner identity", async () => {
    await deleteRemoteTaskSnapshots({
      ownerDesktopId: "desktop-owner",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-remote",
    });

    expect(mocks.publish).toHaveBeenCalledWith({
      action: "delete",
      identity: {
        ownerDesktopId: "desktop-owner",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-remote",
      },
    });
  });

  it("reconciles the owned cloud index to the current open local task set", async () => {
    await reconcileDesktopTaskSnapshots(null as never);

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith({
      action: "reconcile",
      ownerDesktopId: "desktop-owner",
      snapshots: [
        expect.objectContaining({
          localRepoId: "repo-1",
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "task-open",
          closedAt: null,
        }),
      ],
    });
  });
});

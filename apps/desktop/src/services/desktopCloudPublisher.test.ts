import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishDesktopTaskSnapshot, publishDesktopTaskSnapshots } from "./desktopCloudPublisher";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@kanna/db", () => ({
  getRepo: vi.fn(async () => ({
    id: "repo-1",
    name: "Repo One",
    path: "/repo",
    default_branch: "main",
  })),
  listPipelineItems: vi.fn(async () => [
    {
      id: "task-open",
      repo_id: "repo-1",
      prompt: "Open task",
      stage: "in progress",
      activity: "working",
      branch: "task-open",
      base_ref: "main",
      pr_number: null,
      pr_url: null,
      display_name: null,
      agent_provider: "claude",
      agent_type: "pty",
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:01:00.000Z",
      closed_at: null,
    },
    {
      id: "task-closed",
      repo_id: "repo-1",
      prompt: "Closed task",
      stage: "done",
      activity: "idle",
      branch: "task-closed",
      base_ref: "main",
      pr_number: null,
      pr_url: null,
      display_name: null,
      agent_provider: "claude",
      agent_type: "pty",
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:02:00.000Z",
      closed_at: "2026-05-22T00:02:00.000Z",
    },
  ]),
  listRepos: vi.fn(async () => [{
    id: "repo-1",
    name: "Repo One",
    path: "/repo",
    default_branch: "main",
  }]),
  listBlockersForItem: vi.fn(async () => []),
}));

vi.mock("../invoke", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("./desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    getIdToken: vi.fn(async () => "id-token"),
  })),
}));

vi.mock("./desktopFirebaseConfig", () => ({
  resolveDesktopFirebaseConfig: vi.fn(async () => ({
    functionsEndpoint: "http://127.0.0.1:5001/upsertTaskSnapshot",
  })),
}));

vi.mock("./cloudTaskPublisher", () => ({
  createCloudTaskPublisher: vi.fn(() => ({
    publish: mocks.publish,
  })),
}));

describe("publishDesktopTaskSnapshot", () => {
  beforeEach(() => {
    mocks.publish.mockClear();
    mocks.invoke.mockReset();
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

  it("publishes the mobile server desktop id used for relay routing", async () => {
    await publishDesktopTaskSnapshot(null as never, {
      id: "task-1",
      repo_id: "repo-1",
      prompt: "Implement relay terminal streaming",
      stage: "in progress",
      activity: "working",
      branch: "task-1",
      base_ref: "main",
      pr_number: null,
      pr_url: null,
      display_name: null,
      agent_provider: "claude",
      agent_type: "pty",
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:01:00.000Z",
      closed_at: null,
    } as never);

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "task-1",
      }),
    );
  });

  it("publishes open and recently closed local task snapshots during reconciliation", async () => {
    await publishDesktopTaskSnapshots(null as never);

    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      ownerLocalTaskId: "task-open",
      closedAt: null,
    }));
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      ownerLocalTaskId: "task-closed",
      stage: "done",
      closedAt: "2026-05-22T00:02:00.000Z",
    }));
  });
});

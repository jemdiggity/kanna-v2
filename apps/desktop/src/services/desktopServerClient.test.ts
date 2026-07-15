import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDesktopTask,
  createDesktopBackup,
  fetchDesktopRepoAgentProviders,
  fetchDesktopSnapshot,
  fetchPendingIncomingTransfers,
  getDesktopSetting,
  mutateDesktopWindowWorkspace,
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
} from "./desktopServerClient";

const mocks = vi.hoisted(() => {
  const invoke = vi.fn(async (command: string, args?: { name?: string }) => {
    if (command === "ensure_mobile_server") return undefined;
    if (command === "mobile_server_status") return { state: "running", lanPort: 48121 };
    if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") {
      throw new Error("env var not set");
    }
    throw new Error(`unexpected invoke: ${command}`);
  });
  return { invoke };
});

vi.mock("../invoke", () => ({
  invoke: mocks.invoke,
}));

describe("desktopServerClient", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(null);
    mocks.invoke.mockClear();
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(null);
    vi.unstubAllGlobals();
  });

  it("ensures the desktop server is running and uses its current port when fetching the snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [],
          taskBlockers: [],
          worktreePaths: {},
          settings: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopSnapshot()).resolves.toEqual({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });

    expect(mocks.invoke).toHaveBeenCalledWith("mobile_server_status");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/snapshot",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("fetches repo-scoped agent providers from the encoded repo endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          providers: [
            { id: "claude", executable: "/repo/.kanna/bin/claude" },
            { id: "future-provider", executable: "/repo/.kanna/bin/future-provider" },
            { id: "opencode", executable: "/repo/.kanna/bin/opencode" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDesktopRepoAgentProviders("repo/with space")).resolves.toEqual([
      "claude",
      "opencode",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/repos/repo%2Fwith%20space/agent-providers",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("allows tests to override server readiness checks", async () => {
    const ensureMobileServer = vi.fn(async () => {});
    setDesktopServerClientHandlersForTests({ ensureMobileServer });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [],
          taskBlockers: [],
          worktreePaths: {},
          settings: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDesktopSnapshot();

    expect(ensureMobileServer).toHaveBeenCalled();
    expect(ensureMobileServer.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("creates backups through the desktop server endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          backupPath: "/mock/data/kanna-v2.db.backup-2026-07-07T00-00-00",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDesktopBackup()).resolves.toEqual({
      backupPath: "/mock/data/kanna-v2.db.backup-2026-07-07T00-00-00",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/backup",
      {
        method: "POST",
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("treats a 204 close-task response as success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(closeDesktopTask("task-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/tasks/task-1/actions/close",
      {
        method: "POST",
        headers: undefined,
        body: undefined,
      },
    );
  });

  it("retries transient setting read failures during startup", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response("setting not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDesktopSetting("window_workspace_v1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "mobile_server_status")).toHaveLength(2);
  });

  it("sends narrow window workspace mutations to the atomic server endpoint", async () => {
    const response = {
      windows: [{
        windowId: "window-2",
        selectedRepoId: "repo-new",
        selectedItemId: "task-new",
        sidebarHidden: false,
        sidebarWidth: 260,
        order: 0,
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const mutation = {
      operation: "updateSelection" as const,
      windowId: "window-2",
      selectedRepoId: "repo-new",
      selectedItemId: "task-new",
    };

    await expect(mutateDesktopWindowWorkspace(mutation)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/window-workspace/mutations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
      },
    );
  });

  it("normalizes pending incoming transfers returned by the server", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          transfers: [
            {
              id: "transfer-1",
              sourcePeerId: "peer-source",
              sourceTaskId: "task-source",
              payloadJson: "{\"task\":{},\"repo\":{}}",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPendingIncomingTransfers()).resolves.toEqual([
      {
        id: "transfer-1",
        source_peer_id: "peer-source",
        source_task_id: "task-source",
        payload_json: "{\"task\":{},\"repo\":{}}",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48121/v1/transfers/incoming/pending",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
  });
});

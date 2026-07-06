import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDesktopSnapshot,
  fetchPendingIncomingTransfers,
  getDesktopSetting,
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
} from "./desktopServerClient";

vi.mock("../utils/invokeHelpers", () => ({
  readEnvVarOptional: vi.fn(async () => "49123"),
}));

describe("desktopServerClient transfer routes", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests(null);
    setDesktopSnapshotFetcherForTests(null);
  });

  afterEach(() => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    vi.unstubAllGlobals();
  });

  it("ensures the desktop server is running before fetching the initial snapshot", async () => {
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

    await expect(fetchDesktopSnapshot()).resolves.toEqual({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });
    expect(ensureMobileServer).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49123/v1/snapshot",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
    expect(ensureMobileServer.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("retries transient setting read failures during startup", async () => {
    const ensureMobileServer = vi.fn(async () => {});
    setDesktopServerClientHandlersForTests({ ensureMobileServer });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response("setting not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDesktopSetting("window_workspace_v1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ensureMobileServer).toHaveBeenCalledTimes(2);
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
      "http://127.0.0.1:49123/v1/transfers/incoming/pending",
      {
        method: "GET",
        headers: undefined,
        body: undefined,
      },
    );
  });
});

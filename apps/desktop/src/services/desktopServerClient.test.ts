import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPendingIncomingTransfers,
  setDesktopServerClientHandlersForTests,
} from "./desktopServerClient";

vi.mock("../utils/invokeHelpers", () => ({
  readEnvVarOptional: vi.fn(async () => "49123"),
}));

describe("desktopServerClient transfer routes", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

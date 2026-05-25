import { describe, expect, it, vi } from "vitest";
import { createCloudTaskPublisher } from "./cloudTaskPublisher";

describe("cloud task publisher", () => {
  it("posts snapshots to the configured Firebase function", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const publisher = createCloudTaskPublisher({
      endpoint: "http://localhost:5001/upsertTaskSnapshot",
      getIdToken: async () => "id-token-1",
      fetchImpl: fetchMock,
    });

    await publisher.publish({ cloudTaskId: "cloud-task-1", title: "Task" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/upsertTaskSnapshot",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer id-token-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ cloudTaskId: "cloud-task-1", title: "Task" }),
      }),
    );
  });

  it("skips publishing when the user is signed out", async () => {
    const fetchMock = vi.fn();
    const publisher = createCloudTaskPublisher({
      endpoint: "http://localhost:5001/upsertTaskSnapshot",
      getIdToken: async () => null,
      fetchImpl: fetchMock,
    });

    await publisher.publish({ cloudTaskId: "cloud-task-1" });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

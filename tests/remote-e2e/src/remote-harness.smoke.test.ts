import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRemoteHarness, type RemoteHarness } from "./harness";

describe("remote task E2E harness", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("authenticates as Buffy and invokes desktop status through the relay", async () => {
    const status = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });

    expect(status).toMatchObject({
      desktopId: harness.desktopId,
      desktopName: "Remote E2E Desktop",
      state: "running"
    });
  });
});

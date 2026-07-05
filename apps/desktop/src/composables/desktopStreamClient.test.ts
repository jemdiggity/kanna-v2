import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, args?: { name?: string }) => {
    if (command === "wait_for_mobile_server_ready") return null;
    if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") return "48330";
    throw new Error(`unexpected invoke: ${command}`);
  }),
  streamClient: vi.fn(function StreamClientMock() {
    return { close: vi.fn() };
  }),
}));

vi.mock("../invoke", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@kanna/stream-client", () => ({
  StreamClient: mocks.streamClient,
}));

describe("desktopStreamClient", () => {
  afterEach(async () => {
    const { resetSharedStreamClientForTests } = await import("./desktopStreamClient");
    resetSharedStreamClientForTests();
    vi.resetModules();
    mocks.invoke.mockClear();
    mocks.streamClient.mockClear();
  });

  it("awaits mobile server readiness before creating the shared stream client", async () => {
    const { getSharedStreamClient } = await import("./desktopStreamClient");

    await getSharedStreamClient();

    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("wait_for_mobile_server_ready");
    expect(mocks.streamClient).toHaveBeenCalledWith(expect.objectContaining({
      url: "ws://127.0.0.1:48330/v1/stream",
    }));
  });
});

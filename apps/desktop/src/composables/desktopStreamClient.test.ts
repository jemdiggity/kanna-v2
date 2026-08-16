import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const invokeDefault = async (command: string, args?: { name?: string }) => {
    if (command === "ensure_mobile_server") return null;
    if (command === "mobile_server_status") return { state: "running", lanPort: 48330 };
    if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") return "48330";
    throw new Error(`unexpected invoke: ${command}`);
  };
  const invoke = vi.fn(invokeDefault);
  const streamClient = vi.fn(function StreamClientMock() {
    return { close: vi.fn() };
  });
  return { invoke, invokeDefault, streamClient };
});

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
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(mocks.invokeDefault);
    mocks.streamClient.mockClear();
  });

  it("ensures the mobile server is running before creating the shared stream client", async () => {
    const { getSharedStreamClient } = await import("./desktopStreamClient");

    await getSharedStreamClient();

    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("ensure_mobile_server");
    expect(mocks.streamClient).toHaveBeenCalledWith(expect.objectContaining({
      url: "ws://127.0.0.1:48330/v1/stream",
    }));
  });

  it("uses the running desktop server port for the terminal stream URL", async () => {
    mocks.invoke.mockImplementation(async (command: string, args?: { name?: string }) => {
      if (command === "mobile_server_status") return { state: "running", lanPort: 48121 };
      if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") {
        throw new Error("env var not set");
      }
      return mocks.invokeDefault(command, args);
    });
    const { getSharedStreamClient } = await import("./desktopStreamClient");

    await getSharedStreamClient();

    expect(mocks.streamClient).toHaveBeenCalledWith(expect.objectContaining({
      url: "ws://127.0.0.1:48121/v1/stream",
    }));
  });

  it("tracks authenticated connection generations for snapshot catch-up", async () => {
    const {
      getSharedStreamClient,
      getSharedStreamConnectionState,
      onSharedStreamConnectionChange,
    } = await import("./desktopStreamClient");
    const connectionChanges: boolean[] = [];
    const unsubscribe = onSharedStreamConnectionChange((connected) => {
      connectionChanges.push(connected);
    });

    await getSharedStreamClient();
    const options = mocks.streamClient.mock.calls[0]?.[0] as {
      onConnectionChange: (connected: boolean) => void;
    };

    expect(getSharedStreamConnectionState()).toEqual({ connected: false, revision: 0 });
    options.onConnectionChange(true);
    expect(getSharedStreamConnectionState()).toEqual({ connected: true, revision: 1 });
    options.onConnectionChange(false);
    expect(getSharedStreamConnectionState()).toEqual({ connected: false, revision: 1 });
    options.onConnectionChange(true);
    expect(getSharedStreamConnectionState()).toEqual({ connected: true, revision: 2 });
    expect(connectionChanges).toEqual([true, false, true]);

    unsubscribe();
  });
});

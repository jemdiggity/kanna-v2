import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const invoke = vi.fn(async (command: string, args?: { name?: string }) => {
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    mocks.invoke.mockClear();
  });

  it("uses the running desktop server port when fetching the snapshot", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    })));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchDesktopSnapshot, setDesktopSnapshotFetcherForTests } = await import("./desktopServerClient");
    setDesktopSnapshotFetcherForTests(null);

    await fetchDesktopSnapshot();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:48121/v1/snapshot", { method: "GET" });
  });
});

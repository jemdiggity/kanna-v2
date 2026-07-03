import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileExistsSafe, readEnvVarOptional, whichBinaryOptional } from "./invokeHelpers";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("../invoke", () => ({
  invoke: mocks.invoke,
}));

describe("invokeHelpers", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    vi.restoreAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("returns false and logs at debug level when file_exists fails", async () => {
    const error = new Error("missing command");
    mocks.invoke.mockRejectedValueOnce(error);

    await expect(fileExistsSafe("/tmp/missing")).resolves.toBe(false);

    expect(mocks.invoke).toHaveBeenCalledWith("file_exists", { path: "/tmp/missing" });
    expect(console.debug).toHaveBeenCalledWith("[invokeHelpers] file_exists failed for /tmp/missing:", error);
  });

  it("returns null without logging when read_env_var fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("unset"));

    await expect(readEnvVarOptional("KANNA_MOBILE_SERVER_PORT")).resolves.toBeNull();

    expect(mocks.invoke).toHaveBeenCalledWith("read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" });
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("returns null and logs at debug level when which_binary fails", async () => {
    const error = new Error("not found");
    mocks.invoke.mockRejectedValueOnce(error);

    await expect(whichBinaryOptional("kanna-cli")).resolves.toBeNull();

    expect(mocks.invoke).toHaveBeenCalledWith("which_binary", { name: "kanna-cli" });
    expect(console.debug).toHaveBeenCalledWith("[invokeHelpers] which_binary failed for kanna-cli:", error);
  });
});

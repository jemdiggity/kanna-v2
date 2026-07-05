import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDesktopTask, markDesktopTaskRead, reopenDesktopTask } from "./desktopServerClient";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

describe("desktopServerClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_env_var" && args?.name === "KANNA_MOBILE_SERVER_PORT") {
        return "48321";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => "",
    })));
  });

  it("posts task close actions to the local kanna-server", async () => {
    await closeDesktopTask("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/close",
      { method: "POST" },
    );
  });

  it("posts task reopen actions to the local kanna-server", async () => {
    await reopenDesktopTask("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/reopen",
      { method: "POST" },
    );
  });

  it("posts task mark-read actions to the local kanna-server", async () => {
    await markDesktopTaskRead("task-1");

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:48321/v1/tasks/task-1/actions/mark-read",
      { method: "POST" },
    );
  });
});

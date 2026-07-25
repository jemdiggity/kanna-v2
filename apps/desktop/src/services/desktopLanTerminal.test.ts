import { describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock("../listen", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { invoke } from "../invoke";
import { createDesktopLanTerminalClient } from "./desktopLanTerminal";

describe("createDesktopLanTerminalClient", () => {
  it("sends LAN terminal control actions through Tauri commands", async () => {
    const client = createDesktopLanTerminalClient();

    await client.sendInput({ desktopId: "peer-primary", taskId: "task-1", data: "hello\n" });
    await client.resize({ desktopId: "peer-primary", taskId: "task-1", cols: 100, rows: 32 });
    await client.closeTask({ desktopId: "peer-primary", taskId: "task-1" });
    await client.advanceStage({ desktopId: "peer-primary", taskId: "task-1" });
    await client.markTaskRead({ desktopId: "peer-primary", taskId: "task-1" });

    expect(invoke).toHaveBeenCalledWith("send_transfer_peer_session_input", {
      peerId: "peer-primary",
      sessionId: "task-1",
      data: "hello\n",
    });
    expect(invoke).toHaveBeenCalledWith("resize_transfer_peer_session", {
      peerId: "peer-primary",
      sessionId: "task-1",
      cols: 100,
      rows: 32,
    });
    expect(invoke).toHaveBeenCalledWith("close_transfer_peer_task", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
    expect(invoke).toHaveBeenCalledWith("advance_transfer_peer_task_stage", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
    expect(invoke).toHaveBeenCalledWith("mark_transfer_peer_task_read", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
  });

  it("reads a remote task file through the transfer sidecar command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: "read_peer_task_file",
      request_id: "read-task-file-1",
      path: "src/app.ts",
      content: "remote body",
    });
    const client = createDesktopLanTerminalClient();

    await expect(
      client.readTaskFile({ desktopId: "peer-primary", taskId: "task-1", path: "src/app.ts" }),
    ).resolves.toEqual({ path: "src/app.ts", content: "remote body" });

    expect(invoke).toHaveBeenCalledWith("read_transfer_peer_task_file", {
      peerId: "peer-primary",
      taskId: "task-1",
      path: "src/app.ts",
    });
  });

  it("rejects a malformed LAN task file response", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ path: "src/app.ts" });
    const client = createDesktopLanTerminalClient();

    await expect(
      client.readTaskFile({ desktopId: "peer-primary", taskId: "task-1", path: "src/app.ts" }),
    ).rejects.toThrow("LAN task file response was malformed.");
  });
});

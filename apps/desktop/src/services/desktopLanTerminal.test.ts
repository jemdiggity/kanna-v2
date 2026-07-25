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
});

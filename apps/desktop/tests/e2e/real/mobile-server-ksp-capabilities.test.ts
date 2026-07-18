import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAppKannaServer } from "../helpers/kannaServer";
import { WebDriverClient } from "../helpers/webdriver";

type KspFrame = Record<string, unknown> & { type?: unknown };

const client = new WebDriverClient();

function streamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/stream";
  return url.toString();
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectOpen(new Error("timed out opening app kanna-server KSP websocket"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = () => {
      cleanup();
      rejectOpen(new Error("app kanna-server KSP websocket failed before open"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

function waitForFrame(
  socket: WebSocket,
  predicate: (frame: KspFrame) => boolean,
): Promise<KspFrame> {
  return new Promise((resolveFrame, rejectFrame) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectFrame(new Error("timed out waiting for app kanna-server KSP frame"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: KspFrame;
      try {
        frame = JSON.parse(event.data) as KspFrame;
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      cleanup();
      resolveFrame(frame);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      rejectFrame(new Error(`KSP websocket closed while waiting: ${event.code}`));
    };
    const onError = () => {
      cleanup();
      rejectFrame(new Error("app kanna-server KSP websocket failed"));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

describe("app kanna-server KSP capabilities", () => {
  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("ships a sidecar that advertises and accepts the visual companion stream", async () => {
    const server = await resolveAppKannaServer(client);
    const socket = new WebSocket(streamUrl(server.baseUrl));

    try {
      await waitForSocketOpen(socket);
      const authReply = waitForFrame(
        socket,
        (frame) => frame.type === "auth_ok" || frame.type === "error",
      );
      socket.send(JSON.stringify({ type: "auth" }));
      const authFrame = await authReply;

      expect(authFrame).toMatchObject({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal", "companion"],
      });

      const attachReply = waitForFrame(
        socket,
        (frame) =>
          frame.type === "companion_unavailable" ||
          frame.type === "companion_error" ||
          frame.type === "error",
      );
      socket.send(JSON.stringify({
        type: "attach",
        task_id: "missing-e2e-task",
        kind: "companion",
        from_seq: 0,
      }));
      const attachFrame = await attachReply;

      expect(attachFrame).not.toMatchObject({ code: "bad_frame" });
      expect(String(attachFrame.message ?? "")).not.toContain("unparseable frame");
      expect(["companion_unavailable", "companion_error"]).toContain(attachFrame.type);
    } finally {
      socket.close();
    }
  });
});

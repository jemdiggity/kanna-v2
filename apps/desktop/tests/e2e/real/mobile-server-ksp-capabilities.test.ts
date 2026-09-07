import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAppKannaServer } from "../helpers/kannaServer";
import { tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { localProcessFetch } from "@kanna/local-process-fetch";

type KspFrame = Record<string, unknown> & { type?: unknown };

const client = new WebDriverClient();

function streamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hostname = lanAddress();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/stream";
  return url.toString();
}

function lanAddress(): string {
  const interfaces = networkInterfaces();
  for (const name of ["en0", "en1", ...Object.keys(interfaces).sort()]) {
    const address = interfaces[name]?.find((candidate) =>
      candidate.family === "IPv4" && !candidate.internal
    );
    if (address) return address.address;
  }
  throw new Error("no non-loopback IPv4 address is available for the paired-device KSP test");
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
    const pairing = await tauriInvoke(client, "create_mobile_pairing_session") as {
      code?: unknown;
    };
    if (typeof pairing.code !== "string") {
      throw new Error(`pairing session did not return a code: ${JSON.stringify(pairing)}`);
    }
    const claimResponse = await localProcessFetch(`${server.baseUrl}/v1/pairing/sessions/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pairing.code,
        deviceId: "mobile-server-ksp-capabilities-e2e",
        deviceName: "Kanna E2E",
      }),
    });
    const claim = await claimResponse.json().catch(() => null) as { deviceSecret?: unknown } | null;
    if (!claimResponse.ok || typeof claim?.deviceSecret !== "string") {
      throw new Error(`pairing claim failed: ${claimResponse.status} ${JSON.stringify(claim)}`);
    }
    const socket = new WebSocket(streamUrl(server.baseUrl));

    try {
      await waitForSocketOpen(socket);
      const authReply = waitForFrame(
        socket,
        (frame) => frame.type === "auth_ok" || frame.type === "error",
      );
      socket.send(JSON.stringify({
        type: "auth",
        credential: JSON.stringify({
          deviceId: "mobile-server-ksp-capabilities-e2e",
          deviceSecret: claim.deviceSecret,
        }),
      }));
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

import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_CLOUD_TRANSPORT_URL,
  createDesktopRelayTerminalClient,
  resolveDesktopCloudTransportUrlFromEnv,
  type DesktopRelayTerminalEvent,
} from "./desktopRelayTerminal";

class FakeSocket {
  readyState = 1;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string) {
    this.sent.push(data);
  }
}

describe("createDesktopRelayTerminalClient", () => {
  it("observes remote terminal output over the relay only after auth", async () => {
    const socket = new FakeSocket();
    const events: DesktopRelayTerminalEvent[] = [];
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    client.observeTerminal({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });

    socket.onopen?.();
    await Promise.resolve();
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "auth", id_token: "id-token" });

    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: "invoke",
      desktopId: "desktop-owner",
      command: "observe_session",
      args: { session_id: "task-1" },
    });

    const observeId = JSON.parse(socket.sent[1]).id;
    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: observeId, data: null }) });
    await Promise.resolve();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "task-1", data_b64: "aGVsbG8=" },
      }),
    });

    expect(events).toEqual([
      { type: "ready", taskId: "task-1" },
      { type: "output", taskId: "task-1", text: "hello" },
    ]);
  });

  it("sends unobserve when a terminal subscription closes", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const subscription = client.observeTerminal({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });

    socket.onopen?.();
    await Promise.resolve();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await Promise.resolve();

    subscription.close();
    await Promise.resolve();

    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual(
      expect.objectContaining({
        type: "invoke",
        desktopId: "desktop-owner",
        command: "unobserve_session",
        args: { session_id: "task-1" },
      }),
    );
  });

  it("sends terminal input through the relay", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const promise = client.sendInput({
      desktopId: "desktop-owner",
      taskId: "task-1",
      data: "hello\n",
    });

    socket.onopen?.();
    await Promise.resolve();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "invoke",
      desktopId: "desktop-owner",
      command: "send_input",
      args: { session_id: "task-1", data: "hello\n" },
    }));
    const invokeId = sent.find((entry) => entry.command === "send_input").id;
    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: invokeId, data: null }) });

    await expect(promise).resolves.toBeUndefined();
  });

  it("sends terminal resize, close task, and advance stage through the relay", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const resizePromise = client.resize({
      desktopId: "desktop-owner",
      taskId: "task-1",
      cols: 100,
      rows: 32,
    });
    const closePromise = client.closeTask({
      desktopId: "desktop-owner",
      taskId: "task-1",
    });
    const advancePromise = client.advanceStage({
      desktopId: "desktop-owner",
      taskId: "task-1",
    });

    socket.onopen?.();
    await Promise.resolve();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "invoke",
      desktopId: "desktop-owner",
      command: "resize_session",
      args: { session_id: "task-1", cols: 100, rows: 32 },
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "invoke",
      desktopId: "desktop-owner",
      command: "close_task",
      args: { task_id: "task-1" },
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "invoke",
      desktopId: "desktop-owner",
      command: "advance_stage",
      args: { task_id: "task-1" },
    }));

    for (const command of ["resize_session", "close_task", "advance_stage"]) {
      const invokeId = sent.find((entry) => entry.command === command).id;
      socket.onmessage?.({ data: JSON.stringify({ type: "response", id: invokeId, data: null }) });
    }

    await expect(resizePromise).resolves.toBeUndefined();
    await expect(closePromise).resolves.toBeUndefined();
    await expect(advancePromise).resolves.toBeUndefined();
  });
});

describe("resolveDesktopCloudTransportUrlFromEnv", () => {
  it("uses explicit URL and local port overrides before defaults", () => {
    expect(resolveDesktopCloudTransportUrlFromEnv({
      KANNA_RELAY_URL: " wss://cloud.example ",
      KANNA_RELAY_PORT: "19083",
    }, { dev: false })).toBe("wss://cloud.example");

    expect(resolveDesktopCloudTransportUrlFromEnv({
      KANNA_RELAY_PORT: "19083",
    }, { dev: false })).toBe("ws://127.0.0.1:19083");
  });

  it("uses the production cloud transport default only outside dev builds", () => {
    expect(resolveDesktopCloudTransportUrlFromEnv({}, { dev: false })).toBe(PRODUCTION_CLOUD_TRANSPORT_URL);
    expect(resolveDesktopCloudTransportUrlFromEnv({}, { dev: true })).toBeNull();
  });
});

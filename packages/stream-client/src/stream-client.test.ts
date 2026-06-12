import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ClientFrame, ServerFrame } from "@kanna/agent-protocol";
import { StreamClient, type WebSocketLike } from "./index";

class MockSocket implements WebSocketLike {
  sent: ClientFrame[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  receive(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(): void {
    this.onclose?.({});
  }
}

describe("StreamClient", () => {
  let sockets: MockSocket[];
  let factory: (url: string) => WebSocketLike;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    factory = () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connectedClient(): { client: StreamClient; socket: MockSocket } {
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    const socket = sockets[0];
    socket.open();
    expect(socket.sent[0]).toEqual({ type: "auth" });
    socket.receive({ type: "auth_ok" });
    return { client, socket };
  }

  it("authenticates on open and flushes queued frames after auth_ok", () => {
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    // Queued before the socket is even open.
    client.sendAgentInput("task-1", "hello");

    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok" });

    expect(socket.sent).toEqual([
      { type: "auth" },
      { type: "agent_input", task_id: "task-1", text: "hello" },
    ]);
    client.close();
  });

  it("delivers snapshot and live events and tracks the resume seq", () => {
    const { client, socket } = connectedClient();
    const snapshots: Array<{ count: number; nextSeq: number }> = [];
    const events: Array<{ seq: number; event: AgentEvent }> = [];

    client.attachAgent("task-1", {
      onSnapshot: (e, nextSeq) => snapshots.push({ count: e.length, nextSeq }),
      onEvent: (seq, event) => events.push({ seq, event }),
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-1",
      kind: "agent",
      from_seq: 0,
    });

    socket.receive({
      type: "agent_snapshot",
      task_id: "task-1",
      next_seq: 2,
      events: [
        { seq: 0, event: { type: "user_message", text: "prompt" } },
        { seq: 1, event: { type: "turn_started", model: null } },
      ],
    });
    socket.receive({
      type: "agent_event",
      task_id: "task-1",
      seq: 2,
      event: { type: "assistant_text", text: "hi", truncated: false },
    });

    expect(snapshots).toEqual([{ count: 2, nextSeq: 2 }]);
    expect(events).toEqual([
      { seq: 2, event: { type: "assistant_text", text: "hi", truncated: false } },
    ]);

    // Reconnect resumes from seq 3 (last seen + 1).
    socket.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({ type: "auth_ok" });
    expect(socket2.sent).toEqual([
      { type: "auth" },
      { type: "attach", task_id: "task-1", kind: "agent", from_seq: 3 },
    ]);
    client.close();
  });

  it("correlates request frames with responses", async () => {
    const { client, socket } = connectedClient();

    const pending = client.request("GET", "/v1/status");
    const sent = socket.sent.at(-1);
    expect(sent).toMatchObject({ type: "request", method: "GET", path: "/v1/status" });
    const id = (sent as { id: number }).id;

    socket.receive({ type: "response", id, status: 200, body: { ok: true } });
    await expect(pending).resolves.toEqual({ status: 200, body: { ok: true } });
    client.close();
  });

  it("rejects in-flight requests on disconnect", async () => {
    const { client, socket } = connectedClient();
    const pending = client.request("GET", "/v1/status");
    socket.drop();
    await expect(pending).rejects.toThrow("stream disconnected");
    client.close();
  });

  it("routes task errors to the attachment handler", () => {
    const { client, socket } = connectedClient();
    const errors: string[] = [];
    client.attachAgent("task-1", {
      onSnapshot: () => {},
      onEvent: () => {},
      onError: (code) => errors.push(code),
    });
    socket.receive({
      type: "error",
      task_id: "task-1",
      code: "no_session",
      message: "missing",
    });
    expect(errors).toEqual(["no_session"]);
    client.close();
  });

  it("reattaches terminal streams after reconnect and routes snapshot before output", () => {
    const { client, socket } = connectedClient();
    const events: string[] = [];

    client.attachTerminal("task-pty", {
      onSnapshot: (_cols, _rows, dataB64) => events.push(`snapshot:${dataB64}`),
      onOutput: (dataB64) => events.push(`output:${dataB64}`),
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-pty",
      kind: "terminal",
      from_seq: 0,
    });

    socket.receive({
      type: "term_snapshot",
      task_id: "task-pty",
      cols: 80,
      rows: 24,
      data_b64: "c25hcA==",
    });
    socket.receive({
      type: "term_output",
      task_id: "task-pty",
      data_b64: "bGl2ZQ==",
    });

    expect(events).toEqual(["snapshot:c25hcA==", "output:bGl2ZQ=="]);

    socket.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({ type: "auth_ok" });

    expect(socket2.sent).toEqual([
      { type: "auth" },
      { type: "attach", task_id: "task-pty", kind: "terminal", from_seq: 0 },
    ]);
    client.close();
  });

  it("sends terminal input and resize frames over the stream", () => {
    const { client, socket } = connectedClient();

    client.sendTermInput("task-pty", "YQ==");
    client.sendTermResize("task-pty", 120, 40);

    expect(socket.sent.slice(1)).toEqual([
      { type: "term_input", task_id: "task-pty", data_b64: "YQ==" },
      { type: "term_resize", task_id: "task-pty", cols: 120, rows: 40 },
    ]);
    client.close();
  });

  it("stops reconnecting after close", () => {
    const { client, socket } = connectedClient();
    client.close();
    socket.drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(1);
  });
});

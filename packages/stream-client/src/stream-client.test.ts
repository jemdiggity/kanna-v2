import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ClientFrame,
  CompanionEvent,
  KspCapability,
  ServerFrame,
  StreamKind,
} from "@kanna/agent-protocol";
import {
  createRelayTunnelWebSocketFactory,
  StreamClient,
  type CompanionEventResult,
  type WebSocketLike,
} from "./index";

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

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

  drop(code?: number): void {
    this.onclose?.(code === undefined ? {} : { code });
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

  function connectedClient(
    streamKinds?: StreamKind[],
    capabilities?: KspCapability[],
  ): { client: StreamClient; socket: MockSocket } {
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    const socket = sockets[0];
    socket.open();
    expect(socket.sent[0]).toEqual({
      type: "auth",
      capabilities: ["companion_event_epoch", "term_input_boundary"],
    });
    socket.receive({
      type: "auth_ok",
      ...(streamKinds ? { stream_kinds: streamKinds } : {}),
      capabilities: capabilities ?? ["term_input_boundary"],
    });
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
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      { type: "agent_input", task_id: "task-1", text: "hello" },
    ]);
    client.close();
  });

  it("sends agent_set_model frames", () => {
    const { client, socket } = connectedClient();
    client.sendAgentSetModel("task-1", "claude-haiku-4-5-20251001");
    expect(socket.sent).toContainEqual({
      type: "agent_set_model",
      task_id: "task-1",
      model: "claude-haiku-4-5-20251001",
    });
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
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      { type: "attach", task_id: "task-1", kind: "agent", from_seq: 3 },
    ]);
    client.close();
  });

  it("attaches, routes, detaches, and reconnects desktop task summaries", () => {
    const { client, socket } = connectedClient(["task_summary"]);
    const summaries: unknown[] = [];
    client.attachTaskSummaries({ onSummary: (summary) => summaries.push(summary) });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "__desktop__",
      kind: "task_summary",
      from_seq: 0,
    });
    socket.receive({
      type: "task_summary",
      task_id: "task-1",
      snippet: "still working",
      activity: "working",
      runtime_state: "busy",
      revision: 4,
    });
    expect(summaries).toEqual([{
      taskId: "task-1",
      snippet: "still working",
      activity: "working",
      runtimeState: "busy",
      revision: 4,
    }]);
    client.detachTaskSummaries();
    expect(socket.sent.at(-1)).toEqual({
      type: "detach",
      task_id: "__desktop__",
      kind: "task_summary",
    });
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

  it("notifies state-change listeners for coarse server invalidations", () => {
    const { client, socket } = connectedClient();
    const scopes: string[] = [];
    const unsubscribe = client.onStateChanged((scope) => scopes.push(scope));

    socket.receive({ type: "state_changed", scope: "tasks" });
    socket.receive({ type: "state_changed", scope: "repos" });
    unsubscribe();
    socket.receive({ type: "state_changed", scope: "settings" });

    expect(scopes).toEqual(["tasks", "repos"]);
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

  it("routes connection errors to active attachment handlers", () => {
    const { client, socket } = connectedClient();
    const errors: string[] = [];
    client.attachTerminal("task-1", {
      onOutput: () => {},
      onError: (code, message) => errors.push(`${code}:${message}`),
    });
    socket.receive({
      type: "error",
      code: "unauthorized",
      message: "invalid stream credential",
    });

    expect(errors).toEqual(["unauthorized:invalid stream credential"]);
    client.close();
  });


  it("reattaches terminal streams after reconnect and routes snapshot before output", () => {
    const { client, socket } = connectedClient();
    const events: string[] = [];

    client.attachTerminal("task-pty", {
      onSnapshot: (_cols, _rows, dataB64, agentProvider) =>
        events.push(`snapshot:${dataB64}:${agentProvider}`),
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
      agent_provider: "claude",
    });
    socket.receive({
      type: "term_output",
      task_id: "task-pty",
      data_b64: "bGl2ZQ==",
    });

    expect(events).toEqual(["snapshot:c25hcA==:claude", "output:bGl2ZQ=="]);

    socket.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({ type: "auth_ok" });

    expect(socket2.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      { type: "attach", task_id: "task-pty", kind: "terminal", from_seq: 0 },
    ]);
    client.close();
  });

  it("preserves snapshot-before-output ordering while snapshot decoding is delayed", async () => {
    let finishSnapshot!: (frame: ServerFrame | null) => void;
    const frameDecoder = {
      decode: vi.fn((data: string) => {
        const frame = JSON.parse(data) as ServerFrame;
        if (frame.type === "term_snapshot") {
          return new Promise<ServerFrame | null>((resolve) => {
            finishSnapshot = resolve;
          });
        }
        return Promise.resolve(frame);
      }),
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["terminal"] });
    await flushMicrotasks();
    const events: string[] = [];
    client.attachTerminal("task-delayed", {
      onSnapshot: (_cols, _rows, dataB64) => events.push(`snapshot:${dataB64}`),
      onOutput: (dataB64) => events.push(`output:${dataB64}`),
    });

    socket.receive({
      type: "term_snapshot",
      task_id: "task-delayed",
      cols: 80,
      rows: 24,
      data_b64: "c25hcA==",
    });
    await flushMicrotasks();
    socket.receive({
      type: "term_output",
      task_id: "task-delayed",
      data_b64: "bGl2ZQ==",
    });

    expect(events).toEqual([]);
    finishSnapshot({
      type: "term_snapshot",
      task_id: "task-delayed",
      cols: 80,
      rows: 24,
      data_b64: "c25hcA==",
    });
    await flushMicrotasks();
    expect(events).toEqual(["snapshot:c25hcA==", "output:bGl2ZQ=="]);
    client.close();
  });

  it("routes status changes to terminal attachments", () => {
    const { client, socket } = connectedClient();
    const statuses: string[] = [];
    client.attachTerminal("task-pty", {
      onOutput: () => {},
      onStatus: (status) => statuses.push(status),
    });

    socket.receive({
      type: "status_changed",
      task_id: "task-pty",
      status: "busy",
    });

    expect(statuses).toEqual(["busy"]);
    client.close();
  });

  it("continues routing status changes to agent attachments", () => {
    const { client, socket } = connectedClient();
    const statuses: string[] = [];
    client.attachAgent("task-agent", {
      onSnapshot: () => {},
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    });

    socket.receive({
      type: "status_changed",
      task_id: "task-agent",
      status: "waiting",
    });

    expect(statuses).toEqual(["waiting"]);
    client.close();
  });

  it("ignores terminal status changes when the optional handler is absent", () => {
    const { client, socket } = connectedClient();
    client.attachTerminal("task-pty", { onOutput: () => {} });

    expect(() => {
      socket.receive({
        type: "status_changed",
        task_id: "task-pty",
        status: "idle",
      });
    }).not.toThrow();
    client.close();
  });

  it("ignores status changes for tasks without an attachment", () => {
    const { client, socket } = connectedClient();
    const terminalStatus = vi.fn();
    const agentStatus = vi.fn();
    client.attachTerminal("task-attached", {
      onOutput: () => {},
      onStatus: terminalStatus,
    });
    client.attachAgent("task-attached", {
      onSnapshot: () => {},
      onEvent: () => {},
      onStatus: agentStatus,
    });

    expect(() => {
      socket.receive({
        type: "status_changed",
        task_id: "task-unattached",
        status: "busy",
      });
    }).not.toThrow();
    expect(terminalStatus).not.toHaveBeenCalled();
    expect(agentStatus).not.toHaveBeenCalled();
    client.close();
  });

  it("stamps terminal output dispatch with the local monotonic clock", () => {
    const now = vi.fn(() => 1_234.5);
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      now,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok" });
    const received: Array<{ dataB64: string; receivedAtMs: number }> = [];
    client.attachTerminal("task-timed", {
      onOutput: (dataB64, metadata) => received.push({
        dataB64,
        receivedAtMs: metadata.receivedAtMs,
      }),
    });

    socket.receive({
      type: "term_output",
      task_id: "task-timed",
      data_b64: "dGltZWQ=",
    });

    expect(received).toEqual([{ dataB64: "dGltZWQ=", receivedAtMs: 1_234.5 }]);
    expect(now).toHaveBeenCalledOnce();
    client.close();
  });

  it("keeps terminal output responsive while an actual maximum companion bundle decodes", async () => {
    let finishCompanionDecode: ((frame: ServerFrame | null) => void) | undefined;
    const frameDecoder = {
      decode: vi.fn((data: string) => {
        if (data.startsWith('{"type":"companion_snapshot",')) {
          return new Promise<ServerFrame | null>((resolve) => {
            finishCompanionDecode = resolve;
          });
        }
        return Promise.resolve(JSON.parse(data) as ServerFrame);
      }),
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["terminal", "companion"] });
    await flushMicrotasks();

    const output = vi.fn();
    client.attachTerminal("task-max", { onOutput: output });
    const assetBytes = 16 * 1024 * 1024 / 32;
    const assetDataB64 = Buffer.alloc(assetBytes).toString("base64");
    const maximumBundle = JSON.stringify({
      type: "companion_snapshot",
      task_id: "task-max",
      session_id: "session-max",
      revision: "revision-max",
      document_kind: "full_document",
      html: "x".repeat(1024 * 1024),
      assets: Array.from({ length: 32 }, (_, index) => ({
        name: `${index}.bin`,
        content_type: "application/octet-stream",
        digest: "d".repeat(64),
        data_b64: assetDataB64,
      })),
    });

    socket.onmessage?.({ data: maximumBundle });
    await flushMicrotasks();
    expect(finishCompanionDecode).toBeTypeOf("function");

    socket.receive({
      type: "term_output",
      task_id: "task-max",
      data_b64: "cmVzcG9uc2l2ZQ==",
    });
    expect(output).toHaveBeenCalledWith(
      "cmVzcG9uc2l2ZQ==",
      expect.objectContaining({ receivedAtMs: expect.any(Number) }),
    );

    finishCompanionDecode?.(null);
    client.close();
    expect(frameDecoder.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a legal maximum companion chunk burst healthy behind a delayed decoder", async () => {
    let blockNextDecode = false;
    let releaseDecode: ((frame: ServerFrame | null) => void) | undefined;
    const frameDecoder = {
      decode: vi.fn((data: string) => {
        if (blockNextDecode) {
          blockNextDecode = false;
          return new Promise<ServerFrame | null>((resolve) => {
            releaseDecode = () => resolve(JSON.parse(data) as ServerFrame);
          });
        }
        return Promise.resolve(JSON.parse(data) as ServerFrame);
      }),
      decodeChunks: vi.fn((chunks: readonly string[]) =>
        Promise.resolve(JSON.parse(chunks.join("")) as ServerFrame)
      ),
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["companion"] });
    await flushMicrotasks();
    const snapshots: unknown[] = [];
    client.attachCompanion("task-max-chunks", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    const assetDataB64 = Buffer.alloc(16 * 1024 * 1024 / 32).toString("base64");
    const serialized = JSON.stringify({
      type: "companion_snapshot",
      task_id: "task-max-chunks",
      session_id: "session-max",
      revision: "revision-max",
      document_kind: "full_document",
      html: "x".repeat(1024 * 1024),
      assets: Array.from({ length: 32 }, (_, index) => ({
        name: `${index}.bin`,
        content_type: "application/octet-stream",
        digest: "d".repeat(64),
        data_b64: assetDataB64,
      })),
    } satisfies ServerFrame);
    const chunkCharacters = 96 * 1024;
    const count = Math.ceil(serialized.length / chunkCharacters);
    expect(count).toBeGreaterThan(200);

    blockNextDecode = true;
    for (let index = 0; index < count; index += 1) {
      socket.receive({
        type: "companion_snapshot_chunk",
        task_id: "task-max-chunks",
        transfer_id: "session-max:revision-max",
        index,
        count,
        data: serialized.slice(
          index * chunkCharacters,
          (index + 1) * chunkCharacters,
        ),
      } as unknown as ServerFrame);
    }

    expect(socket.closed).toBe(false);
    expect(releaseDecode).toBeTypeOf("function");
    releaseDecode?.(null);
    for (let index = 0; index < count + 10; index += 1) {
      await Promise.resolve();
    }
    expect(socket.closed).toBe(false);
    expect(snapshots).toEqual([
      expect.objectContaining({
        sessionId: "session-max",
        revision: "revision-max",
      }),
    ]);
    client.close();
  });

  it("admits two repeated maximum companion bundles without a reconnect loop", async () => {
    type PendingDecode = {
      chunks: readonly string[];
      resolve(frame: ServerFrame | null): void;
    };
    const pendingDecodes: PendingDecode[] = [];
    const frameDecoder = {
      decode: vi.fn((data: string) =>
        Promise.resolve(JSON.parse(data) as ServerFrame)
      ),
      decodeChunks: vi.fn((chunks: readonly string[]) =>
        new Promise<ServerFrame | null>((resolve) => {
          pendingDecodes.push({ chunks, resolve });
        })
      ),
      cancel: vi.fn(),
    };
    const revisions = new Map<string, string[]>();
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["companion"] });
    await flushMicrotasks();

    for (const taskId of ["task-max-a", "task-max-b"]) {
      revisions.set(taskId, []);
      client.attachCompanion(taskId, {
        onSnapshot: (snapshot) => revisions.get(taskId)!.push(snapshot.revision),
        onUnavailable: () => {},
        onEventResult: () => {},
      });
    }

    const assetDataB64 = Buffer.alloc(16 * 1024 * 1024 / 32).toString("base64");
    const maximumBundle = (taskId: string, revision: string) => JSON.stringify({
      type: "companion_snapshot",
      task_id: taskId,
      session_id: `session-${taskId}`,
      revision,
      document_kind: "full_document",
      html: "x".repeat(1024 * 1024),
      assets: Array.from({ length: 32 }, (_, index) => ({
        name: `${index}.bin`,
        content_type: "application/octet-stream",
        digest: "d".repeat(64),
        data_b64: assetDataB64,
      })),
    } satisfies ServerFrame);
    const chunkCharacters = 96 * 1024;

    for (let round = 1; round <= 2; round += 1) {
      const bundles = ["task-max-a", "task-max-b"].map((taskId) => ({
        taskId,
        revision: `revision-${round}-${taskId}`,
        serialized: maximumBundle(taskId, `revision-${round}-${taskId}`),
      }));
      const counts = bundles.map(({ serialized }) =>
        Math.ceil(serialized.length / chunkCharacters)
      );
      expect(Math.min(...counts)).toBeGreaterThan(200);

      for (let index = 0; index < Math.max(...counts); index += 1) {
        for (let bundleIndex = 0; bundleIndex < bundles.length; bundleIndex += 1) {
          const bundle = bundles[bundleIndex];
          const count = counts[bundleIndex];
          if (index >= count) continue;
          socket.receive({
            type: "companion_snapshot_chunk",
            task_id: bundle.taskId,
            transfer_id: `${bundle.taskId}:${round}`,
            index,
            count,
            data: bundle.serialized.slice(
              index * chunkCharacters,
              (index + 1) * chunkCharacters,
            ),
          } as unknown as ServerFrame);
        }
      }

      for (
        let index = 0;
        index < counts.reduce((total, count) => total + count, 0) + 20;
        index += 1
      ) {
        await Promise.resolve();
      }
      expect(socket.closed).toBe(false);
      expect(sockets).toHaveLength(1);
      expect(pendingDecodes).toHaveLength(round * 2 - 1);

      const first = pendingDecodes[(round - 1) * 2];
      first.resolve(JSON.parse(first.chunks.join("")) as ServerFrame);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(pendingDecodes).toHaveLength(round * 2);
      const second = pendingDecodes[(round - 1) * 2 + 1];
      second.resolve(JSON.parse(second.chunks.join("")) as ServerFrame);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    }

    expect(revisions.get("task-max-a")).toEqual([
      "revision-1-task-max-a",
      "revision-2-task-max-a",
    ]);
    expect(revisions.get("task-max-b")).toEqual([
      "revision-1-task-max-b",
      "revision-2-task-max-b",
    ]);
    expect(socket.closed).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(frameDecoder.cancel).not.toHaveBeenCalled();
    client.close();
  });

  it("reports local decode overflow without reconnecting and replaying it", async () => {
    const frameDecoder = {
      decode: vi.fn(() => new Promise<ServerFrame | null>(() => {})),
      cancel: vi.fn(),
    };
    const errors: string[] = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["companion"] });
    await flushMicrotasks();
    client.attachCompanion("task-overflow", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code) => errors.push(code),
    });

    for (let index = 0; index < 17; index += 1) {
      socket.receive({
        type: "companion_error",
        task_id: "task-overflow",
        code: "oversized",
        message: "x".repeat(4 * 1024 * 1024),
      });
    }

    expect(socket.closed).toBe(false);
    expect(frameDecoder.cancel).not.toHaveBeenCalled();
    expect(errors).toContain("stream_decode_capacity");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it("keeps terminal streams healthy when an old server does not support companions", () => {
    const terminalErrors: string[] = [];
    const unavailable: string[] = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    client.attachTerminal("task-1", {
      onOutput: () => {},
      onError: (_code, message) => terminalErrors.push(message),
    });
    client.attachCompanion("task-1", {
      onSnapshot: () => {},
      onUnavailable: () => unavailable.push("unavailable"),
      onEventResult: () => {},
    });

    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok" });

    expect(socket.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 },
    ]);
    expect(unavailable).toEqual(["unavailable"]);
    expect(terminalErrors).toEqual([]);

    const event: CompanionEvent = {
      session_id: "session-1",
      revision: "revision-1",
      event_id: "unsupported-event",
      type: "click",
      choice: "a",
      text: "Option A",
      id: null,
      timestamp: 1_784_268_000_000,
    };
    expect(
      client.sendCompanionEvent("task-1", "session-1", "revision-1", event),
    ).toBe(false);
    client.detach("task-1", "companion");
    expect(socket.sent).toHaveLength(2);

    client.attachCompanion("task-1", {
      onSnapshot: () => {},
      onUnavailable: () => unavailable.push("unavailable"),
      onEventResult: () => {},
    });
    expect(unavailable).toEqual(["unavailable", "unavailable"]);
    socket.drop();
    vi.advanceTimersByTime(250);
    const upgradedSocket = sockets[1];
    upgradedSocket.open();
    upgradedSocket.receive({
      type: "auth_ok",
      stream_kinds: ["agent", "terminal", "companion"],
    });
    expect(upgradedSocket.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 },
      {
        type: "attach",
        task_id: "task-1",
        kind: "companion",
        from_seq: 0,
        accept_snapshot_chunks: true,
        attachment_epoch: 2,
        include_assets: true,
      },
    ]);
    expect(
      client.sendCompanionEvent("task-1", "session-1", "revision-2", {
        ...event,
        revision: "revision-2",
      }),
    ).toBe(true);
    client.detach("task-1", "companion");
    expect(upgradedSocket.sent.at(-1)).toEqual({
      type: "detach",
      task_id: "task-1",
      kind: "companion",
      attachment_epoch: 2,
    });
    client.close();
  });

  it("does not replay an offline detach after reattaching from the registry", () => {
    const { client, socket } = connectedClient(["terminal"]);
    client.attachTerminal("task-offline", { onOutput: () => {} });

    socket.drop();
    client.detach("task-offline", "terminal");
    client.attachTerminal("task-offline", { onOutput: () => {} });

    vi.advanceTimersByTime(250);
    const replacementSocket = sockets[1];
    replacementSocket.open();
    replacementSocket.receive({
      type: "auth_ok",
      stream_kinds: ["terminal"],
    });
    expect(replacementSocket.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      {
        type: "attach",
        task_id: "task-offline",
        kind: "terminal",
        from_seq: 0,
      },
    ]);
    client.close();
  });

  it("does not replay duplicate offline detaches across a replacement attach", () => {
    const { client, socket } = connectedClient(["agent"]);
    const handlers = {
      onSnapshot: () => {},
      onEvent: () => {},
    };
    client.attachAgent("task-duplicate", handlers);

    socket.drop();
    client.detach("task-duplicate", "agent");
    client.detach("task-duplicate", "agent");
    client.attachAgent("task-duplicate", handlers);

    vi.advanceTimersByTime(250);
    const replacementSocket = sockets[1];
    replacementSocket.open();
    replacementSocket.receive({
      type: "auth_ok",
      stream_kinds: ["agent"],
    });
    expect(replacementSocket.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      {
        type: "attach",
        task_id: "task-duplicate",
        kind: "agent",
        from_seq: 0,
      },
    ]);
    client.close();
  });

  it("opts companion attachments into bounded snapshot chunks", () => {
    const { client, socket } = connectedClient(["terminal", "companion"]);

    client.attachCompanion("task-chunks", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-chunks",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });
    client.close();
  });

  it("attaches, dispatches, sends, detaches, and reconnects visual companions", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: string[] = [];
    const unavailable: string[] = [];
    const results: string[] = [];
    const errors: string[] = [];
    const terminalErrors: string[] = [];

    client.attachTerminal("task-1", {
      onOutput: () => {},
      onError: (code) => terminalErrors.push(code),
    });
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) =>
        snapshots.push(
          `${snapshot.sessionId}:${snapshot.revision}:${snapshot.documentKind}:${snapshot.html}`,
        ),
      onUnavailable: () => unavailable.push("unavailable"),
      onEventResult: (result) =>
        results.push(
          `${result.eventId}:${result.accepted}:${result.code ?? ""}:${result.message ?? ""}`,
        ),
      onError: (code, message) => errors.push(`${code}:${message}`),
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });
    const pendingEvent = (eventId: string): CompanionEvent => ({
      session_id: "123-456",
      revision: "rev-1",
      event_id: eventId,
      type: "click",
      choice: "a",
      text: "Option A",
      id: null,
      timestamp: 1_784_268_000_000,
    });
    expect(
      client.sendCompanionEvent(
        "task-1",
        "123-456",
        "rev-1",
        pendingEvent("event-1"),
      ),
    ).toBe(true);
    expect(
      client.sendCompanionEvent(
        "task-1",
        "123-456",
        "rev-1",
        pendingEvent("event-2"),
      ),
    ).toBe(true);

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-1",
      session_id: "123-456",
      revision: "rev-1",
      document_kind: "fragment",
      html: "<h2>Choose</h2>",
    });
    socket.receive({ type: "companion_unavailable", task_id: "task-1" });
    socket.receive({
      type: "companion_event_result",
      task_id: "task-1",
      session_id: "123-456",
      revision: "rev-1",
      event_id: "event-1",
      accepted: true,
    });
    socket.receive({
      type: "companion_event_result",
      task_id: "task-1",
      session_id: "123-456",
      revision: "rev-1",
      event_id: "event-2",
      accepted: false,
      code: "companion_stale_revision",
      message: "changed",
    });
    socket.receive({
      type: "companion_event_result",
      task_id: "task-1",
      event_id: "legacy-event",
      accepted: true,
    });
    socket.receive({
      type: "companion_error",
      task_id: "task-1",
      code: "companion_source_failed",
      message: "unreadable",
    });

    expect(snapshots).toEqual(["123-456:rev-1:fragment:<h2>Choose</h2>"]);
    expect(unavailable).toEqual(["unavailable"]);
    expect(results).toEqual([
      "event-1:true::",
      "event-2:false:companion_stale_revision:changed",
    ]);
    expect(errors).toEqual([
      "companion_source_failed:unreadable",
    ]);
    expect(terminalErrors).toEqual([]);

    const event: CompanionEvent = {
      session_id: "123-456",
      revision: "rev-1",
      event_id: "event-3",
      type: "click",
      choice: "a",
      text: "Option A",
      id: null,
      timestamp: 1_784_268_000_000,
    };
    client.sendCompanionEvent("task-1", "123-456", "rev-1", event);
    expect(socket.sent.at(-1)).toEqual({
      type: "companion_event",
      task_id: "task-1",
      session_id: "123-456",
      revision: "rev-1",
      event,
      attachment_epoch: 1,
    });
    expect(
      client.sendCompanionEvent("task-1", "123-456", "rev-2", event),
    ).toBe(false);

    socket.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({
      type: "auth_ok",
      stream_kinds: ["agent", "terminal", "companion"],
    });
    expect(socket2.sent).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });

    client.detach("task-1", "companion");
    expect(socket2.sent.at(-1)).toEqual({
      type: "detach",
      task_id: "task-1",
      kind: "companion",
      attachment_epoch: 1,
    });
    client.close();
  });

  it("correlates a legacy companion ACK with the outbound session and revision", () => {
    const { client, socket } = connectedClient(["companion"]);
    const results: CompanionEventResult[] = [];
    const errors: string[] = [];
    client.attachCompanion("task-legacy", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result) => results.push(result),
      onError: (code) => errors.push(code),
    });
    const event: CompanionEvent = {
      session_id: "session-legacy",
      revision: "revision-legacy",
      event_id: "event-legacy",
      type: "click",
      choice: "grid",
      text: "Grid",
      id: null,
      timestamp: 1,
    };

    expect(
      client.sendCompanionEvent(
        "task-legacy",
        "session-legacy",
        "revision-legacy",
        event,
      ),
    ).toBe(true);
    socket.receive({
      type: "companion_event_result",
      task_id: "task-legacy",
      event_id: "event-legacy",
      accepted: true,
    });

    expect(results).toEqual([{
      sessionId: "session-legacy",
      revision: "revision-legacy",
      eventId: "event-legacy",
      accepted: true,
    }]);
    expect(errors).toEqual([]);
    client.close();
  });

  it("keeps a current same-id companion selection pending when an old attachment result arrives", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const oldResults: CompanionEventResult[] = [];
    const currentResults: CompanionEventResult[] = [];
    const errors: string[] = [];
    const handlers = (results: CompanionEventResult[]) => ({
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result: CompanionEventResult) => results.push(result),
      onError: (code: string) => errors.push(code),
    });
    const oldEvent: CompanionEvent = {
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      type: "click",
      choice: "old",
      text: "Old",
      id: null,
      timestamp: 1,
    };

    client.attachCompanion("task-reused", handlers(oldResults));
    expect(
      client.sendCompanionEvent(
        "task-reused",
        "session-old",
        "revision-old",
        oldEvent,
      ),
    ).toBe(true);
    const oldEventFrame = socket.sent.at(-1);

    client.detach("task-reused", "companion");
    client.attachCompanion("task-reused", handlers(currentResults));
    const currentEvent: CompanionEvent = {
      ...oldEvent,
      session_id: "session-current",
      revision: "revision-current",
      choice: "current",
      text: "Current",
    };
    expect(
      client.sendCompanionEvent(
        "task-reused",
        "session-current",
        "revision-current",
        currentEvent,
      ),
    ).toBe(true);
    const currentEventFrame = socket.sent.at(-1);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-reused",
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 1,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([]);
    expect(errors).toEqual([]);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-reused",
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 2,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([{
      sessionId: "session-current",
      revision: "revision-current",
      eventId: "event-reused",
      accepted: true,
    }]);
    expect(errors).toEqual([]);
    expect(oldEventFrame).toEqual({
      type: "companion_event",
      task_id: "task-reused",
      session_id: "session-old",
      revision: "revision-old",
      event: oldEvent,
      attachment_epoch: 1,
    });
    expect(currentEventFrame).toEqual({
      type: "companion_event",
      task_id: "task-reused",
      session_id: "session-current",
      revision: "revision-current",
      event: currentEvent,
      attachment_epoch: 2,
    });
    client.close();
  });

  it("ignores a prior server's epoch-less result without consuming the current selection", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const oldResults: CompanionEventResult[] = [];
    const currentResults: CompanionEventResult[] = [];
    const handlers = (results: CompanionEventResult[]) => ({
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result: CompanionEventResult) => results.push(result),
    });
    const oldEvent: CompanionEvent = {
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      type: "click",
      choice: "old",
      text: "Old",
      id: null,
      timestamp: 1,
    };

    client.attachCompanion("task-prior-server", handlers(oldResults));
    expect(
      client.sendCompanionEvent(
        "task-prior-server",
        "session-old",
        "revision-old",
        oldEvent,
      ),
    ).toBe(true);
    client.detach("task-prior-server", "companion");
    client.attachCompanion("task-prior-server", handlers(currentResults));
    const currentEvent: CompanionEvent = {
      ...oldEvent,
      session_id: "session-current",
      revision: "revision-current",
      choice: "current",
      text: "Current",
    };
    expect(
      client.sendCompanionEvent(
        "task-prior-server",
        "session-current",
        "revision-current",
        currentEvent,
      ),
    ).toBe(true);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-prior-server",
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      accepted: true,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([]);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-prior-server",
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 2,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([{
      sessionId: "session-current",
      revision: "revision-current",
      eventId: "event-reused",
      accepted: true,
    }]);
    client.close();
  });

  it("keeps an identical replacement selection pending when an old epoch-less result arrives", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const oldResults: CompanionEventResult[] = [];
    const currentResults: CompanionEventResult[] = [];
    const handlers = (results: CompanionEventResult[]) => ({
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result: CompanionEventResult) => results.push(result),
    });
    const event: CompanionEvent = {
      session_id: "session-same",
      revision: "revision-same",
      event_id: "event-same",
      type: "click",
      choice: "same",
      text: "Same",
      id: null,
      timestamp: 1,
    };

    client.attachCompanion("task-same", handlers(oldResults));
    expect(
      client.sendCompanionEvent(
        "task-same",
        "session-same",
        "revision-same",
        event,
      ),
    ).toBe(true);
    client.detach("task-same", "companion");
    client.attachCompanion("task-same", handlers(currentResults));
    expect(
      client.sendCompanionEvent(
        "task-same",
        "session-same",
        "revision-same",
        event,
      ),
    ).toBe(true);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-same",
      session_id: "session-same",
      revision: "revision-same",
      event_id: "event-same",
      accepted: true,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([]);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-same",
      session_id: "session-same",
      revision: "revision-same",
      event_id: "event-same",
      accepted: true,
      attachment_epoch: 2,
    });
    expect(oldResults).toEqual([]);
    expect(currentResults).toEqual([{
      sessionId: "session-same",
      revision: "revision-same",
      eventId: "event-same",
      accepted: true,
    }]);
    client.close();
  });

  it("keeps a current same-id companion selection pending when an old identity result arrives", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const results: CompanionEventResult[] = [];
    client.attachCompanion("task-identity", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result) => results.push(result),
    });
    const oldEvent: CompanionEvent = {
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      type: "click",
      choice: "old",
      text: "Old",
      id: null,
      timestamp: 1,
    };
    const currentEvent: CompanionEvent = {
      ...oldEvent,
      session_id: "session-current",
      revision: "revision-current",
      choice: "current",
      text: "Current",
    };
    expect(
      client.sendCompanionEvent(
        "task-identity",
        "session-old",
        "revision-old",
        oldEvent,
      ),
    ).toBe(true);
    expect(
      client.sendCompanionEvent(
        "task-identity",
        "session-current",
        "revision-current",
        currentEvent,
      ),
    ).toBe(true);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-identity",
      session_id: "session-old",
      revision: "revision-old",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 1,
    });
    expect(results).toEqual([]);
    socket.receive({
      type: "companion_event_result",
      task_id: "task-identity",
      session_id: "session-current",
      revision: "revision-old",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 1,
    });
    expect(results).toEqual([]);

    socket.receive({
      type: "companion_event_result",
      task_id: "task-identity",
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-reused",
      accepted: true,
      attachment_epoch: 1,
    });
    expect(results).toEqual([{
      sessionId: "session-current",
      revision: "revision-current",
      eventId: "event-reused",
      accepted: true,
    }]);
    client.close();
  });

  it("clears pending companion selections when directly replacing an attachment", () => {
    const { client } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const handlers = {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
    };
    client.attachCompanion("task-direct-replacement", handlers);
    for (let index = 0; index < 1024; index += 1) {
      const event: CompanionEvent = {
        session_id: "session-old",
        revision: "revision-old",
        event_id: `event-old-${index}`,
        type: "click",
        choice: "old",
        text: "Old",
        id: null,
        timestamp: index,
      };
      expect(
        client.sendCompanionEvent(
          "task-direct-replacement",
          "session-old",
          "revision-old",
          event,
        ),
      ).toBe(true);
    }

    client.attachCompanion("task-direct-replacement", handlers);
    const currentEvent: CompanionEvent = {
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-current",
      type: "click",
      choice: "current",
      text: "Current",
      id: null,
      timestamp: 1024,
    };
    expect(
      client.sendCompanionEvent(
        "task-direct-replacement",
        "session-current",
        "revision-current",
        currentEvent,
      ),
    ).toBe(true);
    client.close();
  });

  it("allows replacing an existing companion event key at pending capacity", () => {
    const { client } = connectedClient(["companion"]);
    client.attachCompanion("task-capacity", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
    });
    for (let index = 0; index < 1024; index += 1) {
      const event: CompanionEvent = {
        session_id: "session-old",
        revision: "revision-old",
        event_id: `event-${index}`,
        type: "click",
        choice: "old",
        text: "Old",
        id: null,
        timestamp: index,
      };
      expect(
        client.sendCompanionEvent(
          "task-capacity",
          "session-old",
          "revision-old",
          event,
        ),
      ).toBe(true);
    }

    const replacementEvent: CompanionEvent = {
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-0",
      type: "click",
      choice: "current",
      text: "Current",
      id: null,
      timestamp: 1024,
    };
    expect(
      client.sendCompanionEvent(
        "task-capacity",
        "session-current",
        "revision-current",
        replacementEvent,
      ),
    ).toBe(true);
    expect(
      client.sendCompanionEvent(
        "task-capacity",
        "session-current",
        "revision-current",
        { ...replacementEvent, event_id: "event-overflow" },
      ),
    ).toBe(false);
    client.close();
  });

  it("discards an unsolicited companion result for the current attachment", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const results: CompanionEventResult[] = [];
    const errors: string[] = [];
    client.attachCompanion("task-unsolicited", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result) => results.push(result),
      onError: (code) => errors.push(code),
    });

    socket.receive({
      type: "companion_event_result",
      task_id: "task-unsolicited",
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-unsolicited",
      accepted: true,
      attachment_epoch: 1,
    });

    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    client.close();
  });

  it("maps complete companion snapshot bundles to public client fields", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-1",
      session_id: "session-1",
      revision: "revision-2",
      document_kind: "fragment",
      html: "<h2>Updated</h2>",
      source_origin: "http://localhost:52341",
      assets: [
        {
          name: "layout.png",
          content_type: "image/png",
          digest: "asset-1",
          data_b64: "UE5H",
        },
      ],
    });

    expect(snapshots).toEqual([
      {
        sessionId: "session-1",
        revision: "revision-2",
        documentKind: "fragment",
        html: "<h2>Updated</h2>",
        sourceOrigin: "http://localhost:52341",
        assets: [
          {
            name: "layout.png",
            contentType: "image/png",
            digest: "asset-1",
            dataB64: "UE5H",
          },
        ],
      },
    ]);
    client.close();
  });

  it("reassembles bounded companion chunks while dispatching terminal traffic between them", () => {
    const { client, socket } = connectedClient(["terminal", "companion"]);
    const snapshots: unknown[] = [];
    const terminalOutput = vi.fn();
    client.attachCompanion("task-chunked", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });
    client.attachTerminal("task-chunked", { onOutput: terminalOutput });
    const serialized = JSON.stringify({
      type: "companion_snapshot",
      task_id: "task-chunked",
      session_id: "session-chunked",
      revision: "revision-chunked",
      document_kind: "fragment",
      html: "<h2>Chunked</h2>",
      assets: [],
    });
    const boundary = Math.floor(serialized.length / 2);

    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-chunked",
      transfer_id: "session-chunked:revision-chunked",
      index: 0,
      count: 2,
      data: serialized.slice(0, boundary),
    } as unknown as ServerFrame);
    socket.receive({
      type: "term_output",
      task_id: "task-chunked",
      data_b64: "cmVzcG9uc2l2ZQ==",
    });
    expect(terminalOutput).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([]);

    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-chunked",
      transfer_id: "session-chunked:revision-chunked",
      index: 1,
      count: 2,
      data: serialized.slice(boundary),
    } as unknown as ServerFrame);
    expect(snapshots).toEqual([{
      sessionId: "session-chunked",
      revision: "revision-chunked",
      documentKind: "fragment",
      html: "<h2>Chunked</h2>",
      sourceOrigin: undefined,
      assets: [],
    }]);
    client.close();
  });

  it("dispatches terminal output while the final companion chunk decodes off-thread", async () => {
    let finishChunkDecode: ((frame: ServerFrame | null) => void) | undefined;
    const decodeChunks = vi.fn((_chunks: readonly string[]) =>
      new Promise<ServerFrame | null>((resolve) => {
        finishChunkDecode = resolve;
      })
    );
    const frameDecoder = {
      decode: vi.fn((data: string) =>
        Promise.resolve(JSON.parse(data) as ServerFrame)
      ),
      decodeChunks,
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["terminal", "companion"] });
    await flushMicrotasks();

    const snapshots: unknown[] = [];
    const terminalOutput = vi.fn();
    client.attachCompanion("task-final-chunk", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });
    client.attachTerminal("task-final-chunk", { onOutput: terminalOutput });
    const snapshotFrame: ServerFrame = {
      type: "companion_snapshot",
      task_id: "task-final-chunk",
      session_id: "session-final",
      revision: "revision-final",
      document_kind: "fragment",
      html: "<h2>Final</h2>",
      assets: [],
    };
    const serialized = JSON.stringify(snapshotFrame);
    const boundary = Math.floor(serialized.length / 2);

    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-final-chunk",
      transfer_id: "session-final:revision-final",
      index: 0,
      count: 2,
      data: serialized.slice(0, boundary),
    } as unknown as ServerFrame);
    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-final-chunk",
      transfer_id: "session-final:revision-final",
      index: 1,
      count: 2,
      data: serialized.slice(boundary),
    } as unknown as ServerFrame);
    await flushMicrotasks();
    expect(decodeChunks).toHaveBeenCalledWith(
      [serialized.slice(0, boundary), serialized.slice(boundary)],
      "companion",
    );
    expect(finishChunkDecode).toBeTypeOf("function");

    socket.receive({
      type: "term_output",
      task_id: "task-final-chunk",
      data_b64: "cmVzcG9uc2l2ZQ==",
    });
    await flushMicrotasks();
    expect(terminalOutput).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([]);

    finishChunkDecode?.(snapshotFrame);
    await flushMicrotasks();
    expect(snapshots).toEqual([
      {
        sessionId: "session-final",
        revision: "revision-final",
        documentKind: "fragment",
        html: "<h2>Final</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
    ]);
    client.close();
  });

  it("discards a blocked companion decode after detach and replacement", async () => {
    let finishOldDecode: ((frame: ServerFrame | null) => void) | undefined;
    let decodeCount = 0;
    const frameDecoder = {
      decode: vi.fn((data: string) =>
        Promise.resolve(JSON.parse(data) as ServerFrame)
      ),
      decodeChunks: vi.fn((chunks: readonly string[]) => {
        decodeCount += 1;
        if (decodeCount === 1) {
          return new Promise<ServerFrame | null>((resolve) => {
            finishOldDecode = resolve;
          });
        }
        return Promise.resolve(JSON.parse(chunks.join("")) as ServerFrame);
      }),
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({
      type: "auth_ok",
      stream_kinds: ["companion"],
      capabilities: ["companion_attachment_epoch", "companion_event_epoch"],
    });
    await flushMicrotasks();
    const oldSnapshots: unknown[] = [];
    const newSnapshots: unknown[] = [];
    const oldErrors: string[] = [];
    const newErrors: string[] = [];
    const handlers = (snapshots: unknown[], errors: string[]) => ({
      onSnapshot: (snapshot: unknown) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code: string) => errors.push(code),
    });
    client.attachCompanion(
      "task-replaced",
      handlers(oldSnapshots, oldErrors),
    );
    const oldFrame: Extract<ServerFrame, { type: "companion_snapshot" }> = {
      type: "companion_snapshot",
      task_id: "task-replaced",
      session_id: "session-old",
      revision: "revision-old",
      document_kind: "fragment",
      html: "<h2>Old</h2>",
      assets: [],
    };
    const sendChunks = (frame: ServerFrame, attachmentEpoch: number) => {
      const serialized = JSON.stringify(frame);
      const boundary = Math.floor(serialized.length / 2);
      socket.receive({
        type: "companion_snapshot_chunk",
        task_id: "task-replaced",
        transfer_id: "transfer",
        index: 0,
        count: 2,
        data: serialized.slice(0, boundary),
        attachment_epoch: attachmentEpoch,
      } as unknown as ServerFrame);
      socket.receive({
        type: "companion_snapshot_chunk",
        task_id: "task-replaced",
        transfer_id: "transfer",
        index: 1,
        count: 2,
        data: serialized.slice(boundary),
        attachment_epoch: attachmentEpoch,
      } as unknown as ServerFrame);
    };
    sendChunks(oldFrame, 1);
    await flushMicrotasks();

    client.detach("task-replaced", "companion");
    client.attachCompanion(
      "task-replaced",
      handlers(newSnapshots, newErrors),
    );
    finishOldDecode?.(oldFrame);
    await flushMicrotasks();
    expect(oldSnapshots).toEqual([]);
    expect(newSnapshots).toEqual([]);
    expect(oldErrors).toEqual([]);
    expect(newErrors).toEqual([]);

    sendChunks(
      {
        ...oldFrame,
        session_id: "session-new",
        revision: "revision-new",
        html: "<h2>New</h2>",
        attachment_epoch: 2,
      },
      2,
    );
    await flushMicrotasks();
    expect(newSnapshots).toEqual([
      expect.objectContaining({
        sessionId: "session-new",
        revision: "revision-new",
      }),
    ]);
    client.close();
  });

  it("rejects companion chunks whose inner snapshot epoch differs from the wrapper", () => {
    const { client, socket } = connectedClient(["companion"]);
    const snapshots: unknown[] = [];
    const errors: string[] = [];
    client.attachCompanion("task-inner-epoch", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code) => errors.push(code),
    });

    for (const [transferId, innerEpoch] of [
      ["missing-inner-epoch", undefined],
      ["old-inner-epoch", 0],
    ] as const) {
      const inner = {
        type: "companion_snapshot",
        task_id: "task-inner-epoch",
        session_id: "session-1",
        revision: transferId,
        document_kind: "fragment",
        html: "<h2>Wrong epoch</h2>",
        ...(innerEpoch === undefined
          ? {}
          : { attachment_epoch: innerEpoch }),
      };
      socket.receive({
        type: "companion_snapshot_chunk",
        task_id: "task-inner-epoch",
        transfer_id: transferId,
        index: 0,
        count: 1,
        data: JSON.stringify(inner),
        attachment_epoch: 1,
      });
    }

    expect(snapshots).toEqual([]);
    expect(errors).toEqual([
      "invalid_companion_chunks",
      "invalid_companion_chunks",
    ]);
    client.close();
  });

  it("rejects a later companion chunk whose wrapper epoch differs from the first", () => {
    const { client, socket } = connectedClient(["companion"]);
    const snapshots: unknown[] = [];
    const errors: string[] = [];
    client.attachCompanion("task-wrapper-epoch", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code) => errors.push(code),
    });
    const serialized = JSON.stringify({
      type: "companion_snapshot",
      task_id: "task-wrapper-epoch",
      session_id: "session-1",
      revision: "revision-1",
      document_kind: "fragment",
      html: "<h2>Mixed wrappers</h2>",
      attachment_epoch: 1,
    });
    const boundary = Math.floor(serialized.length / 2);

    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-wrapper-epoch",
      transfer_id: "mixed-wrapper-epoch",
      index: 0,
      count: 2,
      data: serialized.slice(0, boundary),
      attachment_epoch: 1,
    });
    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-wrapper-epoch",
      transfer_id: "mixed-wrapper-epoch",
      index: 1,
      count: 2,
      data: serialized.slice(boundary),
    });

    expect(snapshots).toEqual([]);
    expect(errors).toEqual(["invalid_companion_chunks"]);
    client.close();
  });

  it("rejects a decoded chunk snapshot whose epoch differs from its wrapper", async () => {
    const inner: ServerFrame = {
      type: "companion_snapshot",
      task_id: "task-decoded-epoch",
      session_id: "session-1",
      revision: "revision-1",
      document_kind: "fragment",
      html: "<h2>Decoded</h2>",
    };
    const frameDecoder = {
      decode: vi.fn((data: string) =>
        Promise.resolve(JSON.parse(data) as ServerFrame)
      ),
      decodeChunks: vi.fn(() => Promise.resolve(inner)),
      cancel: vi.fn(),
    };
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      frameDecoder,
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok", stream_kinds: ["companion"] });
    await flushMicrotasks();
    const snapshots: unknown[] = [];
    const errors: string[] = [];
    client.attachCompanion("task-decoded-epoch", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code) => errors.push(code),
    });
    socket.receive({
      type: "companion_snapshot_chunk",
      task_id: "task-decoded-epoch",
      transfer_id: "decoded-epoch",
      index: 0,
      count: 1,
      data: JSON.stringify(inner),
      attachment_epoch: 1,
    });
    await flushMicrotasks();

    expect(snapshots).toEqual([]);
    expect(errors).toEqual(["invalid_companion_chunks"]);
    client.close();
  });

  it("rejects an old companion delivery that arrives after local replacement", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch", "companion_event_epoch"],
    );
    const oldSnapshots: string[] = [];
    const newSnapshots: string[] = [];
    const errors: string[] = [];

    client.attachCompanion("task-race", {
      onSnapshot: (snapshot) => oldSnapshots.push(snapshot.revision),
      onUnavailable: () => {},
      onEventResult: () => {},
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-race",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });

    client.detach("task-race", "companion");
    expect(socket.sent.at(-1)).toEqual({
      type: "detach",
      task_id: "task-race",
      kind: "companion",
      attachment_epoch: 1,
    });
    client.attachCompanion("task-race", {
      onSnapshot: (snapshot) => newSnapshots.push(snapshot.revision),
      onUnavailable: () => {},
      onEventResult: () => {},
      onError: (code) => errors.push(code),
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "attach",
      task_id: "task-race",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 2,
      include_assets: true,
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-race",
      session_id: "session-old",
      revision: "revision-old",
      document_kind: "fragment",
      html: "<h2>Old</h2>",
      attachment_epoch: 1,
    });
    socket.receive({
      type: "companion_error",
      task_id: "task-race",
      code: "old-error",
      message: "old",
      attachment_epoch: Number.MAX_SAFE_INTEGER + 1,
    });

    expect(oldSnapshots).toEqual([]);
    expect(newSnapshots).toEqual([]);
    expect(errors).toEqual([]);

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-race",
      session_id: "session-new",
      revision: "revision-new",
      document_kind: "fragment",
      html: "<h2>New</h2>",
      attachment_epoch: 2,
    });
    expect(newSnapshots).toEqual(["revision-new"]);
    client.close();
  });

  it("reopens a previous-server socket so late legacy frames cannot reach a replacement", () => {
    const { client, socket } = connectedClient(["companion"]);
    const oldSnapshots: string[] = [];
    const newSnapshots: string[] = [];
    client.attachCompanion("task-legacy-race", {
      onSnapshot: (snapshot) => oldSnapshots.push(snapshot.revision),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    client.detach("task-legacy-race", "companion");
    client.attachCompanion("task-legacy-race", {
      onSnapshot: (snapshot) => newSnapshots.push(snapshot.revision),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    expect(socket.closed).toBe(true);
    socket.receive({
      type: "companion_snapshot",
      task_id: "task-legacy-race",
      session_id: "session-old",
      revision: "revision-old",
      document_kind: "fragment",
      html: "<h2>Late old frame</h2>",
    });
    expect(oldSnapshots).toEqual([]);
    expect(newSnapshots).toEqual([]);

    vi.advanceTimersByTime(250);
    const replacementSocket = sockets[1];
    replacementSocket.open();
    replacementSocket.receive({
      type: "auth_ok",
      stream_kinds: ["companion"],
    });
    replacementSocket.receive({
      type: "companion_snapshot",
      task_id: "task-legacy-race",
      session_id: "session-new",
      revision: "revision-new",
      document_kind: "fragment",
      html: "<h2>Fresh socket frame</h2>",
    });
    expect(newSnapshots).toEqual(["revision-new"]);
    client.close();
  });

  it("reopens a 915439c server socket before a second companion event lifecycle", () => {
    const { client, socket } = connectedClient(
      ["companion"],
      ["companion_attachment_epoch"],
    );
    const results: CompanionEventResult[] = [];
    const handlers = {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: (result: CompanionEventResult) => results.push(result),
    };
    const event: CompanionEvent = {
      session_id: "session-current",
      revision: "revision-current",
      event_id: "event-reused",
      type: "click",
      choice: "current",
      text: "Current",
      id: null,
      timestamp: 1,
    };
    client.attachCompanion("task-old-server", handlers);
    expect(
      client.sendCompanionEvent(
        "task-old-server",
        event.session_id,
        event.revision,
        event,
      ),
    ).toBe(true);
    client.detach("task-old-server", "companion");
    client.attachCompanion("task-old-server", handlers);

    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(250);
    const replacementSocket = sockets[1];
    replacementSocket.open();
    expect(replacementSocket.sent).toEqual([
      {
        type: "auth",
        capabilities: ["companion_event_epoch", "term_input_boundary"],
      },
    ]);
    replacementSocket.receive({
      type: "auth_ok",
      stream_kinds: ["companion"],
      capabilities: ["companion_attachment_epoch"],
    });

    expect(
      client.sendCompanionEvent(
        "task-old-server",
        event.session_id,
        event.revision,
        event,
      ),
    ).toBe(true);
    socket.receive({
      type: "companion_event_result",
      task_id: "task-old-server",
      session_id: event.session_id,
      revision: event.revision,
      event_id: event.event_id,
      accepted: true,
    });
    expect(results).toEqual([]);

    replacementSocket.receive({
      type: "companion_event_result",
      task_id: "task-old-server",
      session_id: event.session_id,
      revision: event.revision,
      event_id: event.event_id,
      accepted: true,
    });

    expect(results).toEqual([
      {
        sessionId: event.session_id,
        revision: event.revision,
        eventId: event.event_id,
        accepted: true,
      },
    ]);
    client.close();
  });

  it("negotiates an asset-free companion attachment and discards legacy asset bytes", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion(
      "task-mobile",
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onUnavailable: () => {},
        onEventResult: () => {},
      },
      { includeAssets: false },
    );

    expect(socket.sent).toContainEqual({
      type: "attach",
      task_id: "task-mobile",
      kind: "companion",
      from_seq: 0,
      include_assets: false,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-mobile",
      session_id: "session-mobile",
      revision: "revision-mobile",
      document_kind: "fragment",
      html: "<h2>Mobile</h2>",
      assets: [
        {
          name: "unused.png",
          content_type: "image/png",
          digest: "asset-1",
          data_b64: "UE5H",
        },
      ],
    });

    expect(snapshots).toEqual([
      {
        sessionId: "session-mobile",
        revision: "revision-mobile",
        documentKind: "fragment",
        html: "<h2>Mobile</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
    ]);
    client.close();
  });

  it("maps legacy companion snapshot frames without bundle fields", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-1",
      session_id: "legacy-session",
      revision: "legacy-revision",
      document_kind: "fragment",
      html: "<h2>Legacy</h2>",
    });

    expect(snapshots).toEqual([
      {
        sessionId: "legacy-session",
        revision: "legacy-revision",
        documentKind: "fragment",
        html: "<h2>Legacy</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
    ]);
    client.close();
  });

  it("ignores malformed non-string companion source origins", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    for (const source_origin of [52341, { url: "http://localhost:52341" }]) {
      socket.receive({
        type: "companion_snapshot",
        task_id: "task-1",
        session_id: "session-1",
        revision: "revision-2",
        document_kind: "fragment",
        html: "<h2>Updated</h2>",
        source_origin,
      } as unknown as ServerFrame);
    }

    expect(snapshots).toEqual([
      {
        sessionId: "session-1",
        revision: "revision-2",
        documentKind: "fragment",
        html: "<h2>Updated</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
      {
        sessionId: "session-1",
        revision: "revision-2",
        documentKind: "fragment",
        html: "<h2>Updated</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
    ]);
    client.close();
  });

  it("treats non-array companion assets as an empty legacy bundle", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-1",
      session_id: "legacy-session",
      revision: "legacy-revision",
      document_kind: "fragment",
      html: "<h2>Legacy</h2>",
      assets: "not-an-array",
    } as unknown as ServerFrame);

    expect(snapshots).toEqual([
      {
        sessionId: "legacy-session",
        revision: "legacy-revision",
        documentKind: "fragment",
        html: "<h2>Legacy</h2>",
        sourceOrigin: undefined,
        assets: [],
      },
    ]);
    client.close();
  });

  it("discards malformed companion asset entries without dropping valid assets", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const snapshots: unknown[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onUnavailable: () => {},
      onEventResult: () => {},
    });

    socket.receive({
      type: "companion_snapshot",
      task_id: "task-1",
      session_id: "session-1",
      revision: "revision-2",
      document_kind: "fragment",
      html: "<h2>Updated</h2>",
      assets: [
        null,
        17,
        "asset",
        { name: "incomplete.png", content_type: "image/png" },
        {
          name: "mistyped.png",
          content_type: "image/png",
          digest: 42,
          data_b64: "UE5H",
        },
        {
          name: "layout.png",
          content_type: "image/png",
          digest: "asset-1",
          data_b64: "UE5H",
        },
      ],
    } as unknown as ServerFrame);

    expect(snapshots).toEqual([
      {
        sessionId: "session-1",
        revision: "revision-2",
        documentKind: "fragment",
        html: "<h2>Updated</h2>",
        sourceOrigin: undefined,
        assets: [
          {
            name: "layout.png",
            contentType: "image/png",
            digest: "asset-1",
            dataB64: "UE5H",
          },
        ],
      },
    ]);
    client.close();
  });

  it("drops companion selections across disconnect and requires a fresh explicit send", () => {
    const { client, socket } = connectedClient(["agent", "terminal", "companion"]);
    const connectionChanges: boolean[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
      onConnectionChange: (connected) => connectionChanges.push(connected),
    });
    const event: CompanionEvent = {
      session_id: "session-1",
      revision: "rev-1",
      event_id: "event-offline",
      type: "click",
      choice: "a",
      text: "Option A",
      id: null,
      timestamp: 1_784_268_000_000,
    };

    socket.drop();
    expect(connectionChanges).toEqual([false]);
    expect(
      client.sendCompanionEvent("task-1", "session-1", "rev-1", event),
    ).toBe(false);

    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({
      type: "auth_ok",
      stream_kinds: ["agent", "terminal", "companion"],
    });

    expect(connectionChanges).toEqual([false, true]);
    expect(socket2.sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch", "term_input_boundary"] },
      {
        type: "attach",
        task_id: "task-1",
        kind: "companion",
        from_seq: 0,
        accept_snapshot_chunks: true,
        attachment_epoch: 1,
        include_assets: true,
      },
    ]);
    expect(
      client.sendCompanionEvent("task-1", "session-1", "rev-2", {
        ...event,
        revision: "rev-2",
        event_id: "event-retry",
      }),
    ).toBe(true);
    expect(socket2.sent.at(-1)).toMatchObject({
      type: "companion_event",
      revision: "rev-2",
      event: { event_id: "event-retry" },
    });
    client.close();
  });

  it("sends terminal input and resize frames when boundary support is negotiated", () => {
    const { client, socket } = connectedClient();

    client.sendTermInput("task-pty", "YQ==");
    client.sendTermInput("task-pty", "DQ==", true);
    client.sendTermInput("task-pty", "G1s8NjU7MTsxTQ==", false, true);
    client.sendTermResize("task-pty", 120, 40);

    expect(socket.sent.slice(1)).toEqual([
      { type: "term_input", task_id: "task-pty", data_b64: "YQ==" },
      { type: "term_input_boundary", task_id: "task-pty", data_b64: "DQ==" },
      { type: "term_input_control", task_id: "task-pty", data_b64: "G1s8NjU7MTsxTQ==" },
      { type: "term_resize", task_id: "task-pty", cols: 120, rows: 40 },
    ]);
    client.close();
  });

  it("fails closed without server boundary support and never emits terminal input", () => {
    const errors: Array<{ code: string; message: string }> = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    client.attachTerminal("task-pty", {
      onOutput() {},
      onError(code, message) {
        errors.push({ code, message });
      },
    });
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok" });

    client.sendTermInput("task-pty", "YQ==");
    client.sendTermInput("task-pty", "DQ==", true);

    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "term_input" }),
    );
    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "term_input_boundary" }),
    );
    expect(errors).toEqual([
      {
        code: "term_input_boundary_required",
        message: "The server does not support safe terminal input boundaries.",
      },
      {
        code: "term_input_boundary_required",
        message: "The server does not support safe terminal input boundaries.",
      },
    ]);
    client.close();
  });

  it("drops terminal input queued before an incompatible auth_ok", () => {
    const errors: string[] = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
    });
    client.attachTerminal("task-pty", {
      onOutput() {},
      onError(code) {
        errors.push(code);
      },
    });
    client.sendTermInput("task-pty", "DQ==", true);
    const socket = sockets[0];
    socket.open();
    socket.receive({ type: "auth_ok" });

    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "term_input_boundary" }),
    );
    expect(errors).toEqual(["term_input_boundary_required"]);
    client.close();
  });

  it("stops reconnecting after close", () => {
    const { client, socket } = connectedClient();
    client.close();
    socket.drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(1);
  });

  it("does not let stale socket auth resolve onto a reconnected socket", async () => {
    const credentialResolvers: Array<(value: string) => void> = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      credentialProvider: () =>
        new Promise<string>((resolve) => {
          credentialResolvers.push(resolve);
        }),
    });

    const socket1 = sockets[0];
    socket1.open();
    expect(credentialResolvers).toHaveLength(1);

    socket1.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    expect(credentialResolvers).toHaveLength(2);

    credentialResolvers[0]("stale-token");
    await Promise.resolve();
    expect(socket2.sent).toEqual([]);

    credentialResolvers[1]("current-token");
    await Promise.resolve();
    expect(socket2.sent).toEqual([{
      type: "auth",
      credential: "current-token",
      capabilities: ["companion_event_epoch", "term_input_boundary"],
    }]);
    client.close();
  });

  it("opens relay tunnel before sending KSP auth frames", async () => {
    const tunnelFactory = createRelayTunnelWebSocketFactory({
      relayUrl: "ws://relay",
      desktopId: "desktop-1",
      getIdentityToken: async () => "id-token",
      webSocketFactory: factory,
      nextId: () => "tunnel-request-1",
    });
    const client = new StreamClient({
      url: "ignored-by-tunnel-factory",
      credentialProvider: async () => "id-token",
      webSocketFactory: tunnelFactory,
    });

    const socket = sockets[0];
    socket.open();
    await Promise.resolve();
    expect(socket.sent).toEqual([
      { type: "auth", id_token: "id-token" } as unknown as ClientFrame,
    ]);

    socket.receive({ type: "auth_ok" } as ServerFrame);
    expect(socket.sent.at(-1)).toEqual({
      type: "tunnel_request",
      id: "tunnel-request-1",
      desktopId: "desktop-1",
      service: "ksp",
    } as unknown as ClientFrame);

    socket.receive({
      type: "tunnel_ready",
      tunnelId: "relay-tunnel-1",
      desktopId: "desktop-1",
    } as unknown as ServerFrame);
    await Promise.resolve();

    expect(socket.sent.at(-1)).toEqual({
      type: "auth",
      credential: "id-token",
      capabilities: ["companion_event_epoch", "term_input_boundary"],
    });
    socket.receive({ type: "auth_ok" });
    client.close();
  });

  it("uses the relay identity token as the tunneled KSP credential", async () => {
    const tunnelFactory = createRelayTunnelWebSocketFactory({
      relayUrl: "ws://relay",
      desktopId: "desktop-1",
      getIdentityToken: async () => "relay-id-token",
      webSocketFactory: factory,
      nextId: () => "tunnel-request-1",
    });
    const client = new StreamClient({
      url: "ignored-by-tunnel-factory",
      credentialProvider: async () => null,
      webSocketFactory: tunnelFactory,
    });

    const socket = sockets[0];
    socket.open();
    await Promise.resolve();
    expect(socket.sent).toEqual([
      { type: "auth", id_token: "relay-id-token" } as unknown as ClientFrame,
    ]);

    socket.receive({ type: "auth_ok" } as ServerFrame);
    socket.receive({
      type: "tunnel_ready",
      tunnelId: "relay-tunnel-1",
      desktopId: "desktop-1",
    } as unknown as ServerFrame);
    await Promise.resolve();

    expect(socket.sent.at(-1)).toEqual({
      type: "auth",
      credential: "relay-id-token",
      capabilities: ["companion_event_epoch", "term_input_boundary"],
    });
    client.close();
  });

  it("force-refreshes the credential once and retries after an auth-failure close", async () => {
    const forceRefreshArgs: Array<boolean | undefined> = [];
    const onAuthError = vi.fn();
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      credentialProvider: async (forceRefresh) => {
        forceRefreshArgs.push(forceRefresh);
        return "token";
      },
      onAuthError,
    });

    const socket1 = sockets[0];
    socket1.open();
    await Promise.resolve();
    expect(forceRefreshArgs).toEqual([false]);

    // Relay rejects the handshake with the auth-failure close code.
    socket1.drop(4005);
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    expect(socket2).toBeDefined();
    socket2.open();
    await Promise.resolve();
    // The retry forced a fresh token rather than reusing the rejected one.
    expect(forceRefreshArgs).toEqual([false, true]);

    socket2.receive({ type: "auth_ok" });
    expect(onAuthError).not.toHaveBeenCalled();
    client.close();
  });

  it("reports an auth error and stops reconnecting when the refreshed token is still rejected", async () => {
    const onAuthError = vi.fn();
    const errors: Array<{ code: string; message: string }> = [];
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      credentialProvider: async () => "token",
      onAuthError,
    });
    client.attachAgent("task-1", {
      onSnapshot() {},
      onEvent() {},
      onError(code, message) {
        errors.push({ code, message });
      },
    });

    const socket1 = sockets[0];
    socket1.open();
    await Promise.resolve();

    socket1.drop(4005); // first auth failure → schedule forced-refresh retry
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    await Promise.resolve();

    socket2.drop(4005); // still rejected after refresh → give up
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      { code: "auth_expired", message: "Your session expired. Please sign in again." },
    ]);

    // No further reconnect attempts are scheduled.
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(2);
    client.close();
  });

  it("keeps reconnecting without forcing a refresh on an ordinary disconnect", async () => {
    const forceRefreshArgs: Array<boolean | undefined> = [];
    const onAuthError = vi.fn();
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      credentialProvider: async (forceRefresh) => {
        forceRefreshArgs.push(forceRefresh);
        return "token";
      },
      onAuthError,
    });

    const socket1 = sockets[0];
    socket1.open();
    await Promise.resolve();
    socket1.receive({ type: "auth_ok" });

    socket1.drop(); // network drop, no auth-failure code
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    expect(socket2).toBeDefined();
    socket2.open();
    await Promise.resolve();

    expect(forceRefreshArgs).toEqual([false, false]);
    expect(onAuthError).not.toHaveBeenCalled();
    client.close();
  });

  it("resets ordinary reconnect backoff only after auth_ok", async () => {
    const client = new StreamClient({
      url: "ws://test/v1/stream",
      webSocketFactory: factory,
      reconnectDelaysMs: [10, 20, 40],
    });
    const socket1 = sockets[0];
    socket1.open();
    socket1.receive({ type: "auth_ok" });
    socket1.drop();

    await vi.advanceTimersByTimeAsync(10);
    const socket2 = sockets[1];
    socket2.open();
    socket2.drop();
    await vi.advanceTimersByTimeAsync(19);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    const socket3 = sockets[2];
    socket3.open();
    socket3.receive({ type: "auth_ok" });
    socket3.drop();
    await vi.advanceTimersByTimeAsync(9);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(4);
    client.close();
  });

  it("treats a relay tunnel identity-token failure as an auth failure", async () => {
    const refreshCalls: Array<boolean | undefined> = [];
    const tunnelFactory = createRelayTunnelWebSocketFactory({
      relayUrl: "ws://relay",
      desktopId: "desktop-1",
      getIdentityToken: async (forceRefresh) => {
        refreshCalls.push(forceRefresh);
        throw new Error("revoked");
      },
      webSocketFactory: factory,
      nextId: () => "tunnel-request-1",
    });
    const onAuthError = vi.fn();
    const client = new StreamClient({
      url: "ignored-by-tunnel-factory",
      credentialProvider: async () => "id-token",
      webSocketFactory: tunnelFactory,
      onAuthError,
    });

    const socket1 = sockets[0];
    socket1.open();
    await Promise.resolve();
    await Promise.resolve();
    // First attempt reused a cached token (no force refresh) and was rejected.
    expect(refreshCalls).toEqual([false]);

    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    expect(socket2).toBeDefined();
    socket2.open();
    await Promise.resolve();
    await Promise.resolve();
    // The retry forced a refresh; it still failed → permanent auth error.
    expect(refreshCalls).toEqual([false, true]);
    expect(onAuthError).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("surfaces relay tunnel request failures to terminal attachments", async () => {
    const tunnelFactory = createRelayTunnelWebSocketFactory({
      relayUrl: "ws://relay",
      desktopId: "desktop-offline",
      getIdentityToken: async () => "id-token",
      webSocketFactory: factory,
      nextId: () => "tunnel-request-1",
    });
    const errors: string[] = [];
    const client = new StreamClient({
      url: "ignored-by-tunnel-factory",
      webSocketFactory: tunnelFactory,
    });

    client.attachTerminal("task-1", {
      onOutput: () => {},
      onError: (code, message) => errors.push(`${code}:${message}`),
    });

    const socket = sockets[0];
    socket.open();
    await Promise.resolve();
    expect(socket.sent[0]).toEqual({ type: "auth", id_token: "id-token" });

    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    expect(socket.sent[1]).toEqual({
      type: "tunnel_request",
      id: "tunnel-request-1",
      desktopId: "desktop-offline",
      service: "ksp",
    });

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: "tunnel-request-1",
        error: "desktop is not connected",
      }),
    });

    expect(errors).toEqual(["relay_tunnel:desktop is not connected"]);
    client.close();
  });
});

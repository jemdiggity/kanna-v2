import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ClientFrame,
  CompanionEvent,
  ServerFrame,
} from "@kanna/agent-protocol";
import {
  createRelayTunnelWebSocketFactory,
  StreamClient,
  type WebSocketLike,
} from "./index";

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

  it("attaches, dispatches, sends, detaches, and reconnects visual companions", () => {
    const { client, socket } = connectedClient();
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
    });

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
      event_id: "event-1",
      accepted: true,
    });
    socket.receive({
      type: "companion_event_result",
      task_id: "task-1",
      event_id: "event-2",
      accepted: false,
      code: "companion_stale_revision",
      message: "changed",
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
    expect(errors).toEqual(["companion_source_failed:unreadable"]);
    expect(terminalErrors).toEqual([]);

    const event: CompanionEvent = {
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
    });

    socket.drop();
    vi.advanceTimersByTime(250);
    const socket2 = sockets[1];
    socket2.open();
    socket2.receive({ type: "auth_ok" });
    expect(socket2.sent).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
    });

    client.detach("task-1", "companion");
    expect(socket2.sent.at(-1)).toEqual({
      type: "detach",
      task_id: "task-1",
      kind: "companion",
    });
    client.close();
  });

  it("drops companion selections across disconnect and requires a fresh explicit send", () => {
    const { client, socket } = connectedClient();
    const connectionChanges: boolean[] = [];
    client.attachCompanion("task-1", {
      onSnapshot: () => {},
      onUnavailable: () => {},
      onEventResult: () => {},
      onConnectionChange: (connected) => connectionChanges.push(connected),
    });
    const event: CompanionEvent = {
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
    socket2.receive({ type: "auth_ok" });

    expect(connectionChanges).toEqual([false, true]);
    expect(socket2.sent).toEqual([
      { type: "auth" },
      { type: "attach", task_id: "task-1", kind: "companion", from_seq: 0 },
    ]);
    expect(
      client.sendCompanionEvent("task-1", "session-1", "rev-2", {
        ...event,
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
    expect(socket2.sent).toEqual([{ type: "auth", credential: "current-token" }]);
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

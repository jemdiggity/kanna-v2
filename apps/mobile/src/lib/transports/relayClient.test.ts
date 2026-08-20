import { describe, expect, it, vi } from "vitest";
import {
  createRelayDesktopClient,
  type RelaySocketLike
} from "./relayClient";

function createSocket(): RelaySocketLike {
  return {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createRelayDesktopClient", () => {
  it("carries visual companion frames transparently through the shared relay tunnel", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });
    const events: unknown[] = [];
    const subscription = client.observeTaskCompanion(
      { desktopId: "desktop-1", taskId: "task-1" },
      (event) => events.push(event)
    );

    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tunnel_ready" }) });
    await flushPromises();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal", "companion"]
      })
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_snapshot",
        task_id: "task-1",
        session_id: "123-456",
        revision: "rev-1",
        document_kind: "fragment",
        html: "<button data-choice='a'>A</button>",
        assets: [{
          name: "unused.png",
          content_type: "image/png",
          digest: "asset-1",
          data_b64: "UE5H"
        }]
      })
    });
    expect(subscription.sendEvent("123-456", "rev-1", {
      session_id: "123-456",
      revision: "rev-1",
      event_id: "event-1",
      type: "click",
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    })).toBe(true);
    subscription.close();

    const frames = vi.mocked(socket.send).mock.calls.map(([payload]) =>
      JSON.parse(payload) as Record<string, unknown>
    );
    expect(frames).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      include_assets: false,
      attachment_epoch: 1
    });
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "companion_event", task_id: "task-1" })
    );
    expect(frames).toContainEqual({
      type: "detach",
      task_id: "task-1",
      kind: "companion",
      attachment_epoch: 1
    });
    expect(events).toEqual([
      { type: "connection", taskId: "task-1", connected: true },
      expect.objectContaining({
        type: "snapshot",
        taskId: "task-1",
        sessionId: "123-456",
        revision: "rev-1",
        assets: []
      })
    ]);
    client.close();
  });

  it("authenticates with a Firebase ID token and invokes a targeted desktop", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      nextId: () => "invoke-1",
      relayUrl: "wss://relay.example"
    });

    const invocation = client.invokeDesktop({
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/repos",
      body: null
    });

    socket.onopen?.();
    await flushPromises();
    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "auth",
        id_token: "id-token-1"
      })
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        userId: "user-1"
      })
    });
    await flushPromises();
    expect(socket.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: "invoke",
        id: "invoke-1",
        desktopId: "desktop-1",
        method: "GET",
        path: "/v1/repos",
        body: null
      })
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: "invoke-1",
        status: 200,
        body: [{ id: "repo-1", name: "Repo One" }]
      })
    });

    await expect(invocation).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
  });

  it("rejects remote responses that carry an error", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      nextId: () => "invoke-2",
      relayUrl: "wss://relay.example"
    });

    const invocation = client.invokeDesktop({
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/tasks/recent",
      body: null
    });
    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await flushPromises();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: "invoke-2",
        status: 500,
        error: "desktop failed"
      })
    });

    await expect(invocation).rejects.toThrow("desktop failed");
  });

  it("lists active desktop ids through a relay command", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      nextId: () => "active-1",
      relayUrl: "wss://relay.example"
    });

    const activeDesktopIds = client.listActiveDesktopIds();
    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await flushPromises();

    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "invoke",
        id: "active-1",
        command: "list_active_desktops",
        args: {}
      })
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: "active-1",
        data: {
          desktopIds: ["desktop-1", "", "desktop-2", 12]
        }
      })
    });

    await expect(activeDesktopIds).resolves.toEqual(
      new Set(["desktop-1", "desktop-2"])
    );
  });

  it("reuses one control connection for sequential presence refreshes", async () => {
    const sockets: RelaySocketLike[] = [];
    let nextId = 0;
    const client = createRelayDesktopClient({
      createSocket: () => {
        const socket = createSocket();
        sockets.push(socket);
        return socket;
      },
      getIdToken: async () => "id-token-1",
      nextId: () => `active-${++nextId}`,
      relayUrl: "wss://relay.example"
    });

    const first = client.listActiveDesktopIds();
    sockets[0].onopen?.();
    await flushPromises();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await flushPromises();
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "response", id: "active-1", data: { desktopIds: [] } })
    });
    await first;

    const second = client.listActiveDesktopIds();
    await flushPromises();
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "response", id: "active-2", data: { desktopIds: ["desktop-1"] } })
    });

    await expect(second).resolves.toEqual(new Set(["desktop-1"]));
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it("reconnects a dropped control connection with backoff", async () => {
    vi.useFakeTimers();
    try {
      const sockets: RelaySocketLike[] = [];
      const client = createRelayDesktopClient({
        createSocket: () => {
          const socket = createSocket();
          sockets.push(socket);
          return socket;
        },
        getIdToken: async () => "id-token-1",
        relayUrl: "wss://relay.example",
        reconnectDelaysMs: [250, 500]
      });

      const refresh = client.listActiveDesktopIds();
      sockets[0].onopen?.();
      await flushPromises();
      sockets[0].onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
      await flushPromises();
      sockets[0].onmessage?.({
        data: JSON.stringify({ type: "response", id: "mobile-1", data: { desktopIds: [] } })
      });
      await refresh;
      sockets[0].onclose?.();

      await vi.advanceTimersByTimeAsync(249);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the control connection in background and reopens in foreground", async () => {
    const sockets: RelaySocketLike[] = [];
    const client = createRelayDesktopClient({
      createSocket: () => {
        const socket = createSocket();
        sockets.push(socket);
        return socket;
      },
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });

    const refresh = client.listActiveDesktopIds();
    client.setForeground(false);
    await expect(refresh).rejects.toThrow("background");
    expect(sockets[0].close).toHaveBeenCalledTimes(1);

    client.setForeground(true);
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it("opens a fresh invoke socket after a relay socket error", async () => {
    const sockets: RelaySocketLike[] = [];
    const client = createRelayDesktopClient({
      createSocket: () => {
        const socket = createSocket();
        sockets.push(socket);
        return socket;
      },
      getIdToken: async () => "id-token-1",
      nextId: () => `invoke-${sockets.length}`,
      relayUrl: "wss://relay.example"
    });

    const first = client.invokeDesktop({
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/status",
      body: null
    });
    sockets[0].onerror?.(new Error("relay unavailable"));
    await expect(first).rejects.toThrow("Relay connection failed.");

    const second = client.invokeDesktop({
      desktopId: "desktop-1",
      method: "GET",
      path: "/v1/status",
      body: null
    });
    expect(sockets).toHaveLength(2);
    sockets[1].onopen?.();
    await flushPromises();
    sockets[1].onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await flushPromises();
    expect(sockets[1].send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "invoke",
        id: "invoke-2",
        desktopId: "desktop-1",
        method: "GET",
        path: "/v1/status",
        body: null
      })
    );
    sockets[1].onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: "invoke-2",
        status: 200,
        body: { state: "running" }
      })
    });

    await expect(second).resolves.toEqual({ state: "running" });
  });

  it("observes terminal events through the KSP relay tunnel", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });
    const events: unknown[] = [];

    const subscription = client.observeTaskTerminal(
      { desktopId: "desktop-1", taskId: "task-1" },
      (event) => {
        events.push(event);
      }
    );

    socket.onopen?.();
    await flushPromises();
    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "auth",
        id_token: "id-token-1"
      })
    );

    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tunnel_ready" }) });
    await flushPromises();
    expect(socket.send).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({
        type: "auth",
        capabilities: [
          "companion_event_epoch",
          "term_input_boundary",
          "term_scrollback_window"
        ],
        credential: "id-token-1"
      })
    );
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["term_input_boundary"],
      }),
    });
    await flushPromises();
    expect(socket.send).toHaveBeenNthCalledWith(
      4,
      JSON.stringify({
        type: "attach",
        task_id: "task-1",
        kind: "terminal",
        from_seq: 0
      })
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_snapshot",
        task_id: "task-1",
        cols: 80,
        rows: 24,
        data_b64: Buffer.from("restored output").toString("base64")
      })
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "bGl2ZSBvdXRwdXQ="
      })
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "session_exit",
        task_id: "task-1",
        code: 0
      })
    });

    expect(events).toEqual([
      {
        type: "snapshot",
        taskId: "task-1",
        cols: 80,
        rows: 24,
        dataB64: Buffer.from("restored output").toString("base64")
      },
      { type: "output", taskId: "task-1", dataB64: "bGl2ZSBvdXRwdXQ=" },
      { type: "exit", taskId: "task-1", code: 0 }
    ]);

    subscription.sendInput?.("G1s8NjU7MTsxTQ==", false, true);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "term_input_control",
        task_id: "task-1",
        data_b64: "G1s8NjU7MTsxTQ=="
      })
    );
    subscription.resize?.(80, 48);
    await flushPromises();
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "term_resize",
        task_id: "task-1",
        cols: 80,
        rows: 48
      })
    );

    subscription.close();
    await flushPromises();
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "detach", task_id: "task-1", kind: "terminal" })
    );
  });

  it("passes split utf-8 terminal output across relay chunks without decoding", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });
    const events: unknown[] = [];

    client.observeTaskTerminal(
      { desktopId: "desktop-1", taskId: "task-1" },
      (event) => {
        events.push(event);
      }
    );

    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tunnel_ready" }) });
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await flushPromises();

    const spinnerBytes = Buffer.from("⠋");
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_snapshot",
        task_id: "task-1",
        cols: 80,
        rows: 24,
        data_b64: ""
      })
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: Buffer.from(spinnerBytes.subarray(0, 1)).toString("base64")
      })
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: Buffer.from(spinnerBytes.subarray(1)).toString("base64")
      })
    });

    expect(events).toEqual([
      { type: "snapshot", taskId: "task-1", cols: 80, rows: 24, dataB64: "" },
      {
        type: "output",
        taskId: "task-1",
        dataB64: Buffer.from(spinnerBytes.subarray(0, 1)).toString("base64")
      },
      {
        type: "output",
        taskId: "task-1",
        dataB64: Buffer.from(spinnerBytes.subarray(1)).toString("base64")
      }
    ]);
  });

  it("force-refreshes the token once and reports an auth error when the relay keeps rejecting it", async () => {
    vi.useFakeTimers();
    try {
      const sockets: RelaySocketLike[] = [];
      const forceRefreshArgs: Array<boolean | undefined> = [];
      const onAuthError = vi.fn();
      const client = createRelayDesktopClient({
        createSocket: () => {
          const socket = createSocket();
          sockets.push(socket);
          return socket;
        },
        getIdToken: async (forceRefresh) => {
          forceRefreshArgs.push(forceRefresh);
          return "id-token";
        },
        relayUrl: "wss://relay.example",
        onAuthError
      });

      client.observeTaskTerminal(
        { desktopId: "desktop-1", taskId: "task-1" },
        () => {}
      );

      // First tunnel: relay rejects the (revoked) phone token by closing 4005.
      const socket1 = sockets[0];
      socket1.onopen?.();
      await flushPromises();
      expect(forceRefreshArgs).toEqual([false]);
      socket1.onclose?.({ code: 4005 });

      // The client force-refreshes and retries.
      await vi.advanceTimersByTimeAsync(250);
      const socket2 = sockets[1];
      expect(socket2).toBeDefined();
      socket2.onopen?.();
      await flushPromises();
      expect(forceRefreshArgs).toEqual([false, true]);

      // Still rejected after refresh → surface auth error, stop retrying.
      socket2.onclose?.({ code: 4005 });
      await flushPromises();
      expect(onAuthError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets.length).toBe(2);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

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
        credential: "id-token-1"
      })
    );
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
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
      { type: "ready", taskId: "task-1", cols: 80, rows: 24 },
      {
        type: "output",
        taskId: "task-1",
        dataB64: Buffer.from("restored output").toString("base64")
      },
      { type: "output", taskId: "task-1", dataB64: "bGl2ZSBvdXRwdXQ=" },
      { type: "exit", taskId: "task-1", code: 0 }
    ]);

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
      { type: "ready", taskId: "task-1", cols: 80, rows: 24 },
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

  it("sends terminal input through relay command invokes", async () => {
    const socket = createSocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });

    const input = client.sendTaskInput({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "continue\n"
    });

    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tunnel_ready" }) });
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await flushPromises();

    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "term_input",
        task_id: "task-1",
        data_b64: Buffer.from("continue\n").toString("base64")
      })
    );

    await expect(input).resolves.toBeUndefined();
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

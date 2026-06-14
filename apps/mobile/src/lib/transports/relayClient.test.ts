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
      { type: "ready", taskId: "task-1" },
      { type: "output", taskId: "task-1", text: "restored output" },
      { type: "output", taskId: "task-1", text: "live output" },
      { type: "exit", taskId: "task-1", code: 0 }
    ]);

    subscription.close();
    await flushPromises();
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "detach", task_id: "task-1", kind: "terminal" })
    );
  });

  it("decodes split utf-8 terminal output across relay chunks", async () => {
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
      { type: "ready", taskId: "task-1" },
      { type: "output", taskId: "task-1", text: "" },
      { type: "output", taskId: "task-1", text: "" },
      { type: "output", taskId: "task-1", text: "⠋" }
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
});

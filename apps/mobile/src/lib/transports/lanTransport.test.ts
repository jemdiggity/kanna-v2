import { describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "@kanna/agent-protocol";
import {
  createLanTransport,
  type FetchLike,
  type WebSocketLike
} from "./lanTransport";

describe("createLanTransport", () => {
  it("puts an identified task at its encoded route without routing fields in the body", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        taskId: "a1b2/c3d4",
        repoId: "repo-1",
        title: "Ship it",
        stage: "in progress"
      })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await transport.createTask({
      taskId: "a1b2/c3d4",
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-route"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/a1b2%2Fc3d4",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          prompt: "Ship it"
        })
      }
    );
  });

  it("never downgrades a present but invalid task identity to legacy POST", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => null
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.createTask({
      taskId: "",
      repoId: "repo-1",
      prompt: "Ship it"
    })).rejects.toThrow("LAN request failed (404)");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          prompt: "Ship it"
        })
      }
    );
  });

  it("fails closed instead of requesting task file contents over unauthenticated LAN", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        path: "docs/spec one.md",
        content: "# Spec"
      })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(
      transport.readTaskFile("task/read", "docs/spec one.md")
    ).rejects.toThrow(/authenticated relay/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts mark-read through the LAN task action route", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ taskId: "task/read", activity: "idle" })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.markTaskRead("task/read")).resolves.toEqual({
      taskId: "task/read",
      activity: "idle"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task%2Fread/actions/mark-read",
      { method: "POST" }
    );
  });

  it("calls the shared LAN API routes for task listing, repo listing, and task creation", async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{
          id: "task-1",
          repoId: "repo-1",
          title: "Refactor mobile shell",
          stage: "in progress",
          waitingPromptSnippet: "Latest agent output preview",
          agentType: "agent"
        }]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: "repo-1", name: "Repo One" }]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{
          id: "task-repo-1",
          repoId: "repo-1",
          title: "Repo task",
          stage: "in progress"
        }]
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          taskId: "task-1",
          repoId: "repo-1",
          title: "Ship it",
          stage: "in progress"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          taskId: "task-2"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          taskId: "task-3"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => undefined
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => undefined
      });

    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.listRecentTasks()).resolves.toEqual([
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Refactor mobile shell",
        stage: "in progress",
        waitingPromptSnippet: "Latest agent output preview",
        agentType: "agent"
      }
    ]);
    await expect(transport.listRepos()).resolves.toEqual([
      { id: "repo-1", name: "Repo One" }
    ]);
    await expect(transport.listRepoTasks("repo-1")).resolves.toEqual([
      {
        id: "task-repo-1",
        repoId: "repo-1",
        title: "Repo task",
        stage: "in progress"
      }
    ]);
    await expect(transport.createTask({
      repoId: "repo-1",
      prompt: "Ship it",
      desktopId: "desktop-ignored",
      terminalCols: 80,
      terminalRows: 48
    })).resolves.toEqual({
      taskId: "task-1",
      repoId: "repo-1",
      title: "Ship it",
      stage: "in progress"
    });
    await expect(transport.runMergeAgent("task-1")).resolves.toEqual({
      taskId: "task-2"
    });
    await expect(transport.advanceTaskStage("task-1")).resolves.toEqual({
      taskId: "task-3"
    });
    await expect(transport.closeTask("task-1")).resolves.toBeUndefined();
    await expect(transport.sendTaskInput("task-1", "continue")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:48120/v1/tasks/recent",
      undefined
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:48120/v1/repos",
      undefined
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:48120/v1/repos/repo-1/tasks",
      undefined
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:48120/v1/tasks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          prompt: "Ship it",
          terminalCols: 80,
          terminalRows: 48
        })
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/run-merge-agent",
      {
        method: "POST"
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/advance-stage",
      {
        method: "POST"
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      7,
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/close",
      {
        method: "POST"
      }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      8,
      "http://127.0.0.1:48120/v1/tasks/task-1/input",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: "continue"
        })
      }
    );
  });

  it("observes task terminal output over the LAN KSP websocket route without decoding bytes", () => {
    const fetchImpl = vi.fn<FetchLike>();
    const sent: ClientFrame[] = [];
    const socket: WebSocketLike = {
      send: vi.fn((payload: string) => {
        sent.push(JSON.parse(payload) as ClientFrame);
      }),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null
    };
    const socketFactory = vi.fn(() => socket);
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      fetchImpl,
      socketFactory
    );
    const events: unknown[] = [];

    const subscription = transport.observeTaskTerminal("task-1", (event) => {
      events.push(event);
    });

    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" } satisfies ServerFrame) });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_snapshot",
        task_id: "task-1",
        cols: 80,
        rows: 24,
        data_b64: "4pSA55WM"
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "8J8="
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "mIA="
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "session_exit",
        task_id: "task-1",
        code: 0
      } satisfies ServerFrame)
    });
    subscription.close();

    expect(socketFactory).toHaveBeenCalledWith(
      "ws://127.0.0.1:48120/v1/stream"
    );
    expect(sent).toEqual([
      { type: "auth" },
      { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 }
    ]);
    expect(events).toEqual([
      { type: "ready", taskId: "task-1", cols: 80, rows: 24 },
      { type: "output", taskId: "task-1", dataB64: "4pSA55WM" },
      { type: "output", taskId: "task-1", dataB64: "8J8=" },
      { type: "output", taskId: "task-1", dataB64: "mIA=" },
      { type: "exit", taskId: "task-1", code: 0 }
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ text: expect.any(String) })
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("observes agent events over the LAN KSP websocket route", () => {
    const fetchImpl = vi.fn<FetchLike>();
    const sent: ClientFrame[] = [];
    const socket: WebSocketLike = {
      send: vi.fn((payload: string) => {
        sent.push(JSON.parse(payload) as ClientFrame);
      }),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null
    };
    const socketFactory = vi.fn(() => socket);
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      fetchImpl,
      socketFactory
    );
    const events: unknown[] = [];

    const subscription = transport.observeTaskAgent("task-1", (event) => {
      events.push(event);
    });

    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" } satisfies ServerFrame) });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "agent_snapshot",
        task_id: "task-1",
        next_seq: 1,
        events: [{ seq: 0, event: { type: "user_message", text: "hello" } }]
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "agent_event",
        task_id: "task-1",
        seq: 1,
        event: { type: "assistant_text", text: "hi", truncated: false }
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "status_changed",
        task_id: "task-1",
        status: "busy"
      } satisfies ServerFrame)
    });

    subscription.sendInput("continue");
    subscription.sendPermission("perm-1", { kind: "allow_session" });
    subscription.interrupt();
    subscription.close();

    expect(socketFactory).toHaveBeenCalledWith("ws://127.0.0.1:48120/v1/stream");
    expect(sent).toEqual([
      { type: "auth" },
      { type: "attach", task_id: "task-1", kind: "agent", from_seq: 0 },
      { type: "agent_input", task_id: "task-1", text: "continue" },
      {
        type: "agent_permission",
        task_id: "task-1",
        request_id: "perm-1",
        decision: { kind: "allow_session" }
      },
      { type: "agent_interrupt", task_id: "task-1" }
    ]);
    expect(events).toEqual([
      {
        type: "snapshot",
        taskId: "task-1",
        events: [{ seq: 0, event: { type: "user_message", text: "hello" } }],
        nextSeq: 1
      },
      {
        type: "event",
        taskId: "task-1",
        seq: 1,
        event: { type: "assistant_text", text: "hi", truncated: false }
      },
      { type: "status", taskId: "task-1", status: "busy" }
    ]);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});

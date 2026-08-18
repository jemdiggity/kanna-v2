import { describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "@kanna/agent-protocol";
import {
  createLanTransport,
  type FetchLike,
  type WebSocketLike
} from "./lanTransport";

describe("createLanTransport", () => {
  it("carries the desktop's reported agent provider inventory", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        {
          id: "desktop-1",
          name: "Studio Mac",
          connectionMode: "both",
          agentProviders: ["opencode"]
        }
      ])
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.listDesktops()).resolves.toEqual([
      {
        id: "desktop-1",
        name: "Studio Mac",
        online: true,
        mode: "lan",
        agentProviders: ["opencode"]
      }
    ]);
  });

  it("reports no inventory for a desktop that predates provider reporting", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        { id: "desktop-1", name: "Studio Mac", connectionMode: "both" }
      ])
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.listDesktops()).resolves.toEqual([
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }
    ]);
  });

  it("lists and runs encoded repository commands over LAN", async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          repoId: "repo/one",
          revision: "catalog-v1",
          commands: [{
            id: "custom:ship/release",
            label: "Ship",
            description: "Release this repository",
            group: "automation"
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ taskId: "task-1", reused: false })
      });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.listRepoCommands("repo/one")).resolves.toEqual(
      expect.objectContaining({ revision: "catalog-v1" })
    );
    await expect(
      transport.runRepoCommand("repo/one", "custom:ship/release", "catalog-v1")
    ).resolves.toEqual({ taskId: "task-1", reused: false });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:48120/v1/repos/repo%2Fone/commands",
      undefined
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:48120/v1/repos/repo%2Fone/commands/custom%3Aship%2Frelease/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogRevision: "catalog-v1" })
      }
    );
  });

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

  it("aborts an identified creation without sending desktop routing in the body", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => null
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await transport.abortTaskCreation({
      taskId: "a1b2/c3d4",
      desktopId: "desktop-route"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/a1b2%2Fc3d4/actions/abort-creation",
      { method: "POST" }
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

  it("surfaces an advance-stage conflict without retrying another route", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "stage conflict" })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.advanceTaskStage("task-1")).rejects.toThrow(
      "LAN request failed (409)"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/advance-stage",
      { method: "POST" }
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

  it("fails closed instead of resolving mentioned files over unauthenticated LAN", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(
      transport.resolveTaskFileMentions("task/read", [
        { path: "TaskScreen.tsx", line: 42 }
      ])
    ).rejects.toThrow(/authenticated relay/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed instead of requesting the task diff without device credentials", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        taskId: "task-1",
        baseRef: "main",
        mergeBase: "abc",
        patch: "",
        truncated: false
      })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.readTaskDiff("task/read")).rejects.toThrow(
      /paired device|authenticated relay/i
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the requested diff scope and mode as query parameters", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        taskId: "task-1",
        baseRef: null,
        mergeBase: null,
        patch: "",
        truncated: false
      })
    });
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      fetchImpl,
      undefined,
      {
        deviceCredentials: {
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }
      }
    );

    await transport.readTaskDiff("task-1", { scope: "working", mode: "unstaged" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task-1/diff?scope=working&mode=unstaged",
      expect.anything()
    );
  });

  it("reads the task diff over LAN with paired device credential headers", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        taskId: "task-1",
        baseRef: "main",
        mergeBase: "abc123",
        patch: "diff --git a/x b/x",
        truncated: false
      })
    });
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      fetchImpl,
      undefined,
      {
        deviceCredentials: {
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }
      }
    );

    await expect(transport.readTaskDiff("task/read")).resolves.toMatchObject({
      patch: "diff --git a/x b/x"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task%2Fread/diff",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Kanna-Device-Id": "phone-1",
          "X-Kanna-Device-Secret": "lan-secret"
        })
      })
    );
  });

  it("loads full task detail through the encoded LAN task route", async () => {
    const fullPrompt = `${"p".repeat(520)}END-OF-CANONICAL-PROMPT`;
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "task/long",
        repoId: "repo-1",
        title: "Long task",
        prompt: fullPrompt,
        stage: "in progress"
      })
    });
    const transport = createLanTransport("http://127.0.0.1:48120", fetchImpl);

    await expect(transport.getTask?.("task/long")).resolves.toEqual(
      expect.objectContaining({ prompt: fullPrompt })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task%2Flong",
      undefined
    );
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

  it("uses the advertised current KSP stream epoch for terminal output", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        state: "running",
        desktopId: "desktop-1",
        desktopName: "Studio Mac",
        version: "1.2.3",
        environment: "production",
        serverVersion: "1.2.3",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null,
        kspStreamVersion: 2
      })
    });
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
      socketFactory,
      {
        deviceCredentials: {
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }
      }
    );
    const events: unknown[] = [];

    await transport.getStatus();
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
      "ws://127.0.0.1:48120/v2/stream",
      {
        "X-Kanna-Device-Id": "phone-1",
        "X-Kanna-Device-Secret": "lan-secret"
      }
    );
    expect(sent).toEqual([
      {
        type: "auth",
        credential: JSON.stringify({
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }),
        capabilities: ["companion_event_epoch"]
      },
      { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 }
    ]);
    expect(events).toEqual([
      {
        type: "snapshot",
        taskId: "task-1",
        cols: 80,
        rows: 24,
        dataB64: "4pSA55WM"
      },
      { type: "output", taskId: "task-1", dataB64: "8J8=" },
      { type: "output", taskId: "task-1", dataB64: "mIA=" },
      { type: "exit", taskId: "task-1", code: 0 }
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ text: expect.any(String) })
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy v1 stream when a previous server omits the KSP epoch", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        state: "running",
        desktopId: "desktop-legacy",
        desktopName: "Previous Studio Mac",
        version: "1.1.0",
        environment: "production",
        serverVersion: "1.1.0",
        lanHost: "0.0.0.0",
        lanPort: 48120,
        pairingCode: null
      })
    });
    const socket: WebSocketLike = {
      send: vi.fn(),
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
      socketFactory,
      {
        deviceCredentials: {
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }
      }
    );

    await transport.getStatus();
    const subscription = transport.observeTaskTerminal("task-1", () => {});

    expect(socketFactory).toHaveBeenCalledWith(
      "ws://127.0.0.1:48120/v1/stream",
      {
        "X-Kanna-Device-Id": "phone-1",
        "X-Kanna-Device-Secret": "lan-secret"
      }
    );
    subscription.close();
  });

  it("sends alt-screen scroll bytes as term_input frames over the LAN KSP route", () => {
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
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      fetchImpl,
      vi.fn(() => socket)
    );

    const subscription = transport.observeTaskTerminal("task-1", () => {});
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" } satisfies ServerFrame) });
    subscription.sendInput?.("G1s8NjU7MTsxTQ==");
    subscription.resize?.(80, 48);

    expect(sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch"] },
      { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 },
      { type: "term_input", task_id: "task-1", data_b64: "G1s8NjU7MTsxTQ==" },
      { type: "term_resize", task_id: "task-1", cols: 80, rows: 48 }
    ]);
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
      { type: "auth", capabilities: ["companion_event_epoch"] },
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

  it("observes and responds to visual companions over the LAN KSP websocket", () => {
    const sent: ClientFrame[] = [];
    const socket: WebSocketLike = {
      send: vi.fn((payload: string) => sent.push(JSON.parse(payload) as ClientFrame)),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null
    };
    const socketFactory = vi.fn(() => socket);
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      vi.fn<FetchLike>(),
      socketFactory,
      {
        deviceCredentials: {
          deviceId: "phone-1",
          deviceSecret: "lan-secret"
        }
      }
    );
    const events: unknown[] = [];
    const subscription = transport.observeTaskCompanion("task-1", (event) =>
      events.push(event)
    );
    expect(socketFactory).toHaveBeenCalledWith(
      "ws://127.0.0.1:48120/v1/stream",
      {
        "X-Kanna-Device-Id": "phone-1",
        "X-Kanna-Device-Secret": "lan-secret"
      }
    );
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal", "companion"],
        capabilities: [
          "companion_attachment_epoch",
          "companion_event_epoch"
        ]
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_snapshot",
        task_id: "task-1",
        session_id: "123-456",
        revision: "rev-1",
        document_kind: "fragment",
        html: "<button data-choice='a'>A</button>",
        source_origin: "http://localhost:52341",
        attachment_epoch: 1,
        assets: [
          {
            name: "layout.png",
            content_type: "image/png",
            digest: "asset-1",
            data_b64: "UE5H"
          }
        ]
      } satisfies ServerFrame)
    });
    const event = {
      session_id: "123-456",
      revision: "rev-1",
      event_id: "event-1",
      type: "click",
      choice: "a",
      text: "A",
      id: null,
      timestamp: 1
    } as const;
    expect(subscription.sendEvent("123-456", "rev-1", event)).toBe(true);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_event_result",
        task_id: "task-1",
        session_id: "123-456",
        revision: "rev-1",
        event_id: "event-1",
        accepted: true,
        attachment_epoch: 1
      } satisfies ServerFrame)
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_event_result",
        task_id: "task-1",
        event_id: "legacy-event",
        accepted: true
      } satisfies ServerFrame)
    });
    socket.onclose?.({});
    expect(subscription.sendEvent("123-456", "rev-1", event)).toBe(false);
    subscription.close();

    expect(events).toEqual([
      { type: "connection", taskId: "task-1", connected: true },
      {
        type: "snapshot",
        taskId: "task-1",
        sessionId: "123-456",
        revision: "rev-1",
        documentKind: "fragment",
        html: "<button data-choice='a'>A</button>",
        sourceOrigin: "http://localhost:52341",
        assets: []
      },
      {
        type: "event_result",
        taskId: "task-1",
        sessionId: "123-456",
        revision: "rev-1",
        eventId: "event-1",
        accepted: true,
      },
      { type: "connection", taskId: "task-1", connected: false }
    ]);
    expect(sent).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      include_assets: false,
      attachment_epoch: 1
    });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "companion_event", task_id: "task-1" })
    );
    expect(sent.filter((frame) => frame.type === "companion_event")).toHaveLength(1);
  });

  it("degrades a headerless LAN companion observer through unavailable capability negotiation", () => {
    const sent: ClientFrame[] = [];
    const socket: WebSocketLike = {
      send: vi.fn((payload: string) => sent.push(JSON.parse(payload) as ClientFrame)),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null
    };
    const socketFactory = vi.fn(() => socket);
    const transport = createLanTransport(
      "http://127.0.0.1:48120",
      vi.fn<FetchLike>(),
      socketFactory
    );
    const events: unknown[] = [];
    transport.observeTaskCompanion("task-legacy", (event) => events.push(event));

    expect(socketFactory).toHaveBeenCalledWith(
      "ws://127.0.0.1:48120/v1/stream"
    );
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal"]
      } satisfies ServerFrame)
    });

    expect(sent).toEqual([
      { type: "auth", capabilities: ["companion_event_epoch"] }
    ]);
    expect(events).toContainEqual({
      type: "unavailable",
      taskId: "task-legacy"
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "error" })
    );
  });
});

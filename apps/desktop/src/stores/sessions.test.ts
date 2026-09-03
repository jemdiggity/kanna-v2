import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "../types/kanna";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import { createSessionsApi } from "./sessions";
import { createStoreState, type StoreContext } from "./state";
import { acknowledgeTaskUiSlot, buildCreatingTaskUiSlot } from "./taskUiSlots";

const mocks = vi.hoisted(() => {
  const invokeDefault = async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "read_env_var":
        if (args?.name === "PATH") return "/usr/bin:/bin";
        if (args?.name === "KANNA_DAEMON_DIR") return "/tmp/kanna-daemon";
        throw new Error(`env var not set: ${args?.name ?? ""}`);
      case "mobile_server_status":
        return { state: "running", lanPort: 48120 };
      case "which_binary":
        return `/usr/bin/${args?.name ?? "binary"}`;
      case "get_app_data_dir":
        return "/tmp/kanna";
      case "get_workflow_socket_path":
        return "/tmp/kanna.sock";
      case "ensure_term_init":
        return "/tmp/kanna-zdotdir";
      case "list_dir":
        return [];
      case "read_text_file":
        return "{}";
      case "spawn_session":
      case "spawn_agent_session":
      case "send_input":
      case "ensure_directory":
      case "write_text_file":
        return undefined;
      case "list_sessions":
        return [];
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  };
  const invokeMock = vi.fn(invokeDefault);
  const updateAgentSessionIdMock = vi.fn(async () => {});
  const putTaskAgentSessionMock = vi.fn(async () => {});
  const applyTaskRuntimeStatusMock = vi.fn(async (taskId: string) => ({ taskId, activity: null }));
  const postDesktopTaskActionMock = vi.fn(async () => new Response("{}", { status: 200 }));
  return {
    invokeMock,
    invokeDefault,
    updateAgentSessionIdMock,
    putTaskAgentSessionMock,
    applyTaskRuntimeStatusMock,
    postDesktopTaskActionMock,
  };
});

vi.mock("../invoke", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("../services/desktopTaskActions", () => ({
  postDesktopTaskAction: mocks.postDesktopTaskActionMock,
}));

vi.mock("./db", () => ({
  resolveDbName: vi.fn(async () => "kanna-test.db"),
}));

vi.mock("@kanna/" + "db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../types/kanna")>();
  return {
    ...actual,
    getRepo: vi.fn(async () => null),
    updateAgentSessionId: mocks.updateAgentSessionIdMock,
    updatePipelineItemActivity: vi.fn(async () => {}),
  };
});

function makeContext(): StoreContext {
  const db = {
    select: vi.fn(async () => []),
    execute: vi.fn(async () => undefined),
  } as unknown as DbHandle;

  const state = createStoreState();
  state.db.value = db;
  state.suspendAfterMinutes.value = 5;
  state.killAfterMinutes.value = 30;

  return {
    state,
    services: {},
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    tt: (key: string) => key,
    requireDb: () => db,
  };
}

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Ship it",
    workflow: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "working",
    activity_changed_at: "2026-07-11T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("createSessionsApi", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.invokeMock.mockReset();
    mocks.invokeMock.mockImplementation(mocks.invokeDefault);
    mocks.postDesktopTaskActionMock.mockReset();
    mocks.postDesktopTaskActionMock.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.updateAgentSessionIdMock.mockClear();
    mocks.putTaskAgentSessionMock.mockClear();
    mocks.applyTaskRuntimeStatusMock.mockClear();
    setDesktopServerClientHandlersForTests({
      putTaskAgentSession: mocks.putTaskAgentSessionMock,
      applyTaskRuntimeStatus: mocks.applyTaskRuntimeStatusMock,
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      }),
    });
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  it("derives pending setup runtime status from an acknowledged creating slot", async () => {
    const context = makeContext();
    const item = makeItem();
    context.state.items.value = [item];
    context.state.taskUiSlots.value = acknowledgeTaskUiSlot(
      [buildCreatingTaskUiSlot({
        slotId: "create:slot-1",
        repoId: "repo-1",
        prompt: "Ship it",
        agentType: "pty",
        requestedAgentProviders: "claude",
      })],
      "create:slot-1",
      item.id,
    );
    const sessions = createSessionsApi(context);

    await sessions.applyTaskRuntimeStatus(item, "idle");

    expect(mocks.applyTaskRuntimeStatusMock).not.toHaveBeenCalled();
  });

  it("reports OpenCode CLI availability", async () => {
    const sessions = createSessionsApi(makeContext());

    await expect(sessions.getAgentProviderAvailability()).resolves.toEqual({
      claude: true,
      copilot: true,
      codex: true,
      opencode: true,
      antigravity: true,
    });
  });

  it("builds a fresh Antigravity PTY command using prompt-interactive and Kanna prompt context", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "antigravity",
      worktreePath: "/tmp/repo/.kanna-worktrees/task-1",
    });

    expect(prepared.agentCmd).toBe(
      "mkdir -p '/tmp/kanna-antigravity-workspaces' && rm -f '/tmp/kanna-antigravity-workspaces/task-1' && ln -s '/tmp/repo/.kanna-worktrees/task-1' '/tmp/kanna-antigravity-workspaces/task-1' && 'agy' --dangerously-skip-permissions --add-dir '/tmp/kanna-antigravity-workspaces/task-1' --prompt-interactive 'Ship it'",
    );
    expect(prepared.agentCmdPreamble).toContain(
      "mkdir -p '/tmp/kanna-antigravity-workspaces' && rm -f '/tmp/kanna-antigravity-workspaces/task-1' && ln -s '/tmp/repo/.kanna-worktrees/task-1' '/tmp/kanna-antigravity-workspaces/task-1' && 'agy' --dangerously-skip-permissions --add-dir '/tmp/kanna-antigravity-workspaces/task-1' --prompt-interactive '",
    );
    expect(prepared.agentCmdPreamble).toContain("Ship it");
    expect(prepared.agentCmdPreamble).toContain("This session was launched by Kanna");
    expect(prepared.agentProvider).toBe("antigravity");
    expect(mocks.updateAgentSessionIdMock).not.toHaveBeenCalled();
  });

  it("builds a fresh OpenCode TUI command with prompt and model flags", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "opencode",
      model: "opencode/gpt-5.1-codex",
    });

    // The CLI's default command, not `run`: `opencode run` draws no TUI and
    // exits at the end of its first turn, leaving no composer behind.
    expect(prepared.agentCmd).toBe("'/usr/bin/opencode' --auto -m opencode/gpt-5.1-codex --prompt 'Ship it'");
    expect(prepared.agentCmdPreamble).toContain("'/usr/bin/opencode' --auto -m opencode/gpt-5.1-codex --prompt");
    expect(prepared.agentCmdPreamble).toContain("Ship it");
    expect(prepared.agentCmdPreamble).toContain("This session was launched by Kanna");
    expect(prepared.agentProvider).toBe("opencode");
    expect(mocks.updateAgentSessionIdMock).not.toHaveBeenCalled();
  });

  it("builds an OpenCode resume command with the stored session id", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Continue", {
      agentProvider: "opencode",
      resumeSessionId: "ses_123",
    });

    // Two phases: the TUI drops `--prompt` when it is also resuming a session,
    // so the turn is seeded headlessly against that same id and the TUI then
    // attaches to the conversation it extended.
    expect(prepared.agentCmd).toBe(
      "'/usr/bin/opencode' run --auto --session 'ses_123' 'Continue'; "
      + "'/usr/bin/opencode' --auto --session 'ses_123'",
    );
    expect(prepared.agentCmdPreamble).toContain("'/usr/bin/opencode' run --auto --session 'ses_123'");
    expect(prepared.agentCmdPreamble).toContain("; '/usr/bin/opencode' --auto --session 'ses_123'");
    expect(prepared.agentCmd).not.toContain("--prompt");
    expect(prepared.agentCmdPreamble).toContain("Continue");
    expect(prepared.agentCmdPreamble).toContain("This session was launched by Kanna");
  });

  it("builds a fresh Copilot command with a new session id instead of resume", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "copilot",
    });

    expect(prepared.agentCmd).toMatch(/^copilot --yolo --session-id='[0-9a-f-]+' -i 'Ship it'$/);
    expect(prepared.agentCmdPreamble).toMatch(/^copilot --yolo --session-id='[0-9a-f-]+' -i /);
    expect(prepared.agentCmdPreamble).toContain("Ship it");
    expect(prepared.agentCmdPreamble).toContain("This session was launched by Kanna");
    expect(prepared.agentCmd).not.toContain("--resume");
    expect(prepared.agentCmdPreamble).not.toContain("--resume");
    expect(mocks.putTaskAgentSessionMock).toHaveBeenCalledOnce();
    expect(mocks.putTaskAgentSessionMock).toHaveBeenCalledWith(
      "task-1",
      expect.stringMatching(/^[0-9a-f-]+$/),
    );
    expect(mocks.updateAgentSessionIdMock).not.toHaveBeenCalled();
  });

  it("prints the display prompt while launching Codex with the stage prompt", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Stage guidance\n\nShip it", {
      agentProvider: "codex",
      displayPrompt: "Ship it",
    });

    expect(prepared.agentCmd).toBe("codex --yolo 'Ship it'");
    expect(prepared.agentCmdPreamble).toContain("Stage guidance");
    expect(prepared.agentCmdPreamble).toContain("This session was launched by Kanna");
    expect(prepared.agentCmdPreamble).toContain("Ship it");
  });

  it("builds Codex PTY tasks with the instance-local Kanna MCP config", async () => {
    mocks.invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_text_file" && args?.path === "/tmp/kanna-daemon/runtime/mcp/task-1.json") {
        return JSON.stringify({
          mcpServers: {
            "kanna-mcp": {
              command: "/usr/bin/kanna-mcp",
              args: ["serve"],
              env: {
                KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
              },
            },
          },
        });
      }
      return mocks.invokeDefault(command, args);
    });
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "codex",
    });

    expect(prepared.agentCmd).toBe(
      "codex --yolo -c 'mcp_servers.kanna-mcp.command=\"/usr/bin/kanna-mcp\"' -c 'mcp_servers.kanna-mcp.args=[\"serve\"]' -c 'mcp_servers.kanna-mcp.env.KANNA_SERVER_BASE_URL=\"http://127.0.0.1:48120\"' 'Ship it'",
    );
    expect(prepared.agentCmdPreamble).toContain(
      "Codex is launched with Kanna MCP registration via `-c mcp_servers.kanna-mcp.*` overrides",
    );
    expect(prepared.env).toEqual(expect.objectContaining({
      KANNA_MCP_PATH: "/usr/bin/kanna-mcp",
      KANNA_MCP_CONFIG: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
      KANNA_CLI_PATH: "/usr/bin/kanna-cli",
    }));
  });

  it("builds Claude PTY tasks with the instance-local Kanna MCP config", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "claude",
    });

    expect(prepared.agentCmd).toContain("--append-system-prompt");
    expect(prepared.agentCmd).toContain("--mcp-config '/tmp/kanna-daemon/runtime/mcp/task-1.json'");
    expect(prepared.env).toEqual(expect.objectContaining({
      KANNA_MCP_PATH: "/usr/bin/kanna-mcp",
      KANNA_MCP_CONFIG: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
      KANNA_CLI_PATH: "/usr/bin/kanna-cli",
    }));
    expect(mocks.invokeMock).toHaveBeenCalledWith("ensure_directory", {
      path: "/tmp/kanna-daemon/runtime/mcp",
    });
    expect(mocks.invokeMock).toHaveBeenCalledWith("write_text_file", {
      path: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
      content: expect.stringContaining("\"kanna-mcp\""),
    });
    expect(mocks.putTaskAgentSessionMock).toHaveBeenCalledOnce();
    expect(mocks.putTaskAgentSessionMock).toHaveBeenCalledWith(
      "task-1",
      expect.stringMatching(/^[0-9a-f-]+$/),
    );
    expect(mocks.updateAgentSessionIdMock).not.toHaveBeenCalled();
    const writeCall = mocks.invokeMock.mock.calls.find(([command]) => command === "write_text_file");
    const content = String(writeCall?.[1]?.content ?? "");
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        "kanna-mcp": {
          command: "/usr/bin/kanna-mcp",
          args: ["serve"],
          env: {
            KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
          },
        },
      },
    });
  });

  it("uses the running desktop server port when writing agent MCP config", async () => {
    mocks.invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "mobile_server_status") {
        return { state: "running", lanPort: 48121 };
      }
      return mocks.invokeDefault(command, args);
    });
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "claude",
    });

    expect(prepared.env.KANNA_SERVER_BASE_URL).toBe("http://127.0.0.1:48121");
    const writeCall = mocks.invokeMock.mock.calls.find(([command]) => command === "write_text_file");
    const content = String(writeCall?.[1]?.content ?? "");
    expect(JSON.parse(content).mcpServers["kanna-mcp"].env.KANNA_SERVER_BASE_URL).toBe("http://127.0.0.1:48121");
  });

  it("builds a Copilot resume command with the stored session id", async () => {
    const sessions = createSessionsApi(makeContext());

    const prepared = await sessions.preparePtySession("task-1", "Continue", {
      agentProvider: "copilot",
      resumeSessionId: "5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
    });

    expect(prepared.agentCmd).toBe("copilot --yolo --resume='5fc2bd17-1d1b-4ae9-bed8-011fa4011100'");
    expect(prepared.agentCmdPreamble).toBeUndefined();
    expect(prepared.agentProvider).toBe("copilot");
    expect(mocks.updateAgentSessionIdMock).not.toHaveBeenCalled();
  });

  it("does not send kitty CSI-u enter when spawning a Codex PTY task", async () => {
    vi.useFakeTimers();
    const sessions = createSessionsApi(makeContext());

    const spawn = sessions.spawnPtySession("task-1", "/tmp/repo/.kanna-worktrees/task-1", "Ship it", 80, 24, {
      agentProvider: "codex",
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await spawn;

    expect(mocks.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "task-1",
      data: Array.from(new TextEncoder().encode("\r")),
      submissionBoundary: true,
    });
    expect(mocks.invokeMock).not.toHaveBeenCalledWith("send_input", {
      sessionId: "task-1",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  });

  it("recovers a missing task through the server-owned provider resume path", async () => {
    const context = makeContext();
    const reloadSnapshot = vi.fn(async () => {});
    context.services.reloadSnapshot = reloadSnapshot;
    context.state.items.value = [makeItem({
      agent_type: "agent",
      agent_session_id: "claude-session-1",
    })];
    mocks.invokeMock.mockImplementation(async (command, args) => {
      if (command === "list_sessions") return [{ session_id: "task-1" }];
      return mocks.invokeDefault(command, args);
    });
    const sessions = createSessionsApi(context);

    await sessions.recoverTaskSession("task-1", { cols: 100, rows: 40 });

    expect(mocks.postDesktopTaskActionMock).toHaveBeenCalledWith("task-1", "resume");
    expect(mocks.invokeMock).toHaveBeenCalledWith("list_sessions");
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "spawn_agent_session",
      expect.anything(),
    );
    expect(mocks.invokeMock).not.toHaveBeenCalledWith("spawn_session", expect.anything());
    expect(reloadSnapshot).toHaveBeenCalledOnce();
  });

  it("passes task-scoped Kanna CLI env to worktree shell sessions", async () => {
    const sessions = createSessionsApi(makeContext());

    await sessions.spawnShellSession(
      "shell-wt-task-1",
      "/tmp/repo/.kanna-worktrees/task-1",
      JSON.stringify({ KANNA_DEV_PORT: "1421" }),
      true,
      "/tmp/repo",
    );

    expect(mocks.invokeMock).toHaveBeenCalledWith("spawn_session", expect.objectContaining({
      sessionId: "shell-wt-task-1",
      cwd: "/tmp/repo/.kanna-worktrees/task-1",
      env: expect.objectContaining({
        COLORTERM: "truecolor",
        KANNA_TASK_ID: "task-1",
        KANNA_SOCKET_PATH: "/tmp/kanna.sock",
        KANNA_WORKTREE: "1",
        KANNA_DEV_PORT: "1421",
        KANNA_CLI_PATH: "/usr/bin/kanna-cli",
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        TERM_PROGRAM: "kanna",
      }),
    }));
  });

  it("uses remote repo config for an identified worktree shell and resolves PATH from its actual cwd", async () => {
    const context = makeContext();
    context.state.items.value = [makeItem()];
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: {
        workspace: {
          env: { REMOTE_ENV: "yes" },
          path: { prepend: ["remote-bin"] },
        },
      },
      defaultWorkflow: "default",
      workflows: ["default"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const sessions = createSessionsApi(context);
    const worktreePath = "/tmp/actual-worktree";

    await sessions.spawnShellSession(
      "shell-wt-task-1",
      worktreePath,
      null,
      true,
      "/tmp/repo",
    );

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    const spawnCall = mocks.invokeMock.mock.calls.find(([command]) => command === "spawn_session");
    expect(spawnCall?.[1]).toEqual(expect.objectContaining({ cwd: worktreePath }));
    expect(spawnCall?.[1]?.env).toEqual(expect.objectContaining({ REMOTE_ENV: "yes" }));
    expect(spawnCall?.[1]?.env?.PATH).toContain(`${worktreePath}/remote-bin`);
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      { path: `${worktreePath}/.kanna/config.json` },
    );
  });

  it("uses empty config for a worktree shell with no task identity", async () => {
    const fetchRepoKannaDefinitions = vi.fn(async () => {
      throw new Error("generic shell must not fetch repo definitions");
    });
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const sessions = createSessionsApi(makeContext());
    const worktreePath = "/tmp/generic-worktree";

    await sessions.spawnShellSession("shell-generic", worktreePath, null, true);

    expect(fetchRepoKannaDefinitions).not.toHaveBeenCalled();
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      { path: `${worktreePath}/.kanna/config.json` },
    );
  });

  it("uses remote setup and workspace config when preparing an identified PTY task", async () => {
    const context = makeContext();
    context.state.items.value = [makeItem()];
    const fetchRepoKannaDefinitions = vi.fn(async () => ({
      revision: "remote-rev",
      refName: "origin/main",
      config: {
        setup: ["remote setup"],
        workspace: {
          env: { REMOTE_ENV: "yes" },
          path: { prepend: ["remote-bin"] },
        },
      },
      defaultWorkflow: "default",
      workflows: ["default"],
    }));
    updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions });
    const sessions = createSessionsApi(context);
    const worktreePath = "/tmp/actual-pty-worktree";

    const prepared = await sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "claude",
      worktreePath,
    });

    expect(fetchRepoKannaDefinitions).toHaveBeenCalledWith("repo-1");
    expect(prepared.setupCmds).toEqual(["remote setup"]);
    expect(prepared.env).toEqual(expect.objectContaining({
      REMOTE_ENV: "yes",
    }));
    expect(prepared.env.PATH).toContain(`${worktreePath}/remote-bin`);
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      { path: `${worktreePath}/.kanna/config.json` },
    );
  });

  it("propagates manifest errors while preparing an identified PTY task", async () => {
    const context = makeContext();
    context.state.items.value = [makeItem()];
    const error = new Error("remote task config unavailable");
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => {
        throw error;
      },
    });
    const sessions = createSessionsApi(context);

    await expect(sessions.preparePtySession("task-1", "Ship it", {
      agentProvider: "claude",
      worktreePath: "/tmp/identified-worktree",
    })).rejects.toBe(error);

    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "read_text_file",
      { path: "/tmp/identified-worktree/.kanna/config.json" },
    );
  });

  it("does not spawn locally when the server rejects task recovery", async () => {
    const context = makeContext();
    context.state.items.value = [makeItem({ agent_session_id: null })];
    mocks.postDesktopTaskActionMock.mockResolvedValue(
      new Response("no provider transcript", { status: 409 }),
    );
    const sessions = createSessionsApi(context);

    await expect(sessions.recoverTaskSession("task-1")).rejects.toThrow(
      "no provider transcript",
    );

    expect(mocks.invokeMock).not.toHaveBeenCalledWith("spawn_session", expect.anything());
    expect(mocks.invokeMock).not.toHaveBeenCalledWith(
      "spawn_agent_session",
      expect.anything(),
    );
  });
});

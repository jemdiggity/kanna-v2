import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import { createSessionsApi } from "./sessions";
import type { StoreContext } from "./state";

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "read_env_var":
        if (args?.name === "PATH") return "/usr/bin:/bin";
        if (args?.name === "KANNA_DAEMON_DIR") return "/tmp/kanna-daemon";
        throw new Error(`env var not set: ${args?.name ?? ""}`);
      case "which_binary":
        return `/usr/bin/${args?.name ?? "binary"}`;
      case "get_app_data_dir":
        return "/tmp/kanna";
      case "get_pipeline_socket_path":
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
  });
  const updateAgentSessionIdMock = vi.fn(async () => {});
  return { invokeMock, updateAgentSessionIdMock };
});

vi.mock("../invoke", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("./db", () => ({
  resolveDbName: vi.fn(async () => "kanna-test.db"),
}));

vi.mock("@kanna/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kanna/db")>();
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

  return {
    state: {
      db: ref(db),
      repos: ref<Repo[]>([]),
      items: ref<PipelineItem[]>([]),
      initialWindowBootstrap: ref(null),
      selectedRepoId: ref(null),
      selectedItemId: ref(null),
      lastSelectedItemByRepo: ref({}),
      suspendAfterMinutes: ref(5),
      killAfterMinutes: ref(30),
      ideCommand: ref("code"),
      hideShortcutsOnStartup: ref(false),
      devLingerTerminals: ref(false),
      lastHiddenRepoId: ref(null),
      pendingSetupIds: ref([]),
      pipelineCache: new Map(),
      agentCache: new Map(),
      stageOrderCache: new Map(),
      pendingCreateVisibility: new Map(),
    },
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

describe("createSessionsApi", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.invokeMock.mockClear();
    mocks.updateAgentSessionIdMock.mockClear();
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
    });

    expect(prepared.agentCmd).toBe("'agy' --dangerously-skip-permissions --prompt-interactive 'Ship it'");
    expect(prepared.agentCmdPreamble).toContain("'agy' --dangerously-skip-permissions --prompt-interactive '");
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

    expect(prepared.agentCmd).toBe("'/usr/bin/opencode' run --interactive --dangerously-skip-permissions -m opencode/gpt-5.1-codex 'Ship it'");
    expect(prepared.agentCmdPreamble).toContain("'/usr/bin/opencode' run --interactive --dangerously-skip-permissions -m opencode/gpt-5.1-codex");
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

    expect(prepared.agentCmd).toBe("'/usr/bin/opencode' run --interactive --dangerously-skip-permissions --session 'ses_123' 'Continue'");
    expect(prepared.agentCmdPreamble).toContain("'/usr/bin/opencode' run --interactive --dangerously-skip-permissions --session 'ses_123'");
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
    expect(mocks.updateAgentSessionIdMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      expect.stringMatching(/^[0-9a-f-]+$/),
    );
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
    });
    expect(mocks.invokeMock).not.toHaveBeenCalledWith("send_input", {
      sessionId: "task-1",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  });

  it("recovers an SDK agent task through the shared task session recovery API", async () => {
    const context = makeContext();
    context.state.repos.value = [{
      id: "repo-1",
      path: "/tmp/repo",
      name: "repo",
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-06-18T00:00:00.000Z",
      last_opened_at: "2026-06-18T00:00:00.000Z",
    }];
    context.state.items.value = [{
      id: "task-1",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      pipeline: "default",
      stage: "in progress",
      stage_result: null,
      active_post_action: null,
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: "task-task-1",
      closed_at: null,
      agent_type: "agent",
      agent_provider: "claude",
      activity: "idle",
      activity_changed_at: "2026-06-18T00:00:00.000Z",
      unread_at: null,
      port_offset: null,
      port_env: JSON.stringify({ KANNA_DEV_PORT: "1421" }),
      agent_spawn_options: null,
      pinned: 0,
      pin_order: null,
      display_name: null,
      base_ref: null,
      agent_session_id: "claude-session-1",
      previous_stage: null,
      teardown_started_at: null,
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
    }];
    const sessions = createSessionsApi(context);

    await sessions.recoverTaskSession("task-1", { cols: 100, rows: 40 });

    expect(mocks.invokeMock).toHaveBeenCalledWith("spawn_agent_session", expect.objectContaining({
      sessionId: "task-1",
      cwd: "/tmp/repo/.kanna-worktrees/task-task-1",
      prompt: "Ship it",
      agentProvider: "claude",
      model: null,
      permissionMode: null,
      executable: null,
    }));
    const spawnCall = mocks.invokeMock.mock.calls.find(([command]) => command === "spawn_agent_session");
    expect(spawnCall?.[1]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        KANNA_TASK_ID: "task-1",
        KANNA_WORKTREE: "1",
        KANNA_DEV_PORT: "1421",
        KANNA_MCP_PATH: "/usr/bin/kanna-mcp",
        KANNA_MCP_CONFIG: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
      }),
      mcpConfigPath: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
    }));
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

  it("restores persisted SDK agent spawn options during task session recovery", async () => {
    const context = makeContext();
    context.state.repos.value = [{
      id: "repo-1",
      path: "/tmp/repo",
      name: "repo",
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-06-18T00:00:00.000Z",
      last_opened_at: "2026-06-18T00:00:00.000Z",
    }];
    context.state.items.value = [{
      id: "task-1",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      pipeline: "default",
      stage: "in progress",
      stage_result: null,
      active_post_action: null,
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: "task-task-1",
      closed_at: null,
      agent_type: "agent",
      agent_provider: "claude",
      activity: "idle",
      activity_changed_at: "2026-06-18T00:00:00.000Z",
      unread_at: null,
      port_offset: null,
      port_env: JSON.stringify({ KANNA_DEV_PORT: "1421" }),
      agent_spawn_options: JSON.stringify({
        model: "claude-sonnet-test",
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Bash"],
        disallowedTools: ["WebFetch"],
        maxTurns: 7,
        maxBudgetUsd: 1.5,
      }),
      pinned: 0,
      pin_order: null,
      display_name: null,
      base_ref: null,
      agent_session_id: "claude-session-1",
      previous_stage: null,
      teardown_started_at: null,
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
    }];
    const sessions = createSessionsApi(context);

    await sessions.recoverTaskSession("task-1");

    expect(mocks.invokeMock).toHaveBeenCalledWith("spawn_agent_session", expect.objectContaining({
      sessionId: "task-1",
      model: "claude-sonnet-test",
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["WebFetch"],
      maxTurns: 7,
      maxBudgetUsd: 1.5,
    }));
  });
});

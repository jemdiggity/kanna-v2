import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import { createSessionsApi } from "./sessions";
import type { StoreContext } from "./state";

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn(async (command: string, args?: { name?: string }) => {
    switch (command) {
      case "read_env_var":
        return "/usr/bin:/bin";
      case "which_binary":
        return `/usr/bin/${args?.name ?? "binary"}`;
      case "get_app_data_dir":
        return "/tmp/kanna";
      case "get_pipeline_socket_path":
        return "/tmp/kanna.sock";
      case "read_text_file":
        return "{}";
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
    });
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
});

import { describe, expect, it, vi } from "vitest";
import { buildAgentCommand } from "./agentCommand";

describe("buildAgentCommand", () => {
  it.each([
    ["claude", "--effort 'xhigh'"],
    ["codex", "-c 'model_reasoning_effort=\"xhigh\"'"],
    ["copilot", "--effort='xhigh'"],
    ["opencode", "--variant 'xhigh'"],
    ["antigravity", "--effort 'xhigh'"],
  ] as const)("builds %s commands with its native effort control", async (provider, effortFlag) => {
    const command = await buildAgentCommand(provider, {
      taskId: "task-1",
      prompt: "Ship it",
      permissionFlags: [],
      runtimeSystemPrompt: "system",
      runtimeUserPrompt: "Ship it",
      effort: "xhigh",
      createSessionId: () => "session-1",
      persistAgentSessionId: async () => {},
    });

    expect(command.agentCmd).toContain(effortFlag);
  });

  it("builds Codex commands with Kanna MCP config overrides", async () => {
    const command = await buildAgentCommand("codex", {
      taskId: "task-1",
      prompt: "Ship it",
      permissionFlags: ["--yolo"],
      runtimeSystemPrompt: "system",
      runtimeUserPrompt: "Ship it\n\nThis session was launched by Kanna",
      mcpConfigPath: "/tmp/kanna-daemon/runtime/mcp/task-1.json",
      readTextFile: async () => JSON.stringify({
        mcpServers: {
          "kanna-mcp": {
            command: "/Applications/Kanna Staging.app/Contents/MacOS/kanna-mcp",
            args: ["serve"],
            env: {
              KANNA_SERVER_BASE_URL: "http://127.0.0.1:48121",
            },
          },
        },
      }),
    });

    expect(command.agentCmd).toBe(
      "codex --yolo -c 'mcp_servers.kanna-mcp.command=\"/Applications/Kanna Staging.app/Contents/MacOS/kanna-mcp\"' -c 'mcp_servers.kanna-mcp.args=[\"serve\"]' -c 'mcp_servers.kanna-mcp.env.KANNA_SERVER_BASE_URL=\"http://127.0.0.1:48121\"' 'Ship it'",
    );
    expect(command.agentCmdPreamble).toBe(
      "codex --yolo -c 'mcp_servers.kanna-mcp.command=\"/Applications/Kanna Staging.app/Contents/MacOS/kanna-mcp\"' -c 'mcp_servers.kanna-mcp.args=[\"serve\"]' -c 'mcp_servers.kanna-mcp.env.KANNA_SERVER_BASE_URL=\"http://127.0.0.1:48121\"' 'Ship it\n\nThis session was launched by Kanna'",
    );
  });

  it("builds Codex resume commands with byte-identical quote escaping", async () => {
    const command = await buildAgentCommand("codex", {
      taskId: "task-1",
      prompt: "don't stop",
      permissionFlags: ["--yolo"],
      resumeSessionId: "codex's-session",
      runtimeSystemPrompt: "system",
      runtimeUserPrompt: "don't stop\n\nThis session was launched by Kanna",
    });

    expect(command.agentCmd).toBe("codex resume --yolo 'codex'\\''s-session' 'don'\\''t stop'");
    expect(command.agentCmdPreamble).toBe(
      "codex resume --yolo 'codex'\\''s-session' 'don'\\''t stop\n\nThis session was launched by Kanna'",
    );
  });

  it("persists a fresh Copilot session id while building the command", async () => {
    const persistAgentSessionId = vi.fn(async () => {});

    const command = await buildAgentCommand("copilot", {
      taskId: "task-1",
      prompt: "Ship it",
      permissionFlags: ["--yolo"],
      runtimeSystemPrompt: "system",
      runtimeUserPrompt: "Ship it\n\nThis session was launched by Kanna",
      createSessionId: () => "copilot-session-1",
      persistAgentSessionId,
    });

    expect(command.agentCmd).toBe("copilot --yolo --session-id='copilot-session-1' -i 'Ship it'");
    expect(command.agentCmdPreamble).toBe(
      "copilot --yolo --session-id='copilot-session-1' -i 'Ship it\n\nThis session was launched by Kanna'",
    );
    expect(persistAgentSessionId).toHaveBeenCalledWith("copilot-session-1");
  });

  it("persists a fresh Claude session id while building the command", async () => {
    const persistAgentSessionId = vi.fn(async () => {});

    const command = await buildAgentCommand("claude", {
      taskId: "task-1",
      prompt: "Ship it",
      permissionFlags: ["--dangerously-skip-permissions"],
      runtimeSystemPrompt: "system prompt",
      runtimeUserPrompt: "Ship it\n\nThis session was launched by Kanna",
      createSessionId: () => "claude-session-1",
      persistAgentSessionId,
    });

    expect(command.agentCmd).toBe(
      "claude --dangerously-skip-permissions --append-system-prompt 'system prompt' --session-id claude-session-1 'Ship it'",
    );
    expect(command.agentCmdPreamble).toBeUndefined();
    expect(persistAgentSessionId).toHaveBeenCalledWith("claude-session-1");
  });
});

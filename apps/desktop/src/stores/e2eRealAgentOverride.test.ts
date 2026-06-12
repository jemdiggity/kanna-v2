import { beforeEach, describe, expect, it, vi } from "vitest";

const readEnvVarMock = vi.fn<(name: string) => Promise<string>>(async () => "");

vi.mock("../invoke", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "read_env_var") {
      return readEnvVarMock(String(args?.name ?? ""));
    }
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

describe("resolveRealE2eAgentOverride", () => {
  beforeEach(() => {
    vi.resetModules();
    readEnvVarMock.mockReset();
    readEnvVarMock.mockResolvedValue("");
  });

  it("returns a codex model override for PTY tasks when env vars are present", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("ignores invalid provider values", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "bogus";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toBeNull();
  });

  it("ignores empty model overrides", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: null,
    });
  });

  it("still applies overrides when an explicit provider is supplied", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: "copilot",
        explicitModel: undefined,
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still applies overrides when an explicit model is supplied", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "pty",
        explicitAgentProvider: undefined,
        explicitModel: "gpt-5.1",
      }),
    ).resolves.toEqual({
      agentProvider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("does not apply overrides to SDK tasks", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_E2E_REAL_AGENT_PROVIDER") return "codex";
      if (name === "KANNA_E2E_REAL_AGENT_MODEL") return "gpt-5.4-mini";
      return "";
    });

    const { resolveRealE2eAgentOverride } = await import("./e2eRealAgentOverride");

    await expect(
      resolveRealE2eAgentOverride({
        agentType: "agent",
        explicitAgentProvider: undefined,
        explicitModel: undefined,
      }),
    ).resolves.toBeNull();
  });
});

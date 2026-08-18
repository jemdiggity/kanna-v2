import { describe, expect, it } from "vitest";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
import {
  agentProviderOptionsForDesktop,
  desktopReportsNoAgentProvider,
  parseAgentProviderInventory,
  resolveAgentProviderForDesktop
} from "./agentProviders";

describe("agent provider inventory", () => {
  it("parses a reported inventory and drops names this build does not know", () => {
    expect(parseAgentProviderInventory(["opencode", "not-a-provider", "codex"]))
      .toEqual(["opencode", "codex"]);
  });

  it("separates an unreported inventory from a reported empty one", () => {
    expect(parseAgentProviderInventory(undefined)).toBeUndefined();
    expect(parseAgentProviderInventory(null)).toBeUndefined();
    expect(parseAgentProviderInventory("opencode")).toBeUndefined();
    expect(parseAgentProviderInventory([])).toEqual([]);
  });

  it("offers only what the machine reported, in registry order", () => {
    expect(
      agentProviderOptionsForDesktop({ agentProviders: ["opencode", "codex"] })
    ).toEqual(["codex", "opencode"]);
  });

  it("degrades to every supported provider when a machine reports nothing", () => {
    expect(agentProviderOptionsForDesktop(undefined)).toEqual([...AGENT_PROVIDERS]);
    expect(agentProviderOptionsForDesktop(null)).toEqual([...AGENT_PROVIDERS]);
    expect(agentProviderOptionsForDesktop({})).toEqual([...AGENT_PROVIDERS]);
    expect(desktopReportsNoAgentProvider({})).toBe(false);
    expect(desktopReportsNoAgentProvider({ agentProviders: [] })).toBe(true);
  });

  it("keeps a preferred provider the machine can run", () => {
    expect(
      resolveAgentProviderForDesktop("codex", { agentProviders: ["codex", "opencode"] })
    ).toBe("codex");
  });

  it("replaces a preferred provider the machine cannot run", () => {
    expect(
      resolveAgentProviderForDesktop("claude", { agentProviders: ["opencode"] })
    ).toBe("opencode");
  });

  it("resolves nothing for a machine that reported an empty inventory", () => {
    expect(resolveAgentProviderForDesktop("claude", { agentProviders: [] })).toBeNull();
  });

  it("defaults an unknown machine to the first supported provider", () => {
    expect(resolveAgentProviderForDesktop(null, undefined)).toBe(AGENT_PROVIDERS[0]);
  });
});

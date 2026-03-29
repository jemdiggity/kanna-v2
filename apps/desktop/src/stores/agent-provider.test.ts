import { describe, expect, it } from "bun:test";
import {
  getPreferredAgentProviders,
  normalizeAgentProviderCandidates,
  resolveAgentProvider,
  type AgentProviderAvailability,
} from "./agent-provider";

describe("normalizeAgentProviderCandidates", () => {
  it("returns empty array when providers are missing", () => {
    expect(normalizeAgentProviderCandidates(undefined)).toEqual([]);
  });

  it("wraps a single provider in an array", () => {
    expect(normalizeAgentProviderCandidates("codex")).toEqual(["codex"]);
  });

  it("keeps ordered provider arrays unchanged", () => {
    expect(normalizeAgentProviderCandidates(["codex", "copilot"])).toEqual(["codex", "copilot"]);
  });
});

describe("resolveAgentProvider", () => {
  const allAvailable: AgentProviderAvailability = {
    claude: true,
    copilot: true,
    codex: true,
  };

  it("single available provider resolves", () => {
    expect(resolveAgentProvider("codex", allAvailable)).toBe("codex");
  });

  it("ordered list returns first available", () => {
    expect(resolveAgentProvider(["codex", "copilot"], { claude: true, copilot: true, codex: false })).toBe("copilot");
  });

  it("missing providers throws No agent provider configured for this request.", () => {
    expect(() => resolveAgentProvider(undefined, allAvailable)).toThrow(
      "No agent provider configured for this request.",
    );
  });

  it("unavailable providers throws None of the configured agent providers are available: codex, copilot.", () => {
    expect(() =>
      resolveAgentProvider(["codex", "copilot"], { claude: true, copilot: false, codex: false }),
    ).toThrow("None of the configured agent providers are available: codex, copilot.");
  });
});

describe("getPreferredAgentProviders", () => {
  it("returns explicit providers when present", () => {
    expect(
      getPreferredAgentProviders({
        explicit: ["copilot", "codex"],
        stage: ["claude", "copilot"],
        item: "claude",
      }),
    ).toEqual(["copilot", "codex"]);
  });

  it("falls back to stage when explicit source is missing", () => {
    expect(getPreferredAgentProviders({ stage: "codex" })).toEqual(["codex"]);
  });

  it("returns empty when all sources are missing", () => {
    expect(getPreferredAgentProviders({})).toEqual([]);
  });

  it("does not fall through to lower-precedence sources when selected source is unavailable", () => {
    const selected = getPreferredAgentProviders({ stage: ["codex"], agent: ["copilot"], item: "claude" });
    expect(() =>
      resolveAgentProvider(selected, { claude: true, copilot: true, codex: false }),
    ).toThrow("None of the configured agent providers are available: codex.");
  });
});

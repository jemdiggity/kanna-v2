import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  getAgentProviderSpec,
  isAgentProvider,
  type AgentProvider,
} from "@kanna/agent-protocol";
import { describe, expect, it } from "vitest";
import {
  getPreferredAgentProviders,
  normalizeAgentProviderCandidates,
  requireResolvedAgentProvider,
  resolveAgentProvider,
  type AgentProviderAvailability,
} from "./agent-provider";

interface ProviderResolutionCase {
  name: string;
  explicit?: string[];
  stage?: string[];
  agent?: string[];
  fallback?: string[];
  available: string[];
  expected?: string;
  error?: string;
}

const resolutionCases = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "../..",
  "crates/kanna-agent-protocol/src/provider_resolution_cases.json",
), "utf8")) as ProviderResolutionCase[];

describe("generated provider registry", () => {
  it("exposes every provider with executable and session metadata", () => {
    expect(AGENT_PROVIDERS).toEqual([
      "claude", "copilot", "codex", "opencode", "antigravity",
    ]);
    expect(getAgentProviderSpec("antigravity").executable).toBe("agy");
    expect(getAgentProviderSpec("opencode").default_session_type).toBe("pty");
    expect(isAgentProvider("future-agent")).toBe(false);
  });

  it.each(resolutionCases)("matches shared resolution case: $name", (testCase) => {
    const known = (values?: string[]): AgentProvider[] | undefined => values?.filter(isAgentProvider);
    const selected = getPreferredAgentProviders({
      explicit: known(testCase.explicit),
      stage: known(testCase.stage),
      agent: known(testCase.agent),
      item: known(testCase.fallback),
    });
    const availability = Object.fromEntries(
      AGENT_PROVIDERS.map((provider) => [
        provider,
        testCase.available.includes(provider),
      ]),
    ) as AgentProviderAvailability;

    if (testCase.expected) {
      expect(resolveAgentProvider(selected, availability)).toBe(testCase.expected);
    } else {
      expect(() => resolveAgentProvider(selected, availability)).toThrow(testCase.error);
    }
  });
});

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
    opencode: true,
    antigravity: true,
  };

  it("single available provider resolves", () => {
    expect(resolveAgentProvider("codex", allAvailable)).toBe("codex");
    expect(resolveAgentProvider("opencode", allAvailable)).toBe("opencode");
    expect(resolveAgentProvider("antigravity", allAvailable)).toBe("antigravity");
  });

  it("ordered list returns first available", () => {
    expect(resolveAgentProvider(["opencode", "antigravity", "copilot"], {
      claude: true,
      copilot: true,
      codex: false,
      opencode: false,
      antigravity: true,
    })).toBe("antigravity");
  });

  it("missing providers throws No agent provider configured for this request.", () => {
    expect(() => resolveAgentProvider(undefined, allAvailable)).toThrow(
      "No agent provider configured for this request.",
    );
  });

  it("unavailable providers throws None of the configured agent providers are available: codex, copilot.", () => {
    expect(() =>
      resolveAgentProvider(["codex", "copilot"], {
        claude: true,
        copilot: false,
        codex: false,
        opencode: true,
        antigravity: true,
      }),
    ).toThrow("None of the configured agent providers are available: codex, copilot.");
  });

  it("single unavailable provider throws with that provider in the message", () => {
    expect(() =>
      resolveAgentProvider("codex", {
        claude: true,
        copilot: true,
        codex: false,
        opencode: true,
        antigravity: true,
      }),
    ).toThrow("None of the configured agent providers are available: codex.");
  });
});

describe("getPreferredAgentProviders", () => {
  it("returns explicit providers when present", () => {
    expect(
      getPreferredAgentProviders({
        explicit: ["opencode", "codex"],
        stage: ["claude", "copilot"],
        item: "claude",
      }),
    ).toEqual(["opencode", "codex"]);
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
      resolveAgentProvider(selected, {
        claude: true,
        copilot: true,
        codex: false,
        opencode: true,
        antigravity: true,
      }),
    ).toThrow("None of the configured agent providers are available: codex.");
  });
});

describe("requireResolvedAgentProvider", () => {
  it("returns provider when resolved", () => {
    expect(requireResolvedAgentProvider("codex")).toBe("codex");
  });

  it("throws when provider is missing", () => {
    expect(() => requireResolvedAgentProvider(undefined)).toThrow(
      "No agent provider resolved for PTY spawn.",
    );
  });
});

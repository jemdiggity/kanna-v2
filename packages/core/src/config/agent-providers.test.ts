import { describe, expect, it } from "vitest";
import { parseAgentProviderSelector } from "./agent-providers";

// Mirrors the Rust parser in crates/kanna-agent-protocol/src/providers.rs
// (`parse_provider_selector`) — keep the two in step.
describe("parseAgentProviderSelector", () => {
  it("parses a plain provider id with no model or effort", () => {
    expect(parseAgentProviderSelector("claude")).toEqual({
      provider: "claude",
    });
    expect(parseAgentProviderSelector("codex")).toEqual({ provider: "codex" });
  });

  it("splits provider, model, and a trailing effort token", () => {
    expect(parseAgentProviderSelector("claude-fable-hi")).toEqual({
      provider: "claude",
      model: "fable",
      effort: "high",
    });
    expect(parseAgentProviderSelector("codex-astra-lo")).toEqual({
      provider: "codex",
      model: "astra",
      effort: "low",
    });
  });

  it("keeps a trailing segment that is not an effort token in the model", () => {
    expect(parseAgentProviderSelector("codex-gpt-5-codex")).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
    });
  });

  it("accepts an effort-only selector", () => {
    expect(parseAgentProviderSelector("claude-hi")).toEqual({
      provider: "claude",
      effort: "high",
    });
    expect(parseAgentProviderSelector("codex-med")).toEqual({
      provider: "codex",
      effort: "medium",
    });
  });

  it("normalizes effort aliases to the canonical spelling", () => {
    expect(parseAgentProviderSelector("claude-xhi")?.effort).toBe("xhigh");
    expect(parseAgentProviderSelector("claude-max")?.effort).toBe("max");
  });

  it("returns null for unknown providers and malformed selectors", () => {
    expect(parseAgentProviderSelector("clod-fable")).toBeNull();
    expect(parseAgentProviderSelector("")).toBeNull();
    expect(parseAgentProviderSelector("claude-")).toBeNull();
    expect(parseAgentProviderSelector("claude--hi")).toBeNull();
    // A comma-separated list is a list, never one selector.
    expect(parseAgentProviderSelector("claude,codex")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { AgentProvider } from "../types/kanna";
import {
  getAgentPermissionFlags,
  normalizePermissionMode,
} from "./agent-permissions";

describe("normalizePermissionMode", () => {
  it("treats omitted and default permission modes as provider defaults", () => {
    expect(normalizePermissionMode()).toBeUndefined();
    expect(normalizePermissionMode("default")).toBeUndefined();
  });

  it("preserves explicit non-default permission modes", () => {
    expect(normalizePermissionMode("dontAsk")).toBe("dontAsk");
    expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
  });
});

describe("getAgentPermissionFlags", () => {
  it("maps Claude default-like permissions to the dangerous skip flag", () => {
    expect(getAgentPermissionFlags("claude")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("claude", "default")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("claude", "dontAsk")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("maps Claude acceptEdits to an explicit permission-mode flag", () => {
    expect(getAgentPermissionFlags("claude", "acceptEdits")).toEqual(["--permission-mode acceptEdits"]);
  });

  it("maps Copilot generic permissions to its yolo flag", () => {
    expect(getAgentPermissionFlags("copilot")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("copilot", "default")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("copilot", "dontAsk")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("copilot", "acceptEdits")).toEqual(["--yolo"]);
  });

  it("maps Codex generic permissions to provider-specific flags", () => {
    expect(getAgentPermissionFlags("codex")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("codex", "default")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("codex", "dontAsk")).toEqual(["--yolo"]);
    expect(getAgentPermissionFlags("codex", "acceptEdits")).toEqual(["--sandbox workspace-write"]);
  });

  it("maps OpenCode default-like permissions to its skip-permissions flag", () => {
    expect(getAgentPermissionFlags("opencode")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("opencode", "default")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("opencode", "dontAsk")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("opencode", "acceptEdits")).toEqual([]);
  });

  it("maps Antigravity default-like permissions to its skip-permissions flag", () => {
    expect(getAgentPermissionFlags("antigravity")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("antigravity", "default")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("antigravity", "dontAsk")).toEqual(["--dangerously-skip-permissions"]);
    expect(getAgentPermissionFlags("antigravity", "acceptEdits")).toEqual([]);
  });

  it("rejects an unhandled provider instead of applying another provider's flags", () => {
    expect(() => getAgentPermissionFlags("future-agent" as AgentProvider)).toThrow(
      "Unhandled agent provider: future-agent",
    );
  });
});

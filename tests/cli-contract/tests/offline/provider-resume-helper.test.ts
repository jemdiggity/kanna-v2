import { describe, expect, it } from "vitest";
import {
  extractCodexThreadId,
  extractOpenCodeSessionId,
  providerUnavailableReason,
  selectNewConversationId,
} from "../../helpers/provider-resume";

describe("provider resume helpers", () => {
  it("extracts the Codex thread ID from thread.started", () => {
    expect(extractCodexThreadId([
      { type: "thread.started", thread_id: "codex-thread" },
    ])).toBe("codex-thread");
  });

  it("extracts one stable OpenCode session ID", () => {
    expect(extractOpenCodeSessionId([
      { type: "step_start", sessionID: "ses_open" },
      { type: "text", sessionID: "ses_open" },
    ])).toBe("ses_open");
  });

  it("rejects conflicting OpenCode session IDs", () => {
    expect(() => extractOpenCodeSessionId([
      { type: "step_start", sessionID: "ses_one" },
      { type: "text", sessionID: "ses_two" },
    ])).toThrow(/multiple OpenCode session IDs/);
  });

  it("selects exactly one newly created Antigravity conversation", () => {
    expect(selectNewConversationId(
      new Set(["old-id"]),
      new Set(["old-id", "new-id"]),
    )).toBe("new-id");
  });

  it("rejects an ambiguous Antigravity conversation set", () => {
    expect(() => selectNewConversationId(
      new Set(["old-id"]),
      new Set(["old-id", "new-one", "new-two"]),
    )).toThrow(/expected one new Antigravity conversation/);
  });

  it("classifies only missing binaries and authentication failures", () => {
    expect(providerUnavailableReason("copilot binary not found")).toMatch(/binary/);
    expect(providerUnavailableReason("Please login to continue")).toMatch(/login/);
    expect(providerUnavailableReason("model timed out")).toBeNull();
  });
});

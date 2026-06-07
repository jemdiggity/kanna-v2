import { describe, it, expect } from "vitest";
import { runCopilot, runCopilotRaw } from "../helpers/copilot";

describe("copilot CLI flags", () => {
  it("-p produces output and exits", async () => {
    const result = await runCopilot({ prompt: "Say OK" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("exit code is 0 on success", async () => {
    const result = await runCopilot({ prompt: "Say OK" });
    expect(result.exitCode).toBe(0);
  });

  it("--yolo is accepted (skip all permissions)", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--allow-all is accepted (alias for --yolo)", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--allow-all",
      "--silent",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--model flag is accepted", async () => {
    // Just verify the flag is recognized — model availability may vary
    // Note: copilot uses Claude models (e.g. claude-haiku-4.5), not GPT
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--model=gpt-4o",
    ]);
    // Should not fail with "unknown flag" — model errors are expected
    expect(result.stderr).not.toContain("unknown flag");
    // Model flag is recognized even if model is unavailable
    if (result.exitCode !== 0) {
      expect(result.stderr).toContain("not available");
    }
  });

  it("--allow-tool flag is accepted", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--allow-tool=Bash",
    ]);
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--deny-tool flag is accepted", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--deny-tool=Bash",
    ]);
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--silent flag suppresses non-response output", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
    ]);
    expect(result.exitCode).toBe(0);
    // In silent mode, stdout should be just the agent response
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("--resume flag is recognized", async () => {
    // Pass a bogus session ID — should fail gracefully, not "unknown flag"
    const result = await runCopilotRaw([
      "--resume=nonexistent-session-id",
      "--silent",
    ], { timeoutMs: 10000 });
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--session-id flag is recognized", async () => {
    const result = await runCopilotRaw([
      "-p", "Say OK",
      "--yolo",
      "--silent",
      "--session-id=5fc2bd17-1d1b-4ae9-bed8-011fa4011100",
    ], { timeoutMs: 10000 });
    expect(result.stderr).not.toContain("unknown flag");
  });

  it("--continue flag is recognized", async () => {
    const result = await runCopilotRaw([
      "--continue",
      "-p", "Say OK",
      "--yolo",
      "--silent",
    ], { timeoutMs: 10000 });
    expect(result.stderr).not.toContain("unknown flag");
  });
});

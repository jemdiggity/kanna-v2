import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { runClaude, runClaudeRaw } from "../helpers/claude";

setDefaultTimeout(30_000);

describe("CLI flags", () => {
  it("stream-json produces valid NDJSON", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThan(0);
    // Every line should have a "type" field
    for (const line of result.lines) {
      expect(line).toHaveProperty("type");
    }
  });

  it("stream-json includes system, assistant, and result messages", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const types = result.lines.map((l) => l.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  it("--max-turns 1 limits to single turn", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg).toBeTruthy();
    expect(resultMsg.num_turns).toBe(1);
  });

  it("-p with no stdin produces output and exits", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("exit code is 0 on success", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    expect(result.exitCode).toBe(0);
  });

  it("--permission-mode dontAsk is accepted", async () => {
    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--permission-mode", "dontAsk"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("invalid");
  });

  it("--permission-mode acceptEdits is accepted", async () => {
    const result = await runClaude({
      prompt: "Say OK",
      flags: ["--permission-mode", "acceptEdits"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("invalid");
  });

  it("--permission-mode dont-ask is NOT accepted (camelCase required)", async () => {
    const result = await runClaudeRaw([
      "-p", "Say OK",
      "--output-format", "stream-json",
      "--model", "haiku",
      "--max-turns", "1",
      "--permission-mode", "dont-ask",
    ]);
    // Should fail or show error
    expect(result.exitCode).not.toBe(0);
  });
});

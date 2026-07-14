import { describe, it, expect } from "vitest";
import {
  runClaude,
  runClaudeStreamInput,
  isClaudeUnavailable,
} from "../../helpers/claude";

// Pins the Claude CLI behavior that the Rust ClaudeAdapter in
// crates/kanna-agent-protocol depends on, beyond the long-standing
// stream-json output contract covered by flags.test.ts.
describe("claude agent-protocol contract", () => {
  it("stream-json input: prompt arrives via enveloped stdin user message", async () => {
    const result = await runClaudeStreamInput({
      stdinLines: [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Reply with exactly: ok" },
        }),
      ],
      flags: ["--permission-mode", "dontAsk"],
    });
    if (isClaudeUnavailable(result)) return;

    expect(result.exitCode).toBe(0);
    expect(
      result.lines.some((l) => l.type === "assistant"),
      "stdin user message must start a turn"
    ).toBe(true);
    expect(result.lines.some((l) => l.type === "result")).toBe(true);
  }, 120000);

  it("stream-json input: top-level content shape is silently ignored", async () => {
    // This pins the trap: the legacy {"type":"user","content":...} shape
    // produces NO turn. If this test ever fails, the CLI started accepting
    // it and the adapter/SDK can be simplified.
    const result = await runClaudeStreamInput({
      stdinLines: [
        JSON.stringify({ type: "user", content: "Reply with exactly: ok" }),
      ],
      flags: ["--permission-mode", "dontAsk"],
    });
    if (isClaudeUnavailable(result)) return;

    expect(result.lines.some((l) => l.type === "assistant")).toBe(false);
    expect(result.lines.some((l) => l.type === "result")).toBe(false);
  }, 120000);

  it("--permission-prompt-tool stdio is accepted", async () => {
    const result = await runClaude({
      prompt: "Reply with exactly: ok",
      flags: ["--permission-prompt-tool", "stdio", "--permission-mode", "dontAsk"],
    });
    if (isClaudeUnavailable(result)) return;

    expect(result.exitCode).toBe(0);
    expect(result.lines.some((l) => l.type === "result")).toBe(true);
  }, 120000);
});

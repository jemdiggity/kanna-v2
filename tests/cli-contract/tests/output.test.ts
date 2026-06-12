import { describe, it, expect } from "vitest";
import { isClaudeUnavailable, runClaude } from "../helpers/claude";

describe("output format", () => {
  it("result message has session_id", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    if (isClaudeUnavailable(result)) return;
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg).toBeTruthy();
    expect(resultMsg.session_id).toBeTruthy();
    expect(typeof resultMsg.session_id).toBe("string");
  });

  it("result message has num_turns and duration_ms", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    if (isClaudeUnavailable(result)) return;
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg.num_turns).toBeGreaterThanOrEqual(1);
    expect(resultMsg.duration_ms).toBeGreaterThan(0);
  });

  it("result subtype is success with --max-turns 1 when the prompt completes in one turn", async () => {
    // Current Claude CLI behavior: max_turns still limits the run, but a
    // prompt that completes within that turn reports success.
    const result = await runClaude({ prompt: "Say OK" });
    if (isClaudeUnavailable(result)) return;
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg.subtype).toBe("success");
  });

  it("system init message has session_id and cwd", async () => {
    const result = await runClaude({ prompt: "Say OK", cwd: "/tmp" });
    if (isClaudeUnavailable(result)) return;
    const initMsg = result.lines.find(
      (l) => l.type === "system" && (l as any).subtype === "init"
    ) as any;
    expect(initMsg).toBeTruthy();
    expect(initMsg.session_id).toBeTruthy();
    expect(initMsg.cwd).toBeTruthy();
  });

  it("system messages appear before assistant messages", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    if (isClaudeUnavailable(result)) return;
    const firstSystem = result.lines.findIndex((l) => l.type === "system");
    const firstAssistant = result.lines.findIndex((l) => l.type === "assistant");
    expect(firstSystem).toBeGreaterThanOrEqual(0);
    expect(firstAssistant).toBeGreaterThan(firstSystem);
  });

  it("assistant message has content array", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    if (isClaudeUnavailable(result)) return;
    const assistantMsg = result.lines.find((l) => l.type === "assistant") as any;
    expect(assistantMsg).toBeTruthy();
    // Assistant messages have a nested message.content or top-level content
    const content = assistantMsg.message?.content || assistantMsg.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
  });
});

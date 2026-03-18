import { describe, it, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
import { runClaude } from "../helpers/claude";

describe("output format", () => {
  it("result message has session_id", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg).toBeTruthy();
    expect(resultMsg.session_id).toBeTruthy();
    expect(typeof resultMsg.session_id).toBe("string");
  });

  it("result message has num_turns and duration_ms", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg.num_turns).toBeGreaterThanOrEqual(1);
    expect(resultMsg.duration_ms).toBeGreaterThan(0);
  });

  it("result subtype is error_max_turns with --max-turns 1", async () => {
    // Contract: Claude treats hitting max_turns as an error, not success
    const result = await runClaude({ prompt: "Say OK" });
    const resultMsg = result.lines.find((l) => l.type === "result") as any;
    expect(resultMsg.subtype).toBe("error_max_turns");
  });

  it("system init message has session_id and cwd", async () => {
    const result = await runClaude({ prompt: "Say OK", cwd: "/tmp" });
    const initMsg = result.lines.find(
      (l) => l.type === "system" && (l as any).subtype === "init"
    ) as any;
    expect(initMsg).toBeTruthy();
    expect(initMsg.session_id).toBeTruthy();
    expect(initMsg.cwd).toBeTruthy();
  });

  it("system messages appear before assistant messages", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const firstSystem = result.lines.findIndex((l) => l.type === "system");
    const firstAssistant = result.lines.findIndex((l) => l.type === "assistant");
    expect(firstSystem).toBeGreaterThanOrEqual(0);
    expect(firstAssistant).toBeGreaterThan(firstSystem);
  });

  it("assistant message has content array", async () => {
    const result = await runClaude({ prompt: "Say OK" });
    const assistantMsg = result.lines.find((l) => l.type === "assistant") as any;
    expect(assistantMsg).toBeTruthy();
    // Assistant messages have a nested message.content or top-level content
    const content = assistantMsg.message?.content || assistantMsg.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
  });
});

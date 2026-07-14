import { describe, expect, it } from "vitest";
import { runOpenCodeJson } from "../../helpers/opencode";

// Pins the `opencode run --format json` JSONL event contract that the Rust
// OpencodeAdapter in crates/kanna-agent-protocol depends on. Opencode 1.16.2
// emits top-level event names such as step_start, reasoning, text, tool_use,
// step_finish, and error with a sessionID plus a nested part payload.
describe("opencode run --format json contract", () => {
  it("emits parseable JSONL events with a session id", async () => {
    const result = await runOpenCodeJson({
      prompt: "Reply with exactly: done. Do not run any commands.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThan(0);

    const first = result.lines[0];
    expect(typeof first.type).toBe("string");
    expect(typeof first.sessionID).toBe("string");
    expect((first.sessionID as string).length).toBeGreaterThan(0);
    expect(typeof first.timestamp).toBe("number");

    const stepStart = result.lines.find((line) => line.type === "step_start");
    expect(stepStart, "step_start must announce the run").toBeDefined();
    const part = stepStart?.part as Record<string, unknown> | undefined;
    expect(part?.type).toBe("step-start");
    expect(typeof part?.id).toBe("string");
    expect(typeof part?.messageID).toBe("string");
  }, 180000);
});

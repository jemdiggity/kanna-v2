import { describe, it, expect } from "vitest";
import { runCodexExec } from "../../helpers/codex";

// Pins the `codex exec --json` JSONL event contract that the Rust
// CodexAdapter in crates/kanna-agent-protocol depends on. If these break,
// update the adapter (and its fixtures) together with this file.
describe("codex exec --json contract", () => {
  it("emits thread.started, turn lifecycle, agent_message items, and usage", async () => {
    const result = await runCodexExec({
      prompt: "Reply with exactly: done. Do not run any commands.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThan(0);

    const threadStarted = result.lines.find((l) => l.type === "thread.started");
    expect(threadStarted, "thread.started must announce the session").toBeDefined();
    expect(typeof threadStarted?.thread_id).toBe("string");
    expect((threadStarted?.thread_id as string).length).toBeGreaterThan(0);

    expect(
      result.lines.some((l) => l.type === "turn.started"),
      "turn.started must be emitted"
    ).toBe(true);

    const agentMessages = result.lines.filter((l) => {
      const item = l.item as Record<string, unknown> | undefined;
      return l.type === "item.completed" && item?.type === "agent_message";
    });
    expect(agentMessages.length, "assistant text arrives as agent_message items").toBeGreaterThan(0);
    const lastMessage = agentMessages[agentMessages.length - 1].item as Record<string, unknown>;
    expect(typeof lastMessage.text).toBe("string");

    const turnCompleted = result.lines.find((l) => l.type === "turn.completed");
    expect(turnCompleted, "turn.completed must close the turn").toBeDefined();
    const usage = turnCompleted?.usage as Record<string, unknown> | undefined;
    expect(typeof usage?.input_tokens).toBe("number");
    expect(typeof usage?.output_tokens).toBe("number");
  }, 180000);

  it("command_execution items carry command, aggregated_output, and exit_code", async () => {
    const result = await runCodexExec({
      prompt:
        "Run the shell command `echo codex-contract` and then reply with exactly: done",
      flags: [],
    });

    expect(result.exitCode).toBe(0);

    const completedCommands = result.lines.filter((l) => {
      const item = l.item as Record<string, unknown> | undefined;
      return l.type === "item.completed" && item?.type === "command_execution";
    });
    expect(
      completedCommands.length,
      "command runs arrive as command_execution items"
    ).toBeGreaterThan(0);

    const echoRun = completedCommands
      .map((l) => l.item as Record<string, unknown>)
      .find((item) => String(item.command).includes("echo codex-contract"));
    expect(echoRun, "the requested command must appear").toBeDefined();
    expect(String(echoRun?.aggregated_output)).toContain("codex-contract");
    expect(echoRun?.exit_code).toBe(0);
    expect(typeof echoRun?.id).toBe("string");
  }, 180000);
});

import { describe, it, expect } from "vitest";
import { findCodexBinary, runCodexExec, codexUnavailableReason } from "../../helpers/codex";
import { codexBinaryOrNull } from "../../helpers/availability";
import { BackgroundProcess, makeRealTempDir, removeDir, sleep } from "../../helpers/background";

// Pins the `codex exec --json` JSONL event contract that the Rust
// CodexAdapter in crates/kanna-agent-protocol depends on. If these break,
// update the adapter (and its fixtures) together with this file.
describe("codex exec --json contract", () => {
  it("emits thread.started, turn lifecycle, agent_message items, and usage", async (ctx) => {
    if (!(await codexBinaryOrNull())) {
      ctx.skip("codex CLI is not installed");
      return;
    }
    const result = await runCodexExec({
      prompt: "Reply with exactly: done. Do not run any commands.",
    });
    const unavailable = codexUnavailableReason(result);
    if (unavailable) {
      ctx.skip(unavailable);
      return;
    }

    expect(result.exitCode, `codex failed: ${result.stdout}\n${result.stderr}`).toBe(0);
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

  it("command_execution items carry command, aggregated_output, and exit_code", async (ctx) => {
    if (!(await codexBinaryOrNull())) {
      ctx.skip("codex CLI is not installed");
      return;
    }
    const result = await runCodexExec({
      prompt:
        "Run the shell command `echo codex-contract` and then reply with exactly: done",
      flags: [],
    });
    const unavailable = codexUnavailableReason(result);
    if (unavailable) {
      ctx.skip(unavailable);
      return;
    }

    expect(result.exitCode, `codex failed: ${result.stdout}\n${result.stderr}`).toBe(0);

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

  // WHAT BREAKS IN KANNA IF THIS PIN FAILS: every SDK-mode codex session.
  //
  // The daemon spawns agents with all three stdio as pipes and then drops the
  // child's stdin for per-turn providers (agent.rs, `initial_stdin: None` =>
  // `stdin = None`). That drop is the whole reason codex starts at all: with an
  // open stdin pipe codex waits for EOF before its first API call, so a daemon
  // that kept the handle would hang every codex session at zero output.
  //
  // Codex announces the read on stderr either way, which is why a stderr-only
  // failure message reads as an invocation error when it is nothing of the kind.
  it("waits for stdin EOF before starting, and says so on stderr", async (ctx) => {
    if (!(await codexBinaryOrNull())) {
      ctx.skip("codex CLI is not installed");
      return;
    }
    const binary = await findCodexBinary();
    const cwd = await makeRealTempDir("kanna-codex-stdin-");
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "Reply with exactly: done. Do not run any commands.",
    ];

    // Held open, never written to, never closed — what the daemon would do if
    // it kept the ChildStdin handle around.
    const held = new BackgroundProcess(binary, args, { cwd, stdin: "pipe" });
    // The same invocation the daemon actually makes: stdin at EOF, so codex
    // gets past the read and announces its thread. Killed as soon as it does,
    // so this pin costs an aborted turn rather than a whole one.
    let closed: BackgroundProcess | null = null;
    try {
      await sleep(10_000);
      expect(
        held.stderr,
        `codex no longer announces the stdin read. The daemon's stdin-drop is ` +
        `justified by this message; confirm the wait itself before relying on it.`,
      ).toContain("Reading additional input from stdin");
      expect(
        held.jsonLines().some((line) => line.type === "thread.started"),
        `codex started a thread with stdin still open. If it no longer waits for ` +
        `EOF, the daemon's stdin-drop for per-turn providers is no longer what ` +
        `keeps codex sessions alive. stdout:\n${held.stdout.slice(0, 400)}`,
      ).toBe(false);

      closed = new BackgroundProcess(binary, args, { cwd });
      const deadline = Date.now() + 30_000;
      let started = false;
      while (Date.now() < deadline && !started) {
        started = closed.jsonLines().some((line) => line.type === "thread.started");
        if (!started) await sleep(250);
      }
      expect(
        started,
        `codex never announced a thread with stdin at EOF. stderr:\n${closed.stderr.slice(0, 400)}`,
      ).toBe(true);
    } finally {
      held.kill();
      closed?.kill();
      await removeDir(cwd);
    }
  }, 120_000);
});

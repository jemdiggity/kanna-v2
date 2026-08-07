import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCopilotBinary } from "../../helpers/copilot";
import { copilotBinaryOrNull, ptyBridgeAvailable } from "../../helpers/availability";
import { makeRealTempDir, removeDir } from "../../helpers/background";
import { SUBMIT_ENTER_DELAY_MS, sleep, startPtySession, type PtySession } from "../../helpers/pty";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: transfer finalization sequencing for
// Copilot tasks (Decision 3 step 3 — inject the provider quit command).
//
// Finalization ends the source agent by typing the provider's quit command into
// its TUI, read off the provider registry
// (`AgentProvider::quit_command`, crates/kanna-agent-protocol/src/providers.rs).
// Copilot's is `/exit`, and like Codex its composer opens a command popup on
// `/`, so the open question was whether a burst-written slash command — which
// is how kanna-server submits input: the whole message in one write, 150 ms,
// then a lone CR — survives that popup. It does.
//
// If this pin ever fails, injecting `/exit` sends Copilot a chat message
// instead of quitting: finalization waits out its whole quit budget for an Exit
// that never comes, then degrades the transfer and leaves the source agent for
// the destructive teardown at the end of the ladder.
//
// Companion pins: codex-tui-quit.test.ts (`/quit`), opencode-injected-input.test.ts
// (`/exit`, plus mid-turn preemption). What stays unpinned for Claude is
// recorded in docs/2026-08-06-agent-tui-injection-e2e-gap.md.

// Written without whitespace: the TUI positions words with cursor escapes, so
// on-screen text strips down to "Doyoutrustthefiles…" (see
// PtySession.compactOutput).
const TRUST_PROMPT = /trust.{0,20}(files|contents|folder)/i;
const COMPOSER = /commands·\?help|\/commands/i;
const QUIT_POPUP = /\/exit/;

async function startCopilotTui(): Promise<{ session: PtySession; cwd: string }> {
  const binary = await findCopilotBinary();
  const cwd = await makeRealTempDir("kanna-copilot-tui-");
  const session = startPtySession(binary, [], { cwd });
  return { session, cwd };
}

/**
 * Copilot asks whether the folder is trusted *before* the composer exists, and
 * anything written while that modal is up is consumed by it — the same trap
 * that made an early Codex probe conclude, wrongly, that burst-written slash
 * commands are dropped.
 */
async function reachComposer(
  session: PtySession,
  ctx: { skip: (reason?: string) => void },
): Promise<boolean> {
  if (await session.waitForOutput(TRUST_PROMPT, 60_000)) {
    // "Yes, allow" is preselected; Enter accepts it.
    session.write("\r");
  }
  if (!(await session.waitForOutput(COMPOSER, 60_000))) {
    ctx.skip(`copilot TUI never reached its composer. TUI tail:\n${session.output.slice(-600)}`);
    return false;
  }
  return true;
}

async function requireEnvironment(ctx: { skip: (reason?: string) => void }): Promise<boolean> {
  if (!(await copilotBinaryOrNull())) {
    ctx.skip("copilot CLI is not installed");
    return false;
  }
  if (!(await ptyBridgeAvailable())) {
    ctx.skip("/usr/bin/python3 is unavailable, so no PTY can be allocated");
    return false;
  }
  try {
    await access(join(homedir(), ".copilot"), constants.R_OK);
  } catch {
    ctx.skip("copilot CLI is not authenticated");
    return false;
  }
  return true;
}

describe("copilot TUI quit command", () => {
  it("executes /exit submitted the way kanna-server submits task input", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const { session, cwd } = await startCopilotTui();
    try {
      if (!(await reachComposer(session, ctx))) return;

      // The message half of try_submit_task_input: one write, no per-character
      // pacing. Copilot's `/` popup has to cope with the whole string at once.
      session.write("/exit");
      expect(
        await session.waitForOutput(QUIT_POPUP, 10_000),
        `copilot did not show /exit after a burst write, so the composer now needs paced `
        + `keystrokes and the ordinary input helper would deliver the quit command to the `
        + `model as chat text. TUI tail:\n${session.output.slice(-800)}`,
      ).toBe(true);

      // …and the CR half, sent as a discrete keystroke after the same delay.
      await sleep(SUBMIT_ENTER_DELAY_MS);
      session.write("\r");
      expect(
        await session.waitForExit(30_000),
        `copilot did not exit on /exit. Finalization would wait for an Exit that never `
        + `arrives and fall through to destructive teardown. TUI tail:\n`
        + session.output.slice(-800),
      ).toBe(0);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 240_000);
});

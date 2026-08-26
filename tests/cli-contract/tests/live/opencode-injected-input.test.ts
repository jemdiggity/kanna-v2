import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOpenCodeBinary } from "../../helpers/opencode";
import { openCodeBinaryOrNull, ptyBridgeAvailable } from "../../helpers/availability";
import { makeRealTempDir, removeDir } from "../../helpers/background";
import { startPtySession, type PtySession } from "../../helpers/pty";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: transfer finalization sequencing,
// task send-input, and stage posts.
//
// Decision 3 of the transfer plan replaces finalization's SIGINT with injected
// input: write a wrap-up message, wait for Idle, then inject the provider's quit
// command. Two provider-owned behaviors have to hold for that to work — that a
// message written to the PTY master and submitted with a discrete CR is accepted
// exactly like typing, and that the quit command preempts an agent that is
// mid-turn (which is *why* the design waits for Idle first: quitting early
// truncates the wrap-up the transfer is trying to capture).
//
// These need a real TUI, so they are pinned against OpenCode's free model — the
// repo's standing choice for interactive live-agent tests. Codex's quit command
// is pinned separately in codex-tui-quit.test.ts; what stays unpinned for Claude
// is recorded in docs/2026-08-06-agent-tui-injection-e2e-gap.md.

// Whitespace-free: the TUI draws with cursor escapes (see PtySession.compactOutput).
const READY = /Askanything|Build·/;

async function startOpenCode(cwd: string): Promise<PtySession> {
  const binary = await findOpenCodeBinary();
  return startPtySession(binary, [], { cwd });
}

async function requireEnvironment(ctx: { skip: (reason?: string) => void }): Promise<boolean> {
  if (!(await openCodeBinaryOrNull())) {
    ctx.skip("opencode CLI is not installed");
    return false;
  }
  if (!(await ptyBridgeAvailable())) {
    ctx.skip("/usr/bin/python3 is unavailable, so no PTY can be allocated");
    return false;
  }
  return true;
}

describe("injected input against a live agent TUI (opencode)", () => {
  it("accepts a message written to the PTY and submitted with a discrete CR", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const cwd = await makeRealTempDir("kanna-opencode-input-");
    const session = await startOpenCode(cwd);
    try {
      if (!(await session.waitForOutput(READY, 60_000))) {
        ctx.skip("opencode TUI never reached its composer");
        return;
      }

      // kanna-server's exact submission policy: text, 150 ms, then CR.
      await session.submit(
        "Create a file named parity.txt in the current directory containing exactly: PARITY_OK. Then stop.",
      );

      const parityFile = join(cwd, "parity.txt");
      const wrote = await session.waitUntil(() => existsSync(parityFile), 180_000, 500);
      expect(
        wrote,
        `the agent never acted on the injected prompt. Injected bytes are supposed to be ` +
        `indistinguishable from typing; if that stopped holding, every Kanna input path ` +
        `(send-input, stage posts, transfer finalization) is broken. TUI tail:\n` +
        session.output.slice(-1000),
      ).toBe(true);
      expect(readFileSync(parityFile, "utf8")).toContain("PARITY_OK");

      // Slash commands go through the same path and are executed as commands,
      // not delivered to the model as chat text.
      await session.submit("/exit");
      expect(
        await session.waitForExit(30_000),
        `the injected quit command did not end the session. TUI tail:\n${session.output.slice(-1000)}`,
      ).toBe(0);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 300_000);

  it("quits immediately when the agent is mid-turn", async (ctx) => {
    if (!(await requireEnvironment(ctx))) return;

    const cwd = await makeRealTempDir("kanna-opencode-quit-");
    const session = await startOpenCode(cwd);
    try {
      if (!(await session.waitForOutput(READY, 60_000))) {
        ctx.skip("opencode TUI never reached its composer");
        return;
      }

      // Step 1 proves the turn started; step 3 proves whether it finished.
      await session.submit(
        "Do these steps in order without asking questions. " +
        "Step 1: create a file named started.txt containing STARTED. " +
        "Step 2: in your reply, print every integer from 1 to 900, one per line. " +
        "Step 3: create a file named finished.txt containing DONE.",
      );

      const startedFile = join(cwd, "started.txt");
      const finishedFile = join(cwd, "finished.txt");
      const busy = await session.waitUntil(
        () => existsSync(startedFile) || session.exited,
        180_000,
        250,
      );
      if (!busy || session.exited) {
        ctx.skip(`opencode never started the turn. TUI tail:\n${session.output.slice(-600)}`);
        return;
      }
      if (existsSync(finishedFile)) {
        // The agent got all the way through before we could inject anything —
        // inconclusive about preemption, not evidence against it.
        ctx.skip("the turn completed before the quit command could be injected");
        return;
      }

      const quitAt = Date.now();
      await session.submit("/exit");
      const exitCode = await session.waitForExit(30_000);

      expect(
        exitCode,
        `the quit command did not preempt a busy agent. If quitting now waits for the turn to ` +
        `finish, transfer finalization no longer has to wait for Idle before quitting — but the ` +
        `exit timeout has to grow to cover a full turn. TUI tail:\n${session.output.slice(-1000)}`,
      ).toBe(0);
      expect(Date.now() - quitAt).toBeLessThan(30_000);
      expect(
        existsSync(finishedFile),
        "the interrupted turn must not have completed its remaining steps",
      ).toBe(false);
    } finally {
      session.kill();
      await removeDir(cwd);
    }
  }, 300_000);
});

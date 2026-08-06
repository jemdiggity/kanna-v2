import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isClaudeUnavailable } from "../../helpers/claude-availability";
import { findClaudeBinary } from "../../helpers/claude";
import { claudeBinaryOrNull } from "../../helpers/availability";
import { BackgroundProcess, makeRealTempDir, removeDir, sleep } from "../../helpers/background";
import { claudeTranscriptPath } from "../../../../packages/core/src/claude-transcript";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: transfer finalization sequencing.
//
// The finalization design (docs/2026-08-06-task-transfer-rearchitecture-plan.md,
// Decision 3) sequences notify → idle → quit → exit → stage, and its degradation
// ladder falls back to snapshotting the transcript *as-is* when the agent will
// not quit cleanly. That fallback only ships a conversation if Claude appends to
// the transcript continuously. If Claude ever starts buffering and flushing at
// exit, every degraded finalization would ship an empty or stale file — silently,
// exactly like the 2026-08-06 incident — so the ladder would have to be replaced
// by "graceful exit or fail loudly" rather than left in place.

describe("claude transcript is appended while the session runs", () => {
  it("has the user turn on disk before the process exits", async (ctx) => {
    if (!(await claudeBinaryOrNull())) {
      ctx.skip("claude CLI is not installed");
      return;
    }

    const cwd = await makeRealTempDir("kanna-claude-append-");
    const sessionId = randomUUID();
    const marker = `append-pin-${sessionId.slice(0, 8)}`;
    const transcript = claudeTranscriptPath({ homeDir: homedir(), cwd, sessionId });
    const binary = await findClaudeBinary();

    const child = new BackgroundProcess(
      binary,
      [
        "-p",
        // Long enough that the transcript's first flush lands well before exit —
        // the file showed up ~4 s into an ~8 s run when this was written.
        `Marker ${marker}. Print the numbers from 1 to 500, one per line, nothing else.`,
        "--output-format", "stream-json",
        "--verbose",
        "--model", "haiku",
        "--max-turns", "1",
        "--session-id", sessionId,
      ],
      { cwd },
    );

    let sizeWhileRunning = 0;
    let contentWhileRunning = "";
    try {
      while (child.running) {
        const stats = await stat(transcript).catch(() => null);
        if (stats && stats.size > 0) {
          sizeWhileRunning = stats.size;
          contentWhileRunning = await readFile(transcript, "utf8").catch(() => "");
          if (contentWhileRunning.includes(marker)) break;
        }
        await sleep(200);
      }

      const exitCode = await child.waitForExit(120_000);
      const elapsed = Date.now() - child.startedAt;

      if (isClaudeUnavailable({
        stdout: child.stdout,
        stderr: child.stderr,
        exitCode: exitCode ?? -1,
        lines: child.jsonLines(),
        duration: elapsed,
      })) {
        ctx.skip("claude CLI is not authenticated");
        return;
      }
      expect(exitCode, `claude failed: ${child.stderr}`).toBe(0);

      if (sizeWhileRunning === 0 && elapsed < 3_000) {
        // The turn finished before the first poll — nothing was observable
        // mid-flight, which is not evidence either way.
        ctx.skip(`turn completed in ${elapsed}ms, too fast to sample mid-session`);
        return;
      }

      expect(
        sizeWhileRunning,
        `the transcript at ${transcript} was empty or absent for the whole ${elapsed}ms run. ` +
        `Claude appears to flush at exit now; transfer finalization can no longer fall back ` +
        `to snapshotting a live session's transcript (see Decision 3's degradation ladder).`,
      ).toBeGreaterThan(0);
      expect(
        contentWhileRunning,
        "the user turn must be durable before the process exits",
      ).toContain(marker);

      // Exit only ever adds to it.
      const finalStats = await stat(transcript);
      expect(finalStats.size).toBeGreaterThanOrEqual(sizeWhileRunning);
    } finally {
      child.kill();
      await removeDir(dirname(transcript));
      await removeDir(cwd);
    }
  }, 180_000);
});

import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isClaudeUnavailable, runClaude, runClaudeRaw } from "../../helpers/claude";
import { claudeBinaryOrNull } from "../../helpers/availability";
import { makeRealTempDir, removeDir } from "../../helpers/background";
import { claudeTranscriptPath } from "../../../../packages/core/src/claude-transcript";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: cross-machine task transfer resume.
//
// A transfer moves a transcript between machines whose worktree paths differ, so
// the receiver drops the file into a project directory keyed by *its own* cwd and
// then spawns `claude --resume <session-id>` there. This test is that move, done
// locally: copy a transcript into a different cwd's project directory and resume
// it. If Claude ever starts validating the recorded cwd against the current one,
// re-keying stops working and the transfer has to carry the source worktree path
// (or refuse to transfer at all) instead.
//
// The second case pins the failure mode transfer error handling depends on: a
// resume id with no transcript must fail loudly. If it ever degrades to a silent
// fresh session, a receiver that imported nothing would look like a successful
// transfer with an empty conversation — which is precisely how the 2026-08-06
// data loss stayed invisible.

describe("claude --resume across a re-keyed working directory", () => {
  it("resumes a transcript copied into another cwd's project directory", async (ctx) => {
    if (!(await claudeBinaryOrNull())) {
      ctx.skip("claude CLI is not installed");
      return;
    }

    const sourceCwd = await makeRealTempDir("kanna-claude-resume-src-");
    const destCwd = await makeRealTempDir("kanna-claude-resume-dst-");
    const sessionId = randomUUID();
    const magicWord = `zarquon${sessionId.slice(0, 6)}`;
    const sourceTranscript = claudeTranscriptPath({ homeDir: homedir(), cwd: sourceCwd, sessionId });
    const destTranscript = claudeTranscriptPath({ homeDir: homedir(), cwd: destCwd, sessionId });

    try {
      const first = await runClaude({
        prompt: `Remember this magic word: ${magicWord}. Reply with exactly: ok`,
        flags: ["--session-id", sessionId],
        cwd: sourceCwd,
      });
      if (isClaudeUnavailable(first)) {
        ctx.skip("claude CLI is not authenticated");
        return;
      }
      expect(first.exitCode, `claude failed: ${first.stderr}`).toBe(0);
      await stat(sourceTranscript);

      // Exactly what the receiver does: same filename, receiver-derived directory.
      await mkdir(dirname(destTranscript), { recursive: true });
      await copyFile(sourceTranscript, destTranscript);

      const resumed = await runClaude({
        prompt: "What was the magic word I told you? Reply with just the word.",
        flags: ["--resume", sessionId],
        cwd: destCwd,
      });
      if (isClaudeUnavailable(resumed)) {
        ctx.skip("claude CLI is not authenticated");
        return;
      }
      expect(resumed.exitCode, `resume failed: ${resumed.stderr}`).toBe(0);

      const resultLine = resumed.lines.find((line) => line.type === "result");
      expect(resultLine, "claude must emit a result line").toBeDefined();
      expect(
        String(resultLine?.result ?? ""),
        "the resumed session must see the conversation from the other working directory",
      ).toContain(magicWord);

      // The resumed turn keeps the session id and appends in place, so the
      // receiver's file is the live transcript rather than a discarded copy.
      const destContent = await readFile(destTranscript, "utf8");
      expect(destContent).toContain(magicWord);
      expect(destContent).toContain(destCwd);
    } finally {
      await rm(dirname(sourceTranscript), { recursive: true, force: true }).catch(() => undefined);
      await rm(dirname(destTranscript), { recursive: true, force: true }).catch(() => undefined);
      await removeDir(sourceCwd);
      await removeDir(destCwd);
    }
  }, 180_000);

  it("fails loudly when --resume names a session with no transcript", async (ctx) => {
    if (!(await claudeBinaryOrNull())) {
      ctx.skip("claude CLI is not installed");
      return;
    }

    const cwd = await makeRealTempDir("kanna-claude-resume-missing-");
    const unknownSessionId = randomUUID();
    try {
      const result = await runClaudeRaw(
        [
          "-p", "Reply with exactly: ok",
          "--model", "haiku",
          "--max-turns", "1",
          "--resume", unknownSessionId,
        ],
        { cwd, timeoutMs: 60_000 },
      );

      expect(
        result.exitCode,
        `--resume with no transcript exited 0. Silent fallback to a fresh session ` +
        `would make a failed transfer import look like a successful one; the transfer ` +
        `receiver must be able to rely on this failing.`,
      ).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain(
        `No conversation found with session ID: ${unknownSessionId}`,
      );
    } finally {
      await removeDir(cwd);
    }
  }, 90_000);
});

import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isClaudeUnavailable, runClaude } from "../../helpers/claude";
import { claudeBinaryOrNull } from "../../helpers/availability";
import { makeRealTempDir, removeDir } from "../../helpers/background";
import { claudeProjectSlug, claudeTranscriptPath } from "../../../../packages/core/src/claude-transcript";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: cross-machine task transfer resume.
//
// Transfer ships the source session's conversation so the destination can
// `--resume` it. The transcript is keyed by the session's *working directory*,
// not by session id, so both ends have to agree on the slug: the source locates
// ~/.claude/projects/<slug>/<session-id>.jsonl from the stage run's cwd, and the
// receiver re-derives its own slug for the destination worktree (the sender
// cannot name a path that only exists on the receiving machine).
//
// On 2026-08-06 a transfer silently lost a 2.1 MB conversation because Kanna
// archived ~/.claude/tasks/<session-id> — a real, session-keyed directory that
// holds only a lock file — and nothing pinned where transcripts actually live.
// packages/core/src/claude-transcript.ts is the shared derivation; this test is
// what keeps it honest against the real CLI.

describe("claude transcript location and project slug", () => {
  const cases = [
    { dirName: "a.b_c-d", note: "dot, underscore and hyphen" },
    { dirName: "a b@c+d~e", note: "space and punctuation" },
  ];

  for (const testCase of cases) {
    it(`writes the transcript under the derived slug (${testCase.note})`, async (ctx) => {
      if (!(await claudeBinaryOrNull())) {
        ctx.skip("claude CLI is not installed");
        return;
      }

      const root = await makeRealTempDir("kanna-claude-slug-");
      const cwd = join(root, testCase.dirName);
      await mkdir(cwd, { recursive: true });
      const sessionId = randomUUID();

      try {
        const result = await runClaude({
          prompt: "Reply with exactly: ok",
          flags: ["--session-id", sessionId],
          cwd,
        });
        if (isClaudeUnavailable(result)) {
          ctx.skip("claude CLI is not authenticated");
          return;
        }
        expect(result.exitCode, `claude failed: ${result.stderr}`).toBe(0);

        const transcript = claudeTranscriptPath({ homeDir: homedir(), cwd, sessionId });
        const stats = await stat(transcript).catch(() => null);
        expect(
          stats,
          `no transcript at ${transcript}. Claude's project-slug rule or its ` +
          `transcript layout changed; update claudeProjectSlug/claudeTranscriptPath ` +
          `in packages/core/src/claude-transcript.ts and the transfer locator with it.`,
        ).not.toBeNull();
        expect(stats?.size ?? 0).toBeGreaterThan(0);

        // The slug is a pure function of the cwd — no session id, no repo name.
        expect(transcript).toContain(`/.claude/projects/${claudeProjectSlug(cwd)}/`);
        expect(transcript.endsWith(`/${sessionId}.jsonl`)).toBe(true);

        // And the conversation is *not* in the session-keyed directory the
        // 2026-08-06 incident archived instead.
        const taskDir = join(homedir(), ".claude", "tasks", sessionId);
        const taskDirEntries = await readdir(taskDir).catch(() => null);
        if (taskDirEntries) {
          expect(
            taskDirEntries.filter((entry) => entry.endsWith(".jsonl")),
            `~/.claude/tasks/<session-id> now holds transcript data (${taskDirEntries.join(", ")}). ` +
            `If that is the new home for conversations, the transfer locator must follow it.`,
          ).toEqual([]);
        }
      } finally {
        await removeDir(join(homedir(), ".claude", "projects", claudeProjectSlug(cwd)));
        await removeDir(root);
      }
    }, 90_000);
  }
});

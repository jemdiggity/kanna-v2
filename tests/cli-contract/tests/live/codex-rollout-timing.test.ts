import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCodexBinary } from "../../helpers/codex";
import { codexBinaryOrNull } from "../../helpers/availability";
import { BackgroundProcess, makeRealTempDir, removeDir, sleep } from "../../helpers/background";

// WHAT BREAKS IN KANNA IF THIS PIN FAILS: Codex rollout staging on transfer.
//
// Codex is the mirror image of Claude: Kanna mints Claude's session id up front
// with --session-id, but Codex names its own rollout, so transfer *searches* for
// it — findCodexRolloutArtifact (apps/desktop/src/stores/transfer.ts:244) scans
// ~/.codex/sessions/<y>/<m>/<d>/ for a file ending in -<sessionId>.jsonl, and it
// does that while the agent is still running.
//
// Two facts decide whether that is safe, and this test pins both:
//   1. the rollout is nameable before exit  — so the scan finds a file at all;
//   2. it is still being written after that — so the file the scan finds is a
//      TRUNCATED conversation.
// (2) is why Decision 3 stages artifacts only after the daemon `Exit` event. If
// (1) ever flips to "appears at exit", mid-session staging ships nothing instead
// of shipping too little; either way the current mid-session scan is wrong.

const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

async function findRollout(threadId: string): Promise<string | null> {
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    // Year/month/day directories are zero-padded, so descending order reaches
    // today first — this runs on every poll, over a developer's whole history.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) {
        const hit = await walk(path, depth - 1);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        return path;
      }
    }
    return null;
  };
  // sessions/<year>/<month>/<day>/rollout-...jsonl
  return await walk(SESSIONS_ROOT, 3);
}

describe("codex rollout file timing", () => {
  it("is nameable before exit and still growing at that point", async (ctx) => {
    if (!(await codexBinaryOrNull())) {
      ctx.skip("codex CLI is not installed");
      return;
    }

    const cwd = await makeRealTempDir("kanna-codex-rollout-");
    const binary = await findCodexBinary();
    const child = new BackgroundProcess(
      binary,
      [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "Print every integer from 1 to 400, one per line, nothing else.",
      ],
      { cwd },
    );

    let threadId: string | null = null;
    let firstSighting: { elapsedMs: number; size: number; path: string } | null = null;
    let lastSizeWhileRunning = 0;

    try {
      while (child.running) {
        if (!threadId) {
          const started = child.jsonLines().find((line) => line.type === "thread.started");
          const id = started?.thread_id;
          if (typeof id === "string" && id.length > 0) threadId = id;
        }
        if (threadId) {
          const path = await findRollout(threadId);
          if (path) {
            const size = (await stat(path)).size;
            if (!firstSighting && size > 0) {
              firstSighting = { elapsedMs: Date.now() - child.startedAt, size, path };
            }
            lastSizeWhileRunning = size;
          }
        }
        await sleep(250);
      }

      const exitCode = await child.waitForExit(60_000);
      const elapsed = Date.now() - child.startedAt;

      if (!threadId) {
        ctx.skip(`codex emitted no thread.started (exit ${exitCode}): ${child.stderr.slice(0, 200)}`);
        return;
      }
      expect(exitCode, `codex failed: ${child.stderr}`).toBe(0);

      expect(
        firstSighting,
        `no rollout for thread ${threadId} existed at any point while codex was running. ` +
        `findCodexRolloutArtifact scans mid-session, so it would stage nothing at all.`,
      ).not.toBeNull();
      const sighting = firstSighting as { elapsedMs: number; size: number; path: string };
      expect(sighting.elapsedMs).toBeLessThan(elapsed);

      // The path shape the transfer locator matches on.
      expect(sighting.path.startsWith(`${SESSIONS_ROOT}/`)).toBe(true);
      expect(sighting.path).toMatch(
        new RegExp(`/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]*-${threadId}\\.jsonl$`),
      );

      const finalPath = await findRollout(threadId);
      expect(finalPath).toBe(sighting.path);
      const finalSize = (await stat(sighting.path)).size;
      expect(finalSize).toBeGreaterThanOrEqual(lastSizeWhileRunning);

      if (elapsed < 3_000) {
        ctx.skip(`codex turn finished in ${elapsed}ms, too fast to compare mid-session content`);
        return;
      }
      expect(
        finalSize,
        `the rollout stopped changing after ${sighting.elapsedMs}ms (${sighting.size} bytes) and ` +
        `codex ran for ${elapsed}ms. If codex now writes the whole rollout up front, mid-session ` +
        `staging would be safe and Decision 3's stage-after-Exit ordering could be relaxed — ` +
        `confirm before changing anything.`,
      ).toBeGreaterThan(sighting.size);
    } finally {
      child.kill();
      // The rollout itself stays in the developer's real ~/.codex/sessions: the
      // point of this pin is the path the transfer locator scans, and codex
      // tracks its sessions elsewhere too — deleting the file behind its back
      // would leave a dangling entry.
      await removeDir(cwd);
    }
  }, 240_000);
});

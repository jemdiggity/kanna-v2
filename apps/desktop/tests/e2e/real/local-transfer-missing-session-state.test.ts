import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi, pushSelectedTaskToPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, execDb, queryDb } from "../helpers/vue";

/**
 * A transfer that cannot ship the conversation must fail loudly, on the machine
 * that still holds it.
 *
 * The incident this pins: a Claude PTY task shipped `artifacts: []` beside a
 * valid `resume_session_id`, both sides called it a success, and the
 * destination minted a fresh session while 2.1 MB of conversation stayed
 * behind. Every drop point was a silent fallback. The rule now is that the
 * combination *resume id present + required artifact missing* is a failed
 * transfer — and the source task survives it, because losing the transfer is
 * recoverable and losing the conversation is not.
 *
 * See docs/2026-08-06-missing-session-state-transfer-e2e-gap.md for the
 * receiver-side half this cannot reach from a same-build pair.
 */

interface PipelineRow {
  id: string;
  branch: string | null;
  closed_at: string | null;
  agent_session_id: string | null;
}

interface TransferRow {
  id: string;
  direction: string;
  status: string;
  error: string | null;
  payload_json: string | null;
}

interface CountRow {
  count: number;
}

const SOURCE_SESSION_ID = "5f6f1a0f-2b64-4c8e-9f2a-6b3d1c4e5a70";

/**
 * Claude keys transcripts by the session's working directory, replacing every
 * character outside `[A-Za-z0-9]` with `-`. Mirrored here independently of the
 * app so the test pins the contract rather than the implementation.
 */
function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

function transcriptPathFor(worktreePath: string): string {
  const resolved = existsSync(worktreePath)
    ? realpathSync(worktreePath)
    : join(realpathSync(dirname(worktreePath)), basename(worktreePath));
  return join(
    homedir(),
    ".claude/projects",
    claudeProjectSlug(resolved),
    `${SOURCE_SESSION_ID}.jsonl`,
  );
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";

describe("local transfer refuses to ship a session it cannot carry", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-missing-session-state");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-missing-session-state");
  }, 240_000);

  afterAll(async () => {
    const acquired = (await queryDb(
      secondary,
      "SELECT path FROM repo WHERE path LIKE ?",
      [`${homedir()}/.kanna/repos/local-transfer-missing-session-state%`],
    ).catch(() => [])) as Array<{ path: string }>;
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos([testRepoPath, ...acquired.map((repo) => repo.path)]).catch(
      () => undefined,
    );
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("keeps the source task running and creates no fresh destination session", async () => {
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });

    // Direct task creation is setup-only: the product has no UI path for
    // creating a transfer fixture task without also launching a real agent
    // session, and this test must not drive a live Claude conversation.
    const created = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "Hold the conversation here",
      "agent",
    );
    if (typeof created !== "string") {
      throw new Error(`failed to create source task: ${JSON.stringify(created)}`);
    }

    // Let the worktree and the spawned session settle first: the spawn records
    // its own `agent_session_id`, and it must not land after this rewrite.
    const sourceWorktree = `${testRepoPath}/.kanna-worktrees/task-${created}`;
    await waitForFile(sourceWorktree);
    await sleep(3_000);

    // Present the task as a Claude PTY session with a resumable id — and never
    // plant its transcript. This is the exact shape that used to ship
    // `artifacts: []` beside a valid resume id.
    await execDb(
      primary,
      "UPDATE pipeline_item SET agent_type = 'pty', agent_provider = 'claude', agent_session_id = ? WHERE id = ?",
      [SOURCE_SESSION_ID, created],
    );
    await callVueMethod(primary, "store.reloadSnapshot");
    const seeded = (await queryDb(
      primary,
      "SELECT id, branch, closed_at, agent_session_id FROM pipeline_item WHERE id = ?",
      [created],
    )) as PipelineRow[];
    expect(seeded[0]?.agent_session_id).toBe(SOURCE_SESSION_ID);

    const sourceTranscript = transcriptPathFor(sourceWorktree);
    await rm(sourceTranscript, { force: true });
    expect(existsSync(sourceTranscript)).toBe(false);

    await callVueMethod(primary, "store.selectItem", created);
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary", { waitForDismissal: false });

    // Visible on the source, not only in a console log.
    await primary.waitForText(".toast", "transcript", 15_000);

    // Give the sidecar and the receiver the time a real transfer would have
    // taken, so "nothing happened" is a settled fact rather than a race.
    await sleep(5_000);

    // The source refuses at the push, before `insertDesktopTaskTransfer`, so
    // today there is no row at all. Pin the invariant rather than the count:
    // nothing may be left in a live state, and whatever a later refusal point
    // does create must be `failed`, carrying the reason and no artifacts.
    const transfers = (await queryDb(
      primary,
      "SELECT id, direction, status, error, payload_json FROM task_transfer WHERE source_task_id = ?",
      [created],
    )) as TransferRow[];
    expect(transfers.filter((transfer) => transfer.status !== "failed")).toEqual([]);
    for (const transfer of transfers) {
      expect(transfer.error ?? "").toMatch(/transcript/);
      // An artifact-less finalized payload must never be persisted.
      const payload = JSON.parse(transfer.payload_json ?? "{}") as {
        artifacts?: unknown[];
      };
      expect(payload.artifacts ?? []).toEqual([]);
    }

    // The source task is intact: open, unclosed, still resumable.
    // (`transfer_status` is JOIN-derived in the snapshot query, not a column
    // here, so the transfer rows above are what carry that half.)
    const sourceRows = (await queryDb(
      primary,
      "SELECT id, branch, closed_at, agent_session_id FROM pipeline_item WHERE id = ?",
      [created],
    )) as PipelineRow[];
    expect(sourceRows[0]).toMatchObject({
      id: created,
      branch: `task-${created}`,
      closed_at: null,
    });
    expect(sourceRows[0]?.agent_session_id).toBeTruthy();

    // And nothing arrived on the other machine — a destination task here would
    // be the fresh-session data loss this whole change exists to prevent.
    const destinationTasks = (await queryDb(
      secondary,
      "SELECT COUNT(*) AS count FROM pipeline_item",
    )) as CountRow[];
    expect(Number(destinationTasks[0]?.count ?? 0)).toBe(0);
  }, 240_000);
});

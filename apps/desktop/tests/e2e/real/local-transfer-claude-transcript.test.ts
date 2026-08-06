import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
 * Conversation continuity across a machine transfer, not transfer completion.
 *
 * The pre-existing transfer E2Es assert that a transfer *completed*, which is
 * exactly why the silent transcript loss shipped: a Claude task could arrive
 * with a valid resume session id and no conversation at all. This test asserts
 * the conversation itself crosses — the destination transcript exists under the
 * *destination* slug with the source bytes, and the destination task resumes
 * the same session id rather than minting a fresh one.
 *
 * See docs/2026-08-06-claude-transcript-transfer-e2e-gap.md for the part this
 * cannot reach: a live Claude agent on both ends proving the CLI renders the
 * history.
 */

interface PipelineRow {
  id: string;
  branch: string | null;
  agent_session_id: string | null;
  agent_provider: string | null;
}

interface TransferRow {
  id: string;
  status: string;
  local_task_id: string | null;
  payload_json: string | null;
}

interface StageRunRow {
  provider_session_id: string | null;
  cwd: string | null;
}

interface RepoRow {
  path: string;
}

const SOURCE_SESSION_ID = "364643cc-5e6d-48fc-86ca-ca7764380900";
const SOURCE_TRANSCRIPT = [
  JSON.stringify({ type: "user", message: { role: "user", content: "remember the codeword rhubarb" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: "codeword noted: rhubarb" } }),
  "",
].join("\n");

/**
 * Claude keys transcripts by the session's working directory, replacing every
 * character outside `[A-Za-z0-9]` with `-`. Mirrored here independently of the
 * app so the test pins the contract rather than the implementation.
 */
function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

function transcriptPathFor(worktreePath: string): string {
  // The kernel reports a process's cwd fully resolved, so the slug Claude uses
  // is the realpath — which matters here because fixture repos live under a
  // symlinked temp directory.
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

async function waitForIncomingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 30_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TransferRow | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT id, status, local_task_id, payload_json
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    last = rows[0];
    if (last?.status === "completed") return last;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for incoming transfer of ${sourceTaskId}: ${JSON.stringify(last)}`,
  );
}

async function waitForDestinationWorktree(taskId: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: RepoRow | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT repo.path AS path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [taskId],
    )) as RepoRow[];
    last = rows[0];
    if (last?.path) return `${last.path}/.kanna-worktrees/task-${taskId}`;
    await sleep(250);
  }
  throw new Error(`timed out waiting for destination repo of ${taskId}: ${JSON.stringify(last)}`);
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
const materializedTranscriptDirs = new Set<string>();

describe("local transfer Claude conversation continuity", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-claude-transcript");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-claude-transcript");
  }, 240_000);

  afterAll(async () => {
    for (const directory of materializedTranscriptDirs) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    const acquired = (await queryDb(
      secondary,
      "SELECT path FROM repo WHERE path LIKE ?",
      [`${homedir()}/.kanna/repos/local-transfer-claude-transcript%`],
    ).catch(() => [])) as RepoRow[];
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos([testRepoPath, ...acquired.map((repo) => repo.path)]).catch(
      () => undefined,
    );
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("carries the Claude conversation to the destination slug and resumes the same session", async () => {
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
      "Carry the conversation",
      "agent",
    );
    if (typeof created !== "string") {
      throw new Error(`failed to create source task: ${JSON.stringify(created)}`);
    }

    // Present the task as the Claude PTY session whose transcript we plant.
    await execDb(
      primary,
      "UPDATE pipeline_item SET agent_type = 'pty', agent_provider = 'claude', agent_session_id = ? WHERE id = ?",
      [SOURCE_SESSION_ID, created],
    );
    await callVueMethod(primary, "store.reloadSnapshot");

    const sourceWorktree = `${testRepoPath}/.kanna-worktrees/task-${created}`;
    await waitForFile(sourceWorktree);
    const sourceTranscript = transcriptPathFor(sourceWorktree);
    materializedTranscriptDirs.add(dirname(sourceTranscript));
    await mkdir(dirname(sourceTranscript), { recursive: true });
    await writeFile(sourceTranscript, SOURCE_TRANSCRIPT, "utf8");

    // The `~/.claude/tasks/<id>` session archive is deliberately absent — the
    // shape that used to ship `artifacts: []` beside a valid resume id.
    expect(existsSync(join(homedir(), ".claude/tasks", SOURCE_SESSION_ID))).toBe(false);

    await callVueMethod(primary, "store.selectItem", created);
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

    const transfer = await waitForIncomingTransferCompleted(created);
    const destinationTaskId = transfer.local_task_id;
    if (!destinationTaskId) {
      throw new Error(`incoming transfer imported no local task: ${JSON.stringify(transfer)}`);
    }

    const payload = JSON.parse(transfer.payload_json ?? "{}") as {
      artifacts?: Array<Record<string, unknown>>;
    };
    expect(payload.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          kind: "session-transcript",
          materialization: "copy-file",
          filename: `${SOURCE_SESSION_ID}.jsonl`,
        }),
      ]),
    );

    const destinationWorktree = await waitForDestinationWorktree(destinationTaskId);
    const destinationTranscript = transcriptPathFor(destinationWorktree);
    materializedTranscriptDirs.add(dirname(destinationTranscript));
    expect(destinationTranscript).not.toBe(sourceTranscript);
    await waitForFile(destinationTranscript);
    expect(readFileSync(destinationTranscript, "utf8")).toBe(SOURCE_TRANSCRIPT);

    // Same session id on the destination — not a freshly minted one — and the
    // run the agent was spawned from carries it, keyed to the new worktree.
    const destinationRows = (await queryDb(
      secondary,
      "SELECT id, branch, agent_session_id, agent_provider FROM pipeline_item WHERE id = ?",
      [destinationTaskId],
    )) as PipelineRow[];
    expect(destinationRows[0]).toMatchObject({
      id: destinationTaskId,
      branch: `task-${destinationTaskId}`,
      agent_provider: "claude",
      agent_session_id: SOURCE_SESSION_ID,
    });

    const stageRuns = (await queryDb(
      secondary,
      `SELECT provider_session_id, cwd
         FROM stage_run
        WHERE task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [destinationTaskId],
    )) as StageRunRow[];
    expect(stageRuns[0]?.provider_session_id).toBe(SOURCE_SESSION_ID);
    expect(stageRuns[0]?.cwd).toBe(destinationWorktree);

    // Staging reads the live transcript in place; it must never consume it.
    expect(readFileSync(sourceTranscript, "utf8")).toBe(SOURCE_TRANSCRIPT);
  }, 240_000);
});

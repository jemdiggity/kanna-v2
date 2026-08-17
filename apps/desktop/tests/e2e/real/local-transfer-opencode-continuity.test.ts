import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import {
  exportOpencodeSession,
  opencodeSessionText,
  resolvedWorktreePath,
  waitForOpencodeSessionDirectory,
  waitForOpencodeSessionInDirectory,
  waitForOpencodeAssistantText,
} from "../helpers/opencodeSessions";
import { realE2eAgentProvider } from "../helpers/realAgentProvider";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { pairWithPeerThroughUi, pushSelectedTaskToPeerThroughUi } from "../helpers/transferFlow";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { waitForFile } from "../helpers/worktreeFs";

/**
 * Conversation continuity across a machine transfer, on the provider the real
 * E2E runner actually launches.
 *
 * The transfer E2Es that predate the transcript-loss incident assert a transfer
 * *completed*, which is exactly why silent history loss shipped. This suite
 * runs a live OpenCode agent, plants a codeword in its conversation, transfers
 * the task, and asserts the destination *resumes that conversation*: the same
 * session id on the destination task, its state re-keyed to the destination
 * worktree, and the source turns still in it.
 *
 * Two OpenCode-specific facts make this the shape it is, both pinned
 * empirically against the CLI (1.16.2):
 *
 * - OpenCode has no `--session-id` to assign, so Kanna cannot know the id at
 *   spawn. The transfer discovers it from `opencode session list`, which is why
 *   a null `agent_session_id` on the source task is not a missing conversation.
 * - OpenCode resumes by matching a session's recorded directory against the
 *   current working directory. `opencode run --session <id>` from any other
 *   directory is a *silent* no-op — no error, no history — so re-keying the
 *   session to the destination worktree is the load-bearing step, and the
 *   assertion below on the session's directory is the one that would have
 *   caught the incident's failure shape here.
 *
 * On one machine both instances share a single OpenCode store, so the receiver's
 * `opencode import` re-keys the existing session rather than creating one. Both
 * are the same observable claim: after the transfer, the destination worktree is
 * the directory this conversation belongs to.
 *
 * Every step below — discovering the session, exporting it, importing it into
 * the destination worktree — runs in `kanna-server`'s transfer engine. Nothing
 * here reaches into a renderer to make the transfer happen, which is why the
 * only window interaction left is the push the operator asks for.
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
  error: string | null;
}

interface StageRunRow {
  provider_session_id: string | null;
  cwd: string | null;
}

interface RepoRow {
  path: string;
}

const CODEWORD = "rhubarb";
const PROMPT = [
  `Reply with exactly: codeword ${CODEWORD}.`,
  "Do not use any tools. Do not ask questions.",
].join(" ");

/**
 * What the source agent is actually doing, for the failure that matters most
 * here: a live agent that never produced a conversation looks identical to a
 * transfer that dropped one.
 */
async function captureSourceAgentDiagnostics(taskId: string): Promise<string> {
  const daemonSessions = await tauriInvoke(primary, "list_sessions")
    .catch((error: unknown) => ({ error: String(error) }));
  const terminalText = await primary.executeSync<string>(
    `return window.__KANNA_E2E__?.terminalBuffers?.getText?.(${JSON.stringify(taskId)}) ?? "";`,
  ).catch(() => "");
  return JSON.stringify({ daemonSessions, terminalText: terminalText.slice(-4000) });
}

/**
 * The source agent's conversation, once it exists.
 *
 * OpenCode asks for confirmation before it will work in a directory it has not
 * seen, and it opens no session until that is answered — so the Enter goes
 * straight to the task's PTY through the daemon rather than through whichever
 * terminal the window happens to be showing. Answering repeatedly is safe: the
 * prompt takes the first one and the agent ignores the rest, and once a session
 * exists this stops.
 */
async function waitForSourceOpencodeSession(
  taskId: string,
  worktreePath: string,
  timeoutMs = 300_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessionId = await waitForOpencodeSessionInDirectory(worktreePath, 5_000, 1_000)
      .catch(() => null);
    if (sessionId) return sessionId;
    // 13 is carriage return: the key the trust prompt is waiting for. This
    // direct producer must declare the Enter boundary so later logical input
    // does not remain queued behind a phantom draft.
    await tauriInvoke(primary, "send_input", {
      sessionId: taskId,
      data: [13],
      submissionBoundary: true,
    })
      .catch(() => undefined);
    await sleep(2_000);
  }
  throw new Error(
    `timed out waiting for a source opencode session in ${worktreePath}: `
    + await captureSourceAgentDiagnostics(taskId),
  );
}

async function waitForIncomingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 240_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TransferRow | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT id, status, local_task_id, payload_json, error
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    last = rows[0];
    if (last?.status === "completed") return last;
    if (last?.status === "failed" || last?.status === "rejected") {
      throw new Error(
        `incoming transfer of ${sourceTaskId} ${last.status}: ${last.error ?? "no error recorded"}`,
      );
    }
    await sleep(250);
  }
  // The reason lives on the row. The import runs in `kanna-server` now, so
  // there is no renderer console to scrape — a failed import writes its reason
  // to `task_transfer.error` and a retriable one leaves the row non-terminal,
  // which is what the two branches above read.
  throw new Error(
    `timed out waiting for incoming transfer of ${sourceTaskId}: `
    + `status=${last?.status ?? "none"} error=${last?.error ?? "none"}`,
  );
}

async function waitForDestinationWorktree(taskId: string, timeoutMs = 60_000): Promise<string> {
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

async function waitForStageRun(taskId: string, timeoutMs = 60_000): Promise<StageRunRow> {
  const deadline = Date.now() + timeoutMs;
  let last: StageRunRow | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT provider_session_id, cwd
         FROM stage_run
        WHERE task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [taskId],
    )) as StageRunRow[];
    last = rows[0];
    if (last?.provider_session_id) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for a destination stage run of ${taskId}: ${JSON.stringify(last)}`);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";

describe.skipIf(realE2eAgentProvider() !== "opencode")(
  "local transfer OpenCode conversation continuity",
  () => {
    let repoId = "";

    beforeAll(async () => {
      await primary.createSession();
      await secondary.createSession();
      await resetDatabase(primary);
      await resetDatabase(secondary);
      testRepoPath = await createFixtureRepo("local-transfer-opencode-continuity");
      repoId = await importTestRepo(primary, testRepoPath, "local-transfer-opencode-continuity");
    }, 240_000);

    afterAll(async () => {
      const acquired = (await queryDb(
        secondary,
        "SELECT path FROM repo WHERE path LIKE ?",
        [`${homedir()}/.kanna/repos/local-transfer-opencode-continuity%`],
      ).catch(() => [])) as RepoRow[];
      await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
      await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath, ...acquired.map((repo) => repo.path)]).catch(
        () => undefined,
      );
      await primary.deleteSession().catch(() => undefined);
      await secondary.deleteSession().catch(() => undefined);
    });

    it("resumes the transferred OpenCode conversation in the destination worktree", async () => {
      expect(repoId).not.toBe("");
      await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
        promptClient: secondary,
        promptPeerId: "peer-primary",
      });

      // Created through the store rather than the new-task modal: this suite is
      // about what a transfer does to a live agent's conversation, and the
      // provider it launches is the runner's forced one either way.
      const created = await callVueMethod(
        primary,
        "store.createItem",
        repoId,
        testRepoPath,
        PROMPT,
        "pty",
      );
      if (typeof created !== "string") {
        throw new Error(`failed to create source task: ${JSON.stringify(created)}`);
      }
      const task = await waitForTaskCreated(primary, PROMPT, 30_000);
      expect(task.id).toBe(created);
      expect(task.agent_provider).toBe("opencode");

      // Named rather than discovered: a task's worktree path is derived from its
      // id, so waiting for "some new directory" would happily accept the repo's
      // own setup worktree.
      const sourceWorktree = `${testRepoPath}/.kanna-worktrees/task-${created}`;
      await waitForFile(sourceWorktree, 60_000, 250);

      // The agent must have *answered* before the push. Waiting on the whole
      // conversation would not do: Kanna re-sends the same prompt on the
      // destination, so the user half of this exchange reappears there whether
      // or not any history crossed — only the assistant's turn distinguishes a
      // resumed conversation from a fresh one.
      const sourceSessionId = await waitForSourceOpencodeSession(created, sourceWorktree);
      const sourceConversation = await waitForOpencodeAssistantText(
        sourceSessionId,
        sourceWorktree,
        CODEWORD,
        240_000,
      ).catch(async (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n`
          + `sourceAgent=${await captureSourceAgentDiagnostics(created)}`,
        );
      });
      const sourceAssistantText = opencodeSessionText(sourceConversation, "assistant");
      expect(sourceAssistantText).toContain(CODEWORD);

      // Kanna never learned this id at spawn — nothing assigns one for OpenCode
      // — so the transfer has to discover it.
      const sourceRows = (await queryDb(
        primary,
        "SELECT id, branch, agent_session_id, agent_provider FROM pipeline_item WHERE id = ?",
        [task.id],
      )) as PipelineRow[];
      expect(sourceRows[0]?.agent_session_id).toBeNull();

      await callVueMethod(primary, "store.selectItem", task.id);
      await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

      const transfer = await waitForIncomingTransferCompleted(task.id);
      const destinationTaskId = transfer.local_task_id;
      if (!destinationTaskId) {
        throw new Error(`incoming transfer imported no local task: ${JSON.stringify(transfer)}`);
      }

      const payload = JSON.parse(transfer.payload_json ?? "{}") as {
        task?: { resume_session_id?: string | null };
        artifacts?: Array<Record<string, unknown>>;
      };
      expect(payload.task?.resume_session_id).toBe(sourceSessionId);
      expect(payload.artifacts).toEqual([
        expect.objectContaining({
          provider: "opencode",
          kind: "session-export",
          materialization: "opencode-import",
          filename: "opencode-session.json",
        }),
      ]);

      // Same session id on the destination task — not a freshly minted one, and
      // not the null the source row carried.
      const destinationRows = (await queryDb(
        secondary,
        "SELECT id, branch, agent_session_id, agent_provider FROM pipeline_item WHERE id = ?",
        [destinationTaskId],
      )) as PipelineRow[];
      expect(destinationRows[0]).toMatchObject({
        id: destinationTaskId,
        branch: `task-${destinationTaskId}`,
        agent_provider: "opencode",
        agent_session_id: sourceSessionId,
      });

      const destinationWorktree = await waitForDestinationWorktree(destinationTaskId);
      expect(resolvedWorktreePath(destinationWorktree))
        .not.toBe(resolvedWorktreePath(sourceWorktree));

      // The step that makes `--session` mean anything: without it the resumed
      // agent starts in a directory OpenCode does not associate with this
      // conversation and silently answers from nothing.
      await waitForOpencodeSessionDirectory(sourceSessionId, destinationWorktree);

      // And the conversation itself crossed, not just its id: the agent's own
      // turns from the source machine are still in it.
      const destinationConversation = await exportOpencodeSession(sourceSessionId, destinationWorktree);
      expect(destinationConversation.info?.id).toBe(sourceSessionId);
      expect(opencodeSessionText(destinationConversation, "assistant"))
        .toContain(sourceAssistantText);
      expect(opencodeSessionText(destinationConversation, "assistant")).toContain(CODEWORD);

      // The run the destination agent was spawned from resumes that session in
      // the new worktree.
      const stageRun = await waitForStageRun(destinationTaskId);
      expect(stageRun.provider_session_id).toBe(sourceSessionId);
      expect(stageRun.cwd).toBe(destinationWorktree);
    }, 600_000);
  },
);

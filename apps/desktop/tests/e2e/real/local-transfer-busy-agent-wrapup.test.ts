import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import {
  exportOpencodeSession,
  opencodeSessionText,
  waitForOpencodeSessionInDirectory,
  type OpencodeSessionExport,
} from "../helpers/opencodeSessions";
import { realE2eAgentProvider } from "../helpers/realAgentProvider";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { pairWithPeerThroughUi, pushSelectedTaskToPeerThroughUi } from "../helpers/transferFlow";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { waitForFile } from "../helpers/worktreeFs";

/**
 * Transferring a task whose agent is *busy*.
 *
 * Finalization used to end the source agent with a `SIGINT` and wait 1500 ms.
 * That was never a wrap-up: it interrupted whatever the agent was mid-way
 * through, and on any session the daemon had adopted through a handoff it did
 * not even do that — the daemon refuses signals for adopted children by design,
 * so after every app upgrade no pre-existing task could be finalized at all
 * (the 2026-08-06 incident; pinned at the daemon layer by
 * `crates/daemon/tests/handoff.rs`).
 *
 * The replacement asks instead of signalling: inject a wrap-up message, wait
 * for the daemon to report the session `Idle`, inject the provider's quit
 * command, wait for `Exit`, and only then stage artifacts
 * (`crates/kanna-server/src/transfer_engine/finalize.rs`). This suite is the
 * end-to-end proof of the sequence's payoff — a busy agent's last thought is in
 * the conversation the destination resumes, rather than truncated out of it.
 *
 * OpenCode is the provider because the real-E2E runner forces it
 * (`apps/desktop/tests/e2e/runEnv.ts`) and its free models are what make a live
 * PTY agent affordable; the sequence itself is provider-independent apart from
 * the quit command, which comes from the provider registry.
 */

interface TransferRow {
  id: string;
  status: string;
  local_task_id: string | null;
  payload_json: string | null;
  error: string | null;
}

interface RepoRow {
  path: string;
}

interface EventRow {
  type: string;
  payload: string | null;
}

/** A phrase from the injected wrap-up, distinctive enough to find in a transcript. */
const WRAP_UP_PHRASE = "transferred to another machine";

/**
 * Step 1 lands almost immediately and is what the test waits on, so the push
 * arrives while step 2 is still being written — the busy case the sequence
 * exists for. Step 2 is deliberately modest: the agent has to finish *both* it
 * and the wrap-up turn inside the server's wrap-up budget, and a free model
 * printing 900 lines does not (an earlier revision of this suite asked for 900
 * and the agent was still `busy` five minutes later, with the wrap-up unanswered
 * and the whole budget spent).
 *
 * The deterministic pin that a quit is never typed at a busy agent lives in
 * `transfer_engine/finalize.rs`'s unit tests, where the status stream is
 * scripted. What this suite adds is the live proof that the wrap-up reaches a
 * real agent and its answer crosses the machine boundary.
 */
const PROMPT = [
  "Do these steps in order, without asking questions.",
  "Step 1: create a file named started.txt containing STARTED.",
  "Step 2: in your reply, print every integer from 1 to 200, one per line.",
].join(" ");

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";

/**
 * The source agent's session, once OpenCode has one.
 *
 * OpenCode asks for confirmation before working in an unfamiliar directory and
 * opens no session until that is answered, so the Enter goes straight to the
 * task's PTY. Answering repeatedly is safe: the prompt takes the first one.
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
  throw new Error(`timed out waiting for a source opencode session in ${worktreePath}`);
}

/**
 * Waits out the source's *own* budget, with room to spare.
 *
 * This has to exceed `WRAP_UP_TIMEOUT + QUIT_EXIT_TIMEOUT` (360 s in
 * `transfer_engine/finalize.rs`) plus staging, or the test can time out on a
 * finalization that is still working correctly — and then `afterAll` removes
 * the worktree out from under the in-flight staging, so the transfer records
 * "refusing to ship an empty transfer" and the real reason is buried.
 */
async function waitForIncomingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 600_000,
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
  throw new Error(
    `timed out waiting for incoming transfer of ${sourceTaskId}: `
    + `status=${last?.status ?? "none"} error=${last?.error ?? "none"}`,
  );
}

async function destinationWorktree(taskId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT repo.path AS path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [taskId],
    )) as RepoRow[];
    if (rows[0]?.path) return `${rows[0].path}/.kanna-worktrees/task-${taskId}`;
    await sleep(250);
  }
  throw new Error(`timed out waiting for the destination repo of ${taskId}`);
}

/** The finalization phases the source recorded, in order. */
async function finalizationPhases(taskId: string): Promise<string[]> {
  const rows = (await queryDb(
    primary,
    `SELECT type, payload FROM task_event
      WHERE task_id = ? AND type = 'task.transfer_finalizing'
      ORDER BY seq ASC`,
    [taskId],
  )) as EventRow[];
  return rows.map((row) => {
    const payload = JSON.parse(row.payload ?? "{}") as { phase?: string };
    return payload.phase ?? "";
  });
}

/**
 * Whether an assistant turn *follows* the wrap-up in the conversation.
 *
 * Ordering is the claim: a wrap-up that arrives and is never answered before
 * the agent quits is the truncation the old sequence produced.
 */
function assistantAnsweredTheWrapUp(session: OpencodeSessionExport): boolean {
  const messages = session.messages ?? [];
  const wrapUpIndex = messages.findIndex(
    (message) =>
      message.info?.role === "user"
      && (message.parts ?? []).some((part) => part.text?.includes(WRAP_UP_PHRASE)),
  );
  if (wrapUpIndex < 0) return false;
  return messages.slice(wrapUpIndex + 1).some(
    (message) =>
      message.info?.role === "assistant"
      && (message.parts ?? []).some(
        (part) => part.type === "text" && (part.text ?? "").trim().length > 0,
      ),
  );
}

describe.skipIf(realE2eAgentProvider() !== "opencode")(
  "local transfer finalizes a busy agent with a wrap-up",
  () => {
    let repoId = "";

    beforeAll(async () => {
      await primary.createSession();
      await secondary.createSession();
      await resetDatabase(primary);
      await resetDatabase(secondary);
      testRepoPath = await createFixtureRepo("local-transfer-busy-wrapup");
      repoId = await importTestRepo(primary, testRepoPath, "local-transfer-busy-wrapup");
    }, 240_000);

    afterAll(async () => {
      const acquired = (await queryDb(
        secondary,
        "SELECT path FROM repo WHERE path LIKE ?",
        [`${homedir()}/.kanna/repos/local-transfer-busy-wrapup%`],
      ).catch(() => [])) as RepoRow[];
      await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
      await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath, ...acquired.map((repo) => repo.path)]).catch(
        () => undefined,
      );
      await primary.deleteSession().catch(() => undefined);
      await secondary.deleteSession().catch(() => undefined);
    });

    it("ships the wrap-up the busy agent produced before it quit", async () => {
      expect(repoId).not.toBe("");
      await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
        promptClient: secondary,
        promptPeerId: "peer-primary",
      });

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

      const sourceWorktree = `${testRepoPath}/.kanna-worktrees/task-${created}`;
      await waitForFile(sourceWorktree, 60_000, 250);
      const sourceSessionId = await waitForSourceOpencodeSession(created, sourceWorktree);

      // Step 1 landing is what proves the turn is genuinely under way: the agent
      // is mid-work, with step 2 still to print, when the push arrives.
      await waitForFile(`${sourceWorktree}/started.txt`, 240_000, 500);

      await callVueMethod(primary, "store.selectItem", task.id);
      await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

      const transfer = await waitForIncomingTransferCompleted(task.id);
      const destinationTaskId = transfer.local_task_id;
      if (!destinationTaskId) {
        throw new Error(`incoming transfer imported no local task: ${JSON.stringify(transfer)}`);
      }

      // The finalization state reaches the payload rather than being silently
      // unset, and the *only* degradation this environment may produce is the
      // known one: live OpenCode sessions never report `Idle` to the daemon, so
      // the wrap-up wait always runs out its budget here. Every other rung of
      // the ladder — an injection that failed, a session parked on a permission
      // prompt, an agent that would not exit — still fails this test, and so
      // does a clean run that silently stopped reporting.
      // See docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md.
      const payload = JSON.parse(transfer.payload_json ?? "{}") as {
        finalization?: { cleanly_finalized?: boolean; degraded_reason?: string | null };
      };
      // Clean, not merely "degraded for the known reason". That tolerance
      // existed because Kanna spawned `opencode run --interactive`, which drew
      // no TUI and exited at the end of its first turn: the wrap-up was echoed
      // by the tty, never became a turn, and the sequence could only ever
      // degrade. The spawn now runs the real interactive TUI, so the whole
      // sequence has to complete.
      expect(
        payload.finalization?.cleanly_finalized,
        `the finalization degraded: ${payload.finalization?.degraded_reason ?? "(no reason)"}`,
      ).toBe(true);

      // The wrap-up is minutes of user-visible latency, so the source task's
      // event feed has to make it legible as a transfer rather than as a hung
      // task. Every step is reachable now that the source session is a real
      // TUI: the daemon can report it `Idle`, which is what unblocks the quit.
      // While the spawn was a one-shot, the run ended at `wrap-up-sent`.
      const phases = await finalizationPhases(task.id);
      expect(phases).toEqual(["wrap-up-sent", "idle", "quit-sent", "exited"]);

      // And the shipped conversation carries it: the wrap-up Kanna typed, and
      // the agent's answer to it, both on the destination machine.
      const worktree = await destinationWorktree(destinationTaskId);
      const conversation = await exportOpencodeSession(sourceSessionId, worktree);
      expect(opencodeSessionText(conversation, "user")).toContain(WRAP_UP_PHRASE);
      expect(
        assistantAnsweredTheWrapUp(conversation),
        `the shipped conversation has no assistant turn after the wrap-up, so the agent was `
        + `cut off rather than wrapped up:\n${opencodeSessionText(conversation).slice(-2000)}`,
      ).toBe(true);
    }, 900_000);
  },
);

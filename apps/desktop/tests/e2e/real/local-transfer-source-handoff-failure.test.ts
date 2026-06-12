import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { pauseForSlowMode } from "../helpers/slowMode";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi, pushSelectedTaskToPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";

interface TransferPeer {
  peer_id?: string;
  peerId?: string;
}

interface PipelineRow {
  id: string;
  stage: string;
  closed_at: string | null;
}

interface TransferRow {
  id: string;
  direction: string;
  status: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  local_task_id: string | null;
  payload_json?: string | null;
}

interface VueCallError {
  __error: string;
}

let testRepoPath = "";

function isVueCallError(value: unknown): value is VueCallError {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as VueCallError).__error === "string",
  );
}

function readPeerId(peer: TransferPeer): string | null {
  if (typeof peer.peer_id === "string" && peer.peer_id.length > 0) return peer.peer_id;
  if (typeof peer.peerId === "string" && peer.peerId.length > 0) return peer.peerId;
  return null;
}

async function waitForPeer(peerId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await tauriInvoke(primary, "list_transfer_peers");
    if (Array.isArray(raw) && raw.some((peer) => readPeerId(peer as TransferPeer) === peerId)) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for peer ${peerId}`);
}

async function waitForSecondaryIncomingTransferPending(
  sourceTaskId: string,
  timeoutMs = 20_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id, payload_json
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    const row = rows[0];
    if (row?.status === "pending" && typeof row.id === "string" && row.id.length > 0) {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for secondary transfer to remain pending for ${sourceTaskId}`);
}

async function assertPrimaryTaskRemainsOpen(
  taskId: string,
  durationMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    const taskRows = (await queryDb(
      primary,
      "SELECT id, stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as PipelineRow[];
    expect(taskRows[0]).toMatchObject({
      id: taskId,
      stage: "in progress",
      closed_at: null,
    });

    const transferRows = (await queryDb(
      primary,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id
         FROM task_transfer
        WHERE direction = 'outgoing' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [taskId],
    )) as TransferRow[];
    expect(transferRows[0]).toMatchObject({
      direction: "outgoing",
      status: "pending",
      source_peer_id: "peer-primary",
      source_task_id: taskId,
      local_task_id: taskId,
    });

    await sleep(250);
  }
}

async function deleteSessionIfRunning(client: { deleteSession(): Promise<void> }): Promise<void> {
  await client.deleteSession().catch(() => undefined);
}

async function failNextIncomingTransferAutoApproval(): Promise<void> {
  const result = await secondary.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     const originalApprove = ctx.store.approveIncomingTransfer.bind(ctx.store);
     ctx.store.approveIncomingTransfer = async () => {
       ctx.store.approveIncomingTransfer = originalApprove;
       throw new Error("simulated destination import failure before acknowledgment");
     };
     cb("ok");`,
  );
  if (result !== "ok") {
    throw new Error(`failed to install incoming transfer failure hook: ${result}`);
  }
}

const { primary, secondary } = createPrimaryAndSecondaryClients();

describe("local transfer source handoff failure", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-source-handoff-failure");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-source");
    await pauseForSlowMode("repo imported into primary");
  });

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await deleteSessionIfRunning(primary);
    await deleteSessionIfRunning(secondary);
  });

  it("keeps the source task open when the destination import fails before acknowledgment", async () => {
    await waitForPeer("peer-secondary");
    await pauseForSlowMode("secondary peer discovered");
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });

    // Direct task creation is setup-only: the product has no UI path for creating an inert
    // transfer fixture task without also launching a real agent session.
    const createResult = await callVueMethod(primary, "store.createItem", repoId, testRepoPath, "Keep source open", "agent");
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }

    const sourceRows = (await queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      ["Keep source open"],
    )) as Array<{ id: string }>;
    const sourceTaskId = sourceRows[0]?.id;
    if (!sourceTaskId) {
      throw new Error("expected source task to be created");
    }
    await callVueMethod(primary, "store.selectItem", sourceTaskId);
    await pauseForSlowMode("task created on primary");

    await failNextIncomingTransferAutoApproval();
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");
    await pauseForSlowMode("task pushed to secondary");

    const pendingTransfer = await waitForSecondaryIncomingTransferPending(sourceTaskId);
    await pauseForSlowMode("incoming transfer auto-import failed on secondary");

    const secondaryTransferRows = (await queryDb(
      secondary,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id
         FROM task_transfer
        WHERE id = ?`,
      [pendingTransfer.id],
    )) as TransferRow[];
    expect(secondaryTransferRows[0]).toMatchObject({
      id: pendingTransfer.id,
      direction: "incoming",
      status: "pending",
      source_peer_id: "peer-primary",
      source_task_id: sourceTaskId,
    });
    expect(secondaryTransferRows[0]?.local_task_id).toBeNull();

    await assertPrimaryTaskRemainsOpen(sourceTaskId);
  });
});

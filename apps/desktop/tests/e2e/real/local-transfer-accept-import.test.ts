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
  prompt: string | null;
  branch: string | null;
  stage: string;
  display_name: string | null;
  closed_at?: string | null;
}

interface TransferRow {
  id: string;
  direction: string;
  status: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  local_task_id: string | null;
  completed_at?: string | null;
}

interface ProvenanceRow {
  pipeline_item_id: string;
  source_peer_id: string;
  source_task_id: string;
  source_machine_task_label: string | null;
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

async function waitForPrimaryOutgoingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 20_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      primary,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id, completed_at
         FROM task_transfer
        WHERE direction = 'outgoing' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    const row = rows[0];
    if (row?.status === "completed") {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for outgoing transfer to complete for ${sourceTaskId}`);
}

async function waitForPrimaryTaskClosed(
  taskId: string,
  timeoutMs = 20_000,
): Promise<PipelineRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      primary,
      "SELECT id, stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as PipelineRow[];
    const row = rows[0];
    // closed_at is the sole done indicator — closing never rewrites stage.
    if (typeof row?.closed_at === "string" && row.closed_at.length > 0) {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for source task ${taskId} to close`);
}

async function deleteSessionIfRunning(client: { deleteSession(): Promise<void> }): Promise<void> {
  await client.deleteSession().catch(() => undefined);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();

describe("local transfer accept import", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-accept-import");
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

  it("approves the incoming transfer and imports a new local task on secondary", async () => {
    await waitForPeer("peer-secondary");
    await pauseForSlowMode("secondary peer discovered");
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });

    // Direct task creation is setup-only: the product has no UI path for creating an inert
    // transfer fixture task without also launching a real agent session.
    const createResult = await callVueMethod(primary, "store.createItem", repoId, testRepoPath, "Say OK", "agent");
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }

    const sourceRows = (await queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      ["Say OK"],
    )) as PipelineRow[];
    const sourceTaskId = sourceRows[0]?.id;
    if (!sourceTaskId) {
      throw new Error("expected source task to be created");
    }
    await callVueMethod(primary, "store.selectItem", sourceTaskId);
    await pauseForSlowMode("task created on primary");

    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");
    await pauseForSlowMode("task pushed to secondary");

    const transferRow = await waitForSecondaryIncomingTransferCompleted(sourceTaskId);
    expect(transferRow).toMatchObject({
      direction: "incoming",
      status: "completed",
      source_peer_id: "peer-primary",
      source_task_id: sourceTaskId,
    });
    expect(typeof transferRow?.local_task_id).toBe("string");
    expect(transferRow?.local_task_id?.length ?? 0).toBeGreaterThan(0);

    const importedRows = (await queryDb(
      secondary,
      "SELECT id, prompt, branch, stage, display_name FROM pipeline_item WHERE id = ?",
      [transferRow?.local_task_id],
    )) as PipelineRow[];
    expect(importedRows[0]).toMatchObject({
      id: transferRow?.local_task_id,
      prompt: "Say OK",
      branch: transferRow?.local_task_id ? `task-${transferRow.local_task_id}` : null,
      stage: "in progress",
      display_name: null,
    });

    const provenanceRows = (await queryDb(
      secondary,
      "SELECT pipeline_item_id, source_peer_id, source_task_id, source_machine_task_label FROM task_transfer_provenance WHERE pipeline_item_id = ?",
      [transferRow?.local_task_id],
    )) as ProvenanceRow[];
    expect(provenanceRows[0]).toMatchObject({
      pipeline_item_id: transferRow?.local_task_id,
      source_peer_id: "peer-primary",
      source_task_id: sourceTaskId,
      source_machine_task_label: sourceTaskId ? `task-${sourceTaskId}` : null,
    });

    const primaryOutgoingTransfer = await waitForPrimaryOutgoingTransferCompleted(sourceTaskId);
    expect(primaryOutgoingTransfer).toMatchObject({
      direction: "outgoing",
      status: "completed",
      source_peer_id: "peer-primary",
      source_task_id: sourceTaskId,
      local_task_id: sourceTaskId,
    });
    expect(primaryOutgoingTransfer.completed_at).toBeTruthy();

    const closedSourceTask = await waitForPrimaryTaskClosed(sourceTaskId);
    expect(closedSourceTask).toMatchObject({
      id: sourceTaskId,
      // The stage keeps its last real value; closed_at marks the close.
      stage: "in progress",
    });
    expect(closedSourceTask.closed_at).toBeTruthy();
  });
});

async function waitForSecondaryIncomingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 20_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    const row = rows[0];
    if (row?.status === "completed") {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for incoming transfer to complete for ${sourceTaskId}`);
}

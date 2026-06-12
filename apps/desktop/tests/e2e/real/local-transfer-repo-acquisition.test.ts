import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

interface TransferRow {
  id: string;
  direction: string;
  status: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  local_task_id: string | null;
  payload_json?: string | null;
}

interface PipelineRow {
  id: string;
  stage: string;
  closed_at: string | null;
}

interface RepoRow {
  path: string;
}

interface VueCallError {
  __error: string;
}

let testRepoPath = "";

const { primary, secondary } = createPrimaryAndSecondaryClients();

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

async function waitForLatestTransfer(
  client: typeof primary,
  direction: "incoming" | "outgoing",
  sourceTaskId: string,
  expectedStatus: "pending" | "completed",
  timeoutMs = 20_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      `SELECT id, direction, status, source_peer_id, source_task_id, local_task_id, payload_json
         FROM task_transfer
        WHERE direction = ? AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [direction, sourceTaskId],
    )) as TransferRow[];
    const row = rows[0];
    if (row?.status === expectedStatus) {
      return row;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for ${direction} transfer ${expectedStatus} for ${sourceTaskId}`);
}

async function waitForPrimaryTaskClosed(taskId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      primary,
      "SELECT id, stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as PipelineRow[];
    const row = rows[0];
    if (row?.stage === "done" && typeof row.closed_at === "string" && row.closed_at.length > 0) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for source task ${taskId} to close`);
}

async function deleteSessionIfRunning(client: { deleteSession(): Promise<void> }): Promise<void> {
  await client.deleteSession().catch(() => undefined);
}

async function createSourceTask(repoId: string, repoPath: string, prompt: string): Promise<string> {
  // Direct task creation is setup-only: the product has no UI path for creating an inert
  // transfer fixture task without also launching a real agent session.
  const createResult = await callVueMethod(primary, "store.createItem", repoId, repoPath, prompt, "agent");
  if (isVueCallError(createResult)) {
    throw new Error(createResult.__error);
  }

  const rows = (await queryDb(
    primary,
    "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
    [prompt],
  )) as Array<{ id: string }>;
  const sourceTaskId = rows[0]?.id;
  if (!sourceTaskId) {
    throw new Error(`task not found for prompt ${prompt}`);
  }
  await callVueMethod(primary, "store.selectItem", sourceTaskId);
  return sourceTaskId;
}

async function pushAndApproveTransfer(sourceTaskId: string): Promise<TransferRow> {
  await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

  return waitForLatestTransfer(secondary, "incoming", sourceTaskId, "completed");
}

describe("local transfer repo acquisition", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
  });

  beforeEach(async () => {
    await resetDatabase(primary);
    await resetDatabase(secondary);
    await waitForPeer("peer-secondary");
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });
  });

  afterEach(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
      await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
      testRepoPath = "";
    }
  });

  afterAll(async () => {
    await deleteSessionIfRunning(primary);
    await deleteSessionIfRunning(secondary);
  });

  it("reuses an existing matching repo on secondary before importing a transfer", async () => {
    testRepoPath = await createFixtureRepo("local-transfer-reuse-local");
    const repoId = await importTestRepo(primary, testRepoPath, "local-transfer-reuse-primary");
    await importTestRepo(secondary, testRepoPath, "local-transfer-reuse-secondary");
    await pauseForSlowMode("reuse-local fixture imported into both instances");

    const sourceTaskId = await createSourceTask(repoId, testRepoPath, "Reuse repo on destination");
    const incomingTransfer = await pushAndApproveTransfer(sourceTaskId);
    expect(incomingTransfer.local_task_id).toBeTruthy();

    const repoRows = (await queryDb(
      secondary,
      `SELECT repo.path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [incomingTransfer.local_task_id],
    )) as RepoRow[];
    expect(repoRows[0]?.path).toBe(testRepoPath);

    const outgoingTransfer = await waitForLatestTransfer(primary, "outgoing", sourceTaskId, "completed");
    expect(outgoingTransfer.status).toBe("completed");

    await waitForPrimaryTaskClosed(sourceTaskId);
  });

  it("clones the repo into ~/.kanna/repos on secondary before importing a clone-remote transfer", async () => {
    testRepoPath = await createFixtureRepo("local-transfer-clone-remote");
    const repoId = await importTestRepo(primary, testRepoPath, "local-transfer-clone-remote");
    await pauseForSlowMode("clone-remote fixture imported into primary");

    const sourceTaskId = await createSourceTask(repoId, testRepoPath, "Clone repo on destination");
    const incomingTransfer = await pushAndApproveTransfer(sourceTaskId);
    expect(incomingTransfer.local_task_id).toBeTruthy();

    const repoRows = (await queryDb(
      secondary,
      `SELECT repo.path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [incomingTransfer.local_task_id],
    )) as RepoRow[];
    const importedRepoPath = repoRows[0]?.path;
    expect(importedRepoPath).toBeTruthy();
    expect(importedRepoPath).not.toBe(testRepoPath);
    expect(importedRepoPath).toContain(`${homedir()}/.kanna/repos/local-transfer-clone-remote`);

    const outgoingTransfer = await waitForLatestTransfer(primary, "outgoing", sourceTaskId, "completed");
    expect(outgoingTransfer.payload_json).toBeTruthy();
    const outgoingPayload = JSON.parse(outgoingTransfer.payload_json ?? "{}") as {
      repo?: { mode?: string; remote_url?: string | null };
    };
    expect(outgoingPayload.repo).toMatchObject({
      mode: "clone-remote",
    });
    expect(typeof outgoingPayload.repo?.remote_url).toBe("string");

    await waitForPrimaryTaskClosed(sourceTaskId);
  });

  it("transfers a bundle into ~/.kanna/repos on secondary when no origin remote exists", async () => {
    testRepoPath = await createFixtureRepo("local-transfer-bundle-repo");
    const removeOrigin = await tauriInvoke(primary, "run_script", {
      script: "git remote remove origin",
      cwd: testRepoPath,
      env: {},
    });
    if (isVueCallError(removeOrigin)) {
      throw new Error(removeOrigin.__error);
    }

    const repoId = await importTestRepo(primary, testRepoPath, "local-transfer-bundle-repo");
    await pauseForSlowMode("bundle fixture imported into primary");

    const sourceTaskId = await createSourceTask(repoId, testRepoPath, "Bundle repo on destination");
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

    const incomingTransfer = await waitForLatestTransfer(secondary, "incoming", sourceTaskId, "completed");
    const outgoingTransfer = await waitForLatestTransfer(primary, "outgoing", sourceTaskId, "completed");
    const outgoingPayload = JSON.parse(outgoingTransfer.payload_json ?? "{}") as {
      repo?: {
        mode?: string;
        bundle?: {
          artifact_id?: string;
          filename?: string;
        } | null;
      };
    };
    expect(outgoingPayload.repo).toMatchObject({
      mode: "bundle-repo",
    });
    expect(outgoingPayload.repo?.bundle?.artifact_id).toBeTruthy();
    expect(outgoingPayload.repo?.bundle?.filename).toContain(".bundle");
    expect(incomingTransfer.local_task_id).toBeTruthy();

    const repoRows = (await queryDb(
      secondary,
      `SELECT repo.path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [incomingTransfer.local_task_id],
    )) as RepoRow[];
    const importedRepoPath = repoRows[0]?.path;
    expect(importedRepoPath).toBeTruthy();
    expect(importedRepoPath).not.toBe(testRepoPath);
    expect(importedRepoPath).toContain(`${homedir()}/.kanna/repos/local-transfer-bundle-repo`);

    await waitForPrimaryTaskClosed(sourceTaskId);
  });
});

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
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
  display_name?: string;
  displayName?: string;
}

interface PipelineRow {
  id: string;
}

interface TransferRow {
  id: string;
  direction: string;
  status: string;
  source_task_id: string;
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

function readPeerDisplayName(peer: TransferPeer): string | null {
  if (typeof peer.display_name === "string" && peer.display_name.length > 0) return peer.display_name;
  if (typeof peer.displayName === "string" && peer.displayName.length > 0) return peer.displayName;
  return null;
}

async function waitForPeer(
  peerId: string,
  timeoutMs = 20_000,
): Promise<TransferPeer[]> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await tauriInvoke(primary, "list_transfer_peers");
    if (Array.isArray(raw)) {
      const peers = raw as TransferPeer[];
      if (peers.some((peer) => readPeerId(peer) === peerId)) {
        return peers;
      }
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for peer ${peerId}`);
}

async function deleteSessionIfRunning(client: { deleteSession(): Promise<void> }): Promise<void> {
  await client.deleteSession().catch(() => undefined);
}

const execFileAsync = promisify(execFile);

async function runCommandOutput(command: string, args: string[]): Promise<string> {
  return await execFileAsync(command, args)
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
}

// The sidecar owns one loopback listener per instance, so its port identifies
// the process this desktop's transfers run through — a name or a bare process
// list would match every Kanna instance on the machine.
async function transferSidecarPid(): Promise<number | null> {
  const port = String(
    await tauriInvoke(primary, "read_env_var", { name: "KANNA_TRANSFER_PORT" }),
  ).trim();
  if (!port) throw new Error("primary instance has no KANNA_TRANSFER_PORT");
  const output = await runCommandOutput("/usr/sbin/lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  const pid = Number.parseInt(output.split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) ? pid : null;
}

async function waitForTransferSidecarPid(
  predicate: (pid: number) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await transferSidecarPid();
    if (pid !== null && predicate(pid)) return pid;
    await sleep(250);
  }
  throw new Error("timed out waiting for the transfer sidecar to listen");
}

async function parentCommand(pid: number): Promise<string> {
  const parent = Number.parseInt(await runCommandOutput("/bin/ps", ["-o", "ppid=", "-p", String(pid)]), 10);
  if (!Number.isFinite(parent)) return "";
  return await runCommandOutput("/bin/ps", ["-o", "comm=", "-p", String(parent)]);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();

describe("local transfer first milestone", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-source");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-source");
    await pauseForSlowMode("repo imported into primary");
  });

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await deleteSessionIfRunning(primary);
    await deleteSessionIfRunning(secondary);
  });

  it("lists the secondary peer and persists an incoming transfer on the secondary instance", async () => {
    const peers = await waitForPeer("peer-secondary");
    expect(peers.some((peer) => readPeerId(peer) === "peer-secondary")).toBe(true);
    expect(peers.some((peer) => readPeerDisplayName(peer) === "Secondary")).toBe(true);
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

    const rows = (await queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      ["Say OK"],
    )) as PipelineRow[];
    const taskId = rows[0]?.id;
    if (!taskId) {
      throw new Error("expected source task to be created");
    }
    await callVueMethod(primary, "store.selectItem", taskId);
    await pauseForSlowMode("task created on primary");

    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");
    await pauseForSlowMode("task pushed to secondary");

    const transferRow = await waitForIncomingTransferCompleted(taskId);
    expect(transferRow).toMatchObject({
      direction: "incoming",
      status: "completed",
      source_task_id: taskId,
    });
    expect(typeof transferRow.id).toBe("string");
    expect(transferRow.id.length).toBeGreaterThan(0);
  });

  it("runs the sidecar under kanna-server and respawns it after a crash", async () => {
    // A control call is what makes the sidecar exist; the transfer above has
    // already done that, so this only re-asserts it is up.
    await tauriInvoke(primary, "list_transfer_peers");
    const originalPid = await waitForTransferSidecarPid();
    expect(await parentCommand(originalPid)).toContain("kanna-server");

    process.kill(originalPid, "SIGKILL");
    await pauseForSlowMode("transfer sidecar killed");

    // The control plane must recover on its own rather than hang: every
    // attempt either returns peers or throws, and one of them has to succeed.
    const deadline = Date.now() + 30_000;
    let lastError: unknown = null;
    let recovered = false;
    while (Date.now() < deadline && !recovered) {
      try {
        const peers = await tauriInvoke(primary, "list_transfer_peers");
        recovered = Array.isArray(peers);
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    expect(recovered, `transfer control never recovered: ${String(lastError)}`).toBe(true);

    const respawnedPid = await waitForTransferSidecarPid((pid) => pid !== originalPid);
    expect(respawnedPid).not.toBe(originalPid);
    expect(await parentCommand(respawnedPid)).toContain("kanna-server");
  });

  it("completes a transfer through the respawned sidecar", async () => {
    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "Say OK again",
      "agent",
    );
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }

    const rows = (await queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      ["Say OK again"],
    )) as PipelineRow[];
    const taskId = rows[0]?.id;
    if (!taskId) {
      throw new Error("expected the post-respawn source task to be created");
    }
    await callVueMethod(primary, "store.selectItem", taskId);
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary");

    const transferRow = await waitForIncomingTransferCompleted(taskId);
    expect(transferRow).toMatchObject({
      direction: "incoming",
      status: "completed",
      source_task_id: taskId,
    });
  });
});

async function waitForIncomingTransferCompleted(
  sourceTaskId: string,
  timeoutMs = 20_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      secondary,
      `SELECT id, direction, status, source_task_id
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [sourceTaskId],
    )) as TransferRow[];
    const row = rows[0];
    if (row?.status === "completed") return row;
    await sleep(250);
  }
  throw new Error(`timed out waiting for incoming transfer to complete for ${sourceTaskId}`);
}

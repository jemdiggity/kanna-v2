import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import {
  listPairMachineRows,
  listTransferPickerRows,
  pullSelectedTaskToThisMachineThroughUi,
  pushSelectedTaskToPeerThroughUi,
} from "../helpers/transferFlow";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";

interface TaskRow {
  id: string;
  cloud_task_id: string | null;
  closed_at: string | null;
}

interface TransferRow {
  id: string;
  status: string;
  local_task_id: string | null;
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let primaryRepoId = "";

async function setSetupState(client: typeof primary, key: string, value: unknown): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ${JSON.stringify(value)};
    if (ctx[${JSON.stringify(key)}]?.__v_isRef) ctx[${JSON.stringify(key)}].value = value;
    else ctx[${JSON.stringify(key)}] = value;
  `);
}

async function signIn(client: typeof primary): Promise<void> {
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
  await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
  await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
  await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));
  await client.waitForText(".prefs-panel", "upvote.sieve.7t@icloud.com", 15_000);
  await setSetupState(client, "showPreferencesPanel", false);
  await setSetupState(client, "maximized", false);
  await setSetupState(client, "sidebarHidden", false);
}

async function createSourceTask(prompt: string): Promise<TaskRow> {
  const result = await callVueMethod(
    primary,
    "store.createItem",
    primaryRepoId,
    testRepoPath,
    prompt,
    "sdk",
    { agentProvider: "codex", baseRef: "origin/main" },
  );
  if (typeof result !== "string") {
    throw new Error(`failed to create ${prompt}: ${JSON.stringify(result)}`);
  }
  await callVueMethod(primary, "selectSidebarItemById", result);
  const rows = await queryDb(
    primary,
    "SELECT id, cloud_task_id, closed_at FROM pipeline_item WHERE id = ?",
    [result],
  ) as TaskRow[];
  if (!rows[0]) throw new Error(`created task ${result} was not persisted`);
  return rows[0];
}

async function waitForTaskByCloudIdentity(
  client: typeof primary,
  cloudTaskId: string,
  open: boolean,
  timeoutMs = 45_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskRow[] = [];
  while (Date.now() < deadline) {
    last = await queryDb(
      client,
      "SELECT id, cloud_task_id, closed_at FROM pipeline_item WHERE cloud_task_id = ? ORDER BY created_at DESC",
      [cloudTaskId],
    ) as TaskRow[];
    const match = last.find((row) => open ? row.closed_at === null : row.closed_at !== null);
    if (match) return match;
    await sleep(250);
  }
  throw new Error(`timed out waiting for cloud task ${cloudTaskId} open=${open}: ${JSON.stringify(last)}`);
}

async function waitForLocalTaskClosed(
  client: typeof primary,
  taskId: string,
  timeoutMs = 45_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskRow[] = [];
  while (Date.now() < deadline) {
    last = await queryDb(
      client,
      "SELECT id, cloud_task_id, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    ) as TaskRow[];
    if (last[0]?.closed_at) return last[0];
    await sleep(250);
  }
  throw new Error(`timed out waiting for local task ${taskId} to close: ${JSON.stringify(last)}`);
}

async function waitForIncoming(
  client: typeof primary,
  sourceTaskId: string,
  status: string,
  timeoutMs = 45_000,
): Promise<TransferRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TransferRow[] = [];
  while (Date.now() < deadline) {
    last = await queryDb(
      client,
      `SELECT id, status, local_task_id
         FROM task_transfer
        WHERE direction = 'incoming' AND source_task_id = ?
        ORDER BY started_at DESC LIMIT 1`,
      [sourceTaskId],
    ) as TransferRow[];
    if (last[0]?.status === status) return last[0];
    await sleep(250);
  }
  throw new Error(`timed out waiting for incoming ${sourceTaskId}=${status}: ${JSON.stringify(last)}`);
}

async function selectRemoteTask(client: typeof primary, prompt: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let id = "";
  while (Date.now() < deadline) {
    id = await client.executeSync<string>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      return read(ctx.sidebarItems)?.find((item) =>
        item.prompt === ${JSON.stringify(prompt)} && item.remote_task === true
      )?.task_id || "";
    `);
    if (id) break;
    await sleep(250);
  }
  if (!id) throw new Error(`remote sidebar task not found: ${prompt}`);
  const result = await callVueMethod(client, "selectSidebarItemById", id);
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(String((result as { __error: string }).__error));
  }
}

async function failNextDestinationImport(): Promise<void> {
  await secondary.executeSync(`
    const store = window.__KANNA_E2E__.setupState.store;
    const original = store.approveIncomingTransfer.bind(store);
    window.__KANNA_E2E__.destinationImportFailureCount = 0;
    window.__KANNA_E2E__.restoreApproveIncomingTransfer = () => {
      store.approveIncomingTransfer = original;
      delete window.__KANNA_E2E__.destinationImportFailureCount;
      delete window.__KANNA_E2E__.restoreApproveIncomingTransfer;
    };
    store.approveIncomingTransfer = async () => {
      window.__KANNA_E2E__.destinationImportFailureCount += 1;
      throw new Error("simulated cloud destination import failure");
    };
  `);
}

async function waitForDestinationImportFailure(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failureCount = await secondary.executeSync<number>(
      `return window.__KANNA_E2E__.destinationImportFailureCount || 0;`,
    );
    if (failureCount > 0) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for simulated destination import failure");
}

async function interruptNextDestinationAck(): Promise<void> {
  await secondary.executeSync(`
    window.__KANNA_E2E__.failNextInvoke = "acknowledge_incoming_transfer_commit";
  `);
}

async function waitForTransferMachine(
  client: typeof primary,
  machineName: string,
  timeoutMs = 30_000,
): Promise<{ peerId: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: Array<{ peerId: string; name: string }> = [];
  while (Date.now() < deadline) {
    last = await client.executeSync(`
      const value = window.__KANNA_E2E__.setupState.transferMachines;
      return value?.__v_isRef ? value.value : value;
    `);
    const machine = last.find((candidate) => candidate.name === machineName);
    if (machine) return machine;
    await sleep(250);
  }
  throw new Error(`timed out waiting for transfer machine ${machineName}: ${JSON.stringify(last)}`);
}

async function waitForInvoke(
  client: typeof primary,
  command: string,
  timeoutMs = 10_000,
): Promise<Array<{ cmd: string; args?: unknown }>> {
  const deadline = Date.now() + timeoutMs;
  let calls: Array<{ cmd: string; args?: unknown }> = [];
  while (Date.now() < deadline) {
    calls = await client.executeSync<Array<{ cmd: string; args?: unknown }>>(
      `return window.__KANNA_E2E__.invokes?.getAll() || [];`,
    );
    if (calls.some((call) => call.cmd === command)) return calls;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${command}: ${JSON.stringify(calls)}`);
}

async function waitForBidirectionalCloudReadiness(): Promise<void> {
  await Promise.all([
    waitForTransferMachine(primary, "Secondary"),
    waitForTransferMachine(secondary, "Primary"),
  ]);
}

async function waitForCloudOwner(
  client: typeof primary,
  prompt: string,
  expectedDesktopId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastOwner = "";
  while (Date.now() < deadline) {
    lastOwner = await client.executeSync<string>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const snapshot = read(ctx.cloudSnapshot);
      const item = snapshot?.items?.find((candidate) =>
        candidate.prompt === ${JSON.stringify(prompt)}
      );
      return item ? snapshot.terminalRefs?.[item.id]?.ownerDesktopId || "" : "";
    `);
    if (lastOwner === expectedDesktopId) return;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for cloud owner ${expectedDesktopId} for ${prompt}; last owner=${lastOwner}`,
  );
}

describe("cloud task ownership transfer", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("cloud-task-transfer");
    primaryRepoId = await importTestRepo(primary, testRepoPath, "cloud-transfer-primary");
    await importTestRepo(secondary, testRepoPath, "cloud-transfer-secondary");
    await signIn(primary);
    await signIn(secondary);
    await waitForBidirectionalCloudReadiness();
  }, 240_000);

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  afterEach(async () => {
    for (const client of [primary, secondary]) {
      await client.executeSync(`
        if (window.__KANNA_E2E__) {
          window.__KANNA_E2E__.failNextInvoke = undefined;
          window.__KANNA_E2E__.restoreApproveIncomingTransfer?.();
        }
        const ctx = window.__KANNA_E2E__?.setupState;
        if (ctx?.showPeerPicker?.__v_isRef) ctx.showPeerPicker.value = false;
        if (ctx?.showCommandPalette?.__v_isRef) ctx.showCommandPalette.value = false;
      `).catch(() => undefined);
      const cancel = await client.findElements(".modal-card .btn-danger").catch(() => []);
      if (cancel[0]) await client.click(cancel[0]).catch(() => undefined);
    }
  });

  it("discovers a same-account machine through cloud, pushes ownership, then pulls it back", async () => {
    await waitForBidirectionalCloudReadiness();
    const source = await createSourceTask("Cloud push and pull");
    const cloudTaskId = source.cloud_task_id ?? source.id;

    expect(await listTransferPickerRows(primary)).toContain("Secondary");
    expect(await listPairMachineRows(primary)).not.toContain("Secondary");

    await pushSelectedTaskToPeerThroughUi(primary, "Secondary", { waitForDismissal: false });
    const firstIncoming = await waitForIncoming(secondary, source.id, "completed");
    const secondaryTask = await waitForTaskByCloudIdentity(secondary, cloudTaskId, true);
    expect(firstIncoming.local_task_id).toBe(secondaryTask.id);
    await waitForLocalTaskClosed(primary, source.id);

    const secondaryStatus = await tauriInvoke(secondary, "mobile_server_status") as { desktopId?: string };
    await waitForCloudOwner(primary, "Cloud push and pull", secondaryStatus.desktopId!);

    await selectRemoteTask(primary, "Cloud push and pull");
    await primary.executeSync(`window.__KANNA_E2E__.invokes?.clear();`);
    await secondary.executeSync(`
      window.__KANNA_E2E__.invokes?.clear();
      window.__KANNA_E2E__.events?.clear();
    `);
    await pullSelectedTaskToThisMachineThroughUi(primary);
    const pullInvokes = await waitForInvoke(primary, "request_task_pull");
    const secondaryMachine = await waitForTransferMachine(primary, "Secondary");
    expect(pullInvokes).toContainEqual(expect.objectContaining({
      cmd: "request_task_pull",
      args: expect.objectContaining({
        targetPeerId: secondaryMachine.peerId,
        sourceTaskId: secondaryTask.id,
        transport: "cloud",
      }),
    }));
    try {
      await waitForIncoming(primary, secondaryTask.id, "completed", 15_000);
    } catch (error) {
      const ownerState = await secondary.executeSync(`
        const ctx = window.__KANNA_E2E__.setupState;
        const read = (value) => value?.__v_isRef ? value.value : value;
        return {
          machines: read(ctx.transferMachines),
          source: ctx.store.items.find((item) => item.id === ${JSON.stringify(secondaryTask.id)}) || null,
          events: window.__KANNA_E2E__.events?.getAll() || [],
          invokes: window.__KANNA_E2E__.invokes?.getAll() || [],
        };
      `);
      const outgoing = await queryDb(
        secondary,
        `SELECT id, status, local_task_id, source_task_id, target_peer_id
           FROM task_transfer
          WHERE direction = 'outgoing'
          ORDER BY started_at DESC`,
      );
      throw new Error(`${String(error)} owner=${JSON.stringify(ownerState)} outgoing=${JSON.stringify(outgoing)}`);
    }
    await waitForTaskByCloudIdentity(primary, cloudTaskId, true);
    await waitForLocalTaskClosed(secondary, secondaryTask.id);
    const primaryStatus = await tauriInvoke(primary, "mobile_server_status") as { desktopId?: string };
    await waitForCloudOwner(secondary, "Cloud push and pull", primaryStatus.desktopId!);

    const primaryOpen = await queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ? AND closed_at IS NULL",
      [cloudTaskId],
    );
    const secondaryOpen = await queryDb(
      secondary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ? AND closed_at IS NULL",
      [cloudTaskId],
    );
    expect(primaryOpen).toHaveLength(1);
    expect(secondaryOpen).toHaveLength(0);
  }, 180_000);

  it("retries an interrupted acknowledgment without duplicating the imported destination", async () => {
    await waitForBidirectionalCloudReadiness();
    const source = await createSourceTask("Cloud ack retry");
    const cloudTaskId = source.cloud_task_id ?? source.id;
    await secondary.executeSync(`window.__KANNA_E2E__.invokes?.clear();`);
    await interruptNextDestinationAck();
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary", { waitForDismissal: false });
    const awaiting = await waitForIncoming(secondary, source.id, "awaiting_acknowledgment");
    const interruption = await secondary.executeSync<{
      faultPending: boolean;
      invokes: Array<{ cmd: string }>;
    }>(`
      return {
        faultPending: window.__KANNA_E2E__.failNextInvoke === "acknowledge_incoming_transfer_commit",
        invokes: window.__KANNA_E2E__.invokes?.getAll() || [],
      };
    `);
    expect(interruption.faultPending).toBe(false);
    expect(interruption.invokes).toContainEqual(expect.objectContaining({
      cmd: "acknowledge_incoming_transfer_commit",
    }));
    expect(await queryDb(
      primary,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [source.id],
    )).toEqual([{ closed_at: null }]);
    expect(await queryDb(
      secondary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ?",
      [cloudTaskId],
    )).toHaveLength(1);

    await callVueMethod(secondary, "importPendingIncomingTransfers");
    await waitForIncoming(secondary, source.id, "completed");
    expect(await queryDb(
      secondary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ?",
      [cloudTaskId],
    )).toEqual([{ id: awaiting.local_task_id }]);
    await waitForLocalTaskClosed(primary, source.id);
  }, 120_000);

  it("keeps the source open when destination import fails before acknowledgment", async () => {
    await waitForBidirectionalCloudReadiness();
    const source = await createSourceTask("Cloud import failure");
    await failNextDestinationImport();
    await pushSelectedTaskToPeerThroughUi(primary, "Secondary", { waitForDismissal: false });
    await waitForDestinationImportFailure();
    await waitForIncoming(secondary, source.id, "pending");
    const rows = await queryDb(
      primary,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [source.id],
    ) as Array<{ closed_at: string | null }>;
    expect(rows[0]?.closed_at).toBeNull();
  }, 90_000);
});

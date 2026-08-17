import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import {
  exposeRealLanRoutesBetweenInstances,
  exposeUnusablePrimaryLanRouteToSecondary,
} from "../helpers/transferRegistry";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import {
  listPairMachineRows,
  listTransferPickerRows,
  pairWithPeerThroughUi,
  pullSelectedTaskToThisMachineThroughUi,
  pushSelectedTaskToPeerThroughUi,
  waitForTransferPeerTrusted,
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
  payload_json: string | null;
}

interface RepoRow {
  id: string;
  name: string;
  path: string;
}

interface TransferMachineRow {
  peerId: string;
  name: string;
  trustSource: "paired-lan" | "same-account-cloud";
  preferredTransport: "lan" | "cloud";
  cloudFallback: boolean;
  relayDesktopId: string | null;
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let primaryRepoId = "";
let secondaryRepoId = "";
const fixtureRepoPaths = new Set<string>();

async function setSetupState(client: typeof primary, key: string, value: unknown): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ${JSON.stringify(value)};
    if (ctx[${JSON.stringify(key)}]?.__v_isRef) ctx[${JSON.stringify(key)}].value = value;
    else ctx[${JSON.stringify(key)}] = value;
  `);
}

async function signIn(client: typeof primary): Promise<void> {
  const alreadySignedIn = await client.executeSync<boolean>(`
    const value = window.__KANNA_E2E__.setupState.desktopAuthSession;
    const session = value?.__v_isRef ? value.value : value;
    return session?.getState?.().status === "signedIn";
  `);
  if (alreadySignedIn) return;
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

async function signOut(client: typeof primary): Promise<void> {
  const alreadySignedOut = await client.executeSync<boolean>(`
    const value = window.__KANNA_E2E__.setupState.desktopAuthSession;
    const session = value?.__v_isRef ? value.value : value;
    return session?.getState?.().status !== "signedIn";
  `);
  if (alreadySignedOut) return;
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
  await client.click(await client.waitForText(".account-signed-in button", "Sign out", 10_000));
  await client.waitForElement('[data-testid="account-sign-in"]', 15_000);
  await setSetupState(client, "showPreferencesPanel", false);
}

async function createTask(
  client: typeof primary,
  repoId: string,
  repoPath: string,
  prompt: string,
  baseRef = "origin/main",
): Promise<TaskRow> {
  const result = await callVueMethod(
    client,
    "store.createItem",
    repoId,
    repoPath,
    prompt,
    "sdk",
    { agentProvider: "codex", baseRef },
  );
  if (typeof result !== "string") {
    throw new Error(`failed to create ${prompt}: ${JSON.stringify(result)}`);
  }
  await callVueMethod(client, "selectSidebarItemById", result);
  const rows = await queryDb(
    client,
    "SELECT id, cloud_task_id, closed_at FROM pipeline_item WHERE id = ?",
    [result],
  ) as TaskRow[];
  if (!rows[0]) throw new Error(`created task ${result} was not persisted`);
  return rows[0];
}

async function createSourceTask(
  prompt: string,
  repoId = primaryRepoId,
  repoPath = testRepoPath,
  baseRef = "origin/main",
): Promise<TaskRow> {
  return createTask(primary, repoId, repoPath, prompt, baseRef);
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
      `SELECT id, status, local_task_id, payload_json
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

async function waitForOutgoing(
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
      `SELECT id, status, local_task_id, payload_json
         FROM task_transfer
        WHERE direction = 'outgoing' AND source_task_id = ?
        ORDER BY started_at DESC LIMIT 1`,
      [sourceTaskId],
    ) as TransferRow[];
    if (last[0]?.status === status) return last[0];
    await sleep(250);
  }
  throw new Error(`timed out waiting for outgoing ${sourceTaskId}=${status}: ${JSON.stringify(last)}`);
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

async function waitForTransferMachine(
  client: typeof primary,
  machineName: string,
  timeoutMs = 30_000,
): Promise<TransferMachineRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TransferMachineRow[] = [];
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

async function waitForTransferMachineMatching(
  client: typeof primary,
  machineName: string,
  predicate: (machine: TransferMachineRow | null) => boolean,
  timeoutMs = 30_000,
): Promise<TransferMachineRow | null> {
  const deadline = Date.now() + timeoutMs;
  let last: TransferMachineRow | null = null;
  while (Date.now() < deadline) {
    last = await client.executeSync(`
      const value = window.__KANNA_E2E__.setupState.transferMachines;
      const machines = value?.__v_isRef ? value.value : value;
      return machines?.find((candidate) => candidate.name === ${JSON.stringify(machineName)}) || null;
    `);
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for transfer machine state ${machineName}: ${JSON.stringify(last)}`);
}

async function waitForRemotePullEligibility(
  client: typeof primary,
  prompt: string,
  expected: boolean | null,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; canPull: boolean } = { found: false, canPull: false };
  while (Date.now() < deadline) {
    last = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const tasks = Array.from(read(ctx.workspaceTasksByItemId)?.values?.() || []);
      const task = tasks.find((candidate) => candidate.item?.prompt === ${JSON.stringify(prompt)});
      return {
        found: Boolean(task),
        canPull: task?.capabilities?.canPullFromMachine === true,
      };
    `);
    if (expected === null ? !last.found : last.found && last.canPull === expected) return;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for remote pull eligibility ${prompt}=${String(expected)}: ${JSON.stringify(last)}`,
  );
}

async function waitForRepoForTask(
  client: typeof primary,
  taskId: string,
  timeoutMs = 30_000,
): Promise<RepoRow> {
  const deadline = Date.now() + timeoutMs;
  let last: RepoRow[] = [];
  while (Date.now() < deadline) {
    last = await queryDb(
      client,
      `SELECT repo.id, repo.name, repo.path
         FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [taskId],
    ) as RepoRow[];
    if (last[0]) return last[0];
    await sleep(250);
  }
  throw new Error(`timed out waiting for repo imported for task ${taskId}: ${JSON.stringify(last)}`);
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

async function pushAndAssertCloudOwnershipTransfer(
  source: TaskRow,
  prompt: string,
): Promise<{
  destinationTask: TaskRow;
  incoming: TransferRow;
  outgoing: TransferRow;
}> {
  const cloudTaskId = source.cloud_task_id ?? source.id;
  await pushSelectedTaskToPeerThroughUi(primary, "Secondary", { waitForDismissal: false });
  const incoming = await waitForIncoming(secondary, source.id, "completed");
  const destinationTask = await waitForTaskByCloudIdentity(secondary, cloudTaskId, true);
  expect(incoming.local_task_id).toBe(destinationTask.id);
  const outgoing = await waitForOutgoing(primary, source.id, "completed");
  await waitForLocalTaskClosed(primary, source.id);

  const secondaryStatus = await tauriInvoke(secondary, "mobile_server_status") as { desktopId?: string };
  await waitForCloudOwner(primary, prompt, secondaryStatus.desktopId!);

  const [primaryOpen, secondaryOpen] = await Promise.all([
    queryDb(
      primary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ? AND closed_at IS NULL",
      [cloudTaskId],
    ),
    queryDb(
      secondary,
      "SELECT id FROM pipeline_item WHERE cloud_task_id = ? AND closed_at IS NULL",
      [cloudTaskId],
    ),
  ]);
  expect(primaryOpen).toHaveLength(0);
  expect(secondaryOpen).toEqual([{ id: destinationTask.id }]);
  return { destinationTask, incoming, outgoing };
}

describe("cloud task ownership transfer", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("cloud-task-transfer");
    fixtureRepoPaths.add(testRepoPath);
    primaryRepoId = await importTestRepo(primary, testRepoPath, "cloud-transfer-primary");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "cloud-transfer-secondary");
    await signIn(primary);
    await signIn(secondary);
    await waitForBidirectionalCloudReadiness();
  }, 240_000);

  afterAll(async () => {
    await resetDatabase(primary).catch(() => undefined);
    await resetDatabase(secondary).catch(() => undefined);
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    // Only fixture repos are removed here. The clones the destination acquires
    // land in the operator's real `~/.kanna/repos`, outside every E2E-owned
    // fixture base, so `cleanupFixtureRepos` refuses them by design.
    await cleanupFixtureRepos([...fixtureRepoPaths]).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  afterEach(async () => {
    for (const client of [primary, secondary]) {
      await client.executeSync(`
        if (window.__KANNA_E2E__) {
          window.__KANNA_E2E__.failNextInvoke = undefined;
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

  it("acquires a missing clone-remote repo over the cloud relay before taking ownership", async () => {
    await waitForBidirectionalCloudReadiness();
    const repoName = `cloud-task-transfer-clone-${process.pid}`;
    const repoPath = await createFixtureRepo(repoName);
    fixtureRepoPaths.add(repoPath);
    const repoId = await importTestRepo(primary, repoPath, repoName);
    const prompt = "Cloud clone repo acquisition";
    const source = await createSourceTask(prompt, repoId, repoPath);

    const { destinationTask, outgoing } = await pushAndAssertCloudOwnershipTransfer(source, prompt);
    const importedRepo = await waitForRepoForTask(secondary, destinationTask.id);
    expect(importedRepo.path).not.toBe(repoPath);
    expect(importedRepo.path).toContain(`${homedir()}/.kanna/repos/${repoName}`);

    const payload = JSON.parse(outgoing.payload_json ?? "{}") as {
      repo?: { mode?: string; remote_url?: string | null };
    };
    expect(payload.repo).toMatchObject({
      mode: "clone-remote",
    });
    expect(typeof payload.repo?.remote_url).toBe("string");
  }, 180_000);

  it("acquires a missing bundle-backed repo and artifact over the cloud relay before taking ownership", async () => {
    await waitForBidirectionalCloudReadiness();
    const repoName = `cloud-task-transfer-bundle-${process.pid}`;
    const repoPath = await createFixtureRepo(repoName);
    fixtureRepoPaths.add(repoPath);
    await tauriInvoke(primary, "run_script", {
      script: "git remote remove origin",
      cwd: repoPath,
      env: {},
    });
    const repoId = await importTestRepo(primary, repoPath, repoName);
    const prompt = "Cloud bundle repo acquisition";
    const source = await createSourceTask(prompt, repoId, repoPath, "main");

    const { destinationTask, outgoing } = await pushAndAssertCloudOwnershipTransfer(source, prompt);
    const importedRepo = await waitForRepoForTask(secondary, destinationTask.id);
    expect(importedRepo.path).not.toBe(repoPath);
    expect(importedRepo.path).toContain(`${homedir()}/.kanna/repos/${repoName}`);

    const payload = JSON.parse(outgoing.payload_json ?? "{}") as {
      repo?: {
        mode?: string;
        bundle?: { artifact_id?: string; filename?: string } | null;
      };
    };
    expect(payload.repo).toMatchObject({
      mode: "bundle-repo",
    });
    expect(payload.repo?.bundle?.artifact_id).toBeTruthy();
    expect(payload.repo?.bundle?.filename).toContain(".bundle");
  }, 180_000);

  it("falls back from an unusable preferred LAN route to cloud before creating one durable transfer", async () => {
    await waitForBidirectionalCloudReadiness();
    const source = await createSourceTask("Cloud fallback from unusable LAN");
    const removeLanRoute = await exposeUnusablePrimaryLanRouteToSecondary();
    try {
      await callVueMethod(primary, "updateLanTransferPeers", await tauriInvoke(primary, "list_transfer_peers"));
      const route = await waitForTransferMachineMatching(
        primary,
        "Secondary",
        (machine) =>
          machine?.preferredTransport === "lan"
          && machine.cloudFallback === true
          && machine.relayDesktopId !== null,
      );
      expect(route).toMatchObject({
        trustSource: "same-account-cloud",
        preferredTransport: "lan",
        cloudFallback: true,
      });
      expect(await queryDb(
        primary,
        "SELECT id FROM task_transfer WHERE direction = 'outgoing' AND source_task_id = ?",
        [source.id],
      )).toHaveLength(0);
      await pushAndAssertCloudOwnershipTransfer(source, "Cloud fallback from unusable LAN");

      // The two preflights used to be visible as renderer invokes. Preflight is
      // the engine's now, so what this asserts is the outcome the fallback
      // exists for: one durable transfer, completed, over cloud after the LAN
      // route was unusable. Which failures are eligible for the fallback at all
      // is pinned by `transfer_engine::control`'s own test — retrying a refusal
      // on another transport would be a second attempt at rejected work.
      expect(await queryDb(
        primary,
        "SELECT id, status FROM task_transfer WHERE direction = 'outgoing' AND source_task_id = ?",
        [source.id],
      )).toEqual([expect.objectContaining({ status: "completed" })]);
    } finally {
      await removeLanRoute();
    }
  }, 180_000);

  // Two tests stood here: an interrupted destination acknowledgment retrying
  // without duplicating the import, and the source staying open when the
  // destination import fails before acknowledgment. Both fault-injected by
  // replacing `store.approveIncomingTransfer` or failing the
  // `acknowledge_incoming_transfer_commit` invoke in the destination renderer —
  // seams that exist only while the renderer performs the import, which is
  // exactly what this change removed.
  //
  // The properties are still covered. The acknowledgment is single-flight per
  // work item through `transfer_work_phase`, and a *failed* one releases its
  // claim so the retry re-attempts rather than skipping to `completed` — pinned
  // by `a_released_phase_is_reclaimable_by_the_retry`. The source staying open
  // through a failed destination import is asserted end to end against a real
  // seam (a repository the destination cannot acquire) in
  // `local-transfer-source-handoff-failure.test.ts`.

  it("revokes cloud push and pull eligibility on UI sign-out without clearing paired LAN trust", async () => {
    await waitForBidirectionalCloudReadiness();
    const remoteSource = await createSourceTask("Cloud sign-out pull eligibility");
    const localSecondary = await createTask(
      secondary,
      secondaryRepoId,
      testRepoPath,
      "Cloud sign-out push eligibility",
    );
    await waitForRemotePullEligibility(secondary, "Cloud sign-out pull eligibility", true);

    await signOut(secondary);
    await Promise.all([
      waitForTransferMachineMatching(
        primary,
        "Secondary",
        (machine) =>
          machine?.trustSource === "paired-lan"
          && machine.preferredTransport === "lan"
          && machine.relayDesktopId === null,
      ),
      waitForTransferMachineMatching(secondary, "Primary", (machine) => machine === null),
      waitForRemotePullEligibility(secondary, "Cloud sign-out pull eligibility", null),
    ]);
    await callVueMethod(secondary, "selectSidebarItemById", localSecondary.id);
    expect(await listTransferPickerRows(secondary)).not.toContain("Primary");

    await signOut(primary);

    const removeRealLanRoutes = await exposeRealLanRoutesBetweenInstances();
    try {
      await expect.poll(
        () => listPairMachineRows(primary),
        { timeout: 30_000, interval: 100 },
      ).toContain("Secondary");
      await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
        promptClient: secondary,
        promptPeerId: "peer-primary",
      });
      await Promise.all([
        waitForTransferPeerTrusted(primary, "peer-secondary"),
        waitForTransferPeerTrusted(secondary, "peer-primary"),
      ]);
      // Pairing is accepted by the destination sidecar without opening its
      // picker. Refresh both renderers through the same on-demand discovery
      // path an operator uses before asserting that sign-out preserves LAN
      // eligibility; otherwise the destination can retain its pre-pairing
      // untrusted snapshot until another picker happens to open.
      expect(await listTransferPickerRows(primary)).toContain("Secondary");
      expect(await listTransferPickerRows(secondary)).toContain("Primary");

      await Promise.all([signIn(primary), signIn(secondary)]);
      await waitForBidirectionalCloudReadiness();
      await waitForTransferMachineMatching(
        primary,
        "Secondary",
        (machine) =>
          machine?.trustSource === "same-account-cloud"
          && machine.preferredTransport === "lan"
          && machine.cloudFallback === true,
      );

      await signOut(secondary);
      await Promise.all([
        waitForTransferMachineMatching(
          primary,
          "Secondary",
          (machine) =>
            machine?.trustSource === "paired-lan"
            && machine.preferredTransport === "lan"
            && machine.relayDesktopId === null,
        ),
        waitForTransferMachineMatching(
          secondary,
          "Primary",
          (machine) =>
            machine?.trustSource === "paired-lan"
            && machine.preferredTransport === "lan"
            && machine.relayDesktopId === null,
        ),
        waitForTransferPeerTrusted(primary, "peer-secondary"),
        waitForTransferPeerTrusted(secondary, "peer-primary"),
      ]);
      await callVueMethod(primary, "selectSidebarItemById", remoteSource.id);
      expect(await listTransferPickerRows(primary)).toContain("Secondary");
      expect(await listPairMachineRows(primary)).not.toContain("Secondary");
    } finally {
      await signIn(primary).catch(() => undefined);
      await signIn(secondary).catch(() => undefined);
      await removeRealLanRoutes();
    }
  }, 240_000);
});

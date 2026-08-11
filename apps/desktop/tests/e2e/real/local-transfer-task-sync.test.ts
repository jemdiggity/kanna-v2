import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dragSortableTaskToTarget } from "../helpers/sidebarDrag";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";

interface TransferPeer {
  peer_id?: string;
  peerId?: string;
  trusted?: boolean;
}

interface VueCallError {
  __error: string;
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
const WEBDRIVER_BACKSPACE = "\uE003";
let testRepoPath = "";
let secondaryRepoId = "";
const pipelineName = "lan-advance-stage-e2e";

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

async function ensurePairedPeers(): Promise<void> {
  await waitForPeer("peer-secondary");
  const raw = await tauriInvoke(primary, "list_transfer_peers");
  const peer = Array.isArray(raw)
    ? raw.find((candidate) => readPeerId(candidate as TransferPeer) === "peer-secondary") as TransferPeer | undefined
    : undefined;
  if (peer?.trusted) return;

  await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
    promptClient: secondary,
    promptPeerId: "peer-primary",
  });
}

async function waitForSidebarTask(text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sidebarText = await secondary.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (sidebarText.includes(text)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for LAN task in secondary sidebar: ${text}`);
}

async function waitForSidebarTaskToDisappear(text: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostics: unknown = null;
  while (Date.now() < deadline) {
    const items = await sidebarItemsForPrompt(secondary, text);
    if (items.length === 0) return;
    const sidebarText = await secondary.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (!sidebarText.includes(text)) return;
    lastDiagnostics = await secondary.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const closed = read(ctx.locallyClosedRemoteTaskIds);
      return JSON.parse(JSON.stringify({
        matchingSidebarItems: read(ctx.sidebarItems)?.filter((item) => item.prompt === ${JSON.stringify(text)}).map((item) => ({
          id: item.id,
          prompt: item.prompt,
          repo_id: item.repo_id,
          stage: item.stage,
        })) ?? [],
        selectedCloudItemId: read(ctx.selectedCloudItemId),
        locallyClosedRemoteTaskIds: closed instanceof Set ? Array.from(closed) : closed,
        lanSnapshotItems: read(ctx.lanSnapshot)?.items?.filter((item) => item.prompt === ${JSON.stringify(text)}).map((item) => ({
          id: item.id,
          prompt: item.prompt,
          repo_id: item.repo_id,
          stage: item.stage,
        })) ?? [],
        lanTerminalRefIds: Object.keys(read(ctx.lanSnapshot)?.terminalRefs ?? {}),
      }));
    `).catch((error: unknown) => ({ diagnosticError: String(error) }));
    await sleep(250);
  }
  throw new Error(`timed out waiting for LAN task to disappear from secondary sidebar: ${text}; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function waitForBodyText(text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await secondary.executeSync<string>(`
      return [
        document.body.innerText || "",
        document.querySelector(".xterm-rows")?.textContent || "",
        document.querySelector(".terminal-container")?.textContent || "",
      ].join("\\n");
    `);
    if (bodyText.includes(text)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for secondary body text: ${text}`);
}

async function selectSidebarTaskByTitle(client: typeof primary, title: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let visibleTitles: string[] = [];
  while (Date.now() < deadline) {
    const result = await client.executeSync<{ clicked: boolean; titles: string[] }>(`
      const title = ${JSON.stringify(title)};
      const titles = Array.from(document.querySelectorAll(".pipeline-item .item-title"))
        .map((candidate) => (candidate.textContent || "").trim())
        .filter(Boolean);
      const element = Array.from(document.querySelectorAll(".pipeline-item .item-title"))
        .find((candidate) => (candidate.textContent || "").includes(title));
      element?.closest(".pipeline-item")?.click();
      return { clicked: Boolean(element), titles };
    `);
    visibleTitles = result.titles;
    if (result.clicked) return;
    await sleep(100);
  }
  throw new Error(`timed out selecting sidebar task ${title}; visible titles: ${JSON.stringify(visibleTitles)}`);
}

async function waitForSelectedItem(client: typeof primary, itemId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSelection: unknown = null;
  while (Date.now() < deadline) {
    // Selection tracks the presentation slot id, so resolve the selected
    // workspace task and match against any of its durable identities.
    lastSelection = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const task = read(ctx.selectedWorkspaceTask);
      if (!task) return null;
      return JSON.parse(JSON.stringify({
        itemId: task.item?.id ?? null,
        localTaskId: task.localTaskId,
        remoteTaskIds: task.remoteTaskIds ?? [],
      }));
    `);
    const selection = lastSelection as {
      itemId: string | null;
      localTaskId: string | null;
      remoteTaskIds: string[];
    } | null;
    if (
      selection &&
      (selection.itemId === itemId ||
        selection.localTaskId === itemId ||
        selection.remoteTaskIds.includes(itemId))
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected item ${itemId}; last selection was ${JSON.stringify(lastSelection)}`);
}

async function countLocalTasksOnSecondary(): Promise<number> {
  const rows = await queryDb(secondary, "select count(*) as count from pipeline_item");
  return Number((rows[0] as { count?: number | string } | undefined)?.count ?? 0);
}

async function sidebarItemsForPrompt(client: typeof primary, prompt: string): Promise<Array<{
  id: string;
  prompt: string;
  repo_id: string;
  stage: string;
  isRemote: boolean;
}>> {
  // Sidebar rows carry their durable identity as task_id (slot_id is the
  // presentation identity); for remote-only tasks task_id is the synthetic
  // cloud/lan item id.
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
    return JSON.parse(JSON.stringify(value.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
      id: item.task_id,
      prompt: item.prompt,
      repo_id: item.repo_id,
      stage: item.stage,
      isRemote: (item.task_id || "").startsWith("cloud:") || (item.task_id || "").startsWith("lan:"),
    }))));
  `);
}

async function remoteDiagnosticsForPrompt(
  client: typeof primary,
  prompt: string,
): Promise<Array<{
  prompt: string;
  sources: string[];
  selectedTerminalTransport: string;
  ownerDesktopId?: string;
  ownerLocalTaskId?: string;
}>> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.remoteTaskDiagnostics?.__v_isRef
      ? ctx.remoteTaskDiagnostics.value
      : ctx.remoteTaskDiagnostics;
    return JSON.parse(JSON.stringify((value || []).filter((entry) =>
      entry.prompt === ${JSON.stringify(prompt)}
    )));
  `);
}

async function sidebarTitleTextsForPrompt(client: typeof primary, prompt: string): Promise<string[]> {
  return await client.executeSync(`
    return Array.from(document.querySelectorAll(".sidebar .pipeline-item .item-title"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text.includes(${JSON.stringify(prompt)}));
  `);
}

async function lanSnapshotItemsForPrompt(
  client: typeof primary,
  prompt: string,
): Promise<{
  items: Array<{ id?: string; prompt?: string }>;
  terminalRefs: Record<string, { ownerDesktopId?: string; ownerLocalTaskId?: string; transport?: string }>;
}> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.lanSnapshot?.__v_isRef ? ctx.lanSnapshot.value : ctx.lanSnapshot;
    const snapshot = (() => {
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    })() || {};
    const prompt = ${JSON.stringify(prompt)};
    return {
      items: (snapshot.items || []).filter((item) => item.prompt === prompt),
      terminalRefs: snapshot.terminalRefs || {},
    };
  `);
}

async function waitForSidebarTaskGroupedUnderRepo(prompt: string, repoId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastDiagnostics: unknown = null;
  while (Date.now() < deadline) {
    const items = await sidebarItemsForPrompt(secondary, prompt);
    if (items.length === 1 && items[0]?.repo_id === repoId) return;
    lastDiagnostics = await secondary.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const workspace = read(ctx.workspace);
      const lanSnapshot = read(ctx.lanSnapshot);
      return JSON.parse(JSON.stringify({
        expectedRepoId: ${JSON.stringify(repoId)},
        matchingSidebarItems: read(ctx.sidebarItems)?.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
          id: item.id,
          prompt: item.prompt,
          repo_id: item.repo_id,
          stage: item.stage,
        })) ?? [],
        workspaceTasks: workspace?.tasks?.filter((task) => task.item?.prompt === ${JSON.stringify(prompt)}).map((task) => ({
          id: task.id,
          repoKey: task.repoKey,
          logicalTaskKey: task.logicalTaskKey,
          localTaskId: task.localTaskId,
          remoteTaskIds: task.remoteTaskIds,
          itemRepoId: task.item?.repo_id,
          sourceRepoIds: task.sources?.map((source) => ({
            kind: source.kind,
            taskId: source.taskId,
            repoId: source.repoId,
            ownerLocalTaskId: source.terminalRef?.ownerLocalTaskId,
          })),
        })) ?? [],
        workspaceRepos: workspace?.repos?.map((repo) => ({
          key: repo.key,
          localRepoId: repo.localRepoId,
          remoteRepoIds: repo.remoteRepoIds,
          remoteUrlHash: repo.remoteUrlHash,
          source: repo.source,
        })) ?? [],
        lanSnapshotItems: lanSnapshot?.items?.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
          id: item.id,
          repo_id: item.repo_id,
          stage: item.stage,
        })) ?? [],
        lanSnapshotRepos: lanSnapshot?.repos?.map((repo) => ({
          id: repo.id,
          remote_url: repo.remote_url,
          remoteUrlHash: repo.remoteUrlHash,
        })) ?? [],
        lanTerminalRefs: lanSnapshot?.terminalRefs ?? {},
      }));
    `).catch((error: unknown) => ({ diagnosticError: String(error) }));
    await sleep(250);
  }
  throw new Error(`timed out waiting for LAN task ${prompt} to be grouped under repo ${repoId}; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function waitForPrimaryTaskStage(taskId: string, stage: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: unknown[] = [];
  while (Date.now() < deadline) {
    lastRows = await queryDb(
      primary,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    );
    const row = lastRows[0] as { stage?: string; closed_at?: string | null } | undefined;
    if (row?.stage === stage && row.closed_at === null) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for owner task ${taskId} stage ${stage}; rows=${JSON.stringify(lastRows)}`);
}

async function remoteTaskPinsSetting(client: typeof primary): Promise<Record<string, number>> {
  const rows = await queryDb(
    client,
    "SELECT value FROM settings WHERE key = 'remoteTaskPins'",
  ) as Array<{ value?: string }>;
  const raw = rows[0]?.value;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, number>;
}

async function pinnedZoneTaskIds(repoId: string): Promise<string[]> {
  return await secondary.executeSync<string[]>(`
    const zone = document.querySelector(
      '.sidebar .repo-section[data-repo-id="' + ${JSON.stringify(repoId)} + '"] .pinned-zone',
    );
    return Array.from(zone?.querySelectorAll(".task-subtree") ?? [])
      .map((element) => element.getAttribute("data-task-id") || "");
  `);
}

async function waitForPinnedZoneMembership(
  repoId: string,
  taskId: string,
  pinned: boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastIds: string[] = [];
  while (Date.now() < deadline) {
    lastIds = await pinnedZoneTaskIds(repoId);
    if (lastIds.includes(taskId) === pinned) return;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for task ${taskId} pinned-zone membership to become ${pinned}; zone=${JSON.stringify(lastIds)}`,
  );
}

async function waitForRemoteTaskPinSetting(
  ownerTaskId: string,
  pinned: boolean,
  timeoutMs = 15_000,
): Promise<Record<string, number>> {
  const deadline = Date.now() + timeoutMs;
  let lastPins: Record<string, number> = {};
  while (Date.now() < deadline) {
    lastPins = await remoteTaskPinsSetting(secondary);
    if ((ownerTaskId in lastPins) === pinned) return lastPins;
    await sleep(250);
  }
  const diagnostics = await secondary.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const read = (value) => value?.__v_isRef ? value.value : value;
    return JSON.parse(JSON.stringify({
      toasts: Array.from(document.querySelectorAll(".toast")).map((el) => el.textContent || ""),
      pinnedZoneIds: Array.from(document.querySelectorAll(".sidebar .pinned-zone .task-subtree"))
        .map((el) => el.getAttribute("data-task-id") || ""),
      sidebarItems: (read(ctx.sidebarItems) ?? []).map((item) => ({
        slot_id: item.slot_id,
        task_id: item.task_id,
        pinned: item.pinned,
        pin_order: item.pin_order,
        remote_task: item.remote_task,
      })),
      workspaceAliasHasRemote: Boolean(read(ctx.workspaceTasksByItemId)),
    }));
  `).catch((error: unknown) => ({ diagnosticError: String(error) }));
  throw new Error(
    `timed out waiting for remoteTaskPins[${ownerTaskId}] presence to become ${pinned}; setting=${JSON.stringify(lastPins)}; diagnostics=${JSON.stringify(diagnostics)}`,
  );
}

async function waitForSelectedTask(client: typeof primary, taskId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let selectedTaskId: string | null = null;
  while (Date.now() < deadline) {
    selectedTaskId = await client.executeSync<string | null>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const store = ctx.store?.__v_isRef ? ctx.store.value : ctx.store;
      const value = store?.selectedTaskId;
      return (value?.__v_isRef ? value.value : value) ?? null;
    `);
    if (selectedTaskId === taskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${taskId}; last selected task was ${selectedTaskId}`);
}

async function clearImportSeededTasks(client: typeof primary, targetRepoId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ?",
      [targetRepoId],
    ) as unknown[];
    if (rows.length > 0) break;
    await sleep(200);
  }
  await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [targetRepoId]);
  const reloadResult = await callVueMethod(client, "store.reloadSnapshot");
  if (isVueCallError(reloadResult)) {
    throw new Error(reloadResult.__error);
  }
}

async function closeOpenPrimaryTaskByPrompt(prompt: string): Promise<void> {
  const rows = await queryDb(
    primary,
    "SELECT id FROM pipeline_item WHERE prompt = ? AND closed_at IS NULL",
    [prompt],
  ) as Array<{ id: string }>;
  const taskId = rows[0]?.id;
  if (!taskId) return;
  await selectSidebarTaskByTitle(primary, prompt);
  await waitForSelectedTask(primary, taskId);
  const closeResult = await callVueMethod(primary, "closeSelectedWorkspaceTask");
  if (isVueCallError(closeResult)) {
    throw new Error(closeResult.__error);
  }
  await waitForSidebarTaskToDisappear(prompt);
}

async function waitForSecondaryRemoteTaskStage(prompt: string, stage: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastItems: unknown[] = [];
  while (Date.now() < deadline) {
    lastItems = await sidebarItemsForPrompt(secondary, prompt);
    const item = lastItems[0] as { stage?: string; isRemote?: boolean } | undefined;
    if (lastItems.length === 1 && item?.stage === stage && item.isRemote === true) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for secondary remote task ${prompt} stage ${stage}; items=${JSON.stringify(lastItems)}`);
}

describe("local transfer task sync", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-task-sync");
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await writeFile(
      join(kannaDir, "pipelines", `${pipelineName}.json`),
      JSON.stringify({
        name: "LAN Advance Stage E2E",
        stages: [
          { name: "in progress", transition: "manual" },
          {
            name: "qa",
            transition: "manual",
            mode: "continue",
            prompt: "Continue LAN remote stage advance",
          },
        ],
      }),
    );
    // Repo definitions are resolved from origin/<default_branch>, so the
    // pipeline must be committed and pushed to the fixture origin.
    for (const args of [
      ["add", ".kanna"],
      ["commit", "-m", "test: add LAN advance stage pipeline"],
      ["push", "origin", "main"],
    ]) {
      const result = spawnSync("git", args, { cwd: testRepoPath, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
    }
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-task-sync-source");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "local-transfer-task-sync-secondary");
    // Repo import seeds a setup task on each instance (asynchronously, after
    // the import call returns). These tests assert LAN-only task visibility,
    // so wait for each seeded task and clear both instances back to zero
    // local tasks.
    await clearImportSeededTasks(primary, repoId);
    await clearImportSeededTasks(secondary, secondaryRepoId);
    await ensurePairedPeers();
  });

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("shows a primary task on a paired LAN peer without importing it locally", async () => {
    expect(await countLocalTasksOnSecondary()).toBe(0);

    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "LAN visible task",
      "agent",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }
    await tauriInvoke(primary, "spawn_session", {
      sessionId: createResult,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "--login",
        "-c",
        "printf 'LAN terminal ready from primary\\n'; read line; printf 'LAN terminal input:%s\\n' \"$line\"; sleep 60",
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    await waitForSidebarTask("LAN visible task");
    await waitForSidebarTaskGroupedUnderRepo("LAN visible task", secondaryRepoId);
    expect(await sidebarItemsForPrompt(primary, "LAN visible task")).toEqual([
      expect.objectContaining({
        id: createResult,
        repo_id: repoId,
        isRemote: false,
        stage: "in progress",
      }),
    ]);
    expect(await sidebarTitleTextsForPrompt(primary, "LAN visible task")).toEqual([
      "LAN visible task",
    ]);
    expect(await sidebarItemsForPrompt(secondary, "LAN visible task")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:lan:/),
        repo_id: secondaryRepoId,
        isRemote: true,
        stage: "in progress",
      }),
    ]);
    const lanDiagnostics = await remoteDiagnosticsForPrompt(secondary, "LAN visible task");
    expect(lanDiagnostics).toContainEqual(expect.objectContaining({
      selectedTerminalTransport: "lan",
      sources: expect.arrayContaining(["lan"]),
    }));
    const secondarySidebarTitles = await sidebarTitleTextsForPrompt(secondary, "LAN visible task");
    expect(secondarySidebarTitles).toHaveLength(1);
    expect(secondarySidebarTitles[0]).toMatch(/^< LAN visible task(?:\s|$)/);
    expect(await countLocalTasksOnSecondary()).toBe(0);

    const snapshot = await secondary.executeSync<{
      items?: Array<{ prompt?: string }>;
      terminalRefs?: Record<string, { ownerDesktopId?: string; ownerLocalTaskId?: string; transport?: string }>;
    }>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const value = ctx.lanSnapshot?.__v_isRef ? ctx.lanSnapshot.value : ctx.lanSnapshot;
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    `);
    const item = snapshot.items?.find((candidate) => candidate.prompt === "LAN visible task");
    expect(item).toBeTruthy();
    expect(Object.values(snapshot.terminalRefs ?? {})).toContainEqual(
      expect.objectContaining({
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: createResult,
        transport: "lan",
      }),
    );

    const primaryLanSnapshot = await lanSnapshotItemsForPrompt(primary, "LAN visible task");
    expect(primaryLanSnapshot.items).toEqual([]);
    expect(Object.values(primaryLanSnapshot.terminalRefs)).not.toContainEqual(
      expect.objectContaining({
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: createResult,
        transport: "lan",
      }),
    );

    const remoteItemId = Object.entries(snapshot.terminalRefs ?? {})
      .find(([, ref]) => ref.ownerLocalTaskId === createResult)?.[0];
    expect(remoteItemId).toBeTruthy();
    await selectSidebarTaskByTitle(secondary, "LAN visible task");
    await waitForSelectedItem(secondary, remoteItemId);
    expect(await secondary.findElements(".shell-modal")).toHaveLength(0);
    await secondary.executeSync(buildGlobalKeydownScript({ key: "j", meta: true }));
    const warningToast = await secondary.waitForText(
      ".toast.warning",
      "Shell is only available for local tasks.",
      5_000,
    );
    expect(await secondary.getText(warningToast)).toContain("Shell is only available for local tasks.");
    expect(await secondary.findElements(".shell-modal")).toHaveLength(0);

    await waitForBodyText("LAN terminal ready from primary");
    const terminalTextarea = await secondary.waitForElement(".xterm-helper-textarea");
    await secondary.sendKeys(terminalTextarea, "hello from secondx");
    await secondary.pressKey(WEBDRIVER_BACKSPACE);
    await secondary.sendKeys(terminalTextarea, "ary\n");
    await waitForBodyText("LAN terminal input:hello from secondary");

    const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
    if (isVueCallError(closeResult)) {
      throw new Error(closeResult.__error);
    }
    await waitForSidebarTaskToDisappear("LAN visible task");
  });

  it("advances a reachable LAN task on the owning desktop when secondary presses Cmd+S", async () => {
    expect(await countLocalTasksOnSecondary()).toBe(0);

    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "LAN advance stage task",
      "agent",
      {
        agentProvider: "codex",
        baseRef: "origin/main",
        pipelineName,
      },
    );
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }
    const taskId = String(createResult);

    await tauriInvoke(primary, "spawn_session", {
      sessionId: taskId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "--login",
        "-c",
        "printf 'LAN advance terminal ready\\n'; while IFS= read -r line; do printf 'LAN advance input:%s\\n' \"$line\"; done",
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    await waitForSidebarTask("LAN advance stage task");
    await waitForSidebarTaskGroupedUnderRepo("LAN advance stage task", secondaryRepoId);
    expect(await sidebarItemsForPrompt(primary, "LAN advance stage task")).toEqual([
      expect.objectContaining({
        id: taskId,
        repo_id: repoId,
        isRemote: false,
        stage: "in progress",
      }),
    ]);
    expect(await sidebarItemsForPrompt(secondary, "LAN advance stage task")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:lan:/),
        repo_id: secondaryRepoId,
        isRemote: true,
        stage: "in progress",
      }),
    ]);
    expect(await countLocalTasksOnSecondary()).toBe(0);

    await selectSidebarTaskByTitle(secondary, "LAN advance stage task");
    await secondary.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));

    await waitForPrimaryTaskStage(taskId, "qa");
    await waitForSecondaryRemoteTaskStage("LAN advance stage task", "qa");

    expect(await countLocalTasksOnSecondary()).toBe(0);
    expect(await sidebarItemsForPrompt(secondary, "LAN advance stage task")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:lan:/),
        repo_id: secondaryRepoId,
        isRemote: true,
        stage: "qa",
      }),
    ]);
  });

  it("pins a remote-only LAN task on the viewer, persists it across reload, and never mutates the owner", async () => {
    // The published LAN snapshot derives one synthetic id per peer task
    // stream, so keep a single open owner task while this test drives pins.
    // Close every open owner task, including leftovers from earlier tests.
    const openPrimaryRows = await queryDb(
      primary,
      "SELECT prompt FROM pipeline_item WHERE closed_at IS NULL",
    ) as Array<{ prompt: string }>;
    for (const row of openPrimaryRows) {
      await closeOpenPrimaryTaskByPrompt(row.prompt);
    }

    // Seed a pinned local anchor on the viewer: it gives the pinned zone a
    // real drop rect for the drag gesture and makes the reorder path persist
    // a mixed local/remote pinned list.
    const anchorTaskId = "lan-pin-local-anchor";
    await execDb(
      secondary,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        anchorTaskId,
        secondaryRepoId,
        "Local pinned anchor",
        "Local pinned anchor",
        "in progress",
        "agent",
        "idle",
        1,
        0,
        null,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
      ],
    );
    const reloadResult = await callVueMethod(secondary, "store.reloadSnapshot");
    if (isVueCallError(reloadResult)) {
      throw new Error(reloadResult.__error);
    }
    await secondary.waitForText(".sidebar", "Local pinned anchor", 10_000);
    await waitForPinnedZoneMembership(secondaryRepoId, anchorTaskId, true);

    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "LAN pin persistence task",
      "agent",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (isVueCallError(createResult)) {
      throw new Error(createResult.__error);
    }
    const ownerTaskId = String(createResult);

    await waitForSidebarTask("LAN pin persistence task");
    await waitForSidebarTaskGroupedUnderRepo("LAN pin persistence task", secondaryRepoId);
    const remoteItems = await sidebarItemsForPrompt(secondary, "LAN pin persistence task");
    expect(remoteItems).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:lan:/),
        repo_id: secondaryRepoId,
        isRemote: true,
      }),
    ]);
    const remoteItemId = remoteItems[0].id;
    expect(await remoteTaskPinsSetting(secondary)).toEqual({});
    await waitForPinnedZoneMembership(secondaryRepoId, remoteItemId, false);

    // Drag the remote task from its stage group into the pinned zone.
    const repoSelector = `.sidebar .repo-section[data-repo-id="${secondaryRepoId}"]`;
    const remoteStageRowSelector = `${repoSelector} .type-zone .task-subtree[data-task-id="${remoteItemId}"]`;
    const pinnedAnchorSelector = `${repoSelector} .pinned-zone .task-subtree[data-task-id="${anchorTaskId}"]`;
    await secondary.waitForElement(remoteStageRowSelector, 10_000);
    await secondary.waitForElement(pinnedAnchorSelector, 10_000);
    // Cross-list drops must land off the target's exact vertical center or
    // SortableJS treats the hover as a no-op; bias into the lower half.
    await dragSortableTaskToTarget(secondary, remoteStageRowSelector, pinnedAnchorSelector, {
      targetVerticalBias: 0.25,
    });

    // The viewer persists the pin in its remoteTaskPins setting, keyed by the
    // owner-side durable task id, and renders the task in the pinned zone.
    const pins = await waitForRemoteTaskPinSetting(ownerTaskId, true);
    await waitForPinnedZoneMembership(secondaryRepoId, remoteItemId, true);

    // The mixed pinned list persists one consistent order across the local
    // pipeline_item row and the remote overlay entry.
    const anchorRows = await queryDb(
      secondary,
      "SELECT pinned, pin_order FROM pipeline_item WHERE id = ?",
      [anchorTaskId],
    ) as Array<{ pinned: number; pin_order: number | null }>;
    expect(anchorRows[0]?.pinned).toBe(1);
    const anchorOrder = anchorRows[0]?.pin_order;
    const remoteOrder = pins[ownerTaskId];
    expect([remoteOrder, anchorOrder].sort()).toEqual([0, 1]);
    const zoneIds = await pinnedZoneTaskIds(secondaryRepoId);
    expect(zoneIds.indexOf(remoteItemId) < zoneIds.indexOf(anchorTaskId))
      .toBe(remoteOrder < (anchorOrder ?? 0));

    // The owning desktop's task and settings stay untouched, and the viewer
    // still has no local row for the remote task.
    expect(await queryDb(
      primary,
      "SELECT pinned, pin_order FROM pipeline_item WHERE id = ?",
      [ownerTaskId],
    )).toEqual([{ pinned: 0, pin_order: null }]);
    expect(await remoteTaskPinsSetting(primary)).toEqual({});
    expect(await countLocalTasksOnSecondary()).toBe(1);

    // The pin survives a full viewer reload: the setting is read back from
    // the settings table and reapplied to the freshly synced LAN task.
    await secondary.reload();
    await waitForSidebarTask("LAN pin persistence task");
    await waitForPinnedZoneMembership(secondaryRepoId, remoteItemId, true, 30_000);
    expect((await remoteTaskPinsSetting(secondary))[ownerTaskId]).toBe(remoteOrder);

    // Unpin by dragging back out of the pinned zone into the unpin receiver.
    const pinnedRemoteSelector = `${repoSelector} .pinned-zone .task-subtree[data-task-id="${remoteItemId}"]`;
    const unpinReceiverSelector = `${repoSelector} .empty-unpin-zone`;
    await secondary.waitForElement(pinnedRemoteSelector, 10_000);
    await secondary.waitForElement(unpinReceiverSelector, 10_000);
    await dragSortableTaskToTarget(secondary, pinnedRemoteSelector, unpinReceiverSelector);

    await waitForRemoteTaskPinSetting(ownerTaskId, false);
    await waitForPinnedZoneMembership(secondaryRepoId, remoteItemId, false);
    const anchorAfterUnpin = await queryDb(
      secondary,
      "SELECT pinned, pin_order FROM pipeline_item WHERE id = ?",
      [anchorTaskId],
    ) as Array<{ pinned: number; pin_order: number | null }>;
    expect(anchorAfterUnpin).toEqual([{ pinned: 1, pin_order: 0 }]);
    expect(await queryDb(
      primary,
      "SELECT pinned, pin_order FROM pipeline_item WHERE id = ?",
      [ownerTaskId],
    )).toEqual([{ pinned: 0, pin_order: null }]);
    expect(await remoteTaskPinsSetting(primary)).toEqual({});
  });
});

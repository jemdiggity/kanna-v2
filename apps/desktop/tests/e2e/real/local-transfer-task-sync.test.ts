import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";

interface TransferPeer {
  peer_id?: string;
  peerId?: string;
  trusted?: boolean;
}

interface VueCallError {
  __error: string;
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
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
  let selectedItemId: string | null = null;
  while (Date.now() < deadline) {
    selectedItemId = await client.executeSync<string | null>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const store = ctx.store?.__v_isRef ? ctx.store.value : ctx.store;
      return store?.selectedItemId ?? null;
    `);
    if (selectedItemId === itemId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected item ${itemId}; last selected item was ${selectedItemId}`);
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
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
    return JSON.parse(JSON.stringify(value.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      repo_id: item.repo_id,
      stage: item.stage,
      isRemote: item.id.startsWith("cloud:") || item.id.startsWith("lan:"),
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
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-task-sync-source");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "local-transfer-task-sync-secondary");
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
    expect(Object.values(snapshot.terminalRefs ?? {})).toContainEqual({
      ownerDesktopId: "peer-primary",
      ownerLocalTaskId: createResult,
      transport: "lan",
    });

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
    await secondary.sendKeys(terminalTextarea, "hello from secondary\n");
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
});

import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";

interface TransferPeer {
  peer_id?: string;
  peerId?: string;
}

interface VueCallError {
  __error: string;
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let secondaryRepoId = "";

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
  while (Date.now() < deadline) {
    const items = await sidebarItemsForPrompt(secondary, text);
    if (items.length === 0) return;
    const sidebarText = await secondary.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (!sidebarText.includes(text)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for LAN task to disappear from secondary sidebar: ${text}`);
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

async function waitForSidebarTaskGroupedUnderRepo(prompt: string, repoId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const items = await sidebarItemsForPrompt(secondary, prompt);
    if (items.length === 1 && items[0]?.repo_id === repoId) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for LAN task ${prompt} to be grouped under repo ${repoId}`);
}

describe("local transfer task sync", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-task-sync");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-task-sync-source");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "local-transfer-task-sync-secondary");
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
    await waitForPeer("peer-secondary");
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });

    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "LAN visible task",
      "sdk",
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
    expect(await sidebarItemsForPrompt(secondary, "LAN visible task")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:lan:/),
        repo_id: secondaryRepoId,
        isRemote: true,
        stage: "in progress",
      }),
    ]);
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

    const remoteItemId = Object.entries(snapshot.terminalRefs ?? {})
      .find(([, ref]) => ref.ownerLocalTaskId === createResult)?.[0];
    expect(remoteItemId).toBeTruthy();
    await callVueMethod(secondary, "handleSelectItem", remoteItemId);
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
});

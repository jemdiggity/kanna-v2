import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let secondaryRepoId = "";

async function setSetupState(client: typeof primary, key: string, value: unknown): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const key = ${JSON.stringify(key)};
    const value = ${JSON.stringify(value)};
    if (ctx[key]?.__v_isRef) ctx[key].value = value;
    else ctx[key] = value;
  `);
}

async function signIn(client: typeof primary): Promise<string> {
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
  await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
  await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
  await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));
  await client.waitForText(".prefs-panel", "upvote.sieve.7t@icloud.com", 15_000);
  await setSetupState(client, "showPreferencesPanel", false);
  await setSetupState(client, "maximized", false);
  await setSetupState(client, "sidebarHidden", false);
  return await client.executeSync<string>(`
    const state = window.__KANNA_E2E__.setupState.desktopAuthState;
    const value = state?.__v_isRef ? state.value : state;
    return value?.user?.uid || "";
  `);
}

async function waitForSidebarTask(client: typeof primary, text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (sidebarText.includes(text)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for sidebar text: ${text}`);
}

async function waitForSidebarTaskToDisappear(client: typeof primary, text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastDiagnostics: unknown = null;
  while (Date.now() < deadline) {
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (!sidebarText.includes(text)) return;
    lastDiagnostics = await client.executeSync(`
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
        selectedWorkspaceTask: read(ctx.selectedWorkspaceTask) ? {
          itemId: read(ctx.selectedWorkspaceTask).item?.id,
          terminalKind: read(ctx.selectedWorkspaceTask).terminal?.kind,
          remoteTaskIds: read(ctx.selectedWorkspaceTask).remoteTaskIds,
          sources: read(ctx.selectedWorkspaceTask).sources?.map((source) => ({ taskId: source.taskId, transport: source.transport })),
        } : null,
        locallyClosedRemoteTaskIds: closed instanceof Set ? Array.from(closed) : closed,
        cloudSnapshotItems: read(ctx.cloudSnapshot)?.items?.filter((item) => item.prompt === ${JSON.stringify(text)}).map((item) => ({
          id: item.id,
          prompt: item.prompt,
          repo_id: item.repo_id,
          stage: item.stage,
          closed_at: item.closed_at,
        })) ?? [],
        cloudTerminalRefIds: Object.keys(read(ctx.cloudSnapshot)?.terminalRefs ?? {}),
      }));
    `).catch((error: unknown) => ({ diagnosticError: String(error) }));
    await sleep(200);
  }
  throw new Error(`timed out waiting for sidebar text to disappear: ${text}; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function waitForBodyText(client: typeof primary, text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostics: unknown = null;
  while (Date.now() < deadline) {
    const bodyText = await client.executeSync<string>(`
      return [
        document.body.innerText || "",
        document.querySelector(".xterm-rows")?.textContent || "",
        document.querySelector(".terminal-container")?.textContent || "",
      ].join("\\n");
    `);
    if (bodyText.includes(text)) return;
    lastDiagnostics = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const terminal = document.querySelector(".cloud-terminal-shell");
      return JSON.parse(JSON.stringify({
        selectedRepoId: read(ctx.store)?.selectedRepoId,
        selectedItemId: read(ctx.store)?.selectedItemId,
        selectedCloudItemId: read(ctx.selectedCloudItemId),
        mainPanelIsCloudTask: read(ctx.mainPanelIsCloudTask),
        mainPanelItemId: read(ctx.mainPanelItem)?.id ?? null,
        mainPanelCloudTerminalRef: read(ctx.mainPanelCloudTerminalRef),
        terminalStatus: terminal?.getAttribute("data-status") ?? null,
        terminalText: document.querySelector(".terminal-container")?.textContent ?? "",
        sidebarItems: read(ctx.sidebarItems)?.map((item) => ({
          id: item.id,
          prompt: item.prompt,
          repo_id: item.repo_id,
        })) ?? [],
      }));
    `).catch((error: unknown) => ({ diagnosticError: String(error) }));
    await sleep(200);
  }
  throw new Error(`timed out waiting for body text: ${text}; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function countLocalTasks(client: typeof primary): Promise<number> {
  const rows = await queryDb(client, "select count(*) as count from pipeline_item");
  const first = rows[0] as { count?: number | string } | undefined;
  return Number(first?.count ?? 0);
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

async function waitForSidebarTaskGroupedUnderRepo(
  client: typeof primary,
  prompt: string,
  repoId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const items = await sidebarItemsForPrompt(client, prompt);
    if (items.length === 1 && items[0]?.repo_id === repoId) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${prompt} to be grouped under repo ${repoId}`);
}

async function seedCloudTaskSnapshot(snapshot: Record<string, unknown>): Promise<void> {
  const functionsPort = process.env.KANNA_FIREBASE_FUNCTIONS_PORT;
  if (!functionsPort) {
    throw new Error("KANNA_FIREBASE_FUNCTIONS_PORT is required for cloud task sync E2E");
  }
  const idToken = await signInForIdToken();
  const response = await fetch(
    `http://127.0.0.1:${functionsPort}/kanna-local/us-central1/upsertTaskSnapshot`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to seed cloud task snapshot: ${response.status} ${await response.text()}`);
  }
}

async function signInForIdToken(): Promise<string> {
  const authPort = process.env.KANNA_FIREBASE_AUTH_PORT;
  if (!authPort) {
    throw new Error("KANNA_FIREBASE_AUTH_PORT is required for cloud task sync E2E");
  }
  const response = await fetch(
    `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "upvote.sieve.7t@icloud.com",
        password: "password123",
        returnSecureToken: true,
      }),
    },
  );
  const body = await response.json().catch(() => null) as { idToken?: string } | null;
  if (!response.ok || !body?.idToken) {
    throw new Error(`failed to sign into auth emulator for cloud seed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function waitForCloudTaskSnapshot(
  client: typeof primary,
  prompt: string,
): Promise<{
  item: { id: string; prompt: string };
  terminalRef: { ownerDesktopId: string; ownerLocalTaskId: string };
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await client.executeSync<{
      items?: Array<{ id?: string; prompt?: string }>;
      terminalRefs?: Record<string, { ownerDesktopId?: string; ownerLocalTaskId?: string }>;
    }>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const value = ctx.cloudSnapshot?.__v_isRef ? ctx.cloudSnapshot.value : ctx.cloudSnapshot;
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    `);
    const item = snapshot.items?.find((candidate) => candidate.prompt === prompt);
    const terminalRef = item?.id ? snapshot.terminalRefs?.[item.id] : undefined;
    if (
      item?.id &&
      item.prompt &&
      terminalRef?.ownerDesktopId &&
      terminalRef.ownerLocalTaskId
    ) {
      return {
        item: { id: item.id, prompt: item.prompt },
        terminalRef: {
          ownerDesktopId: terminalRef.ownerDesktopId,
          ownerLocalTaskId: terminalRef.ownerLocalTaskId,
        },
      };
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for cloud snapshot task: ${prompt}`);
}

async function cloudSnapshotItemsForPrompt(
  client: typeof primary,
  prompt: string,
): Promise<{
  items: Array<{ id?: string; prompt?: string }>;
  terminalRefs: Record<string, { ownerDesktopId?: string; ownerLocalTaskId?: string }>;
}> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.cloudSnapshot?.__v_isRef ? ctx.cloudSnapshot.value : ctx.cloudSnapshot;
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

async function observeSessionThroughRelay(input: {
  ownerDesktopId: string;
  ownerTaskId: string;
  expectedText?: string;
}): Promise<{ error?: string; data?: unknown; observedText?: string }> {
  const relayPort = process.env.KANNA_RELAY_PORT;
  if (!relayPort) {
    throw new Error("KANNA_RELAY_PORT is required for cloud task sync E2E");
  }

  return await new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    let responseSeen = false;
    let observedText = "";
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timed out waiting for relay observe${input.expectedText ? " output" : " response"}: ${JSON.stringify(messages)}`));
    }, input.expectedText ? 20_000 : 10_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", id_token: "test-user" }));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        id?: string;
        error?: string;
        data?: unknown;
      };
      messages.push(message);
      if (message.type === "auth_ok") {
        ws.send(JSON.stringify({
          type: "invoke",
          id: "observe-cloud-sync",
          desktopId: input.ownerDesktopId,
          command: "observe_session",
          args: { session_id: input.ownerTaskId },
        }));
        return;
      }
      if (message.type === "response" && message.id === "observe-cloud-sync") {
        responseSeen = true;
        if (!input.expectedText || message.error) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve({ error: message.error, data: message.data, observedText });
        }
        return;
      }
      if (message.type === "event") {
        const eventMessage = message as {
          name?: string;
          payload?: { data_b64?: string; snapshot?: { vt?: string } };
        };
        if (eventMessage.name === "terminal_snapshot") {
          observedText += eventMessage.payload?.snapshot?.vt ?? "";
        } else if (eventMessage.name === "terminal_output" && eventMessage.payload?.data_b64) {
          observedText += new TextDecoder().decode(
            Uint8Array.from(atob(eventMessage.payload.data_b64), (char) => char.charCodeAt(0)),
          );
        }
        if (responseSeen && input.expectedText && observedText.includes(input.expectedText)) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve({ error: message.error, data: message.data, observedText });
        }
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`relay websocket failed: ${JSON.stringify(messages)}`));
    });
  });
}

describe("cloud task sync", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    await signIn(primary);
    await signIn(secondary);
    testRepoPath = await createFixtureRepo("cloud-task-sync-source");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "cloud-sync-repo-secondary");
  });

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("shows a task created on one signed-in desktop on another signed-in desktop", async () => {
    expect(await countLocalTasks(primary)).toBe(0);
    expect(await countLocalTasks(secondary)).toBe(0);

    const primaryStatus = await tauriInvoke(primary, "mobile_server_status") as { desktopId?: string };
    expect(primaryStatus.desktopId).toMatch(/^desktop-/);

    await seedCloudTaskSnapshot({
      cloudTaskId: "stale-cloud-task",
      ownerDesktopId: "desktop-offline",
      ownerLocalTaskId: "stale-local-task",
      title: "Stale offline task",
      promptSnippet: "Stale offline task",
      displayName: null,
      stage: "in progress",
      activity: "working",
      status: "active",
      repo: {
        cloudRepoId: "stale-repo",
        name: "stale-repo",
        remoteUrl: "https://example.invalid/stale.git",
        remoteUrlHash: "stale-remote",
        defaultBranch: "main",
      },
      branch: "task-stale-local-task",
      baseRef: "origin/main",
      prNumber: null,
      prUrl: null,
      agent: { provider: "codex", type: "pty" },
      transfer: {
        state: "none",
        transferId: null,
        sourceDesktopId: null,
        destinationDesktopId: null,
      },
      blockedByTaskIds: [],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      closedAt: null,
    });

    const repoId = await importTestRepo(primary, testRepoPath, "cloud-sync-repo");
    await setSetupState(primary, "maximized", false);
    await setSetupState(primary, "sidebarHidden", false);
    const result = await callVueMethod(
      primary,
      "store.createItem",
      repoId,
      testRepoPath,
      "Cloud sync visible task",
      "sdk",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: string }).__error));
    }
    if (typeof result !== "string") {
      throw new Error(`expected created task id, got ${JSON.stringify(result)}`);
    }

    await waitForSidebarTask(primary, "Cloud sync visible task");
    expect(await countLocalTasks(primary)).toBe(1);
    expect(await sidebarItemsForPrompt(primary, "Cloud sync visible task")).toEqual([
      expect.objectContaining({
        id: result,
        isRemote: false,
        stage: "in progress",
      }),
    ]);

    await sleep(1000);
    await waitForSidebarTask(secondary, "Cloud sync visible task");
    await waitForSidebarTaskGroupedUnderRepo(secondary, "Cloud sync visible task", secondaryRepoId);
    expect(await sidebarItemsForPrompt(secondary, "Cloud sync visible task")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:/),
        repo_id: secondaryRepoId,
        isRemote: true,
        stage: "in progress",
      }),
    ]);
    const secondaryTextAfterSync = await secondary.executeSync<string>("return document.body.innerText;");
    expect(secondaryTextAfterSync).not.toContain("Stale offline task");
    expect(await countLocalTasks(secondary)).toBe(0);

    const synced = await waitForCloudTaskSnapshot(secondary, "Cloud sync visible task");
    expect(synced.terminalRef).toEqual({
      ownerDesktopId: primaryStatus.desktopId,
      ownerLocalTaskId: result,
    });
    expect(synced.terminalRef.ownerDesktopId).not.toBe("peer-primary");

    expect(await sidebarItemsForPrompt(primary, "Cloud sync visible task")).toEqual([
      expect.objectContaining({
        id: result,
        isRemote: false,
        stage: "in progress",
      }),
    ]);
    const primaryCloudSnapshot = await cloudSnapshotItemsForPrompt(primary, "Cloud sync visible task");
    expect(primaryCloudSnapshot.items).toEqual([]);
    expect(Object.values(primaryCloudSnapshot.terminalRefs)).not.toContainEqual(
      expect.objectContaining({
        ownerDesktopId: primaryStatus.desktopId,
        ownerLocalTaskId: result,
      }),
    );

    await tauriInvoke(primary, "spawn_session", {
      sessionId: result,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "--login",
        "-c",
        "printf 'Cloud terminal ready from primary\\n'; read line; printf 'Cloud terminal input:%s\\n' \"$line\"; sleep 60",
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    const secondaryText = await secondary.executeSync<string>("return document.body.innerText;");
    expect(secondaryText).toContain("Cloud sync visible task");

    const observeResponse = await observeSessionThroughRelay({
      ownerDesktopId: synced.terminalRef.ownerDesktopId,
      ownerTaskId: synced.terminalRef.ownerLocalTaskId,
      expectedText: "Cloud terminal ready from primary",
    });
    expect(observeResponse.error ?? "").not.toContain("Desktop offline");
    expect(observeResponse.observedText ?? "").toContain("Cloud terminal ready from primary");

    await callVueMethod(secondary, "handleSelectItem", synced.item.id);
    await waitForBodyText(secondary, "Cloud terminal ready from primary");
    const terminalTextarea = await secondary.waitForElement(".xterm-helper-textarea");
    await secondary.sendKeys(terminalTextarea, "hello through cloud\n");
    await waitForBodyText(secondary, "Cloud terminal input:hello through cloud");

    const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
    if (closeResult && typeof closeResult === "object" && "__error" in closeResult) {
      throw new Error(String((closeResult as { __error: string }).__error));
    }
    await waitForSidebarTaskToDisappear(secondary, "Cloud sync visible task");
  });
});

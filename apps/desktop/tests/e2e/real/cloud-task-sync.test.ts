import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod, execDb, queryDb, tauriInvoke, setPreferencesOpen } from "../helpers/vue";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { pressShiftEnterInActiveTerminal } from "../helpers/terminalInput";
import { localProcessFetch } from "@kanna/local-process-fetch";

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let secondaryRepoId = "";
let primaryRepoId = "";
let primaryDesktopId = "";
let primaryLanPort = 0;
let initialPrimaryTaskCount = 0;
let initialPrimaryOpenTaskCount = 0;
let initialSecondaryTaskCount = 0;
let testRepoRemoteUrl: string | null = null;
let testRepoRemoteUrlHash: string | null = null;

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
  await setPreferencesOpen(client, true);
  await client.click(await client.waitForElement('[data-testid="preferences-account-tab"]'));
  await client.sendKeys(await client.waitForElement('[data-testid="account-email"]'), "upvote.sieve.7t@icloud.com");
  await client.sendKeys(await client.waitForElement('[data-testid="account-password"]'), "password123");
  await client.click(await client.waitForElement('[data-testid="account-sign-in"] .primary-button'));
  await client.waitForText(".prefs-panel", "upvote.sieve.7t@icloud.com", 15_000);
  await setPreferencesOpen(client, false);
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
      const buffers = window.__KANNA_E2E__?.terminalBuffers;
      const terminalBufferText = (() => {
        if (!buffers) return "";
        try {
          return buffers.sessionIds().flatMap((id) => buffers.lines(id)).join("\\n");
        } catch {
          return "";
        }
      })();
      return [
        document.body.innerText || "",
        document.querySelector(".xterm-rows")?.textContent || "",
        document.querySelector(".terminal-container")?.textContent || "",
        terminalBufferText,
      ].join("\\n");
    `);
    if (bodyText.includes(text)) return;
    lastDiagnostics = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const buffers = window.__KANNA_E2E__?.terminalBuffers;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const terminal = document.querySelector(".cloud-terminal-shell");
      const terminalBufferSessionIds = buffers?.sessionIds() ?? [];
      const terminalBufferText = (() => {
        if (!buffers) return "";
        try {
          return terminalBufferSessionIds.flatMap((id) => buffers.lines(id)).join("\\n");
        } catch (error) {
          return String(error);
        }
      })();
      return JSON.parse(JSON.stringify({
        selectedRepoId: read(ctx.store)?.selectedRepoId,
        selectedItemId: read(ctx.store)?.selectedItemId,
        selectedCloudItemId: read(ctx.selectedCloudItemId),
        mainPanelIsCloudTask: read(ctx.mainPanelIsCloudTask),
        mainPanelItemId: read(ctx.mainPanelItem)?.id ?? null,
        mainPanelCloudTerminalRef: read(ctx.mainPanelCloudTerminalRef),
        terminalStatus: terminal?.getAttribute("data-status") ?? null,
        terminalText: document.querySelector(".terminal-container")?.textContent ?? "",
        terminalBufferSessionIds,
        terminalBufferText,
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

async function countOpenLocalTasks(client: typeof primary): Promise<number> {
  const rows = await queryDb(client, "select count(*) as count from pipeline_item where closed_at is null");
  const first = rows[0] as { count?: number | string } | undefined;
  return Number(first?.count ?? 0);
}

async function signOut(client: typeof primary): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sessionReady = await client.executeSync<boolean>(`
      const ctx = window.__KANNA_E2E__.setupState;
      const session = ctx.desktopAuthSession?.__v_isRef
        ? ctx.desktopAuthSession.value
        : ctx.desktopAuthSession;
      return Boolean(session);
    `);
    if (sessionReady) break;
    await sleep(100);
  }

  const result = await client.executeAsync(`
    const cb = arguments[arguments.length - 1];
    const ctx = window.__KANNA_E2E__.setupState;
    const session = ctx.desktopAuthSession?.__v_isRef ? ctx.desktopAuthSession.value : ctx.desktopAuthSession;
    if (!session) {
      cb({ __error: "desktop auth session is unavailable" });
      return;
    }
    Promise.resolve(session.signOut())
      .then(() => cb("ok"))
      .catch((error) => cb({ __error: error?.message || String(error) }));
  `);
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(String((result as { __error: string }).__error));
  }
}

async function sidebarItemsForPrompt(client: typeof primary, prompt: string): Promise<Array<{
  id: string;
  selectionId: string;
  prompt: string;
  repo_id: string;
  stage: string;
  isRemote: boolean;
  parentTaskId: string | null;
}>> {
  return await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
    return JSON.parse(JSON.stringify(value.filter((item) => item.prompt === ${JSON.stringify(prompt)}).map((item) => ({
      id: item.task_id,
      selectionId: item.slot_id,
      prompt: item.prompt,
      repo_id: item.repo_id,
      stage: item.stage,
      isRemote: Boolean(item.remote_task),
      parentTaskId: item.parent_task_id ?? null,
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

async function waitForSingleSidebarTask(
  client: typeof primary,
  prompt: string,
): Promise<Array<{
  id: string;
  prompt: string;
  repo_id: string;
  stage: string;
  isRemote: boolean;
}>> {
  const deadline = Date.now() + 30_000;
  let items: Awaited<ReturnType<typeof sidebarItemsForPrompt>> = [];
  while (Date.now() < deadline) {
    items = await sidebarItemsForPrompt(client, prompt);
    if (items.length === 1) return items;
    await sleep(200);
  }
  throw new Error(`timed out waiting for exactly one sidebar item for ${prompt}; last items=${JSON.stringify(items)}`);
}

function hashRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  return createHash("sha256").update(remoteUrl.trim()).digest("hex");
}

async function waitForRunningMobileServerStatus(client: typeof primary): Promise<{ desktopId: string; lanPort: number }> {
  const deadline = Date.now() + 30_000;
  let lastStatus: unknown = null;
  while (Date.now() < deadline) {
    lastStatus = await tauriInvoke(client, "mobile_server_status").catch((error) => ({ error: String(error) }));
    const status = lastStatus as { state?: string; desktopId?: string; lanPort?: number };
    if (status.state === "running" && status.desktopId?.match(/^desktop-/) && status.lanPort) {
      return { desktopId: status.desktopId, lanPort: status.lanPort };
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for running mobile server status; last status=${JSON.stringify(lastStatus)}`);
}

async function waitForPublishedTaskActivity(input: {
  desktopId: string;
  ownerLocalTaskId: string;
  activity: string;
}): Promise<void> {
  const firestorePort = process.env.KANNA_FIREBASE_FIRESTORE_PORT;
  if (!firestorePort) throw new Error("KANNA_FIREBASE_FIRESTORE_PORT is required");
  const { idToken, localId } = await signInForIdToken();
  const path = `users/${localId}/desktops/${input.desktopId}/tasks`;
  const deadline = Date.now() + 30_000;
  let lastDocuments: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(firestoreDocumentUrl(firestorePort, path), {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const body = await response.json().catch(() => null) as {
      documents?: Array<{ fields?: Record<string, { stringValue?: string }> }>;
    } | null;
    lastDocuments = body;
    const task = body?.documents?.find((document) =>
      document.fields?.ownerLocalTaskId?.stringValue === input.ownerLocalTaskId);
    if (task?.fields?.activity?.stringValue === input.activity) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for published ${input.activity} activity: ${JSON.stringify(lastDocuments)}`);
}

async function waitForDesktopCredentialRevocationState(input: {
  desktopId: string;
  revoked: boolean;
}): Promise<void> {
  const firestorePort = process.env.KANNA_FIREBASE_FIRESTORE_PORT;
  if (!firestorePort) throw new Error("KANNA_FIREBASE_FIRESTORE_PORT is required");
  const path = `desktopCredentials/${input.desktopId.replace(/\//g, "_")}`;
  const deadline = Date.now() + 30_000;
  let lastDocument: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(firestoreDocumentUrl(firestorePort, path), {
      headers: { Authorization: "Bearer owner" },
    });
    const body = await response.json().catch(() => null) as {
      fields?: { revokedAt?: { nullValue?: null; timestampValue?: string } };
    } | null;
    lastDocument = body;
    const revokedAt = body?.fields?.revokedAt;
    if (response.ok && (input.revoked ? Boolean(revokedAt?.timestampValue) : revokedAt?.nullValue === null)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for desktop credential revoked=${input.revoked}: ${JSON.stringify(lastDocument)}`,
  );
}

async function seedCloudTaskSnapshot(snapshot: Record<string, unknown>): Promise<void> {
  const firestorePort = process.env.KANNA_FIREBASE_FIRESTORE_PORT;
  if (!firestorePort) {
    throw new Error("KANNA_FIREBASE_FIRESTORE_PORT is required for cloud task sync E2E");
  }
  const { idToken, localId } = await signInForIdToken();
  const ownerDesktopId = readRequiredString(snapshot, "ownerDesktopId");
  const desktopDocId = deterministicFirestoreDocId(`desktop:${ownerDesktopId}`);
  const cloudTaskId = typeof snapshot.cloudTaskId === "string"
    ? snapshot.cloudTaskId
    : `${ownerDesktopId}:${readRequiredString(snapshot, "ownerLocalTaskId")}`;
  const taskDocId = deterministicFirestoreDocId(`task:${cloudTaskId}`);

  await writeFirestoreEmulatorAdminDocument({
    firestorePort,
    path: `users/${localId}/desktops/${desktopDocId}`,
    data: {
      desktopId: ownerDesktopId,
      updatedAt: readRequiredString(snapshot, "updatedAt"),
    },
  });
  await writeFirestoreEmulatorAdminDocument({
    firestorePort,
    path: `users/${localId}/desktops/${desktopDocId}/tasks/${taskDocId}`,
    data: snapshot,
  });

  const seeded = await readFirestoreEmulatorDocument({
    idToken,
    firestorePort,
    path: `users/${localId}/desktops/${desktopDocId}/tasks/${taskDocId}`,
  });
  if (!JSON.stringify(seeded).includes(readRequiredString(snapshot, "title"))) {
    throw new Error(`seeded nested cloud task is unreadable at desktop task path: ${JSON.stringify(seeded)}`);
  }
}

async function signInForIdToken(): Promise<{ idToken: string; localId: string }> {
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
  const body = await response.json().catch(() => null) as { idToken?: string; localId?: string } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`failed to sign into auth emulator for cloud seed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

function deterministicFirestoreDocId(input: string): string {
  return `e2e-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`cloud seed snapshot is missing ${key}`);
  }
  return value;
}

async function writeFirestoreEmulatorAdminDocument(input: {
  firestorePort: string;
  path: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const response = await fetch(firestoreDocumentUrl(input.firestorePort, input.path), {
    method: "PATCH",
    headers: {
      // The emulator owner token models the relay's Firebase Admin write.
      // Signed-in renderer clients are intentionally denied by firestore.rules.
      Authorization: "Bearer owner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFirestoreFields(input.data) }),
  });
  if (!response.ok) {
    throw new Error(`failed to write Firestore seed document ${input.path}: ${response.status} ${await response.text()}`);
  }
}

async function readFirestoreEmulatorDocument(input: {
  idToken: string;
  firestorePort: string;
  path: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch(firestoreDocumentUrl(input.firestorePort, input.path), {
    headers: { Authorization: `Bearer ${input.idToken}` },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    throw new Error(`failed to read Firestore seed document ${input.path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function firestoreDocumentUrl(firestorePort: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `http://127.0.0.1:${firestorePort}/v1/projects/kanna-local/databases/(default)/documents/${encodedPath}`;
}

function toFirestoreFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (value && typeof value === "object") {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  throw new Error(`unsupported Firestore seed value: ${String(value)}`);
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

async function waitForCloudTaskToBeAbsentAfterRefresh(
  client: typeof primary,
  prompt: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastSnapshot: unknown = null;
  let lastSidebarItems: unknown = null;
  while (Date.now() < deadline) {
    await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      if (ctx.locallyClosedRemoteTaskIds?.__v_isRef) {
        ctx.locallyClosedRemoteTaskIds.value = new Set();
      } else {
        ctx.locallyClosedRemoteTaskIds = new Set();
      }
    `);
    await callVueMethod(client, "refreshCloudTasksForSignedInUser");
    const snapshot = await cloudSnapshotItemsForPrompt(client, prompt);
    const sidebarItems = await sidebarItemsForPrompt(client, prompt);
    lastSnapshot = snapshot;
    lastSidebarItems = sidebarItems;
    if (snapshot.items.length === 0 && sidebarItems.length === 0) return;
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for cloud task to be absent: ${prompt}; snapshot=${JSON.stringify(lastSnapshot)} sidebarItems=${JSON.stringify(lastSidebarItems)}`,
  );
}

async function waitForCloudTaskToStayGoneAfterRefresh(
  client: typeof primary,
  prompt: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastSnapshot: unknown = null;
  while (Date.now() < deadline) {
    await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      if (ctx.locallyClosedRemoteTaskIds?.__v_isRef) {
        ctx.locallyClosedRemoteTaskIds.value = new Set();
      } else {
        ctx.locallyClosedRemoteTaskIds = new Set();
      }
    `);
    await callVueMethod(client, "refreshCloudTasksForSignedInUser");
    const snapshot = await cloudSnapshotItemsForPrompt(client, prompt);
    lastSnapshot = snapshot;
    if (snapshot.items.length === 0) {
      await waitForSidebarTaskToDisappear(client, prompt);
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for cloud task tombstone: ${prompt}; snapshot=${JSON.stringify(lastSnapshot)}`);
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
      void signInForIdToken()
        .then(({ idToken }) => {
          ws.send(JSON.stringify({ type: "auth", id_token: idToken }));
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(error);
        });
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
    testRepoPath = await createFixtureRepo("cloud-task-sync-source");
    const primaryServer = await waitForRunningMobileServerStatus(primary);
    primaryDesktopId = primaryServer.desktopId;
    primaryLanPort = primaryServer.lanPort;
    primaryRepoId = await importTestRepo(primary, testRepoPath, "cloud-sync-repo");
    secondaryRepoId = await importTestRepo(secondary, testRepoPath, "cloud-sync-repo-secondary");
    testRepoRemoteUrl = await tauriInvoke(primary, "git_remote_url", { repoPath: testRepoPath }) as string | null;
    testRepoRemoteUrlHash = hashRemoteUrl(testRepoRemoteUrl);
    expect(testRepoRemoteUrlHash).toMatch(/^[a-f0-9]{64}$/);

    await signOut(primary);
    await signOut(secondary);

    await execDb(
      primary,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, pipeline, stage, pr_number, pr_url,
          branch, agent_type, agent_provider, port_offset, port_env, activity, activity_changed_at,
          display_name, base_ref, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stale-owned-closed-task",
        primaryRepoId,
        null,
        null,
        "Stale owned closed cloud task",
        "default",
        "in progress",
        null,
        null,
        "task-stale-owned-closed-task",
        "pty",
        "codex",
        null,
        null,
        "idle",
        "2026-05-03T00:00:00.000Z",
        null,
        "origin/main",
        "2026-05-03T00:01:00.000Z",
        "2026-05-03T00:00:00.000Z",
        "2026-05-03T00:01:00.000Z",
      ],
    );

    await seedCloudTaskSnapshot({
      cloudTaskId: `${primaryRepoId}:stale-owned-closed-task`,
      ownerDesktopId: primaryDesktopId,
      ownerLocalTaskId: "stale-owned-closed-task",
      title: "Stale owned closed cloud task",
      promptSnippet: "Stale owned closed cloud task",
      displayName: null,
      stage: "in progress",
      activity: "working",
      status: "active",
      repo: {
        cloudRepoId: primaryRepoId,
        name: "cloud-sync-repo",
        remoteUrl: testRepoRemoteUrl,
        remoteUrlHash: testRepoRemoteUrlHash,
        defaultBranch: "main",
      },
      branch: "task-stale-owned-closed-task",
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
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:01:00.000Z",
      closedAt: null,
    });

    await signIn(primary);
    await signIn(secondary);
    initialPrimaryTaskCount = await countLocalTasks(primary);
    initialPrimaryOpenTaskCount = await countOpenLocalTasks(primary);
    initialSecondaryTaskCount = await countLocalTasks(secondary);
  }, 240_000);

  afterAll(async () => {
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("removes a stale owned cloud task whose local task is already closed during sign-in reconciliation", async () => {
    expect(await queryDb(
      primary,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      ["stale-owned-closed-task"],
    )).toEqual([
      expect.objectContaining({
        // closed_at is the sole done indicator; stage keeps its last value.
        stage: "in progress",
        closed_at: "2026-05-03T00:01:00.000Z",
      }),
    ]);

    await waitForCloudTaskToBeAbsentAfterRefresh(primary, "Stale owned closed cloud task");
    expect(await cloudSnapshotItemsForPrompt(primary, "Stale owned closed cloud task")).toEqual({
      items: [],
      terminalRefs: expect.any(Object),
    });
    expect(await sidebarItemsForPrompt(primary, "Stale owned closed cloud task")).toEqual([]);
  });

  it("shows a task created on one signed-in desktop on another signed-in desktop", async () => {
    expect(await countLocalTasks(primary)).toBe(initialPrimaryTaskCount);
    expect(await countOpenLocalTasks(primary)).toBe(initialPrimaryOpenTaskCount);
    expect(await countLocalTasks(secondary)).toBe(initialSecondaryTaskCount);

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

    await setSetupState(primary, "maximized", false);
    await setSetupState(primary, "sidebarHidden", false);
    const result = await callVueMethod(
      primary,
      "store.createItem",
      primaryRepoId,
      testRepoPath,
      "Cloud sync visible task",
      "agent",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: string }).__error));
    }
    if (typeof result !== "string") {
      throw new Error(`expected created task id, got ${JSON.stringify(result)}`);
    }

    await waitForSidebarTask(primary, "Cloud sync visible task");
    expect(await countLocalTasks(primary)).toBe(initialPrimaryTaskCount + 1);
    expect(await countOpenLocalTasks(primary)).toBe(initialPrimaryOpenTaskCount + 1);
    expect(await sidebarItemsForPrompt(primary, "Cloud sync visible task")).toEqual([
      expect.objectContaining({
        id: result,
        isRemote: false,
        stage: "in progress",
      }),
    ]);

    await execDb(primary, "UPDATE pipeline_item SET activity = 'idle', updated_at = datetime('now') WHERE id = ?", [result]);
    await waitForPublishedTaskActivity({
      desktopId: primaryDesktopId,
      ownerLocalTaskId: result,
      activity: "idle",
    });
    const workingResponse = await localProcessFetch(
      `http://127.0.0.1:${primaryLanPort}/v1/tasks/${encodeURIComponent(result)}/actions/runtime-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "busy", selected: false }),
      },
    );
    expect(workingResponse.ok).toBe(true);
    await waitForPublishedTaskActivity({
      desktopId: primaryDesktopId,
      ownerLocalTaskId: result,
      activity: "working",
    });

    await signOut(primary);
    await waitForDesktopCredentialRevocationState({
      desktopId: primaryDesktopId,
      revoked: true,
    });
    await execDb(primary, "UPDATE pipeline_item SET activity = 'idle', updated_at = datetime('now') WHERE id = ?", [result]);

    await signIn(primary);
    await waitForDesktopCredentialRevocationState({
      desktopId: primaryDesktopId,
      revoked: false,
    });
    await waitForPublishedTaskActivity({
      desktopId: primaryDesktopId,
      ownerLocalTaskId: result,
      activity: "idle",
    });

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
    const cloudDiagnostics = await remoteDiagnosticsForPrompt(secondary, "Cloud sync visible task");
    expect(cloudDiagnostics).toContainEqual(expect.objectContaining({
      selectedTerminalTransport: "cloud",
      sources: expect.arrayContaining(["cloud"]),
    }));
    await waitForSidebarTask(secondary, "Stale offline task");
    const secondaryTextAfterSync = await secondary.executeSync<string>("return document.body.innerText;");
    expect(secondaryTextAfterSync).toContain("Stale offline task");
    expect(await sidebarItemsForPrompt(secondary, "Stale offline task")).toEqual([
      expect.objectContaining({
        id: "cloud:stale-cloud-task",
        isRemote: true,
        stage: "in progress",
      }),
    ]);
    expect(await remoteDiagnosticsForPrompt(secondary, "Stale offline task")).toContainEqual(expect.objectContaining({
      selectedTerminalTransport: "none",
      sources: expect.arrayContaining(["cloud"]),
    }));
    expect(await countLocalTasks(secondary)).toBe(initialSecondaryTaskCount);

    const synced = await waitForCloudTaskSnapshot(secondary, "Cloud sync visible task");
    expect(synced.terminalRef).toEqual({
      ownerDesktopId: primaryDesktopId,
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
    if (primaryCloudSnapshot.items.length > 0) {
      expect(primaryCloudSnapshot.items).toHaveLength(1);
      expect(Object.values(primaryCloudSnapshot.terminalRefs)).toContainEqual(expect.objectContaining({
        ownerDesktopId: primaryDesktopId,
        ownerLocalTaskId: result,
      }));
    }
    expect(await waitForSingleSidebarTask(primary, "Cloud sync visible task")).toEqual([
      expect.objectContaining({
        id: result,
        isRemote: false,
        stage: "in progress",
      }),
    ]);

    await tauriInvoke(primary, "spawn_session", {
      sessionId: result,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "--login",
        "-c",
        "printf 'Cloud terminal ready from primary\\n'; read line; printf 'Cloud terminal input:%s\\n' \"$line\"; stty raw -echo; shifted=$(dd bs=1 count=7 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf '\\r\\nCloud terminal shift enter:%s\\r\\n' \"$shifted\"; sleep 60",
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

    const [secondarySidebarItem] = await sidebarItemsForPrompt(secondary, "Cloud sync visible task");
    if (!secondarySidebarItem) throw new Error("cloud task was missing from the secondary sidebar");
    await callVueMethod(secondary, "selectSidebarItemById", secondarySidebarItem.selectionId);
    await waitForBodyText(secondary, "Cloud terminal ready from primary");
    const terminalTextarea = await secondary.waitForElement(".xterm-helper-textarea");
    await secondary.sendKeys(terminalTextarea, "hello through cloud\n");
    await waitForBodyText(secondary, "Cloud terminal input:hello through cloud");
    await pressShiftEnterInActiveTerminal(secondary);
    await waitForBodyText(secondary, "Cloud terminal shift enter:1b5b31333b3275");

    const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
    if (closeResult && typeof closeResult === "object" && "__error" in closeResult) {
      throw new Error(String((closeResult as { __error: string }).__error));
    }
    await waitForSidebarTaskToDisappear(secondary, "Cloud sync visible task");
    await waitForCloudTaskToStayGoneAfterRefresh(secondary, "Cloud sync visible task");
  });
  it("streams live terminal output from the owning desktop through the relay", async () => {
    const prompt = "Relay live stream task";

    await setSetupState(primary, "maximized", false);
    await setSetupState(primary, "sidebarHidden", false);
    const result = await callVueMethod(
      primary,
      "store.createItem",
      primaryRepoId,
      testRepoPath,
      prompt,
      "sdk",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: string }).__error));
    }
    if (typeof result !== "string") {
      throw new Error(`expected created task id, got ${JSON.stringify(result)}`);
    }
    await waitForSidebarTask(primary, prompt);

    const synced = await waitForCloudTaskSnapshot(secondary, prompt);
    expect(synced.terminalRef).toEqual({
      ownerDesktopId: primaryDesktopId,
      ownerLocalTaskId: result,
    });

    // The PTY prints a marker at spawn time (visible via attach snapshot), then
    // prints a second marker only after it receives a line of input.
    await tauriInvoke(primary, "spawn_session", {
      sessionId: result,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "--login",
        "-c",
        "printf 'Relay stream attach marker\\n'; read line; printf 'Relay live event:%s\\n' \"$line\"; sleep 60",
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    await waitForSidebarTask(secondary, prompt);
    expect(await sidebarItemsForPrompt(secondary, prompt)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cloud:/),
        isRemote: true,
        stage: "in progress",
      }),
    ]);
    // The secondary holds no local copy of this task and no LAN/local route to
    // the primary's daemon in this harness: its only terminal transport for the
    // remote task is "cloud", i.e. the relay websocket (desktopRelayTerminal.ts
    // observe_session over KANNA_RELAY_PORT). Everything asserted below from
    // the secondary's terminal therefore traversed the relay.
    expect(await countLocalTasks(secondary)).toBe(initialSecondaryTaskCount);
    expect(await remoteDiagnosticsForPrompt(secondary, prompt)).toContainEqual(
      expect.objectContaining({
        selectedTerminalTransport: "cloud",
        ownerDesktopId: primaryDesktopId,
      }),
    );

    const [secondarySidebarItem] = await sidebarItemsForPrompt(secondary, prompt);
    if (!secondarySidebarItem) throw new Error("relay task was missing from the secondary sidebar");
    await callVueMethod(secondary, "selectSidebarItemById", secondarySidebarItem.selectionId);
    await waitForBodyText(secondary, "Relay stream attach marker");

    // Produce NEW output on the owning desktop only after the secondary has
    // attached. The secondary sends nothing here, so the marker below cannot
    // come from attach-snapshot hydration or from a secondary-initiated invoke:
    // it can only arrive as relay `type:"event"` terminal_output messages
    // routed by sessionId to the observing secondary (services/relay/src/router.ts).
    const liveInput = "through-the-relay\n";
    await tauriInvoke(primary, "send_input", {
      sessionId: result,
      data: Array.from(new TextEncoder().encode(liveInput)),
    });
    await waitForBodyText(secondary, "Relay live event:through-the-relay");

    const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
    if (closeResult && typeof closeResult === "object" && "__error" in closeResult) {
      throw new Error(String((closeResult as { __error: string }).__error));
    }
    await waitForSidebarTaskToDisappear(secondary, prompt);
    await waitForCloudTaskToStayGoneAfterRefresh(secondary, prompt);
  });

  it("does not flash a matching stale remote task after closing a local task from the sidebar shortcut", async () => {
    const prompt = "Local close stale cloud copy";
    const createResult = await callVueMethod(
      primary,
      "store.createItem",
      primaryRepoId,
      testRepoPath,
      prompt,
      "sdk",
      { agentProvider: "codex", baseRef: "origin/main" },
    );
    if (createResult && typeof createResult === "object" && "__error" in createResult) {
      throw new Error(String((createResult as { __error: string }).__error));
    }
    if (typeof createResult !== "string") {
      throw new Error(`expected created task id, got ${JSON.stringify(createResult)}`);
    }

    const taskRows = await queryDb(
      primary,
      "SELECT branch FROM pipeline_item WHERE id = ?",
      [createResult],
    ) as Array<{ branch?: string | null }>;
    const branch = taskRows[0]?.branch;
    if (!branch) {
      throw new Error(`expected ${createResult} to have a branch`);
    }
    await tauriInvoke(primary, "write_text_file", {
      path: `${testRepoPath}/.kanna-worktrees/${branch}/.kanna/config.json`,
      content: JSON.stringify({ setup: [] }),
    });

    await seedCloudTaskSnapshot({
      cloudTaskId: `${primaryRepoId}:${createResult}`,
      ownerDesktopId: primaryDesktopId,
      ownerLocalTaskId: createResult,
      title: prompt,
      promptSnippet: prompt,
      displayName: null,
      stage: "in progress",
      activity: "idle",
      status: "active",
      repo: {
        cloudRepoId: primaryRepoId,
        name: "cloud-sync-repo",
        remoteUrl: testRepoRemoteUrl,
        remoteUrlHash: testRepoRemoteUrlHash,
        defaultBranch: "main",
      },
      branch,
      baseRef: "origin/main",
      prNumber: null,
      prUrl: null,
      agent: { provider: "codex", type: "sdk" },
      transfer: {
        state: "none",
        transferId: null,
        sourceDesktopId: null,
        destinationDesktopId: null,
      },
      blockedByTaskIds: [],
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:01:00.000Z",
      closedAt: null,
    });

    await callVueMethod(primary, "store.selectRepo", primaryRepoId);
    await callVueMethod(primary, "store.selectItem", createResult);
    await callVueMethod(primary, "refreshCloudTasksForSignedInUser");
    const mergedItems = await waitForSingleSidebarTask(primary, prompt);
    expect(mergedItems).toEqual([
      expect.objectContaining({
        id: createResult,
        isRemote: false,
        stage: "in progress",
      }),
    ]);
    expect(await cloudSnapshotItemsForPrompt(primary, prompt)).toEqual(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ prompt })]),
    }));

    const observedStates = await primary.executeAsync<Array<Array<{ id: string; isRemote: boolean }>>>(
      `const cb = arguments[arguments.length - 1];
       const prompt = ${JSON.stringify(prompt)};
       const states = [];
       const read = () => {
         const ctx = window.__KANNA_E2E__.setupState;
         const value = ctx.sidebarItems?.__v_isRef ? ctx.sidebarItems.value : ctx.sidebarItems;
         states.push(JSON.parse(JSON.stringify((value || [])
           .filter((item) => item.prompt === prompt)
           .map((item) => ({ id: item.task_id, isRemote: item.remote_task === true })))));
       };
       read();
       const sampler = setInterval(read, 10);
       ${buildGlobalKeydownScript({ key: "Delete", meta: true, shift: true })}
       const deadline = Date.now() + 10000;
       const wait = () => {
         read();
         const latest = states[states.length - 1] || [];
         if (latest.length === 0) {
           clearInterval(sampler);
           cb(states);
           return;
         }
         if (Date.now() > deadline) {
           clearInterval(sampler);
           cb(states);
           return;
         }
         setTimeout(wait, 20);
       };
       wait();`
    );

    expect(observedStates.at(-1)).toEqual([]);
    expect(observedStates.some((state) =>
      state.some((item) => item.isRemote || item.id.startsWith("cloud:") || item.id.startsWith("lan:"))
    )).toBe(false);
    await waitForSidebarTaskToDisappear(primary, prompt);
  });

  it("nests a cloud subtask under its parent when viewed from another desktop", async () => {
    const parentPrompt = "Cloud hierarchy parent";
    const childPrompt = "Cloud hierarchy subtask";
    const hierarchyRepo = {
      cloudRepoId: "hierarchy-repo",
      name: "hierarchy-repo",
      remoteUrl: "https://example.invalid/hierarchy.git",
      remoteUrlHash: "hierarchy-remote",
      defaultBranch: "main",
    };
    const hierarchyTask = (
      ownerLocalTaskId: string,
      prompt: string,
      parentTaskId: string | null,
    ) => ({
      cloudTaskId: `hierarchy:${ownerLocalTaskId}`,
      ownerDesktopId: "desktop-hierarchy",
      ownerLocalTaskId,
      title: prompt,
      promptSnippet: prompt,
      displayName: null,
      stage: "in progress",
      activity: "idle",
      status: "active",
      repo: hierarchyRepo,
      branch: `task-${ownerLocalTaskId}`,
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
      parentTaskId,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:01:00.000Z",
      closedAt: null,
    });

    await seedCloudTaskSnapshot(hierarchyTask("hierarchy-parent", parentPrompt, null));
    await seedCloudTaskSnapshot(hierarchyTask("hierarchy-child", childPrompt, "hierarchy-parent"));

    await waitForSidebarTask(secondary, childPrompt);
    const [parentItem] = await sidebarItemsForPrompt(secondary, parentPrompt);
    expect(parentItem).toEqual(expect.objectContaining({
      id: "cloud:hierarchy:hierarchy-parent",
      isRemote: true,
      parentTaskId: null,
    }));
    expect(await sidebarItemsForPrompt(secondary, childPrompt)).toEqual([
      expect.objectContaining({
        id: "cloud:hierarchy:hierarchy-child",
        repo_id: parentItem.repo_id,
        isRemote: true,
        parentTaskId: parentItem.id,
      }),
    ]);

    // The owner's hierarchy has to reach the rendered rows, not just the model:
    // the subtask row renders indented, and without a local detach affordance.
    const childRow = await secondary.executeSync<{
      indented: boolean;
      detachable: boolean;
    }>(`
      const row = document.querySelector('.sidebar .workflow-item[data-task-id="cloud:hierarchy:hierarchy-child"]');
      return {
        indented: Boolean(row && row.classList.contains("subtask")),
        detachable: Boolean(row && row.querySelector(".subtask-detach")),
      };
    `);
    expect(childRow).toEqual({ indented: true, detachable: false });
  });
});

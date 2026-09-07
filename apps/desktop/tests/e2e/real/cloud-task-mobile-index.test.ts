import { setTimeout as sleep } from "node:timers/promises";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFirestoreTaskIndex,
  type CloudTaskSummary,
  type CloudTaskIndex,
} from "../../../../mobile/src/lib/firebase/taskIndex";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { execDb, tauriInvoke } from "../helpers/vue";
import { localProcessFetch } from "@kanna/local-process-fetch";

const { primary } = createPrimaryAndSecondaryClients();
const TASK_ID = "mobile-index-activity-task";
const TASK_TITLE = "Desktop owner publication";
const ORIGINAL_PROMPT = "Original desktop prompt that must remain separate";
const WAITING_PROMPT = "Ready for review from the desktop agent";
let testRepoPath = "";
let repoId = "";
let desktopId = "";
let lanPort = 0;
let mobileFirebaseApp: FirebaseApp | null = null;
let mobileTaskIndex: CloudTaskIndex | null = null;
let mobileUid = "";

async function setSetupState(key: string, value: unknown): Promise<void> {
  await primary.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const target = ctx[${JSON.stringify(key)}];
    const value = ${JSON.stringify(value)};
    if (target?.__v_isRef) target.value = value;
    else ctx[${JSON.stringify(key)}] = value;
  `);
}

async function signInDesktopRenderer(): Promise<void> {
  await setSetupState("showPreferencesPanel", true);
  await primary.click(await primary.waitForElement('[data-testid="preferences-account-tab"]'));
  const email = await primary.waitForElement('[data-testid="account-email"]');
  const password = await primary.waitForElement('[data-testid="account-password"]');
  await primary.sendKeys(email, "upvote.sieve.7t@icloud.com");
  await primary.sendKeys(password, "password123");
  await primary.click(await primary.waitForElement('[data-testid="account-sign-in"] .primary-button'));
  await primary.waitForText(".prefs-panel", "upvote.sieve.7t@icloud.com", 15_000);
  await setSetupState("showPreferencesPanel", false);
}

async function waitForRunningServer(): Promise<{ desktopId: string; lanPort: number }> {
  const deadline = Date.now() + 30_000;
  let lastStatus: unknown = null;
  while (Date.now() < deadline) {
    lastStatus = await tauriInvoke(primary, "mobile_server_status").catch((error) => ({
      error: String(error),
    }));
    const status = lastStatus as { state?: string; desktopId?: string; lanPort?: number };
    if (status.state === "running" && status.desktopId && status.lanPort) {
      return { desktopId: status.desktopId, lanPort: status.lanPort };
    }
    await sleep(100);
  }
  throw new Error(`kanna-server did not become ready: ${JSON.stringify(lastStatus)}`);
}

async function createAuthenticatedMobileTaskIndex(): Promise<void> {
  const authPort = Number(process.env.KANNA_FIREBASE_AUTH_PORT);
  const firestorePort = Number(process.env.KANNA_FIREBASE_FIRESTORE_PORT);
  if (!Number.isInteger(authPort) || !Number.isInteger(firestorePort)) {
    throw new Error("Firebase emulator ports are required");
  }
  mobileFirebaseApp = initializeApp({
    apiKey: "kanna-local",
    projectId: "kanna-local",
    appId: `mobile-index-e2e-${Date.now()}`,
  }, `mobile-index-e2e-${Date.now()}`);
  const auth = getAuth(mobileFirebaseApp);
  connectAuthEmulator(auth, `http://127.0.0.1:${authPort}`, { disableWarnings: true });
  const credential = await signInWithEmailAndPassword(
    auth,
    "upvote.sieve.7t@icloud.com",
    "password123",
  );
  mobileUid = credential.user.uid;
  const firestore = getFirestore(mobileFirebaseApp);
  connectFirestoreEmulator(firestore, "127.0.0.1", firestorePort);
  mobileTaskIndex = createFirestoreTaskIndex(firestore);
}

async function waitForMobileActivity(activity: string): Promise<CloudTaskSummary> {
  const deadline = Date.now() + 30_000;
  let lastTasks: unknown = null;
  while (Date.now() < deadline) {
    const tasks = await mobileTaskIndex!.listRecentTasks(mobileUid);
    lastTasks = tasks;
    const task = tasks.find((candidate) =>
      candidate.ownerDesktopId === desktopId && candidate.ownerLocalTaskId === TASK_ID);
    if (task?.activity === activity) return task;
    await sleep(200);
  }
  throw new Error(`mobile task index did not observe ${activity}: ${JSON.stringify(lastTasks)}`);
}

async function waitForMobileWaitingPrompt(
  waitingPromptSnippet: string,
): Promise<CloudTaskSummary> {
  const deadline = Date.now() + 30_000;
  let lastTasks: unknown = null;
  while (Date.now() < deadline) {
    const tasks = await mobileTaskIndex!.listRecentTasks(mobileUid);
    lastTasks = tasks;
    const task = tasks.find((candidate) =>
      candidate.ownerDesktopId === desktopId && candidate.ownerLocalTaskId === TASK_ID);
    if (task?.waitingPromptSnippet === waitingPromptSnippet) return task;
    await sleep(200);
  }
  throw new Error(
    `mobile task index did not observe waiting prompt ${JSON.stringify(waitingPromptSnippet)}: ${JSON.stringify(lastTasks)}`,
  );
}

describe("server-owned publication through the mobile task index", () => {
  beforeAll(async () => {
    await primary.createSession();
    await resetDatabase(primary);
    testRepoPath = await createFixtureRepo("cloud-mobile-index-source");
    repoId = await importTestRepo(primary, testRepoPath, "cloud-mobile-index-repo");
    const server = await waitForRunningServer();
    desktopId = server.desktopId;
    lanPort = server.lanPort;
    await signInDesktopRenderer();
    await createAuthenticatedMobileTaskIndex();
  }, 240_000);

  afterAll(async () => {
    if (mobileFirebaseApp) await deleteApp(mobileFirebaseApp).catch(() => undefined);
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(testRepoPath ? [testRepoPath] : []).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
  });

  it("observes a waiting-prompt and activity change through kanna-server, relay, Firestore, and the mobile index", async () => {
    await execDb(
      primary,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider,
          activity, activity_changed_at, display_name, base_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        TASK_ID,
        repoId,
        ORIGINAL_PROMPT,
        "default",
        "in progress",
        `task-${TASK_ID}`,
        "pty",
        "codex",
        "idle",
        "2026-07-14T00:00:00.000Z",
        TASK_TITLE,
        "origin/main",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
      ],
    );
    const initialTask = await waitForMobileActivity("idle");
    expect(initialTask.title).toBe(TASK_TITLE);
    expect(initialTask.waitingPromptSnippet).toBeUndefined();

    await execDb(
      primary,
      `UPDATE pipeline_item
       SET last_output_preview = ?, updated_at = ?
       WHERE id = ?`,
      [WAITING_PROMPT, "2026-07-14T00:00:01.000Z", TASK_ID],
    );
    const waitingTask = await waitForMobileWaitingPrompt(WAITING_PROMPT);
    expect(waitingTask.title).toBe(TASK_TITLE);
    expect(waitingTask.waitingPromptSnippet).not.toBe(ORIGINAL_PROMPT);

    const response = await localProcessFetch(
      `http://127.0.0.1:${lanPort}/v1/tasks/${TASK_ID}/actions/runtime-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "busy", selected: false }),
      },
    );
    expect(response.status).toBe(200);
    await waitForMobileActivity("working");
  });
});

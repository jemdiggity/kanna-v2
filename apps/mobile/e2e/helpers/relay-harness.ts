import type { PtyTerminalFixture } from "../specs/smoke/list-detail-back.e2e";
import type { TaskActivity } from "../../src/lib/api/types";

const RELAY_TASK_TITLE = "Hybrid duplicate from LAN";
const HYBRID_DUPLICATE_CLOUD_TITLE = "Hybrid duplicate from cloud";
const HYBRID_CLOUD_ONLY_TITLE = "Hybrid cloud-only task";
const HYBRID_CLOUD_ONLY_REFRESHED_TITLE = "Hybrid cloud-only task refreshed";
const HYBRID_LAN_ONLY_TITLE = "Hybrid LAN-only task";
const HYBRID_CLOUD_ONLY_DESKTOP_ID = "mobile-hybrid-cloud-only-desktop";
const HYBRID_CLOUD_ONLY_REPO_ID = "mobile-hybrid-cloud-only-repo";
const HYBRID_CLOUD_ONLY_LOCAL_TASK_ID = "mobile-hybrid-cloud-only-task";
const HYBRID_UNRESOLVED_TASK_ID = "mobile-hybrid-unresolved-selection";
const RELAY_TASK_SENTINEL = "SCRIPT_READY";
const RELAY_MENU_CURSOR_MARKER = "SCRIPT_MENU_CURSOR:2";
const RELAY_MENU_OPTION_ONE_MARKER = "SCRIPT_MENU_OPTION_1_HIGHLIGHTED";
const RELAY_MENU_SELECTION_MARKER = "SCRIPT_MENU_SELECTED:1";
const BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
const BUFFY_PASSWORD = "password123";

interface RemoteHarness {
  desktopId: string;
  lanBaseUrl: string;
  ports: {
    auth: number;
    firestore: number;
    relay: number;
  };
  stopRelay(): Promise<void>;
  stop(): Promise<void>;
}

interface ScriptedTask {
  repoId: string;
  taskId: string;
  worktreePath: string | null;
}

interface TerminalEventCollector {
  close(): void;
  outputText(): string;
}

interface RemoteHarnessModule {
  startRemoteHarness(options?: { lanHost?: string }): Promise<RemoteHarness>;
}

interface TerminalFlowModule {
  collectTerminalEvents(
    harness: RemoteHarness,
    taskId: string
  ): TerminalEventCollector;
  createScriptedTask(
    harness: RemoteHarness,
    options: { displayName: string }
  ): Promise<ScriptedTask>;
  waitForTerminalOutput(
    collector: TerminalEventCollector,
    marker: string,
    timeoutMs?: number
  ): Promise<string>;
}

interface FirestoreFieldValue {
  booleanValue?: boolean;
  mapValue?: { fields: FirestoreFields };
  nullValue?: null;
  stringValue?: string;
}

type FirestoreFields = Record<string, FirestoreFieldValue>;

interface AuthSession {
  idToken: string;
  uid: string;
}

export interface MobileRelayHarness {
  credentials: {
    email: string;
    password: string;
  };
  env: Record<string, string>;
  fixture: PtyTerminalFixture;
  harness: RemoteHarness;
  hybridEnv: Record<string, string>;
  hybridFixture: MobileHybridFixture;
  menuInput: string;
  lanOnlyTask: ScriptedTask;
  localTask: ScriptedTask;
  prepareTaskUnreadForMarkRead(): Promise<void>;
  setTaskActivity(activity: TaskActivity): Promise<void>;
  terminalEvents: TerminalEventCollector;
  publishHybridCloudRefresh(): Promise<void>;
  stop(): Promise<void>;
  waitForFirstMenuSelection(timeoutMs?: number): Promise<string>;
  waitForLocalTaskActivity(activity: TaskActivity, timeoutMs?: number): Promise<void>;
}

export interface MobileHybridFixture {
  cloudOnly: {
    refreshedTitle: string;
    taskId: string;
    title: string;
  };
  desktop: {
    desktopId: string;
    displayName: string;
    lanBaseUrl: string;
  };
  duplicate: {
    cloudTitle: string;
    displayTaskId: string;
    lanTitle: string;
    localTaskId: string;
  };
  expectedDisplayTaskIds: string[];
  lanOnly: {
    taskId: string;
    title: string;
  };
  terminal: PtyTerminalFixture;
  unresolvedTaskId: string;
}

export async function startMobileRelayHarness(): Promise<MobileRelayHarness> {
  const remote = await loadRemoteHarnessModules();
  const harness = await remote.harness.startRemoteHarness({
    lanHost: "0.0.0.0"
  });
  let terminalEvents: TerminalEventCollector | null = null;

  try {
    const localTask = await remote.terminal.createScriptedTask(harness, {
      displayName: RELAY_TASK_TITLE
    });
    const lanOnlyTask = await remote.terminal.createScriptedTask(harness, {
      displayName: HYBRID_LAN_ONLY_TITLE
    });
    await assertHybridLanFixture(harness, [localTask, lanOnlyTask]);
    terminalEvents = remote.terminal.collectTerminalEvents(harness, localTask.taskId);
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_TASK_SENTINEL);
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_MENU_CURSOR_MARKER);
    const cloudTaskId = cloudTaskIdFor(harness, localTask);
    const cloudOnlyTaskId =
      `cloud:${HYBRID_CLOUD_ONLY_DESKTOP_ID}:` +
      `${HYBRID_CLOUD_ONLY_REPO_ID}:${HYBRID_CLOUD_ONLY_LOCAL_TASK_ID}`;
    const auth = await signInRelayUser(harness.ports.auth);
    await seedCloudDesktopSnapshot({
      auth,
      cloudTaskId,
      cloudOnlyTaskId,
      harness,
      localTask
    });

    const terminalFixture: PtyTerminalFixture = {
      taskId: cloudTaskId,
      sentinel: RELAY_TASK_SENTINEL,
      expectedCols: 80,
      expectedRows: 24,
      minDecodedBytes: RELAY_TASK_SENTINEL.length
    };
    const hybridFixture: MobileHybridFixture = {
      cloudOnly: {
        refreshedTitle: HYBRID_CLOUD_ONLY_REFRESHED_TITLE,
        taskId: cloudOnlyTaskId,
        title: HYBRID_CLOUD_ONLY_TITLE
      },
      desktop: {
        desktopId: harness.desktopId,
        displayName: "Remote E2E Desktop",
        lanBaseUrl: harness.lanBaseUrl
      },
      duplicate: {
        cloudTitle: HYBRID_DUPLICATE_CLOUD_TITLE,
        displayTaskId: cloudTaskId,
        lanTitle: RELAY_TASK_TITLE,
        localTaskId: localTask.taskId
      },
      expectedDisplayTaskIds: [
        cloudOnlyTaskId,
        cloudTaskId,
        lanOnlyTask.taskId
      ],
      lanOnly: {
        taskId: lanOnlyTask.taskId,
        title: HYBRID_LAN_ONLY_TITLE
      },
      terminal: terminalFixture,
      unresolvedTaskId: HYBRID_UNRESOLVED_TASK_ID
    };

    return {
      credentials: {
        email: BUFFY_EMAIL,
        password: BUFFY_PASSWORD
      },
      env: mobileRelayExpoEnv(harness),
      fixture: terminalFixture,
      harness,
      hybridEnv: mobileRelayExpoEnv(harness, { forceCloud: false }),
      hybridFixture,
      menuInput: "1",
      lanOnlyTask,
      localTask,
      async prepareTaskUnreadForMarkRead() {
        await setLocalTaskRuntimeStatus(harness, localTask.taskId, "busy");
        await setLocalTaskRuntimeStatus(harness, localTask.taskId, "idle");
        await waitForLocalTaskActivity(harness, localTask, "unread");
        await setCloudTaskActivity({
          activity: "unread",
          auth,
          harness,
          localTask,
        });
      },
      setTaskActivity(activity) {
        return setCloudTaskActivity({
          activity,
          auth,
          harness,
          localTask,
        });
      },
      terminalEvents,
      publishHybridCloudRefresh: () =>
        publishHybridCloudRefresh({ auth, harness }),
      async stop() {
        terminalEvents?.close();
        await harness.stop();
      },
      async waitForFirstMenuSelection(timeoutMs = 10_000) {
        const output = await remote.terminal.waitForTerminalOutput(
          terminalEvents!,
          RELAY_MENU_SELECTION_MARKER,
          timeoutMs
        );
        const cursor = output.indexOf(RELAY_MENU_CURSOR_MARKER);
        const highlighted = output.indexOf(RELAY_MENU_OPTION_ONE_MARKER);
        const selected = output.indexOf(RELAY_MENU_SELECTION_MARKER);
        if (cursor < 0 || highlighted < cursor || selected < highlighted) {
          throw new Error(
            "Expected the scripted menu to start on option 2, highlight option 1, then select option 1. " +
            `Terminal output:\n${output}`
          );
        }
        return output;
      },
      waitForLocalTaskActivity(activity, timeoutMs) {
        return waitForLocalTaskActivity(harness, localTask, activity, timeoutMs);
      }
    };
  } catch (error) {
    terminalEvents?.close();
    await harness.stop();
    throw error;
  }
}

async function publishHybridCloudRefresh(input: {
  auth: AuthSession;
  harness: RemoteHarness;
}): Promise<void> {
  await setFirestoreDocument(
    input.harness.ports.firestore,
    [
      "users",
      input.auth.uid,
      "desktops",
      HYBRID_CLOUD_ONLY_DESKTOP_ID,
      "tasks",
      HYBRID_CLOUD_ONLY_LOCAL_TASK_ID
    ],
    input.auth.idToken,
    {
      title: stringValue(HYBRID_CLOUD_ONLY_REFRESHED_TITLE),
      displayName: stringValue(HYBRID_CLOUD_ONLY_REFRESHED_TITLE),
      updatedAt: stringValue(new Date().toISOString())
    }
  );
}

async function loadRemoteHarnessModules(): Promise<{
  harness: RemoteHarnessModule;
  terminal: TerminalFlowModule;
}> {
  const harnessModulePath = "../../../../tests/remote-e2e/src/harness.ts";
  const terminalModulePath =
    "../../../../tests/remote-e2e/src/terminalFlowTestUtils.ts";
  const [harness, terminal] = await Promise.all([
    import(harnessModulePath),
    import(terminalModulePath)
  ]);

  return {
    harness: harness as unknown as RemoteHarnessModule,
    terminal: terminal as unknown as TerminalFlowModule
  };
}

export function mobileRelayExpoEnv(
  harness: Pick<RemoteHarness, "ports">,
  options: { forceCloud: boolean } = { forceCloud: true }
): Record<string, string> {
  return {
    EXPO_PUBLIC_KANNA_FORCE_CLOUD: options.forceCloud ? "1" : "0",
    EXPO_PUBLIC_KANNA_RELAY_URL: `ws://127.0.0.1:${harness.ports.relay}`,
    EXPO_PUBLIC_KANNA_CLOUD_ENV: "local",
    EXPO_PUBLIC_FIREBASE_API_KEY: "kanna-local",
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "kanna-local.firebaseapp.com",
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-local",
    EXPO_PUBLIC_FIREBASE_APP_ID: "kanna-mobile-local",
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1",
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: String(harness.ports.auth),
    EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
    EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT: String(harness.ports.firestore),
    KANNA_APP_ENV: "dev"
  };
}

function cloudTaskIdFor(
  harness: RemoteHarness,
  localTask: ScriptedTask
): string {
  return `cloud:${harness.desktopId}:${localTask.repoId}:${localTask.taskId}`;
}

async function seedCloudDesktopSnapshot(input: {
  auth: AuthSession;
  cloudTaskId: string;
  cloudOnlyTaskId: string;
  harness: RemoteHarness;
  localTask: ScriptedTask;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await setFirestoreDocument(
    input.harness.ports.firestore,
    ["users", input.auth.uid, "desktops", input.harness.desktopId],
    input.auth.idToken,
    {
      desktopId: stringValue(input.harness.desktopId),
      displayName: stringValue("Remote E2E Desktop"),
      updatedAt: stringValue(updatedAt)
    }
  );

  await setFirestoreDocument(
    input.harness.ports.firestore,
    [
      "users",
      input.auth.uid,
      "desktops",
      input.harness.desktopId,
      "tasks",
      input.localTask.taskId
    ],
    input.auth.idToken,
    {
      cloudTaskId: stringValue(input.cloudTaskId),
      localRepoId: stringValue(input.localTask.repoId),
      ownerDesktopId: stringValue(input.harness.desktopId),
      ownerLocalTaskId: stringValue(input.localTask.taskId),
      title: stringValue(HYBRID_DUPLICATE_CLOUD_TITLE),
      promptSnippet: stringValue("Run deterministic scripted task"),
      displayName: stringValue(HYBRID_DUPLICATE_CLOUD_TITLE),
      stage: stringValue("review"),
      status: stringValue("active"),
      activity: stringValue("working"),
      repo: mapValue({
        cloudRepoId: stringValue(input.localTask.repoId),
        name: stringValue("Mobile relay Appium repo")
      }),
      agent: mapValue({
        provider: stringValue("codex"),
        type: stringValue("pty")
      }),
      updatedAt: stringValue(updatedAt),
      closedAt: nullValue()
    }
  );

  await setFirestoreDocument(
    input.harness.ports.firestore,
    ["users", input.auth.uid, "desktops", HYBRID_CLOUD_ONLY_DESKTOP_ID],
    input.auth.idToken,
    {
      desktopId: stringValue(HYBRID_CLOUD_ONLY_DESKTOP_ID),
      displayName: stringValue("Cloud-only E2E Desktop"),
      updatedAt: stringValue(updatedAt)
    }
  );

  await setFirestoreDocument(
    input.harness.ports.firestore,
    [
      "users",
      input.auth.uid,
      "desktops",
      HYBRID_CLOUD_ONLY_DESKTOP_ID,
      "tasks",
      HYBRID_CLOUD_ONLY_LOCAL_TASK_ID
    ],
    input.auth.idToken,
    {
      cloudTaskId: stringValue(input.cloudOnlyTaskId),
      localRepoId: stringValue(HYBRID_CLOUD_ONLY_REPO_ID),
      ownerDesktopId: stringValue(HYBRID_CLOUD_ONLY_DESKTOP_ID),
      ownerLocalTaskId: stringValue(HYBRID_CLOUD_ONLY_LOCAL_TASK_ID),
      title: stringValue(HYBRID_CLOUD_ONLY_TITLE),
      promptSnippet: stringValue("Visible only through the cloud task index"),
      displayName: stringValue(HYBRID_CLOUD_ONLY_TITLE),
      stage: stringValue("in progress"),
      status: stringValue("idle"),
      repo: mapValue({
        cloudRepoId: stringValue(HYBRID_CLOUD_ONLY_REPO_ID),
        name: stringValue("Hybrid cloud-only repo")
      }),
      agent: mapValue({
        provider: stringValue("codex"),
        type: stringValue("pty")
      }),
      updatedAt: stringValue(updatedAt),
      closedAt: nullValue()
    }
  );
}

async function assertHybridLanFixture(
  harness: RemoteHarness,
  tasks: readonly ScriptedTask[]
): Promise<void> {
  const response = await fetch(`${harness.lanBaseUrl}/v1/tasks/recent`);
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(
      `Hybrid LAN fixture preflight failed (${response.status}): ${JSON.stringify(body)}`
    );
  }

  const rows = body.filter(isRecord);
  for (const task of tasks) {
    if (!rows.some((row) => row.id === task.taskId && row.repoId === task.repoId)) {
      throw new Error(
        `Hybrid LAN fixture is missing task ${task.taskId} in repo ${task.repoId}: ` +
          JSON.stringify(body)
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function setCloudTaskActivity(input: {
  activity: TaskActivity;
  auth: AuthSession;
  harness: RemoteHarness;
  localTask: ScriptedTask;
}): Promise<void> {
  await setFirestoreDocument(
    input.harness.ports.firestore,
    [
      "users",
      input.auth.uid,
      "desktops",
      input.harness.desktopId,
      "tasks",
      input.localTask.taskId,
    ],
    input.auth.idToken,
    { activity: stringValue(input.activity) },
  );
}

async function setLocalTaskRuntimeStatus(
  harness: RemoteHarness,
  taskId: string,
  status: "busy" | "idle",
): Promise<void> {
  const response = await fetch(
    `${harness.lanBaseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/runtime-status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, selected: false }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to set local task ${taskId} runtime status ${status}: ` +
        `${response.status} ${await response.text()}`,
    );
  }
}

async function waitForLocalTaskActivity(
  harness: RemoteHarness,
  task: ScriptedTask,
  expected: TaskActivity,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastObserved: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${harness.lanBaseUrl}/v1/repos/${encodeURIComponent(task.repoId)}/tasks`,
    );
    if (response.ok) {
      const tasks = await response.json() as Array<{ id?: unknown; activity?: unknown }>;
      lastObserved = tasks.find((candidate) => candidate.id === task.taskId)?.activity ?? null;
      if (lastObserved === expected) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Expected owner task ${task.taskId} activity ${expected}; last observed ${String(lastObserved)}`,
  );
}

async function signInRelayUser(authPort: number): Promise<AuthSession> {
  const response = await fetch(
    `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: BUFFY_EMAIL,
        password: BUFFY_PASSWORD,
        returnSecureToken: true
      })
    }
  );
  const body = await response.json().catch(() => null) as { idToken?: string; localId?: string } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`Failed to sign into relay Auth emulator: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, uid: body.localId };
}

async function setFirestoreDocument(
  firestorePort: number,
  path: string[],
  bearerToken: string,
  fields: FirestoreFields
): Promise<void> {
  const encodedPath = path.map(encodeURIComponent).join("/");
  const url = new URL(
    `http://127.0.0.1:${firestorePort}/v1/projects/kanna-local/databases/(default)/documents/` +
      encodedPath
  );
  for (const field of Object.keys(fields)) {
    url.searchParams.append("updateMask.fieldPaths", field);
  }
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    throw new Error(
      `Failed to seed Firestore document ${path.join("/")}: ` +
        `${response.status} ${await response.text()}`
    );
  }
}

function stringValue(value: string): FirestoreFieldValue {
  return { stringValue: value };
}

function mapValue(fields: FirestoreFields): FirestoreFieldValue {
  return { mapValue: { fields } };
}

function nullValue(): FirestoreFieldValue {
  return { nullValue: null };
}

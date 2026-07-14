import { createHash } from "node:crypto";
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
const CLOUD_PUBLICATION_TIMEOUT_MS = 30_000;

type MobileRelayHarnessMode = "relay" | "hybrid";

interface RemoteHarness {
  desktopId: string;
  lanBaseUrl: string;
  ports: {
    auth: number;
    firestore: number;
    relay: number;
  };
  restartServerWithIdentity(identity: {
    desktopId: string;
    desktopSecret?: string | null;
  }): Promise<void>;
  startServer(): Promise<void>;
  stopRelay(): Promise<void>;
  stopServer(): Promise<void>;
  waitForDesktop(desktopId?: string): Promise<void>;
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

export async function startMobileRelayHarness(
  options: { mode?: MobileRelayHarnessMode } = {}
): Promise<MobileRelayHarness> {
  const mode = options.mode ?? "relay";
  const remote = await loadRemoteHarnessModules();
  const harness = await remote.harness.startRemoteHarness({
    lanHost: "0.0.0.0"
  });
  let terminalEvents: TerminalEventCollector | null = null;

  try {
    const auth = await signInRelayUser(harness.ports.auth);
    if (mode === "relay") {
      const desktopSecret = desktopSecretFor(harness.desktopId);
      await publishDesktopCredential({
        auth,
        desktopId: harness.desktopId,
        desktopSecret,
        displayName: "Remote E2E Desktop",
        firestorePort: harness.ports.firestore
      });
      await harness.restartServerWithIdentity({
        desktopId: harness.desktopId,
        desktopSecret
      });
      await harness.waitForDesktop();
    }

    const localTask = await remote.terminal.createScriptedTask(harness, {
      displayName: RELAY_TASK_TITLE
    });
    const lanOnlyTask = mode === "hybrid"
      ? await remote.terminal.createScriptedTask(harness, {
          displayName: HYBRID_LAN_ONLY_TITLE
        })
      : localTask;
    await assertHybridLanFixture(
      harness,
      mode === "hybrid" ? [localTask, lanOnlyTask] : [localTask]
    );
    const cloudTaskId = cloudTaskIdFor(harness, localTask);
    const cloudOnlyTaskId =
      `cloud:${HYBRID_CLOUD_ONLY_DESKTOP_ID}:` +
      `${HYBRID_CLOUD_ONLY_REPO_ID}:${HYBRID_CLOUD_ONLY_LOCAL_TASK_ID}`;
    if (mode === "relay") {
      await setLocalTaskRuntimeStatus(harness, localTask.taskId, "busy");
      await waitForLocalTaskActivity(harness, localTask, "working");
      await waitForCloudTaskActivity({
        activity: "working",
        auth,
        harness,
        task: localTask
      }, CLOUD_PUBLICATION_TIMEOUT_MS, 1_000);
    } else {
      await seedHybridCloudSnapshots({ auth, harness, localTask });
    }

    terminalEvents = remote.terminal.collectTerminalEvents(harness, localTask.taskId);
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_TASK_SENTINEL);
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_MENU_CURSOR_MARKER);

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
        await setPublishedTaskActivity({
          activity: "unread",
          auth,
          harness,
          task: localTask
        });
      },
      setTaskActivity(activity) {
        return setPublishedTaskActivity({
          activity,
          auth,
          harness,
          task: localTask
        });
      },
      terminalEvents,
      publishHybridCloudRefresh: () =>
        publishHybridCloudRefresh({ harness }),
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
  harness: RemoteHarness;
}): Promise<void> {
  await publishRelayTaskSnapshot({
    desktopId: HYBRID_CLOUD_ONLY_DESKTOP_ID,
    desktopSecret: desktopSecretFor(HYBRID_CLOUD_ONLY_DESKTOP_ID),
    displayName: "Cloud-only E2E Desktop",
    relayPort: input.harness.ports.relay,
    tasks: [
      syntheticCloudTask({
        activity: "idle",
        desktopId: HYBRID_CLOUD_ONLY_DESKTOP_ID,
        displayName: HYBRID_CLOUD_ONLY_REFRESHED_TITLE,
        repoId: HYBRID_CLOUD_ONLY_REPO_ID,
        taskId: HYBRID_CLOUD_ONLY_LOCAL_TASK_ID,
        title: HYBRID_CLOUD_ONLY_REFRESHED_TITLE
      })
    ]
  });
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

async function seedHybridCloudSnapshots(input: {
  auth: AuthSession;
  harness: RemoteHarness;
  localTask: ScriptedTask;
}): Promise<void> {
  const fixtures = [
    {
      desktopId: input.harness.desktopId,
      displayName: "Remote E2E Desktop",
      tasks: [
        syntheticCloudTask({
          activity: "working",
          desktopId: input.harness.desktopId,
          displayName: HYBRID_DUPLICATE_CLOUD_TITLE,
          repoId: input.localTask.repoId,
          taskId: input.localTask.taskId,
          title: HYBRID_DUPLICATE_CLOUD_TITLE
        })
      ]
    },
    {
      desktopId: HYBRID_CLOUD_ONLY_DESKTOP_ID,
      displayName: "Cloud-only E2E Desktop",
      tasks: [
        syntheticCloudTask({
          activity: "idle",
          desktopId: HYBRID_CLOUD_ONLY_DESKTOP_ID,
          displayName: HYBRID_CLOUD_ONLY_TITLE,
          repoId: HYBRID_CLOUD_ONLY_REPO_ID,
          taskId: HYBRID_CLOUD_ONLY_LOCAL_TASK_ID,
          title: HYBRID_CLOUD_ONLY_TITLE
        })
      ]
    }
  ];

  await input.harness.stopServer();
  try {
    for (const fixture of fixtures) {
      const desktopSecret = desktopSecretFor(fixture.desktopId);
      await publishDesktopCredential({
        auth: input.auth,
        desktopId: fixture.desktopId,
        desktopSecret,
        displayName: fixture.displayName,
        firestorePort: input.harness.ports.firestore
      });
      await publishRelayTaskSnapshot({
        ...fixture,
        desktopSecret,
        relayPort: input.harness.ports.relay
      });
    }
  } finally {
    await input.harness.startServer();
    await input.harness.waitForDesktop();
  }
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

async function setPublishedTaskActivity(input: {
  activity: TaskActivity;
  auth: AuthSession;
  harness: RemoteHarness;
  task: ScriptedTask;
}): Promise<void> {
  if (input.activity === "working") {
    await setLocalTaskRuntimeStatus(input.harness, input.task.taskId, "busy");
  } else if (input.activity === "unread") {
    await setLocalTaskRuntimeStatus(input.harness, input.task.taskId, "busy");
    await setLocalTaskRuntimeStatus(input.harness, input.task.taskId, "idle");
  } else {
    await postLocalTaskAction(input.harness, input.task.taskId, "mark-read");
  }
  await waitForLocalTaskActivity(
    input.harness,
    input.task,
    input.activity
  );
  await waitForCloudTaskActivity(input);
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

async function postLocalTaskAction(
  harness: RemoteHarness,
  taskId: string,
  action: "mark-read"
): Promise<void> {
  const response = await fetch(
    `${harness.lanBaseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/${action}`,
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to apply local task ${taskId} action ${action}: ` +
        `${response.status} ${await response.text()}`
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

async function waitForCloudTaskActivity(input: {
  activity: TaskActivity;
  auth: AuthSession;
  harness: RemoteHarness;
  task: ScriptedTask;
}, timeoutMs = CLOUD_PUBLICATION_TIMEOUT_MS, stableForMs = 0): Promise<void> {
  const path = [
    "users",
    input.auth.uid,
    "desktops",
    input.harness.desktopId,
    "tasks"
  ].map(encodeURIComponent).join("/");
  const url =
    `http://127.0.0.1:${input.harness.ports.firestore}/v1/projects/kanna-local/` +
    `databases/(default)/documents/${path}?pageSize=100`;
  const deadline = Date.now() + timeoutMs;
  let lastObserved: unknown = null;
  let matchingSince: number | null = null;

  while (Date.now() < deadline) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${input.auth.idToken}` }
    });
    const body = await response.json().catch(() => null) as {
      documents?: Array<{ fields?: FirestoreFields }>;
    } | null;
    if (response.ok) {
      const taskDocument = body?.documents?.find((document) =>
        document.fields?.ownerLocalTaskId?.stringValue === input.task.taskId
        && document.fields?.localRepoId?.stringValue === input.task.repoId
      );
      lastObserved = taskDocument?.fields?.activity?.stringValue ?? null;
      if (lastObserved === input.activity) {
        matchingSince ??= Date.now();
        if (Date.now() - matchingSince >= stableForMs) return;
      } else {
        matchingSince = null;
      }
    } else {
      lastObserved = `${response.status} ${JSON.stringify(body)}`;
      matchingSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Expected published task ${input.task.taskId} activity ${input.activity}; ` +
      `last observed ${String(lastObserved)}`
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

function desktopSecretFor(desktopId: string): string {
  return createHash("sha256")
    .update(`mobile-relay-e2e:${desktopId}`)
    .digest("hex");
}

async function publishDesktopCredential(input: {
  auth: AuthSession;
  desktopId: string;
  desktopSecret: string;
  displayName: string;
  firestorePort: number;
}): Promise<void> {
  await setFirestoreDocument(
    input.firestorePort,
    ["desktopCredentials", input.desktopId.split("/").join("_")],
    input.auth.idToken,
    {
      desktopId: stringValue(input.desktopId),
      desktopSecretHash: stringValue(
        createHash("sha256").update(input.desktopSecret).digest("hex")
      ),
      displayName: stringValue(input.displayName),
      revokedAt: nullValue(),
      uid: stringValue(input.auth.uid),
      updatedAt: stringValue(new Date().toISOString())
    }
  );
}

function syntheticCloudTask(input: {
  activity: TaskActivity;
  desktopId: string;
  displayName: string;
  repoId: string;
  taskId: string;
  title: string;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    localRepoId: input.repoId,
    ownerDesktopId: input.desktopId,
    ownerLocalTaskId: input.taskId,
    title: input.title,
    promptSnippet: "Run deterministic scripted task",
    displayName: input.displayName,
    stage: "in progress",
    activity: input.activity,
    status: "active",
    repo: {
      cloudRepoId: input.repoId,
      name: "Mobile relay Appium repo",
      remoteUrl: null,
      remoteUrlHash: null,
      defaultBranch: null
    },
    branch: null,
    baseRef: null,
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null
    },
    blockedByTaskIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null
  };
}

async function publishRelayTaskSnapshot(input: {
  desktopId: string;
  desktopSecret: string;
  displayName: string;
  relayPort: number;
  tasks: Array<Record<string, unknown>>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const publicationId = `mobile-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const socket = new WebSocket(`ws://127.0.0.1:${input.relayPort}`);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out publishing cloud snapshot for ${input.desktopId}`));
    }, CLOUD_PUBLICATION_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "auth",
        desktop_id: input.desktopId,
        desktop_secret: input.desktopSecret
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = parseJsonRecord(event.data);
      if (message?.type === "auth_ok") {
        socket.send(JSON.stringify({
          type: "task_snapshot_publish",
          id: publicationId,
          snapshot: {
            schemaVersion: 1,
            desktop: { displayName: input.displayName },
            tasks: input.tasks
          }
        }));
      } else if (
        message?.type === "task_snapshot_ack"
        && message.id === publicationId
      ) {
        if (message.ok === true) finish();
        else finish(new Error(
          `Relay rejected cloud snapshot for ${input.desktopId}: ${String(message.error)}`
        ));
      }
    });
    socket.addEventListener("error", () => {
      finish(new Error(`Relay socket failed for ${input.desktopId}`));
    });
    socket.addEventListener("close", (event) => {
      if (!settled) {
        finish(new Error(
          `Relay closed while publishing ${input.desktopId}: ${event.code} ${event.reason}`
        ));
      }
    });
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(
      typeof value === "string" ? value : Buffer.from(value as ArrayBuffer).toString("utf8")
    ) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function nullValue(): FirestoreFieldValue {
  return { nullValue: null };
}

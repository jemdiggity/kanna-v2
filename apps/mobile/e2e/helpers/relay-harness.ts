import type { PtyTerminalFixture } from "../specs/smoke/list-detail-back.e2e";

const RELAY_TASK_TITLE = "Mobile relay Appium task";
const RELAY_TASK_SENTINEL = "SCRIPT_READY";
const RELAY_INPUT_MARKER = "mobile-relay-appium-input";
const BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
const BUFFY_PASSWORD = "password123";

interface RemoteHarness {
  desktopId: string;
  ports: {
    auth: number;
    firestore: number;
    relay: number;
  };
  stop(): Promise<void>;
}

interface ScriptedTask {
  repoId: string;
  taskId: string;
  worktreePath: string | null;
}

interface TerminalEventCollector {
  close(): void;
}

interface RemoteHarnessModule {
  startRemoteHarness(): Promise<RemoteHarness>;
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
  inputMarker: string;
  localTask: ScriptedTask;
  terminalEvents: TerminalEventCollector;
  stop(): Promise<void>;
  waitForInput(timeoutMs?: number): Promise<string>;
}

export async function startMobileRelayHarness(): Promise<MobileRelayHarness> {
  const remote = await loadRemoteHarnessModules();
  const harness = await remote.harness.startRemoteHarness();
  let terminalEvents: TerminalEventCollector | null = null;

  try {
    const localTask = await remote.terminal.createScriptedTask(harness, {
      displayName: RELAY_TASK_TITLE
    });
    terminalEvents = remote.terminal.collectTerminalEvents(harness, localTask.taskId);
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_TASK_SENTINEL);
    const cloudTaskId = cloudTaskIdFor(harness, localTask);
    const auth = await signInRelayUser(harness.ports.auth);
    await seedCloudDesktopSnapshot({
      auth,
      cloudTaskId,
      harness,
      localTask
    });

    return {
      credentials: {
        email: BUFFY_EMAIL,
        password: BUFFY_PASSWORD
      },
      env: mobileRelayExpoEnv(harness),
      fixture: {
        taskId: cloudTaskId,
        sentinel: RELAY_TASK_SENTINEL,
        expectedCols: 80,
        expectedRows: 24,
        minDecodedBytes: RELAY_TASK_SENTINEL.length
      },
      harness,
      inputMarker: RELAY_INPUT_MARKER,
      localTask,
      terminalEvents,
      async stop() {
        terminalEvents?.close();
        await harness.stop();
      },
      waitForInput(timeoutMs = 10_000) {
        return remote.terminal.waitForTerminalOutput(
          terminalEvents!,
          RELAY_INPUT_MARKER,
          timeoutMs
        );
      }
    };
  } catch (error) {
    terminalEvents?.close();
    await harness.stop();
    throw error;
  }
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

function mobileRelayExpoEnv(harness: RemoteHarness): Record<string, string> {
  return {
    EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1",
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
      title: stringValue(RELAY_TASK_TITLE),
      promptSnippet: stringValue("Run deterministic scripted task"),
      displayName: stringValue(RELAY_TASK_TITLE),
      stage: stringValue("in progress"),
      status: stringValue("working"),
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

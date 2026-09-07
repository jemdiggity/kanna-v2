import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PtyTerminalFixture } from "../specs/smoke/list-detail-back.e2e";
import type { TaskActivity } from "../../src/lib/api/types";
import { DEFAULT_MOBILE_TERMINAL_GEOMETRY } from "../../src/mobileTerminalGeometry";
import { localProcessFetch, type LocalProcessFetch } from "./local-process-fetch";

const RELAY_TASK_TITLE = "Relay card current title";
const RELAY_ORIGINAL_PROMPT = "Original relay request must stay hidden";
const RELAY_REPO_LABEL = "Relay fixture repository";
const RELAY_WAITING_PROMPT = RELAY_TASK_TITLE;
const RELAY_TASK_STAGE = "in progress";
const HYBRID_DUPLICATE_CLOUD_TITLE = "Hybrid duplicate from cloud";
const HYBRID_CLOUD_ONLY_TITLE = "Hybrid cloud-only task";
const HYBRID_CLOUD_ONLY_REFRESHED_TITLE = "Hybrid cloud-only task refreshed";
const HYBRID_LAN_ONLY_TITLE = "Hybrid LAN-only task";
const HYBRID_CLOUD_ONLY_DESKTOP_ID = "mobile-hybrid-cloud-only-desktop";
const HYBRID_CLOUD_ONLY_REPO_ID = "mobile-hybrid-cloud-only-repo";
const HYBRID_CLOUD_ONLY_LOCAL_TASK_ID = "mobile-hybrid-cloud-only-task";
const HYBRID_UNRESOLVED_TASK_ID = "mobile-hybrid-unresolved-selection";
const RELAY_ORDERING_DESKTOP_ID = "mobile-relay-ordering-desktop";
const RELAY_ORDERING_OLDER_TASK_ID = "mobile-relay-ordering-older";
const RELAY_ORDERING_NEWER_TASK_ID = "mobile-relay-ordering-newer";
const RELAY_ORDERING_OLDER_CREATED_AT = "2026-07-15T08:00:00.000Z";
const RELAY_ORDERING_NEWER_CREATED_AT = "2026-07-16T08:00:00.000Z";
const RELAY_ORDERING_OLDER_UPDATED_AT = "2026-07-17T12:00:00.000Z";
const RELAY_ORDERING_NEWER_UPDATED_AT = "2026-07-17T11:00:00.000Z";
const RELAY_TASK_SENTINEL = "SCRIPT_READY";
const RELAY_MENU_CURSOR_MARKER = "SCRIPT_MENU_CURSOR:2";
const RELAY_QUICK_REPLY_DRAFT = "  Preserve the relay fixture.  ";
const RELAY_CUSTOMIZED_QUICK_REPLY = "Persisted relay approval.";
const RELAY_QUICK_REPLY_EXPECTED_INPUT =
  `${RELAY_CUSTOMIZED_QUICK_REPLY}\n\nPreserve the relay fixture.`;
const BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
const BUFFY_PASSWORD = "password123";
const CLOUD_PUBLICATION_TIMEOUT_MS = 30_000;
const INPUT_TRACE_FILE = ".kanna-e2e-inputs";

export const MOBILE_RELAY_PTY_HISTORY_FIXTURE = {
  maxEncodedChars: 100_000,
  minEncodedChars: 1_000,
  minRetainedScrollbackLines: 9_000,
  sentinel: "MOBILE_PTY_SNAPSHOT_SENTINEL"
} as const;

export const MOBILE_RELAY_FILE_PREVIEW_FIXTURE = {
  ambiguousBarePath: "shared.ts",
  ambiguousCanonicalPaths: [
    "fixtures/a/shared.ts",
    "fixtures/b/shared.ts"
  ],
  content: [
    "# Mobile Relay Preview",
    "",
    "Rendered through the authenticated owner relay.",
    "",
    "```ts",
    'const relayStatus: string = "connected";',
    "```",
    "TARGET RAW LINE"
  ].join("\n"),
  expectedHeading: "Mobile Relay Preview",
  expectedHighlightedToken: "const",
  expectedHighlightedTokenClass: "hljs-keyword",
  expectedRenderedText: "Rendered through the authenticated owner relay.",
  expectedRawLine: "TARGET RAW LINE",
  expectedCanonicalRowOrder: [
    "fixtures/unique/TaskScreen.tsx",
    "fixtures/a/shared.ts",
    "fixtures/b/shared.ts",
    "docs/spec.md"
  ],
  line: 7,
  mentionedCount: 3,
  mentionedLinks: [
    "docs/spec.md",
    "TaskScreen.tsx:7",
    "shared.ts",
    "TaskScreen.tsx:7"
  ],
  missingLink: "docs/mobile-preview-missing.md",
  path: "docs/spec.md",
  rawLink: "TaskScreen.tsx:7",
  renderedLink: "docs/spec.md",
  uniqueBarePath: "TaskScreen.tsx",
  uniqueCanonicalPath: "fixtures/unique/TaskScreen.tsx",
  uniqueContent: [
    "export function relayFixture() {",
    '  const status = "connected";',
    "  return status;",
    "}",
    "",
    "// Mentioned by bare filename.",
    "TARGET RAW LINE"
  ].join("\n")
} as const;

export type MobileRelayFilePreviewFixture =
  typeof MOBILE_RELAY_FILE_PREVIEW_FIXTURE;

export const MOBILE_RELAY_COMPANION_FIXTURE = {
  choice: "relay-layout-a",
  initialMarker: "Initial relay visual companion",
  sessionId: "mobile-relay-companion",
  sourceErrorMessage:
    "The visual companion is too large. Ask the agent to simplify the screen.",
  updatedMarker: "Updated relay visual companion"
} as const;

export type MobileRelayCompanionFixture =
  typeof MOBILE_RELAY_COMPANION_FIXTURE;

type MobileRelayHarnessMode = "relay" | "hybrid";

interface RemoteHarness {
  client: {
    invokeDesktop(input: {
      desktopId: string;
      method: string;
      path: string;
      body?: unknown;
    }): Promise<unknown>;
  };
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
  waitForSnapshot(
    expectation: {
      cols?: number;
      maxEncodedChars?: number;
      minEncodedChars: number;
      minRetainedScrollbackLines?: number;
      rows?: number;
      sentinel: string;
    },
    timeoutMs?: number,
  ): Promise<{
    cols: number;
    dataB64: string;
    rows: number;
    scrollbackLines: number;
  }>;
  waitForNewSnapshot(
    expectation: {
      minEncodedChars: number;
      sentinel: string;
    },
    timeoutMs?: number,
  ): Promise<{
    cols: number;
    dataB64: string;
    rows: number;
  }>;
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
    options: {
      displayName: string;
      inputTraceFile?: string;
      prompt?: string;
      repoName?: string;
      snapshotHistory?: {
        sentinel: string;
      };
      terminalCols?: number;
      terminalRows?: number;
      waitingPromptSnippet?: string;
    }
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
  filePreview: MobileRelayFilePreviewFixture;
  companion: {
    fixture: MobileRelayCompanionFixture;
    disconnect(): Promise<void>;
    expectNoEvent(choice: string): Promise<void>;
    invalidateSource(): Promise<void>;
    reconnect(): Promise<void>;
    restoreSource(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    waitForEvent(choice: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  };
  harness: RemoteHarness;
  hybridEnv: Record<string, string>;
  hybridFixture: MobileHybridFixture;
  quickReply: {
    draft: string;
    expectedInput: string;
    text: string;
  };
  lanOnlyTask: ScriptedTask;
  localTask: ScriptedTask;
  createPairingSession(): Promise<HarnessPairingSession>;
  emitFilePreviewLinks(): Promise<void>;
  expirePairingSession(): Promise<void>;
  prepareTaskUnreadForMarkRead(): Promise<void>;
  setTaskActivity(activity: TaskActivity): Promise<void>;
  taskRow: {
    originalPromptSnippet: string;
    repoLabel: string;
    stage: string;
    taskId: string;
    title: string;
    waitingPromptSnippet: string;
  };
  taskOrdering: RelayTaskOrderingFixture;
  terminalEvents: TerminalEventCollector;
  publishHybridCloudRefresh(): Promise<void>;
  setLanHttpEnabled(enabled: boolean): Promise<void>;
  stop(): Promise<void>;
  waitForQuickReplyInput(
    expectedInput: string,
    timeoutMs?: number,
  ): Promise<string>;
  waitForLocalTaskActivity(activity: TaskActivity, timeoutMs?: number): Promise<void>;
  beginMobileTerminalGeometryObservation(timeoutMs?: number): Promise<void>;
}

export interface RelayTaskOrderingFixture {
  sourceOrderTaskIds: [string, string];
  expectedVisualOrderTaskIds: [string, string];
}

export interface HarnessPairingSession {
  code: string;
  pairingPayload: string;
  desktopId: string;
  desktopName: string;
  lanHost: string;
  lanPort: number;
  expiresAtUnixMs: number;
}

export async function createHarnessPairingSession(
  baseUrl: string,
  fetchImpl: LocalProcessFetch = localProcessFetch
): Promise<HarnessPairingSession> {
  const response = await fetchImpl(`${baseUrl}/v1/pairing/sessions`, {
    method: "POST"
  });
  const body = await response.json().catch(() => null) as HarnessPairingSession | null;
  if (!response.ok || !body?.code || !body.pairingPayload) {
    throw new Error(
      `Failed to create mobile E2E pairing session: ${response.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

export async function updateHarnessMobileMachineControls(
  baseUrl: string,
  controls: {
    expirePairingSession?: boolean;
    lanHttpEnabled?: boolean;
  },
  fetchImpl: LocalProcessFetch = localProcessFetch
): Promise<void> {
  const response = await fetchImpl(
    `${baseUrl}/v1/e2e/mobile-machine-controls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(controls)
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to update mobile E2E machine controls: ${response.status} ${await response.text()}`
    );
  }
}

export function assertSingleSubmittedTaskInput(
  output: string,
  expectedInput: string,
): void {
  const normalizedOutput = output.replace(/\r+\n/g, "\n").replace(/\r/g, "\n");
  const expectedMarker = `SCRIPT_INPUT:${expectedInput}\n`;
  const matchingInputCount = normalizedOutput.split(expectedMarker).length - 1;
  if (matchingInputCount !== 1) {
    throw new Error(
      `Expected exactly one matching task input, observed ${matchingInputCount}. ` +
        `Terminal output:\n${output}`,
    );
  }
}

export interface MobileHybridFixture {
  cloudOnly: {
    localTaskId: string;
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
      displayName: RELAY_TASK_TITLE,
      ...(mode === "relay"
        ? {
            prompt: RELAY_ORIGINAL_PROMPT,
            repoName: RELAY_REPO_LABEL,
            inputTraceFile: INPUT_TRACE_FILE,
            snapshotHistory: {
              sentinel: MOBILE_RELAY_PTY_HISTORY_FIXTURE.sentinel,
            },
            // Start at the daemon default so the mobile detail's resize is
            // observable, rather than inherited from fixture seeding.
            terminalCols: 80,
            terminalRows: 24,
            waitingPromptSnippet: RELAY_WAITING_PROMPT,
          }
        : {}),
    });
    await seedMobileRelayFilePreview(localTask);
    await seedMobileRelayCompanion(localTask);
    const lanOnlyTask = mode === "hybrid"
      ? await remote.terminal.createScriptedTask(harness, {
          displayName: HYBRID_LAN_ONLY_TITLE
        })
      : localTask;
    await assertHybridLanFixture(
      harness,
      mode === "hybrid" ? [localTask, lanOnlyTask] : [localTask]
    );
    let cloudTaskId = cloudTaskIdFor(harness, localTask);
    const cloudOnlyTaskId =
      `cloud:${HYBRID_CLOUD_ONLY_DESKTOP_ID}:` +
      `${HYBRID_CLOUD_ONLY_REPO_ID}:${HYBRID_CLOUD_ONLY_LOCAL_TASK_ID}`;
    if (mode === "relay") {
      await setLocalTaskRuntimeStatus(harness, localTask.taskId, "busy");
      await waitForLocalTaskActivity(harness, localTask, "working");
      cloudTaskId = await waitForCloudTaskActivity({
        activity: "working",
        auth,
        harness,
        task: localTask
      }, CLOUD_PUBLICATION_TIMEOUT_MS, 1_000);
      await seedRelayTaskOrderingSnapshot({ auth, harness, localTask });
    } else {
      await seedHybridCloudSnapshots({ auth, harness, localTask });
    }

    terminalEvents = remote.terminal.collectTerminalEvents(harness, localTask.taskId);
    await remote.terminal.waitForTerminalOutput(
      terminalEvents,
      mode === "relay"
        ? MOBILE_RELAY_PTY_HISTORY_FIXTURE.sentinel
        : RELAY_TASK_SENTINEL,
      30_000,
    );
    let historySnapshot: {
      cols: number;
      dataB64: string;
      rows: number;
      scrollbackLines: number;
    } | null = null;
    if (mode === "relay") {
      terminalEvents.close();
      terminalEvents = remote.terminal.collectTerminalEvents(
        harness,
        localTask.taskId,
      );
      historySnapshot = await terminalEvents.waitForSnapshot(
        MOBILE_RELAY_PTY_HISTORY_FIXTURE,
        30_000,
      );
      process.stdout.write(
        `[mobile-e2e] authoritative PTY window encodedChars=` +
          `${historySnapshot.dataB64.length} decodedBytes=` +
          `${Buffer.from(historySnapshot.dataB64, "base64").length} ` +
          `retainedScrollbackLines=${historySnapshot.scrollbackLines} ` +
          `dimensions=${historySnapshot.cols}x${historySnapshot.rows}\n`,
      );
    }
    await remote.terminal.waitForTerminalOutput(terminalEvents, RELAY_MENU_CURSOR_MARKER);
    const terminalFixture: PtyTerminalFixture = {
      taskId: cloudTaskId,
      sentinel:
        historySnapshot === null
          ? RELAY_TASK_SENTINEL
          : MOBILE_RELAY_PTY_HISTORY_FIXTURE.sentinel,
      expectedCols: DEFAULT_MOBILE_TERMINAL_GEOMETRY.cols,
      expectedRows: DEFAULT_MOBILE_TERMINAL_GEOMETRY.rows,
      minDecodedBytes:
        historySnapshot === null
          ? RELAY_TASK_SENTINEL.length
          : Buffer.from(historySnapshot.dataB64, "base64").length,
    };
    const hybridFixture: MobileHybridFixture = {
      cloudOnly: {
        localTaskId: HYBRID_CLOUD_ONLY_LOCAL_TASK_ID,
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
    const taskOrdering = relayTaskOrderingFixture(localTask.repoId);
    const inputTracePath = localTask.worktreePath === null
      ? null
      : join(localTask.worktreePath, INPUT_TRACE_FILE);

    return {
      credentials: {
        email: BUFFY_EMAIL,
        password: BUFFY_PASSWORD
      },
      env: mobileRelayExpoEnv(harness),
      fixture: terminalFixture,
      filePreview: MOBILE_RELAY_FILE_PREVIEW_FIXTURE,
      companion: {
        fixture: MOBILE_RELAY_COMPANION_FIXTURE,
        async disconnect() {
          await harness.stopServer();
        },
        async expectNoEvent(choice) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const events = await readMobileRelayCompanionEvents(localTask);
          if (events.some((candidate) => candidate.choice === choice)) {
            throw new Error(
              `Visual companion event ${JSON.stringify(choice)} was delivered before an explicit retry`
            );
          }
        },
        invalidateSource: () => invalidateMobileRelayCompanion(localTask),
        async reconnect() {
          await harness.startServer();
          await harness.waitForDesktop();
        },
        restoreSource: () => replaceMobileRelayCompanion(localTask),
        resume: () => resumeMobileRelayCompanion(localTask),
        stop: () => stopMobileRelayCompanion(localTask),
        async waitForEvent(choice, timeoutMs = 10_000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const events = await readMobileRelayCompanionEvents(localTask);
            const event = events.find((candidate) => candidate.choice === choice);
            if (event) return event;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(
            `Expected visual companion event ${JSON.stringify(choice)}`
          );
        }
      },
      harness,
      hybridEnv: mobileRelayExpoEnv(harness, { forceCloud: false }),
      hybridFixture,
      quickReply: {
        draft: RELAY_QUICK_REPLY_DRAFT,
        expectedInput: RELAY_QUICK_REPLY_EXPECTED_INPUT,
        text: RELAY_CUSTOMIZED_QUICK_REPLY,
      },
      lanOnlyTask,
      localTask,
      createPairingSession: () => createHarnessPairingSession(harness.lanBaseUrl),
      async emitFilePreviewLinks() {
        for (const link of MOBILE_RELAY_FILE_PREVIEW_FIXTURE.mentionedLinks) {
          // Emit after the simulator has attached so the paths cannot age out
          // of the bounded xterm scan while Metro and WebDriverAgent start.
          // The space also mirrors agent prose and creates a path boundary.
          const input = ` ${link}`;
          const expectedCount =
            scriptedInputTraceCount(inputTracePath, input) + 1;
          await postScriptedTaskInput(harness, localTask.taskId, input);
          await waitForScriptedInput(inputTracePath, input, expectedCount);
        }
      },
      expirePairingSession: () => updateHarnessMobileMachineControls(
        harness.lanBaseUrl,
        { expirePairingSession: true }
      ),
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
      taskRow: {
        originalPromptSnippet: RELAY_ORIGINAL_PROMPT,
        repoLabel: RELAY_REPO_LABEL,
        stage: RELAY_TASK_STAGE,
        taskId: localTask.taskId,
        title: RELAY_TASK_TITLE,
        waitingPromptSnippet: RELAY_WAITING_PROMPT,
      },
      taskOrdering,
      terminalEvents,
      publishHybridCloudRefresh: () =>
        publishHybridCloudRefresh({ harness }),
      setLanHttpEnabled: (enabled) => updateHarnessMobileMachineControls(
        harness.lanBaseUrl,
        { lanHttpEnabled: enabled }
      ),
      async stop() {
        terminalEvents?.close();
        await harness.stop();
      },
      async waitForQuickReplyInput(expectedInput, timeoutMs = 10_000) {
        await waitForScriptedInput(inputTracePath, expectedInput, 1, timeoutMs);
        const response = await harness.client.invokeDesktop({
          desktopId: harness.desktopId,
          method: "GET",
          path: `/v1/tasks/${localTask.taskId}/inputs`,
        }) as { inputs: Array<{ message: string }> };
        const matchingInputs = response.inputs.filter(
          (candidate) => candidate.message === expectedInput,
        );
        if (matchingInputs.length !== 1) {
          throw new Error(
            `Expected exactly one durable matching task input, observed ` +
              `${matchingInputs.length}`,
          );
        }
        return expectedInput;
      },
      waitForLocalTaskActivity(activity, timeoutMs) {
        return waitForLocalTaskActivity(harness, localTask, activity, timeoutMs);
      },
      async beginMobileTerminalGeometryObservation(timeoutMs = 10_000) {
        const snapshot = await terminalEvents!.waitForNewSnapshot(
          {
            minEncodedChars: terminalFixture.minDecodedBytes,
            sentinel: terminalFixture.sentinel
          },
          timeoutMs
        );
        if (
          snapshot.cols !== terminalFixture.expectedCols ||
          snapshot.rows !== terminalFixture.expectedRows
        ) {
          throw new Error(
            `Expected a post-mount daemon PTY resize to ${terminalFixture.expectedCols}x` +
              `${terminalFixture.expectedRows}, received ${snapshot.cols}x${snapshot.rows}`
          );
        }
      },
    };
  } catch (error) {
    terminalEvents?.close();
    await harness.stop();
    throw error;
  }
}

type CompanionFixtureTask = Pick<ScriptedTask, "taskId" | "worktreePath">;

function companionSessionRoot(task: CompanionFixtureTask): string {
  if (!task.worktreePath) {
    throw new Error(
      `Scripted task ${task.taskId} did not return a worktree for visual companion E2E`
    );
  }
  return join(
    task.worktreePath,
    ".superpowers",
    "brainstorm",
    MOBILE_RELAY_COMPANION_FIXTURE.sessionId
  );
}

function mobileRelayCompanionHtml(marker: string): string {
  const fixture = MOBILE_RELAY_COMPANION_FIXTURE;
  return [
    `<section><h2>${marker}</h2>`,
    '<div class="options">',
    `<button class="option" data-choice="${fixture.choice}" ` +
      'onclick="toggleSelect(this)">Choose relay layout</button>',
    "</div></section>"
  ].join("");
}

export async function seedMobileRelayCompanion(
  task: CompanionFixtureTask
): Promise<void> {
  const root = companionSessionRoot(task);
  await mkdir(join(root, "content"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(join(root, "state", "server-info"), "{}", "utf8");
  await writeFile(
    join(root, "content", "screen.html"),
    mobileRelayCompanionHtml(MOBILE_RELAY_COMPANION_FIXTURE.initialMarker),
    "utf8"
  );
}

export async function replaceMobileRelayCompanion(
  task: CompanionFixtureTask
): Promise<void> {
  await writeFile(
    join(companionSessionRoot(task), "content", "screen.html"),
    mobileRelayCompanionHtml(MOBILE_RELAY_COMPANION_FIXTURE.updatedMarker),
    "utf8"
  );
}

export async function invalidateMobileRelayCompanion(
  task: CompanionFixtureTask
): Promise<void> {
  await writeFile(
    join(companionSessionRoot(task), "content", "screen.html"),
    new Uint8Array(1024 * 1024 + 1).fill(0x78)
  );
}

export async function readMobileRelayCompanionEvents(
  task: CompanionFixtureTask
): Promise<Array<Record<string, unknown>>> {
  let content: string;
  try {
    content = await readFile(
      join(companionSessionRoot(task), "state", "events"),
      "utf8"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r\n|\r|\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function stopMobileRelayCompanion(
  task: CompanionFixtureTask
): Promise<void> {
  await writeFile(
    join(companionSessionRoot(task), "state", "server-stopped"),
    "",
    "utf8"
  );
}

export async function resumeMobileRelayCompanion(
  task: CompanionFixtureTask
): Promise<void> {
  await rm(
    join(companionSessionRoot(task), "state", "server-stopped"),
    { force: true }
  );
}

async function seedMobileRelayFilePreview(task: ScriptedTask): Promise<void> {
  if (!task.worktreePath) {
    throw new Error(
      `Scripted task ${task.taskId} did not return a worktree for file-preview E2E`
    );
  }
  const files = [
    {
      content: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.content,
      path: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.path
    },
    {
      content: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.uniqueContent,
      path: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.uniqueCanonicalPath
    },
    {
      content: "export const shared = 'a';\n",
      path: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.ambiguousCanonicalPaths[0]
    },
    {
      content: "export const shared = 'b';\n",
      path: MOBILE_RELAY_FILE_PREVIEW_FIXTURE.ambiguousCanonicalPaths[1]
    }
  ];
  for (const file of files) {
    const target = join(task.worktreePath, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

async function postScriptedTaskInput(
  harness: RemoteHarness,
  taskId: string,
  input: string
): Promise<void> {
  await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "POST",
    path: `/v1/tasks/${encodeURIComponent(taskId)}/input`,
    body: { input }
  });
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

export function publishedCloudTaskId(
  fields: Partial<Pick<FirestoreFields, "cloudTaskId">> | undefined,
  fallbackId: string,
): string {
  return fields?.cloudTaskId?.stringValue?.trim() || fallbackId;
}

export function scriptedInputTraceCount(
  path: string | null,
  input: string,
): number {
  if (path === null || !existsSync(path)) return 0;
  return readFileSync(path)
    .toString("utf8")
    .split("\0")
    .filter((candidate) => candidate === input).length;
}

async function waitForScriptedInput(
  path: string | null,
  input: string,
  count = 1,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scriptedInputTraceCount(path, input) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Expected desktop PTY to receive input occurrence ${count}: ${input}`,
  );
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
  const response = await localProcessFetch(`${harness.lanBaseUrl}/v1/tasks/recent`);
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
  const response = await localProcessFetch(
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
  const response = await localProcessFetch(
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
    const response = await localProcessFetch(
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
}, timeoutMs = CLOUD_PUBLICATION_TIMEOUT_MS, stableForMs = 0): Promise<string> {
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
  let publishedTaskId: string | null = null;

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
        publishedTaskId = publishedCloudTaskId(
          taskDocument?.fields,
          cloudTaskIdFor(input.harness, input.task),
        );
        matchingSince ??= Date.now();
        if (Date.now() - matchingSince >= stableForMs) return publishedTaskId;
      } else {
        matchingSince = null;
        publishedTaskId = null;
      }
    } else {
      lastObserved = `${response.status} ${JSON.stringify(body)}`;
      matchingSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Expected published task ${input.task.taskId} activity ${input.activity}; ` +
      `last observed ${String(lastObserved)} with task id ${String(publishedTaskId)}`
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
    },
    // Credential rules validate the complete canonical resource. A field-mask
    // PATCH is suitable for mutable fixtures but is rejected for this create.
    { updateMask: false },
  );
}

function syntheticCloudTask(input: {
  activity: TaskActivity;
  createdAt?: string;
  desktopId: string;
  displayName: string;
  repoId: string;
  taskId: string;
  title: string;
  updatedAt?: string;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    localRepoId: input.repoId,
    ownerDesktopId: input.desktopId,
    ownerLocalTaskId: input.taskId,
    title: input.title,
    promptSnippet: "Run deterministic scripted task",
    waitingPromptSnippet: null,
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
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    closedAt: null
  };
}

function relayOrderingDisplayTaskId(repoId: string, taskId: string): string {
  return `cloud:${RELAY_ORDERING_DESKTOP_ID}:${repoId}:${taskId}`;
}

export function relayTaskOrderingFixture(
  repoId: string,
): RelayTaskOrderingFixture {
  const olderTaskId = relayOrderingDisplayTaskId(
    repoId,
    RELAY_ORDERING_OLDER_TASK_ID,
  );
  const newerTaskId = relayOrderingDisplayTaskId(
    repoId,
    RELAY_ORDERING_NEWER_TASK_ID,
  );
  return {
    // Cloud indexing orders by updatedAt, so this deliberately conflicts with
    // the creation-time ordering required by the repo-scoped Tasks tab.
    sourceOrderTaskIds: [olderTaskId, newerTaskId],
    expectedVisualOrderTaskIds: [newerTaskId, olderTaskId],
  };
}

async function seedRelayTaskOrderingSnapshot(input: {
  auth: AuthSession;
  harness: RemoteHarness;
  localTask: ScriptedTask;
}): Promise<void> {
  const desktopSecret = desktopSecretFor(RELAY_ORDERING_DESKTOP_ID);
  await publishDesktopCredential({
    auth: input.auth,
    desktopId: RELAY_ORDERING_DESKTOP_ID,
    desktopSecret,
    displayName: "Task ordering E2E Desktop",
    firestorePort: input.harness.ports.firestore,
  });
  await publishRelayTaskSnapshot({
    desktopId: RELAY_ORDERING_DESKTOP_ID,
    desktopSecret,
    displayName: "Task ordering E2E Desktop",
    relayPort: input.harness.ports.relay,
    tasks: [
      syntheticCloudTask({
        activity: "idle",
        createdAt: RELAY_ORDERING_OLDER_CREATED_AT,
        desktopId: RELAY_ORDERING_DESKTOP_ID,
        displayName: "Older-created ordering fixture",
        repoId: input.localTask.repoId,
        taskId: RELAY_ORDERING_OLDER_TASK_ID,
        title: "Older-created ordering fixture",
        updatedAt: RELAY_ORDERING_OLDER_UPDATED_AT,
      }),
      syntheticCloudTask({
        activity: "idle",
        createdAt: RELAY_ORDERING_NEWER_CREATED_AT,
        desktopId: RELAY_ORDERING_DESKTOP_ID,
        displayName: "Newer-created ordering fixture",
        repoId: input.localTask.repoId,
        taskId: RELAY_ORDERING_NEWER_TASK_ID,
        title: "Newer-created ordering fixture",
        updatedAt: RELAY_ORDERING_NEWER_UPDATED_AT,
      }),
    ],
  });
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
  fields: FirestoreFields,
  options: { updateMask?: boolean } = {},
): Promise<void> {
  const encodedPath = path.map(encodeURIComponent).join("/");
  const url = new URL(
    `http://127.0.0.1:${firestorePort}/v1/projects/kanna-local/databases/(default)/documents/` +
      encodedPath
  );
  if (options.updateMask !== false) {
    for (const field of Object.keys(fields)) {
      url.searchParams.append("updateMask.fieldPaths", field);
    }
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

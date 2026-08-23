import type {
  CreateTaskResponse,
  DesktopSummary,
  RepoCommandCatalog,
  RepoSummary,
  RepoDirectoryListing,
  RepoFileRange,
  TaskActivity,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskInputAttachment,
  TaskSummary
} from "../lib/api/types";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskCompanionSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../lib/api/client";
import { isInputHeldByDraft } from "../lib/transports/serverRefusal";
import type { CompanionEvent } from "@kanna/agent-protocol";
import { TaskCreationError } from "../lib/api/client";
import { RepoNotRegisteredError } from "../lib/api/client";
import {
  mergeRepoSummaries,
  repoIsRegisteredOnDesktop
} from "../lib/api/repoIdentity";
import type { MachinePairingService } from "../lib/pairing/machinePairing";
import type { MobileAuthSession } from "../lib/firebase/auth";
import {
  DEFAULT_MOBILE_TERMINAL_GEOMETRY,
  type MobileTerminalGeometry
} from "../mobileTerminalGeometry";
import type {
  ComposerAgentProvider,
  MobileView,
  PendingRepoCommandTask,
  PendingTaskCreation,
  SessionStore,
  TaskCreationAttempt
} from "./sessionStore";
import { MAX_TERMINAL_SCROLLBACK_CHARS } from "./terminalOutputBuffer";
import type { PersistedSessionContext } from "./sessionPersistence";
import { isTaskBlocked } from "../lib/api/taskIdentity";
import { resolveAgentProviderForDesktop } from "../lib/api/agentProviders";
import { buildMachineInventory } from "./machineInventory";
import {
  buildCreatingTaskUiSlot,
  taskUiSlotForSelection,
  taskUiSlotToTaskSummary
} from "./taskUiSlots";
import {
  dismissLocalActivity,
  pruneLocalTaskListPreferences,
  seedLocalTaskPinsFromServer,
  setLocalTaskPinned,
  type LocalTaskListPreferences
} from "./taskListPreferences";
import {
  createDefaultTaskListPreferencesStore,
  type TaskListPreferencesStore
} from "./taskListPreferencesStorage";

export interface MobileController {
  bootstrap(): Promise<void>;
  pairMachineByCode(code: string): Promise<string>;
  pairMachineByPayload(payload: string): Promise<string>;
  removeManualMachine(desktopId: string): Promise<void>;
  signInWithEmailPassword(email: string, password: string): Promise<void>;
  createUserWithEmailPassword(email: string, password: string): Promise<void>;
  refreshAccount(): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  refresh(options?: { preserveTaskSession?: boolean }): Promise<void>;
  setNavigationView(view: MobileView): void;
  setTaskDetailVisible(visible: boolean): void;
  setAppForeground(foreground: boolean): void;
  expireTaskTerminalGrace(): void;
  selectDesktop(desktopId: string): Promise<void>;
  selectRepo(repoId: string): Promise<void>;
  loadRepoCommands(): Promise<void>;
  runRepoCommand(commandId: string): Promise<string | null>;
  retryRepoCommand(): Promise<string | null>;
  dismissRepoCommandTaskLoadError(): void;
  subscribeRepoCommandTaskOpen(listener: (taskId: string) => void): () => void;
  openTask(taskId: string): void;
  closeTask(taskId?: string): void;
  openComposer(): void;
  closeComposer(): void;
  updateComposerPrompt(prompt: string): void;
  selectComposerDesktop(desktopId: string): void;
  setComposerOptionsExpanded(isExpanded: boolean): void;
  selectComposerAgentProvider(provider: ComposerAgentProvider): void;
  searchTasks(query: string): Promise<void>;
  dismissActivity(taskId: string): Promise<void>;
  setTaskPinned(taskId: string, pinned: boolean): Promise<void>;
  createTask(terminalGeometry?: MobileTerminalGeometry): Promise<string | null>;
  confirmRepoCheckout(
    terminalGeometry?: MobileTerminalGeometry
  ): Promise<string | null>;
  recoverTaskCreation(slotId?: string): Promise<string | null>;
  abortTaskCreation(slotId: string): Promise<void>;
  runMergeAgent(taskId: string): Promise<string | null>;
  advanceDesktopTaskStage(taskId: string): Promise<string | null>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  listTaskDirectory(taskId: string, path: string, showAllFiles?: boolean, offset?: number, filter?: string): Promise<RepoDirectoryListing>;
  readTaskFileRange(taskId: string, path: string, startLine: number, lineCount: number, metadataOnly?: boolean, startByte?: number): Promise<RepoFileRange>;
  resolveTaskFileMentions(
    taskId: string,
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  readTaskDiff(taskId: string, request?: TaskDiffRequest): Promise<TaskDiffContent>;
  sendTaskInput(
    taskId: string,
    input: string,
    attachment?: TaskInputAttachment
  ): Promise<void>;
  sendTaskTerminalInput(taskId: string, dataB64: string): void;
  resizeTaskTerminal(taskId: string, cols: number, rows: number): void;
  /** Pull the next older chunk of terminal scrollback, if the desktop kept any
   * back and no request is already in flight. */
  requestTaskTerminalScrollback(taskId: string): void;
  requestTaskAgentHistory(taskId: string): void;
  sendTaskAgentPermission(taskId: string, requestId: string, decision: Parameters<TaskAgentSubscription["sendPermission"]>[1]): void;
  interruptTaskAgent(taskId: string): void;
  setTaskCompanionOpen(taskId: string, isOpen: boolean): void;
  sendTaskCompanionEvent(
    taskId: string,
    sessionId: string,
    revision: string,
    event: CompanionEvent
  ): void;
  closeDesktopTask(taskId: string): Promise<void>;
  dispose(): void;
}

const BACKGROUND_REFRESH_INTERVAL_MS = 3_000;
const MARK_READ_DEBOUNCE_MS = 1_000;
const MARK_READ_MAX_ATTEMPTS = 3;
const MARK_READ_RETRY_BASE_MS = 1_000;
// Lines asked for per scrollback chunk. Deliberately smaller than the
// desktop's per-request ceiling: on a poor link a chunk that renders now beats
// a chunk that arrives complete.
const TERMINAL_SCROLLBACK_CHUNK_LINES = 200;
// The largest chunk the desktop can answer with, in base64 chars plus its
// frame newline: `TERMINAL_SCROLLBACK_CHUNK_MAX_BYTES` (64 KiB) encodes to
// 87,384 chars. Used to stop the walk one chunk before the buffer's own bound
// so no chunk is fetched that would then have to be refused.
const MAX_TERMINAL_SCROLLBACK_CHUNK_CHARS = 88_000;
const REPO_COMMAND_TASK_LOAD_ERROR =
  "The task was created, but it could not be opened here yet. Find it on the Tasks tab, or try again.";
const REPO_COMMAND_TASK_LOAD_ATTEMPTS = 3;
const REPO_COMMAND_TASK_LOAD_RETRY_MS = 200;
const DEFAULT_REPO_CHECKOUT_POLL_INTERVAL_MS = 500;

export interface CloudTaskPublication {
  cloudAuthoritative: boolean;
}

export interface MobileControllerOptions {
  // Live cloud task subscription (onSnapshot). When provided and signed in,
  // the controller reads tasks via this push stream instead of polling.
  subscribeCloudTasks?: (
    uid: string,
    onUpdate: (
      tasks: TaskSummary[],
      publication?: CloudTaskPublication
    ) => void,
    onError?: (error: unknown) => void,
  ) => () => void;
  createTaskId?: () => string;
  createTaskSlotId?: () => string;
  persistSessionContext?: (context?: PersistedSessionContext) => Promise<void>;
  pairingService?: MachinePairingService;
  replaceClientForTrustChange?: () => void;
  subscribeTaskRouteChanges?: (listener: () => void) => () => void;
  /** Phone-local pin/dismiss record. Defaults to AsyncStorage. */
  taskListPreferencesStore?: TaskListPreferencesStore;
  repoCheckoutPollIntervalMs?: number;
}

let fallbackTaskCreationCounter = 0;

function generateTaskCreationId(): string {
  const cryptoObject = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (values: Uint8Array) => Uint8Array;
    };
  }).crypto;
  try {
    const uuid = cryptoObject?.randomUUID?.().replace(/-/g, "").toLowerCase();
    if (uuid && /^[0-9a-f]{32}$/.test(uuid)) {
      return uuid.slice(0, 8);
    }
  } catch {
    // Some React Native runtimes expose a partial crypto shim. Try the next
    // source before falling back to the time/counter identity below.
  }

  try {
    if (cryptoObject?.getRandomValues) {
      const bytes = cryptoObject.getRandomValues(new Uint8Array(4));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to a process-local best-effort identity.
  }

  fallbackTaskCreationCounter = (fallbackTaskCreationCounter + 1) >>> 0;
  const entropy = Math.floor(Math.random() * 0x100000000) >>> 0;
  const mixed = ((Date.now() >>> 0) ^ fallbackTaskCreationCounter ^ entropy) >>> 0;
  return mixed.toString(16).padStart(8, "0");
}

function isStaleRepoCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b|catalog changed|stale/i.test(message);
}

export function createMobileController(
  client: KannaClient,
  store: SessionStore,
  authSession?: MobileAuthSession,
  options: MobileControllerOptions = {}
): MobileController {
  let activeTaskTerminal:
    | {
        taskId: string;
        routeIdentity: string;
        subscription: TaskTerminalSubscription;
        retagTaskId(taskId: string): void;
      }
    | null = null;
  let requestedTaskTerminalGeometry:
    | (MobileTerminalGeometry & { taskId: string })
    | null = null;
  let activeTaskAgent:
    | {
        taskId: string;
        routeIdentity: string;
        subscription: TaskAgentSubscription;
        retagTaskId(taskId: string): void;
      }
    | null = null;
  let activeTaskCompanion:
    | {
        taskId: string;
        routeIdentity: string;
        subscription: TaskCompanionSubscription;
        setOpen(isOpen: boolean): void;
        retagTaskId(taskId: string): void;
      }
    | null = null;
  let taskTerminalGeneration = 0;
  let taskAgentGeneration = 0;
  let taskCompanionGeneration = 0;
  let taskDetailGeneration = 0;
  /** Fences the per-task attachment-capability read against task switching. */
  let taskAttachmentSupportGeneration = 0;
  let activeTaskDetailIdentity: string | null = null;
  let loadedTaskPrompt:
    | { taskId: string; routeIdentity: string; prompt: string }
    | null = null;
  /**
   * The attachment-capability read currently in flight, tagged with the
   * generation that installed it.
   *
   * The generation is the owner token, and it is not decoration: two reads for
   * the same task and route — an A -> B -> A switch — share an identity, so a
   * marker keyed on identity alone lets the *earlier* read's completion free
   * the marker the later one installed. The next reconciler entry then sees an
   * unanswered route with nothing in flight, re-probes, and clears the flag
   * again, which is the flicker the memo exists to prevent. Only the installer
   * releases; every other release is a no-op.
   */
  let activeTaskAttachmentSupport:
    | { identity: string; generation: number }
    | null = null;
  let resolvedTaskAttachmentSupport:
    | { taskId: string; routeIdentity: string; supported: boolean }
    | null = null;
  let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundRefreshInFlight = false;
  let backgroundRefreshMode: "collections" | "desktops" = "collections";
  let authUnsubscribe: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let taskRoutesUnsubscribe: (() => void) | null = null;
  const repoCommandTaskOpenListeners = new Set<(taskId: string) => void>();
  let bootstrapInFlight: Promise<void> | null = null;
  let bootstrapRequested = false;
  let cloudSubscriptionEpoch = 0;
  let cloudSubscriptionError:
    | { epoch: number; message: string }
    | null = null;
  let desktopMetadataError:
    | { revision: number; message: string }
    | null = null;
  let unownedErrorMessage: string | null = null;
  let taskCollectionsRevision = 0;
  let taskDetailVisible = false;
  let appForeground = true;
  const taskSummarySubscriptions = new Map<string, { close(): void }>();
  const taskSummaryRevisions = new Map<string, number>();
  const restingTaskSummaries = new Map<
    string,
    {
      taskId: string;
      snippet: string | undefined;
      activity: TaskActivity;
      runtimeState: TaskSummary["runtimeState"];
    }
  >();
  let liveRepositoryRevision = 0;
  let lastExplicitRepos: RepoSummary[] = [];
  let desktopCollectionsRevision = 0;
  let refreshDesktopsInFlight: Promise<void> | null = null;
  const ordinaryTaskCreationFlights = new Map<
    string,
    Promise<string | null>
  >();
  const recoveryTaskCreationFlights = new Map<
    string,
    Promise<string | null>
  >();
  const taskCreationPersistenceFlights = new Map<string, Promise<void>>();
  const recoveryStartedTaskIds = new Set<string>();
  let repoCheckoutFlight: Promise<string | null> | null = null;
  let lastSubmittedTaskCreationId: string | null = null;
  let repoCommandLoadGeneration = 0;
  const repoCommandCatalogs = new Map<string, RepoCommandCatalog>();
  const pendingTaskIdentities = new Map<
    string,
    {
      ownerDesktopId: string;
      ownerLocalRepoId: string;
      ownerLocalTaskId: string;
    }
  >();

  const getClientResolvedTaskRoute = (response: {
    ownerDesktopId?: string;
    ownerLocalRepoId?: string;
    ownerLocalTaskId?: string;
  }) => {
    const ownerDesktopId = response.ownerDesktopId?.trim();
    const ownerLocalRepoId = response.ownerLocalRepoId?.trim();
    const ownerLocalTaskId = response.ownerLocalTaskId?.trim();
    return ownerDesktopId && ownerLocalRepoId && ownerLocalTaskId
      ? { ownerDesktopId, ownerLocalRepoId, ownerLocalTaskId }
      : null;
  };

  const publishOwnedErrorMessage = () => {
    store.setErrorMessage(
      unownedErrorMessage ??
      cloudSubscriptionError?.message ??
      desktopMetadataError?.message ??
      null
    );
  };

  const restoreRestingTaskSummaries = (desktopId: string) => {
    const prefix = `${desktopId}:`;
    for (const [key, summary] of restingTaskSummaries) {
      if (!key.startsWith(prefix)) continue;
      store.setTaskLiveSummary(
        summary.taskId,
        summary.snippet,
        summary.activity,
        summary.runtimeState
      );
      restingTaskSummaries.delete(key);
    }
    for (const key of taskSummaryRevisions.keys()) {
      if (key.startsWith(prefix)) taskSummaryRevisions.delete(key);
    }
  };

  const reconcileTaskSummarySubscriptions = () => {
    const state = store.getState();
    const shouldSubscribe =
      appForeground &&
      !taskDetailVisible &&
      (state.activeView === "tasks" || state.activeView === "recent") &&
      client.observeDesktopTaskSummaries !== undefined;
    const desiredDesktopIds = shouldSubscribe
      ? new Set(
          [...state.recentTasks, ...state.repoTasks]
            .map((task) => task.ownerDesktopId)
            .filter((desktopId): desktopId is string => Boolean(desktopId))
        )
      : new Set<string>();
    for (const [desktopId, subscription] of taskSummarySubscriptions) {
      if (!desiredDesktopIds.has(desktopId)) {
        subscription.close();
        taskSummarySubscriptions.delete(desktopId);
        restoreRestingTaskSummaries(desktopId);
      }
    }
    for (const desktopId of desiredDesktopIds) {
      if (taskSummarySubscriptions.has(desktopId)) continue;
      const subscription = client.observeDesktopTaskSummaries?.(desktopId, (event) => {
        if (event.type === "connection") {
          if (!event.connected) restoreRestingTaskSummaries(desktopId);
          return;
        }
        const summary = event;
        const key = `${desktopId}:${summary.taskId}`;
        if ((taskSummaryRevisions.get(key) ?? -1) >= summary.revision) return;
        taskSummaryRevisions.set(key, summary.revision);
        const current = store.getState();
        const task = [...current.recentTasks, ...current.repoTasks].find(
          (candidate) =>
            candidate.ownerDesktopId === desktopId &&
            (candidate.ownerLocalTaskId ?? candidate.id) === summary.taskId
        );
        if (!task) return;
        const restingKey = `${desktopId}:${task.id}`;
        if (!restingTaskSummaries.has(restingKey)) {
          restingTaskSummaries.set(restingKey, {
            taskId: task.id,
            snippet: task.waitingPromptSnippet ?? undefined,
            activity: task.activity ?? "idle",
            runtimeState: task.runtimeState ?? "idle"
          });
        }
        const activity = summary.activity === "working" ||
          summary.activity === "unread" ? summary.activity : "idle";
        const runtimeState =
          summary.runtimeState === "busy" ||
          summary.runtimeState === "waiting" ||
          summary.runtimeState === "exited"
            ? summary.runtimeState
            : "idle";
        store.setTaskLiveSummary(
          task.id,
          summary.snippet,
          activity,
          runtimeState
        );
      });
      if (subscription) taskSummarySubscriptions.set(desktopId, subscription);
    }
  };
  const taskSummaryStoreUnsubscribe = store.subscribe(
    reconcileTaskSummarySubscriptions
  );

  const setUnownedErrorMessage = (message: string | null) => {
    unownedErrorMessage = message;
    publishOwnedErrorMessage();
  };
  let markReadTimer: ReturnType<typeof setTimeout> | null = null;
  let markReadGeneration = 0;
  let observedSelectedTaskReadKey: string | null = null;
  let exhaustedMarkReadGeneration: number | null = null;

  const setTerminalStartupError = (taskId: string, error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Terminal stream failed to start";
    store.setTaskTerminalError(taskId, message);
    setUnownedErrorMessage(message);
  };

  const findCollectionTask = (taskId: string): TaskSummary | null => {
    const state = store.getState();
    return (
      state.repoTasks.find((task) => task.id === taskId) ??
      state.recentTasks.find((task) => task.id === taskId) ??
      state.searchResults.find((task) => task.id === taskId) ??
      null
    );
  };

  const findTask = (selectionOrTaskId: string): TaskSummary | null => {
    const state = store.getState();
    const slot = taskUiSlotForSelection(
      state.taskUiSlots,
      selectionOrTaskId
    );
    if (slot?.state === "creating") {
      return taskUiSlotToTaskSummary(slot);
    }
    if (slot?.state === "ready") {
      return findCollectionTask(slot.taskId) ?? slot.task;
    }
    return findCollectionTask(selectionOrTaskId);
  };

  const durableTaskIdForSelection = (
    selectionId: string | null
  ): string | null => {
    if (!selectionId) {
      return null;
    }
    const slot = taskUiSlotForSelection(
      store.getState().taskUiSlots,
      selectionId
    );
    return slot ? slot.taskId : findCollectionTask(selectionId)?.id ?? null;
  };

  const taskPromptRouteIdentity = (task: TaskSummary): string =>
    task.ownerDesktopId && task.ownerLocalTaskId
      ? JSON.stringify([task.ownerDesktopId, task.ownerLocalTaskId])
      : client.getTaskRouteIdentity?.(task.id) ?? task.id;

  const loadSelectedTaskPrompt = (taskId: string) => {
    const task = findTask(taskId);
    if (!client.getTask || !task) {
      return;
    }
    const routeIdentity = taskPromptRouteIdentity(task);
    const detailIdentity = JSON.stringify([taskId, routeIdentity]);
    if (
      loadedTaskPrompt?.taskId === taskId &&
      loadedTaskPrompt.routeIdentity === routeIdentity
    ) {
      store.setTaskPrompt(taskId, loadedTaskPrompt.prompt);
      return;
    }
    if (activeTaskDetailIdentity === detailIdentity) {
      return;
    }

    const generation = ++taskDetailGeneration;
    activeTaskDetailIdentity = detailIdentity;

    void client.getTask(taskId)
      .then((detail) => {
        if (generation !== taskDetailGeneration) {
          return;
        }
        activeTaskDetailIdentity = null;
        if (
          durableTaskIdForSelection(store.getState().selectedTaskId) !== taskId ||
          typeof detail.prompt !== "string"
        ) {
          return;
        }
        loadedTaskPrompt = { taskId, routeIdentity, prompt: detail.prompt };
        store.setTaskPrompt(taskId, detail.prompt);
      })
      .catch(() => {
        if (generation === taskDetailGeneration) {
          activeTaskDetailIdentity = null;
        }
        // Cloud publications intentionally contain only a bounded prompt.
        // Keep that snippet when an older or offline owner cannot serve detail.
      });
  };

  const preserveLoadedTaskPrompt = (tasks: TaskSummary[]): TaskSummary[] => {
    if (!loadedTaskPrompt) {
      return tasks;
    }
    return tasks.map((task) =>
      task.id === loadedTaskPrompt?.taskId &&
      taskPromptRouteIdentity(task) === loadedTaskPrompt.routeIdentity
        ? { ...task, prompt: loadedTaskPrompt.prompt }
        : task
    );
  };

  const resolveCanonicalTaskDisplayId = (
    responseTaskId: string,
    ownerDesktopId: string | null,
    ownerLocalRepoId: string | null,
    tasks: readonly TaskSummary[]
  ): string | null => {
    const candidates = new Map<string, TaskSummary>();
    const exactRepoCandidates = new Map<string, TaskSummary>();
    for (const task of tasks) {
      if (task.id === responseTaskId) continue;
      if (task.ownerLocalTaskId !== responseTaskId) continue;
      if (ownerDesktopId && task.ownerDesktopId !== ownerDesktopId) continue;
      candidates.set(task.id, task);
      if (
        ownerLocalRepoId &&
        task.ownerLocalRepoId === ownerLocalRepoId
      ) {
        exactRepoCandidates.set(task.id, task);
      }
    }

    if (ownerLocalRepoId && exactRepoCandidates.size === 1) {
      return exactRepoCandidates.values().next().value!.id;
    }
    if (ownerLocalRepoId && exactRepoCandidates.size > 1) {
      return null;
    }
    if (candidates.size === 1) {
      const candidate = candidates.values().next().value!;
      if (!ownerLocalRepoId || candidate.ownerLocalRepoId == null) {
        return candidate.id;
      }
    }

    return null;
  };

  const resolveTaskActionDisplayId = (
    responseTaskId: string,
    ownerDesktopId: string | null,
    ownerLocalRepoId: string | null = null
  ): string | null => {
    const state = store.getState();
    const canonicalTaskId = resolveCanonicalTaskDisplayId(
      responseTaskId,
      ownerDesktopId,
      ownerLocalRepoId,
      [...state.repoTasks, ...state.recentTasks, ...state.searchResults]
    );
    if (canonicalTaskId) {
      return canonicalTaskId;
    }
    return findTask(responseTaskId)?.id ?? null;
  };

  const pruneResolvedPendingTaskIdentities = () => {
    const state = store.getState();
    const tasks = [
      ...state.repoTasks,
      ...state.recentTasks,
      ...state.searchResults
    ];
    for (const [displayTaskId, pendingIdentity] of pendingTaskIdentities) {
      const canonicalTaskId = resolveCanonicalTaskDisplayId(
        pendingIdentity.ownerLocalTaskId,
        pendingIdentity.ownerDesktopId,
        pendingIdentity.ownerLocalRepoId,
        tasks
      );
      if (canonicalTaskId) {
        const slot = taskUiSlotForSelection(state.taskUiSlots, displayTaskId);
        const canonicalTask = tasks.find((task) => task.id === canonicalTaskId);
        if (slot && canonicalTask) {
          store.acknowledgeTaskUiSlot(slot.slotId, canonicalTask);
        }
        pendingTaskIdentities.delete(displayTaskId);
      }
    }
  };

  const rememberActionTaskSummary = (task: TaskSummary) => {
    taskCollectionsRevision += 1;
    const state = store.getState();
    const recentTasks = [
      task,
      ...state.recentTasks.filter((candidate) => candidate.id !== task.id)
    ];
    store.setRepos(mergeReposWithTaskRepos(state.repos, recentTasks));
    store.setRecentTasks(recentTasks);
    if (state.selectedRepoId === task.repoId) {
      store.setRepoTasks([
        task,
        ...state.repoTasks.filter((candidate) => candidate.id !== task.id)
      ]);
    }
  };

  const selectedTaskReadState = () => {
    const state = store.getState();
    const selectedTaskId = durableTaskIdForSelection(state.selectedTaskId);
    const taskCopies = selectedTaskId
      ? [state.repoTasks, state.recentTasks, state.searchResults]
          .flatMap((tasks) => tasks.filter((task) => task.id === selectedTaskId))
      : [];
    const activities: TaskActivity[] = taskCopies.map(
      (task) => task.activity ?? "idle"
    );
    const activityRevisions = taskCopies.map((task) => task.activityRevision);
    const activity =
      activities.length > 0 &&
      activities.every((candidate) => candidate === activities[0])
        ? activities[0]
        : null;
    const activityRevision =
      activityRevisions.length > 0 &&
      activityRevisions.every((candidate) => candidate === activityRevisions[0])
        ? activityRevisions[0]
        : undefined;

    return {
      taskId: selectedTaskId,
      visible:
        taskDetailVisible &&
        state.connectionState === "connected" &&
        selectedTaskId !== null,
      activities,
      activity,
      activityRevision
    };
  };
  const taskListPreferencesStore =
    options.taskListPreferencesStore ?? createDefaultTaskListPreferencesStore();
  let taskListPreferencesStatus: "pending" | "loaded" | "failed" = "pending";
  let taskListPreferencesLoad: Promise<void> | null = null;

  /**
   * Hydrates this phone's own pin/dismiss record. Every mutation waits on it,
   * which is what stops a swipe from replacing a record the phone has not read
   * yet; once it has landed, a toggle is a local write and the list reorders
   * from that write alone.
   */
  const ensureTaskListPreferences = (): Promise<void> => {
    taskListPreferencesLoad ??= taskListPreferencesStore
      .load()
      .then((result) => {
        taskListPreferencesStatus = result.status;
        store.setLocalTaskListPreferences(result.preferences);
      })
      .catch(() => {
        // A store that cannot even report its failure leaves the phone with
        // the empty record it started with, and saving stays blocked below
        // rather than replacing whatever is really on disk.
        taskListPreferencesStatus = "failed";
      });
    return taskListPreferencesLoad;
  };

  const updateLocalTaskListPreferences = async (
    update: (current: LocalTaskListPreferences) => LocalTaskListPreferences,
    describeFailure: (detail: string) => string
  ): Promise<void> => {
    await ensureTaskListPreferences();
    const previous = store.getState().localTaskListPreferences;
    const next = update(previous);
    if (next === previous) return;
    // There is no round-trip to wait for: the list reorders (or drops the row)
    // from this write, and the record on disk follows it.
    store.setLocalTaskListPreferences(next);
    try {
      await taskListPreferencesStore.save(next);
    } catch (error) {
      // A write the phone could not keep is not a preference. Put the previous
      // record back so the list matches what the next launch will read.
      if (store.getState().localTaskListPreferences === next) {
        store.setLocalTaskListPreferences(previous);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(describeFailure(detail));
    }
  };

  /**
   * An authoritative all-open-tasks snapshot is the only thing that can prove
   * a pinned task is gone or that a dismissed row has newer activity, so the
   * local record is seeded and pruned against those reads rather than on a
   * timer.
   */
  const reconcileLocalTaskListPreferences = (
    snapshot: readonly TaskSummary[]
  ) => {
    if (taskListPreferencesStatus === "pending") {
      // The first snapshot is the one the seed needs, so wait for the record
      // rather than skipping it.
      const pendingSnapshot = [...snapshot];
      void ensureTaskListPreferences().then(() =>
        reconcileLocalTaskListPreferences(pendingSnapshot)
      );
      return;
    }
    if (taskListPreferencesStatus !== "loaded") return;
    const current = store.getState().localTaskListPreferences;
    const next = pruneLocalTaskListPreferences(
      seedLocalTaskPinsFromServer(current, snapshot),
      snapshot
    );
    if (next === current) return;
    store.setLocalTaskListPreferences(next);
    void taskListPreferencesStore.save(next).catch(() => {
      // Nothing was lost: the record on disk still holds what this pass wanted
      // to drop, so show that instead of a list the next launch contradicts.
      if (store.getState().localTaskListPreferences === next) {
        store.setLocalTaskListPreferences(current);
      }
    });
  };

  const markTaskRead = (
    taskId: string,
    expectedActivityRevision: number | undefined
  ) =>
    expectedActivityRevision === undefined
      ? client.markTaskRead(taskId)
      : client.markTaskRead(taskId, expectedActivityRevision);

  const selectedTaskReadKey = (): string | null => {
    const { taskId, visible, activities, activityRevision } =
      selectedTaskReadState();
    const selectedTaskId = taskId;
    if (!selectedTaskId) return null;
    return `${selectedTaskId}\u0000${visible ? "visible" : "hidden"}\u0000${activities.join(",")}\u0000${activityRevision ?? "legacy"}`;
  };

  const canMarkSelectedTaskRead = (
    taskId: string,
    generation: number,
    expectedActivityRevision: number | undefined
  ) => {
    const selected = selectedTaskReadState();
    return (
      generation === markReadGeneration &&
      selected.taskId === taskId &&
      selected.visible &&
      selected.activity === "unread" &&
      selected.activityRevision === expectedActivityRevision
    );
  };

  const reconcileSelectedTaskRead = (allowExhaustedRetry = false) => {
    const readKey = selectedTaskReadKey();
    const shouldRetryExhausted =
      allowExhaustedRetry && exhaustedMarkReadGeneration === markReadGeneration;
    if (readKey === observedSelectedTaskReadKey && !shouldRetryExhausted) return;
    observedSelectedTaskReadKey = readKey;
    const generation = ++markReadGeneration;
    exhaustedMarkReadGeneration = null;
    if (markReadTimer) {
      clearTimeout(markReadTimer);
      markReadTimer = null;
    }

    const selected = selectedTaskReadState();
    if (!selected.taskId || !selected.visible || selected.activity !== "unread") return;
    const taskId = selected.taskId;
    markReadTimer = setTimeout(() => {
      markReadTimer = null;
      void markSelectedTaskRead(
        taskId,
        generation,
        selected.activityRevision,
        1
      );
    }, MARK_READ_DEBOUNCE_MS);
  };

  const markSelectedTaskRead = async (
    taskId: string,
    generation: number,
    expectedActivityRevision: number | undefined,
    attempt: number
  ) => {
    if (
      !canMarkSelectedTaskRead(
        taskId,
        generation,
        expectedActivityRevision
      )
    ) {
      return;
    }

    try {
      const response = await markTaskRead(taskId, expectedActivityRevision);
      if (
        !canMarkSelectedTaskRead(
          taskId,
          generation,
          expectedActivityRevision
        )
        || response.activity !== "idle"
      ) {
        return;
      }
      store.setTaskActivity(
        taskId,
        "idle",
        expectedActivityRevision === undefined
          ? undefined
          : expectedActivityRevision + 1
      );
      reconcileSelectedTaskRead();
    } catch {
      if (
        !canMarkSelectedTaskRead(
          taskId,
          generation,
          expectedActivityRevision
        )
      ) return;
      if (attempt >= MARK_READ_MAX_ATTEMPTS) {
        exhaustedMarkReadGeneration = generation;
        return;
      }

      const retryDelay = MARK_READ_RETRY_BASE_MS * 2 ** (attempt - 1);
      markReadTimer = setTimeout(() => {
        markReadTimer = null;
        void markSelectedTaskRead(
          taskId,
          generation,
          expectedActivityRevision,
          attempt + 1
        );
      }, retryDelay);
    }
  };

  const stopTaskTerminal = () => {
    const subscription = activeTaskTerminal?.subscription;
    activeTaskTerminal = null;
    taskTerminalGeneration += 1;
    subscription?.close();
  };

  const stopTaskAgent = () => {
    const subscription = activeTaskAgent?.subscription;
    activeTaskAgent = null;
    taskAgentGeneration += 1;
    subscription?.close();
  };

  const stopTaskCompanion = () => {
    const subscription = activeTaskCompanion?.subscription;
    activeTaskCompanion = null;
    taskCompanionGeneration += 1;
    subscription?.close();
  };

  const stopTaskSession = () => {
    stopTaskTerminal();
    stopTaskAgent();
    stopTaskCompanion();
  };

  const clearTaskSessionIfMissing = (taskId: string) => {
    if (findTask(taskId)) {
      return;
    }
    stopTaskSession();
    store.clearTaskTerminal();
    store.clearTaskAgent();
    store.clearTaskCompanion();
  };

  const selectMigratedTaskIdentity = (
    previousTaskId: string,
    nextTaskId: string
  ) => {
    const nextTask = findTask(nextTaskId);
    const previousSlot = taskUiSlotForSelection(
      store.getState().taskUiSlots,
      previousTaskId
    );
    const previousDurableTaskId = previousSlot?.taskId ?? previousTaskId;
    const nextRouteIdentity =
      client.getTaskRouteIdentity?.(nextTaskId) ?? nextTaskId;
    let retainedSession = false;

    if (
      nextTask?.agentType !== "agent" &&
      activeTaskTerminal?.taskId === previousDurableTaskId &&
      activeTaskTerminal.routeIdentity === nextRouteIdentity
    ) {
      activeTaskTerminal.taskId = nextTaskId;
      activeTaskTerminal.retagTaskId(nextTaskId);
      retainedSession = true;
    }
    if (
      activeTaskCompanion?.taskId === previousTaskId &&
      activeTaskCompanion.routeIdentity === nextRouteIdentity
    ) {
      activeTaskCompanion.taskId = nextTaskId;
      activeTaskCompanion.retagTaskId(nextTaskId);
      retainedSession = true;
    }
    if (
      nextTask?.agentType === "agent" &&
      activeTaskAgent?.taskId === previousDurableTaskId &&
      activeTaskAgent.routeIdentity === nextRouteIdentity
    ) {
      activeTaskAgent.taskId = nextTaskId;
      activeTaskAgent.retagTaskId(nextTaskId);
      retainedSession = true;
    }

    if (previousSlot && nextTask) {
      store.acknowledgeTaskUiSlot(previousSlot.slotId, nextTask);
    }

    if (retainedSession) {
      store.retagTaskIdentity(previousDurableTaskId, nextTaskId, {
        preserveSelection: Boolean(previousSlot)
      });
    } else if (previousSlot) {
      if (store.getState().selectedTaskId === previousSlot.slotId) {
        startTaskView(nextTaskId);
      }
    } else {
      store.setSelectedTask(nextTaskId);
    }
  };

  const reconcileSelectedTask = (allowExhaustedReadRetry = false) => {
    const selectedTaskId = store.getState().selectedTaskId;
    if (!selectedTaskId) {
      pruneResolvedPendingTaskIdentities();
      reconcileSelectedTaskRead(allowExhaustedReadRetry);
      return;
    }

    const pendingIdentity = pendingTaskIdentities.get(selectedTaskId);
    if (pendingIdentity) {
      const displayTaskId = resolveTaskActionDisplayId(
        pendingIdentity.ownerLocalTaskId,
        pendingIdentity.ownerDesktopId,
        pendingIdentity.ownerLocalRepoId
      );
      if (displayTaskId) {
        if (displayTaskId !== selectedTaskId) {
          pendingTaskIdentities.delete(selectedTaskId);
          selectMigratedTaskIdentity(selectedTaskId, displayTaskId);
        }
      }
      pruneResolvedPendingTaskIdentities();
      reconcileSelectedTaskRead(allowExhaustedReadRetry);
      return;
    }

    if (findTask(selectedTaskId)) {
      pruneResolvedPendingTaskIdentities();
      reconcileSelectedTaskRead(allowExhaustedReadRetry);
      return;
    }

    stopTaskSession();
    store.reconcileSelectedTask();
    pruneResolvedPendingTaskIdentities();
    reconcileSelectedTaskRead(allowExhaustedReadRetry);
  };

  const refreshSearchResults = async (): Promise<boolean> => {
    const query = store.getState().searchQuery.trim();
    if (!query) {
      return true;
    }

    const readRevision = taskCollectionsRevision;
    let results: TaskSummary[];
    try {
      results = await client.searchTasks(query);
    } catch (error) {
      if (
        taskCollectionsRevision !== readRevision ||
        store.getState().searchQuery.trim() !== query
      ) {
        return false;
      }
      throw error;
    }
    if (
      taskCollectionsRevision !== readRevision ||
      store.getState().searchQuery.trim() !== query
    ) {
      return false;
    }

    taskCollectionsRevision += 1;
    store.setSearchResults(query, results);
    reconcileSelectedTaskRead();
    return true;
  };

  const loadRepoTasks = async (repoId: string | null): Promise<boolean> => {
    const readRevision = taskCollectionsRevision;
    if (!repoId) {
      if (taskCollectionsRevision !== readRevision) {
        return false;
      }
      taskCollectionsRevision += 1;
      store.setRepoTasks([]);
      return true;
    }

    // listRecentTasks is the all-open-tasks snapshot for every repo. Project
    // the selected repo from that already-loaded snapshot before crossing the
    // transport boundary, then let the repo-specific read refresh the slice.
    // Without this projection, changing repos briefly renders the empty state
    // even when the next repo's tasks are already present locally.
    store.setRepoTasks(
      store.getState().recentTasks.filter((task) => task.repoId === repoId)
    );

    let repoTasks: TaskSummary[];
    try {
      repoTasks = await client.listRepoTasks(repoId);
    } catch (error) {
      if (
        taskCollectionsRevision !== readRevision ||
        store.getState().selectedRepoId !== repoId
      ) {
        return false;
      }
      throw error;
    }
    if (
      taskCollectionsRevision !== readRevision ||
      store.getState().selectedRepoId !== repoId
    ) {
      return false;
    }

    taskCollectionsRevision += 1;
    store.setRepoTasks(repoTasks);
    reconcileSelectedTaskRead();
    return true;
  };

  const loadRepoCommands = async (): Promise<void> => {
    const commandState = store.getState();
    const repoId = commandState.selectedRepoId;
    if (!repoId || commandState.runningRepoCommandId !== null) {
      return;
    }
    const generation = ++repoCommandLoadGeneration;
    const cachedCatalog = repoCommandCatalogs.get(repoId);
    if (cachedCatalog) {
      store.setRepoCommandCatalog(cachedCatalog);
    } else {
      store.setRepoCommandLoading(repoId);
    }
    try {
      const catalog = await client.listRepoCommands(repoId);
      if (
        generation !== repoCommandLoadGeneration ||
        store.getState().selectedRepoId !== repoId
      ) {
        return;
      }
      const normalizedCatalog = { ...catalog, repoId };
      repoCommandCatalogs.set(repoId, normalizedCatalog);
      store.setRepoCommandCatalog(normalizedCatalog);
    } catch (error) {
      if (
        generation !== repoCommandLoadGeneration ||
        store.getState().selectedRepoId !== repoId
      ) {
        return;
      }
      if (cachedCatalog) {
        return;
      }

      store.markRepoCommandsUnavailable(repoId);
      store.setRepoCommandError(
        repoId,
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const startTaskTerminal = (taskId: string) => {
    const routeIdentity = client.getTaskRouteIdentity?.(taskId) ?? taskId;
    if (
      activeTaskTerminal?.taskId === taskId &&
      activeTaskTerminal.routeIdentity === routeIdentity
    ) {
      return;
    }

    stopTaskTerminal();
    const generation = taskTerminalGeneration;

    store.beginTaskTerminal(taskId, "");

    try {
      let streamTaskId = taskId;
      let subscription: TaskTerminalSubscription | null = null;
      const resizeToRequestedGeometry = (snapshot?: {
        cols: number;
        rows: number;
      }) => {
        const geometry = requestedTaskTerminalGeometry;
        if (
          !subscription?.resize ||
          geometry?.taskId !== streamTaskId ||
          (snapshot?.cols === geometry.cols && snapshot.rows === geometry.rows)
        ) {
          return;
        }
        subscription.resize(geometry.cols, geometry.rows);
      };
      const applyEvent = (event: TaskTerminalStreamEvent) => {
        if (generation !== taskTerminalGeneration) {
          return;
        }
        switch (event.type) {
          case "snapshot":
            store.replaceTaskTerminalSnapshot(
              streamTaskId,
              event.dataB64,
              event.cols,
              event.rows,
              event.window
            );
            // Every reconnect produces a fresh daemon snapshot. Reassert the
            // mounted mobile viewport if another client changed the shared PTY
            // while this stream was disconnected.
            resizeToRequestedGeometry(event);
            break;
          case "output":
            store.appendTaskTerminal(streamTaskId, `${event.dataB64}\n`);
            break;
          // A resume means the rendered buffer survived the reconnect: the
          // missed bytes arrive as ordinary output behind this, so nothing is
          // replaced and the reader keeps their place.
          case "resumed":
            store.resumeTaskTerminal(streamTaskId, event.window);
            break;
          case "scrollback":
            store.prependTaskTerminalScrollback(streamTaskId, event.chunk);
            break;
          case "exit":
            store.setTaskTerminalStatus(streamTaskId, "closed");
            break;
          case "error":
            if (event.code === "no_scrollback") {
              store.setTaskTerminalScrollbackLoading(streamTaskId, false);
              break;
            }
            store.setTaskTerminalError(streamTaskId, event.message);
            break;
        }
      };
      subscription = client.observeTaskTerminal(taskId, (event) => {
        applyEvent(event);
      });

      if (generation !== taskTerminalGeneration) {
        subscription.close();
        return;
      }
      activeTaskTerminal = {
        taskId,
        routeIdentity,
        subscription,
        retagTaskId(nextTaskId) {
          streamTaskId = nextTaskId;
        }
      };
      // The task-detail layout can be known before route resolution or stream
      // authentication completes. The transport queues this control frame
      // behind attach, so the initial daemon snapshot cannot strand the PTY at
      // its never-rendered 80x24 default.
      resizeToRequestedGeometry();
    } catch (error) {
      if (generation !== taskTerminalGeneration) {
        return;
      }
      taskTerminalGeneration += 1;
      setTerminalStartupError(taskId, error);
    }
  };

  const startTaskAgent = (taskId: string) => {
    const routeIdentity = client.getTaskRouteIdentity?.(taskId) ?? taskId;
    if (
      activeTaskAgent?.taskId === taskId &&
      activeTaskAgent.routeIdentity === routeIdentity
    ) {
      return;
    }

    stopTaskSession();
    const generation = taskAgentGeneration;
    store.clearTaskTerminal();
    store.beginTaskAgent(taskId);

    try {
      let streamTaskId = taskId;
      const subscription = client.observeTaskAgent(taskId, (event) => {
        if (generation !== taskAgentGeneration) {
          return;
        }
        store.applyTaskAgentStreamEvent(streamTaskId, event);
      });

      if (generation !== taskAgentGeneration) {
        subscription.close();
        return;
      }
      activeTaskAgent = {
        taskId,
        routeIdentity,
        subscription,
        retagTaskId(nextTaskId) {
          streamTaskId = nextTaskId;
        }
      };
    } catch (error) {
      if (generation !== taskAgentGeneration) {
        return;
      }
      taskAgentGeneration += 1;
      const message =
        error instanceof Error ? error.message : "Agent stream failed to start";
      store.applyTaskAgentStreamEvent(taskId, { type: "error", message });
      setUnownedErrorMessage(message);
    }
  };

  const startTaskCompanion = (taskId: string) => {
    const routeIdentity = client.getTaskRouteIdentity?.(taskId) ?? taskId;
    if (
      activeTaskCompanion?.taskId === taskId &&
      activeTaskCompanion.routeIdentity === routeIdentity
    ) {
      return;
    }

    stopTaskCompanion();
    const generation = taskCompanionGeneration;
    store.beginTaskCompanion(taskId);
    try {
      let streamTaskId = taskId;
      let isOpen = false;
      const subscription = client.observeTaskCompanion(taskId, (event) => {
        if (generation !== taskCompanionGeneration) return;
        store.applyTaskCompanionStreamEvent(streamTaskId, event, isOpen);
      });
      if (generation !== taskCompanionGeneration) {
        subscription.close();
        return;
      }
      activeTaskCompanion = {
        taskId,
        routeIdentity,
        subscription,
        setOpen(nextIsOpen) {
          isOpen = nextIsOpen;
        },
        retagTaskId(nextTaskId) {
          streamTaskId = nextTaskId;
        }
      };
    } catch (error) {
      if (generation !== taskCompanionGeneration) return;
      taskCompanionGeneration += 1;
      store.applyTaskCompanionStreamEvent(
        taskId,
        {
          type: "error",
          taskId,
          code: "companion_start_failed",
          message:
            error instanceof Error
              ? error.message
              : "Visual companion stream failed to start"
        },
        false
      );
    }
  };

  /** Clear the in-flight claim only if this generation is the one holding it. */
  const releaseTaskAttachmentSupportRead = (generation: number) => {
    if (activeTaskAttachmentSupport?.generation === generation) {
      activeTaskAttachmentSupport = null;
    }
  };

  /**
   * Ask the desktop that owns this task whether it can receive a photo.
   *
   * Per task rather than per connection. The connection's own `/v1/status` is
   * the wrong source twice over: on the relay path it is a synthetic "Kanna
   * Cloud" record describing no desktop at all, and even on LAN a phone can
   * see tasks owned by several machines running different versions. The
   * transport answers by routing to the task's owner desktop — the same
   * routing that will carry the input — so the gate and the delivery cannot
   * disagree about which machine they mean.
   *
   * Failure resolves to "cannot attach". A desktop that will not answer the
   * question is not one to send a photo into.
   */
  const resetSelectedTaskAttachmentSupport = () => {
    taskAttachmentSupportGeneration += 1;
    store.setDesktopSupportsTaskInputAttachments(false);
  };

  const loadSelectedTaskAttachmentSupport = (taskId: string) => {
    const task = findTask(taskId);
    if (!task) {
      return;
    }
    // `startTaskView` is a reconciler, not an open hook: every live cloud
    // publication and every collection refresh re-enters it for the task on
    // screen. Answering once per (task, route) is therefore the whole point —
    // re-asking on each entry both floods the relay and, because each entry
    // would clear the flag first, unmounts the attach control mid-composer and
    // never lets it back when publications outpace the round trip. Memoized
    // and in-flight-guarded exactly like the sibling `loadSelectedTaskPrompt`.
    const routeIdentity = taskPromptRouteIdentity(task);
    const supportIdentity = JSON.stringify([taskId, routeIdentity]);
    if (
      resolvedTaskAttachmentSupport?.taskId === taskId &&
      resolvedTaskAttachmentSupport.routeIdentity === routeIdentity
    ) {
      store.setDesktopSupportsTaskInputAttachments(
        resolvedTaskAttachmentSupport.supported
      );
      return;
    }
    if (activeTaskAttachmentSupport?.identity === supportIdentity) {
      return;
    }

    const generation = ++taskAttachmentSupportGeneration;
    activeTaskAttachmentSupport = { identity: supportIdentity, generation };
    // Only here — a route this answer has never been asked of. A re-entry for
    // the same task and route returns above without touching the flag.
    store.setDesktopSupportsTaskInputAttachments(false);
    void client
      .supportsTaskInputAttachments(taskId)
      .then((supported) => {
        // Released whatever the guards below decide, so a read superseded by a
        // task switch cannot leave this route permanently unaskable — but only
        // by the read that installed it, so an earlier read for the same route
        // cannot free a later one's claim.
        releaseTaskAttachmentSupportRead(generation);
        if (
          generation !== taskAttachmentSupportGeneration ||
          durableTaskIdForSelection(store.getState().selectedTaskId) !== taskId
        ) {
          return;
        }
        resolvedTaskAttachmentSupport = { taskId, routeIdentity, supported };
        store.setDesktopSupportsTaskInputAttachments(supported);
      })
      .catch(() => {
        // Already false, and an unreachable desktop is not one to offer an
        // attach control for. Nothing is memoized, so the next entry retries.
        releaseTaskAttachmentSupportRead(generation);
      });
  };

  const startTaskView = (taskId: string) => {
    const task = findTask(taskId);
    if (!task) {
      return;
    }
    loadSelectedTaskPrompt(taskId);
    loadSelectedTaskAttachmentSupport(taskId);
    if (isTaskBlocked(task)) {
      // A blocked task has no agent session to attach; the task screen
      // renders the blocked placeholder instead. Collection refreshes
      // re-enter here, so attachment starts as soon as the task unblocks.
      if (activeTaskTerminal || activeTaskAgent || activeTaskCompanion) {
        stopTaskSession();
        store.clearTaskTerminal();
        store.clearTaskAgent();
        store.clearTaskCompanion();
      }
      return;
    }
    if (task.agentType === "agent") {
      startTaskAgent(taskId);
    } else {
      stopTaskAgent();
      store.clearTaskAgent();
      startTaskTerminal(taskId);
    }
    startTaskCompanion(taskId);
  };

  const openTask = (taskId: string) => {
    taskCollectionsRevision += 1;
    // Clear the previous task's answer before the new one is asked. Selecting
    // a task whose row has not loaded yet, or a blocked one, never reaches the
    // read below, and inheriting "attachments are fine" from whatever was on
    // screen before would offer the control against the wrong desktop.
    resetSelectedTaskAttachmentSupport();
    const slot = taskUiSlotForSelection(store.getState().taskUiSlots, taskId);
    const selectionId = slot?.slotId ?? taskId;
    const durableTaskId = slot?.taskId ?? findCollectionTask(taskId)?.id ?? null;
    store.setSelectedTask(selectionId);
    reconcileSelectedTaskRead();
    if (durableTaskId) {
      startTaskView(durableTaskId);
    }
  };

  const reconcileSelectedTaskRoute = () => {
    const selectedTaskId = store.getState().selectedTaskId;
    const durableTaskId = durableTaskIdForSelection(selectedTaskId);
    if (durableTaskId && findTask(durableTaskId)) {
      startTaskView(durableTaskId);
    }
  };
  taskRoutesUnsubscribe =
    options.subscribeTaskRouteChanges?.(reconcileSelectedTaskRoute) ?? null;

  const resolvePendingRepoCommandTaskFromCollections = (): void => {
    const pendingTask = store.getState().pendingRepoCommandTask;
    if (!pendingTask || !findCollectionTask(pendingTask.taskId)) {
      return;
    }

    store.resolveRepoCommandTask(pendingTask.taskId);
    setUnownedErrorMessage(null);
    openTask(pendingTask.taskId);
    if (store.getState().runningRepoCommandId === null) {
      for (const listener of repoCommandTaskOpenListeners) {
        listener(pendingTask.taskId);
      }
      void loadRepoCommands();
    }
  };

  const loadCollections = async () => {
    const readRevision = taskCollectionsRevision;
    const taskCollections = Promise.all([
      client.listRepos(),
      client.listRecentTasks()
    ]).catch((error) => {
      if (taskCollectionsRevision !== readRevision) {
        return null;
      }
      throw error;
    });
    const [, collections] = await Promise.all([
      refreshDesktops({ force: true }),
      taskCollections
    ]);

    if (!collections || taskCollectionsRevision !== readRevision) {
      return;
    }
    const [repos, recentTasks] = collections;

    taskCollectionsRevision += 1;
    lastExplicitRepos = repos;
    store.setRepos(mergeReposWithTaskRepos(repos, recentTasks));
    store.setRecentTasks(recentTasks);
    reconcileLocalTaskListPreferences(recentTasks);
    if (!(await loadRepoTasks(store.getState().selectedRepoId))) {
      return;
    }
    if (!(await refreshSearchResults())) {
      return;
    }
    store.reconcileTaskUiSlots(
      uniqueTasksById([
        ...store.getState().repoTasks,
        ...store.getState().recentTasks,
        ...store.getState().searchResults
      ]),
      { authoritative: true }
    );
    reconcileSelectedTask(true);
    store.setTaskCollectionStatus("ready");
    resolvePendingRepoCommandTaskFromCollections();
  };

  const refreshDesktops = async (options: { force?: boolean } = {}) => {
    if (options.force && refreshDesktopsInFlight) {
      await refreshDesktopsInFlight;
    }
    if (options.force || !refreshDesktopsInFlight) {
      const readRevision = ++desktopCollectionsRevision;
      refreshDesktopsInFlight = (async () => {
        try {
          const desktops = await client.listDesktops();
          if (desktopCollectionsRevision === readRevision) {
            store.setDesktops(desktops);
            reconcileComposerAgentProvider();
            desktopMetadataError = null;
            publishOwnedErrorMessage();
          }
        } catch (error) {
          if (desktopCollectionsRevision === readRevision) {
            desktopMetadataError = {
              revision: readRevision,
              message:
                error instanceof Error
                  ? error.message
                  : "Desktop metadata refresh failed"
            };
            publishOwnedErrorMessage();
          }
        }
      })();
    }
    const refresh = refreshDesktopsInFlight;
    try {
      await refresh;
    } finally {
      if (refreshDesktopsInFlight === refresh) {
        refreshDesktopsInFlight = null;
      }
    }
  };

  const refreshTaskCollections = async (): Promise<boolean> => {
    const readRevision = taskCollectionsRevision;
    const selectedRepoId = store.getState().selectedRepoId;
    let recentTasks: TaskSummary[];
    let repoTasks: TaskSummary[];
    try {
      [recentTasks, repoTasks] = await Promise.all([
        client.listRecentTasks(),
        selectedRepoId ? client.listRepoTasks(selectedRepoId) : Promise.resolve([])
      ]);
    } catch (error) {
      if (
        taskCollectionsRevision !== readRevision ||
        store.getState().selectedRepoId !== selectedRepoId
      ) {
        return false;
      }
      throw error;
    }
    if (
      taskCollectionsRevision !== readRevision ||
      store.getState().selectedRepoId !== selectedRepoId
    ) {
      return false;
    }

    taskCollectionsRevision += 1;
    store.setRepos(mergeReposWithTaskRepos(store.getState().repos, recentTasks));
    store.setRecentTasks(recentTasks);
    store.setRepoTasks(repoTasks);
    reconcileLocalTaskListPreferences(recentTasks);
    if (!(await refreshSearchResults())) {
      return false;
    }
    store.reconcileTaskUiSlots(
      uniqueTasksById([
        ...store.getState().repoTasks,
        ...store.getState().recentTasks,
        ...store.getState().searchResults
      ]),
      { authoritative: true }
    );
    reconcileSelectedTask(true);
    store.setTaskCollectionStatus("ready");
    resolvePendingRepoCommandTaskFromCollections();
    return true;
  };

  const loadCreatedRepoCommandTask = async (
    pendingTask: PendingRepoCommandTask
  ): Promise<boolean> => {
    const pendingIdentity = pendingTaskIdentities.get(pendingTask.taskId);
    for (
      let attempt = 0;
      attempt < REPO_COMMAND_TASK_LOAD_ATTEMPTS;
      attempt += 1
    ) {
      if (pendingIdentity && client.getTask) {
        try {
          const detail = await client.getTask(pendingTask.taskId);
          rememberActionTaskSummary({
            ...detail,
            id: pendingTask.taskId,
            ownerDesktopId: pendingIdentity.ownerDesktopId,
            ownerLocalRepoId: pendingIdentity.ownerLocalRepoId,
            ownerLocalTaskId: pendingIdentity.ownerLocalTaskId
          });
          store.resolveRepoCommandTask(pendingTask.taskId);
          setUnownedErrorMessage(null);
          return true;
        } catch {
          // The owner accepted the launch before its task detail became
          // readable. Retry this exact owner route before falling back to the
          // broader task collections used by older desktop responses.
        }
      }
      try {
        await refreshTaskCollections();
        if (findCollectionTask(pendingTask.taskId)) {
          store.resolveRepoCommandTask(pendingTask.taskId);
          setUnownedErrorMessage(null);
          return true;
        }
      } catch {
        // A collection read can race publication or briefly lose its route.
        // Retry through the same authoritative collection boundary below.
      }

      if (attempt + 1 < REPO_COMMAND_TASK_LOAD_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, REPO_COMMAND_TASK_LOAD_RETRY_MS);
        });
      }
    }

    store.setRepoCommandTaskLoadError(
      pendingTask,
      REPO_COMMAND_TASK_LOAD_ERROR
    );
    return false;
  };

  const applyLiveCloudTasks = (
    tasks: TaskSummary[],
    subscriptionEpoch: number,
    cloudAuthoritative: boolean
  ) => {
    tasks = preserveLoadedTaskPrompt(uniqueTasksById(tasks));
    taskCollectionsRevision += 1;
    const repositoryRevision = ++liveRepositoryRevision;
    const previousState = store.getState();
    const selectedRepo = previousState.selectedRepoId
      ? previousState.repos.find(
          (repo) => repo.id === previousState.selectedRepoId
        ) ?? {
          id: previousState.selectedRepoId,
          name: previousState.selectedRepoId
        }
      : null;
    const selectedRepoHasTask = selectedRepo
      ? tasks.some((task) => task.repoId === selectedRepo.id)
      : false;
    store.setRepos(
      mergeReposWithTaskRepos(
        [
          ...lastExplicitRepos,
          ...(selectedRepo && !selectedRepoHasTask ? [selectedRepo] : [])
        ],
        tasks
      )
    );
    store.setRecentTasks(tasks);
    const selectedRepoId = store.getState().selectedRepoId;
    store.setRepoTasks(
      selectedRepoId ? tasks.filter((task) => task.repoId === selectedRepoId) : [],
    );
    const searchQuery = store.getState().searchQuery;
    store.setSearchResults(searchQuery, filterTasksForQuery(tasks, searchQuery));
    if (cloudAuthoritative) {
      reconcileLocalTaskListPreferences(tasks);
    }
    reconcileSelectedTask(true);
    store.reconcileTaskUiSlots(tasks, { authoritative: cloudAuthoritative });
    reconcileSelectedTask(true);
    const ownedError = cloudSubscriptionError;
    if (cloudAuthoritative && ownedError?.epoch === subscriptionEpoch) {
      cloudSubscriptionError = null;
      publishOwnedErrorMessage();
    }
    const selectedTaskId = store.getState().selectedTaskId;
    const selectedDurableTaskId = durableTaskIdForSelection(selectedTaskId);
    if (selectedDurableTaskId) {
      startTaskView(selectedDurableTaskId);
    }
    if (cloudAuthoritative) {
      store.setTaskCollectionStatus("ready");
    }
    resolvePendingRepoCommandTaskFromCollections();

    void client.listRepos().then((repos) => {
      if (
        subscriptionEpoch !== cloudSubscriptionEpoch ||
        repositoryRevision !== liveRepositoryRevision
      ) {
        return;
      }
      lastExplicitRepos = repos;
      store.setRepos(mergeReposWithTaskRepos(repos, tasks));
      const currentRepoId = store.getState().selectedRepoId;
      store.setRepoTasks(
        currentRepoId ? tasks.filter((task) => task.repoId === currentRepoId) : []
      );
    }).catch(() => {
      // Repository supplementation is optional. Keep the task-derived and
      // last-good repository list when either source is temporarily unavailable.
    });
  };

  const reposFromTasks = (tasks: TaskSummary[]): RepoSummary[] => {
    const reposById = new Map<string, RepoSummary>();
    for (const task of tasks) {
      if (reposById.has(task.repoId)) continue;
      reposById.set(task.repoId, {
        id: task.repoId,
        name: task.repoName?.trim() || task.repoId,
        ...(task.ownerDesktopId
          ? { registeredDesktopIds: [task.ownerDesktopId] }
          : {})
      });
    }
    return Array.from(reposById.values());
  };

  const mergeReposWithTaskRepos = (
    repos: RepoSummary[],
    tasks: TaskSummary[]
  ): RepoSummary[] => mergeRepoSummaries([...repos, ...reposFromTasks(tasks)]);

  const uniqueTasksById = (tasks: TaskSummary[]): TaskSummary[] => {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  };

  const getCloudOwnerDesktopId = (task: TaskSummary): string | null => {
    const ownerDesktopId = (task as { ownerDesktopId?: unknown }).ownerDesktopId;
    return typeof ownerDesktopId === "string" && ownerDesktopId.trim()
      ? ownerDesktopId
      : null;
  };

  const resolveKnownDesktopId = (desktopId: string | null | undefined): string | null => {
    if (!desktopId) {
      return null;
    }
    return store.getState().desktops.some((desktop) => desktop.id === desktopId)
      ? desktopId
      : null;
  };

  /**
   * The machine a composer selection refers to, resolved against the same
   * inventory the composer renders its machine list from.
   *
   * `desktops` is the merged desktop read; the composer's machine list is built
   * from the account/LAN/manual sources. A late LAN read republishes those
   * sources without the merged read resolving again, so for up to one refresh
   * cycle a machine can carry an inventory in the list the user is looking at
   * and not in `desktops`. Resolving the provider from the other list is how a
   * task gets created for a provider the machine cannot spawn — the exact
   * failure this inventory exists to prevent.
   */
  const knownDesktop = (
    desktopId: string | null
  ): Pick<DesktopSummary, "name" | "agentProviders"> | null => {
    if (!desktopId) return null;
    const state = store.getState();
    const machine = buildMachineInventory({
      accountDesktops: state.accountDesktops,
      manualDesktops: state.trustedDesktops,
      liveLanDesktops: state.liveLanDesktops
    }).find((candidate) => candidate.desktopId === desktopId);
    const desktop = state.desktops.find(
      (candidate) => candidate.id === desktopId
    );
    if (!machine && !desktop) return null;
    const agentProviders = machine?.agentProviders ?? desktop?.agentProviders;
    return {
      name: machine?.displayName ?? desktop?.name ?? desktopId,
      ...(agentProviders ? { agentProviders } : {})
    };
  };

  /**
   * The provider a task for this machine should be created with. Falls back to
   * the machine's own first choice when the preferred provider is not installed
   * there, and to `null` when that machine reported it can run none — offering
   * a provider the desktop cannot spawn creates a task whose session never
   * connects.
   */
  const composerAgentProviderFor = (
    desktopId: string | null,
    preferred: ComposerAgentProvider | null
  ): ComposerAgentProvider | null =>
    resolveAgentProviderForDesktop(preferred, knownDesktop(desktopId));

  /**
   * Re-resolve the open composer's provider against the latest machine
   * inventory. A refresh can be the first read that carries an inventory at
   * all, so a selection made while the machine looked unrestricted must not
   * survive into a task the machine cannot run.
   */
  const reconcileComposerAgentProvider = (): void => {
    const state = store.getState();
    if (!state.isComposerOpen) return;
    const resolved = composerAgentProviderFor(
      state.composerDesktopId,
      state.composerAgentProvider
    );
    if (resolved !== state.composerAgentProvider) {
      store.setComposerAgentProvider(resolved);
    }
  };

  const inferComposerDesktopId = (repoId: string): string | null => {
    const state = store.getState();
    const repo = state.repos.find((candidate) => candidate.id === repoId);
    if (repo?.registeredDesktopIds) {
      const knownDesktopIds = repo.registeredDesktopIds
        .map(resolveKnownDesktopId)
        .filter((desktopId): desktopId is string => desktopId !== null);
      if (
        state.selectedDesktopId &&
        knownDesktopIds.includes(state.selectedDesktopId)
      ) {
        return state.selectedDesktopId;
      }
      return knownDesktopIds.length === 1 ? knownDesktopIds[0] : null;
    }
    const ownerIds = new Set<string>();
    for (const task of [
      ...state.repoTasks,
      ...state.recentTasks,
      ...state.searchResults
    ]) {
      if (task.repoId !== repoId) {
        continue;
      }
      const ownerDesktopId = getCloudOwnerDesktopId(task);
      if (ownerDesktopId) {
        ownerIds.add(ownerDesktopId);
      }
    }
    if (ownerIds.size === 1) {
      return resolveKnownDesktopId(Array.from(ownerIds)[0]);
    }

    const repoExistsOnCurrentDesktop = state.repos.some((repo) => repo.id === repoId);
    return repoExistsOnCurrentDesktop ? resolveKnownDesktopId(state.selectedDesktopId) : null;
  };

  const startCloudTaskSubscription = (uid: string): boolean => {
    if (!options.subscribeCloudTasks) return false;
    taskCollectionsRevision += 1;
    desktopCollectionsRevision += 1;
    stopCloudTaskSubscription();
    const epoch = cloudSubscriptionEpoch;
    const unsubscribe = options.subscribeCloudTasks(
      uid,
      (tasks, publication) => {
        if (epoch !== cloudSubscriptionEpoch) {
          return;
        }
        applyLiveCloudTasks(
          tasks,
          epoch,
          publication?.cloudAuthoritative !== false
        );
      },
      (error) => {
        if (epoch !== cloudSubscriptionEpoch) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Cloud task subscription failed";
        cloudSubscriptionError = { epoch, message };
        publishOwnedErrorMessage();
        if (store.getState().taskCollectionStatus === "loading") {
          store.setTaskCollectionStatus("error");
        }
      }
    );
    if (epoch !== cloudSubscriptionEpoch) {
      unsubscribe();
      return false;
    }
    cloudTasksUnsubscribe = unsubscribe;
    return true;
  };

  const stopCloudTaskSubscription = () => {
    const unsubscribe = cloudTasksUnsubscribe;
    cloudTasksUnsubscribe = null;
    cloudSubscriptionError = null;
    publishOwnedErrorMessage();
    cloudSubscriptionEpoch += 1;
    liveRepositoryRevision += 1;
    unsubscribe?.();
  };

  const clearAccountScopedState = () => {
    taskCollectionsRevision += 1;
    desktopCollectionsRevision += 1;
    stopCloudTaskSubscription();
    stopTaskSession();
    store.setSelectedTask(null);
    store.setDesktops([]);
    store.resetAccountScopedMachines();
    lastExplicitRepos = [];
    store.setRepos([]);
    store.setRecentTasks([]);
    store.setRepoTasks([]);
    store.setSearchResults(store.getState().searchQuery, []);
    store.setTaskCollectionStatus("loading");
    pendingTaskIdentities.clear();
    desktopMetadataError = null;
    setUnownedErrorMessage(null);
  };

  const startBackgroundRefresh = (mode: "collections" | "desktops") => {
    backgroundRefreshMode = mode;
    if (backgroundRefreshTimer) {
      return;
    }

    backgroundRefreshTimer = setInterval(() => {
      if (backgroundRefreshInFlight || store.getState().connectionState !== "connected") {
        return;
      }

      backgroundRefreshInFlight = true;
      const refresh =
        backgroundRefreshMode === "desktops"
          ? refreshDesktops({ force: true })
          : refreshTaskCollections();
      void refresh
        .catch(fail)
        .finally(() => {
          backgroundRefreshInFlight = false;
        });
    }, BACKGROUND_REFRESH_INTERVAL_MS);
  };

  const fail = (error: unknown) => {
    store.setConnectionState("error");
    if (store.getState().taskCollectionStatus === "loading") {
      store.setTaskCollectionStatus("error");
    }
    setUnownedErrorMessage(
      error instanceof Error ? error.message : "Mobile app request failed"
    );
  };

  const initializeAuth = async () => {
    if (!authSession) {
      return;
    }

    await authSession.initialize();
    store.setAuthState(authSession.getState());
    if (!authUnsubscribe) {
      authUnsubscribe = authSession.subscribe((authState) => {
        const previousAuth = store.getState().auth;
        const previousUid =
          previousAuth.status === "signedIn" ? previousAuth.user.uid : null;
        const nextUid = authState.status === "signedIn" ? authState.user.uid : null;
        const identityChanged =
          previousUid !== nextUid && (previousUid !== null || nextUid !== null);
        if (identityChanged) {
          clearAccountScopedState();
        }
        store.setAuthState(authState);
        if (authState.status !== "signedIn") {
          stopCloudTaskSubscription();
        }
        if (identityChanged) {
          void bootstrap().catch(fail);
        }
      });
    }
  };

  const bootstrap = (): Promise<void> => {
    bootstrapRequested = true;
    if (!bootstrapInFlight) {
      let runner!: Promise<void>;
      runner = (async () => {
        try {
          while (true) {
            bootstrapRequested = false;
            await doBootstrap();
            if (bootstrapRequested) {
              continue;
            }
            if (bootstrapInFlight === runner) {
              bootstrapInFlight = null;
            }
            return;
          }
        } catch (error) {
          if (bootstrapInFlight === runner) {
            bootstrapInFlight = null;
          }
          throw error;
        }
      })();
      bootstrapInFlight = runner;
    }
    return bootstrapInFlight;
  };

  const doBootstrap = async () => {
      setUnownedErrorMessage(null);
      // Read the phone's own pin/dismiss record alongside the connection: the
      // lists it orders are about to be filled.
      void ensureTaskListPreferences();
      await initializeAuth();

      try {
        const status = await client.getStatus();
        store.setDesktopStatus(
          status.state,
          status.desktopName,
          status.pairingCode,
          status.desktopId
        );

        if (status.state !== "running") {
          stopCloudTaskSubscription();
          store.setConnectionState("idle");
          store.setTaskCollectionStatus("ready");
          return;
        }

        store.setConnectionMode(status.lanHost === "cloud" ? "remote" : "lan");
        store.setConnectionState("connected");
        // When connected to the cloud and signed in, read tasks via a live
        // onSnapshot subscription. In LAN mode (including cloud→LAN fallback)
        // keep polling — the live cloud stream would otherwise clobber LAN
        // tasks with empty cloud data.
        const auth = authSession?.getState();
        const useLiveCloudTasks =
          store.getState().connectionMode === "remote" &&
          auth?.status === "signedIn" &&
          startCloudTaskSubscription(auth.user.uid);
        backgroundRefreshMode = useLiveCloudTasks ? "desktops" : "collections";
        if (useLiveCloudTasks) {
          await refreshDesktops({ force: true });
        } else {
          stopCloudTaskSubscription();
          await loadCollections();
        }
        startBackgroundRefresh(useLiveCloudTasks ? "desktops" : "collections");
        const selectedTaskId = store.getState().selectedTaskId;
        const selectedDurableTaskId = durableTaskIdForSelection(selectedTaskId);
        if (selectedDurableTaskId) {
          startTaskView(selectedDurableTaskId);
        }
      } catch (error) {
        fail(error);
      }
    };

  const submitFrozenTaskCreation = (attempt: PendingTaskCreation) =>
    client.createTask({
      taskId: attempt.taskId,
      repoId: attempt.repoId,
      prompt: attempt.prompt,
      desktopId: attempt.desktopId,
      agentProvider: attempt.agentProvider,
      agentType: "pty",
      terminalCols:
        attempt.terminalCols ?? DEFAULT_MOBILE_TERMINAL_GEOMETRY.cols,
      terminalRows:
        attempt.terminalRows ?? DEFAULT_MOBILE_TERMINAL_GEOMETRY.rows
    });

  const offerRepoCheckout = (
    action: "create-task" | "repo-command",
    repo: RepoSummary,
    desktopId: string,
    desktopName: string,
    commandId?: string
  ): boolean => {
    if (!repo.remoteUrl || !repo.remoteUrlHash) {
      return false;
    }
    store.setRepoCheckoutOffer({
      action,
      status: "offered",
      repoId: repo.id,
      repoName: repo.name,
      desktopId,
      desktopName,
      ...(commandId ? { commandId } : {})
    });
    return true;
  };

  const findTaskCreationAttempt = (
    selectionOrSlotId?: string | null
  ): TaskCreationAttempt | null => {
    const state = store.getState();
    const identity = selectionOrSlotId ?? state.selectedTaskId;
    return (
      state.taskCreationAttempts.find(
        (attempt) =>
          attempt.slotId === identity || attempt.taskId === identity
      ) ??
      (!selectionOrSlotId ? state.taskCreationAttempts[0] : null) ??
      null
    );
  };

  const isCurrentTaskCreationAttempt = (attempt: PendingTaskCreation) =>
    store.getState().taskCreationAttempts.some(
      (candidate) =>
        candidate.slotId === attempt.slotId &&
        candidate.taskId === attempt.taskId
    );

  const isTaskCreationAbortPending = (attempt: PendingTaskCreation) => {
    return findTaskCreationAttempt(attempt.slotId)?.pendingAction ===
      "close-task";
  };

  const completeTaskCreation = (
    attempt: PendingTaskCreation,
    created: CreateTaskResponse
  ): string | null => {
    const currentState = store.getState();
    if (
      !isCurrentTaskCreationAttempt(attempt) ||
      isTaskCreationAbortPending(attempt)
    ) {
      return null;
    }

    const shouldOpenCreatedTask =
      currentState.selectedTaskId === attempt.slotId;
    const createdRoute = getClientResolvedTaskRoute(created);
    if (createdRoute) {
      pendingTaskIdentities.set(attempt.slotId, createdRoute);
    }
    taskCollectionsRevision += 1;
    const createdTask = mapCreatedTask(created);
    store.acknowledgeTaskUiSlot(attempt.slotId, createdTask);
    store.setRecentTasks([
      createdTask,
      ...currentState.recentTasks.filter((task) => task.id !== createdTask.id)
    ]);
    if (currentState.selectedRepoId === createdTask.repoId) {
      store.setRepoTasks([
        createdTask,
        ...currentState.repoTasks.filter((task) => task.id !== createdTask.id)
      ]);
    }
    store.upsertRepoCreationProfile({
      repoId: attempt.repoId,
      desktopId: attempt.desktopId,
      agentProvider: attempt.agentProvider,
      updatedAt: new Date().toISOString()
    });
    store.removeTaskCreationAttempt(attempt.slotId);
    taskCreationPersistenceFlights.delete(attempt.taskId);
    recoveryStartedTaskIds.delete(attempt.taskId);
    if (
      !currentState.isComposerOpen &&
      currentState.composerPrompt === attempt.prompt
    ) {
      store.setComposerState(false, "");
    }
    setUnownedErrorMessage(null);
    if (shouldOpenCreatedTask) {
      taskCollectionsRevision += 1;
      startTaskView(createdTask.id);
      return attempt.slotId;
    }
    return null;
  };

  const failTaskCreationDefinitely = (
    attempt: PendingTaskCreation,
    message: string
  ) => {
    if (!isCurrentTaskCreationAttempt(attempt)) {
      return;
    }
    taskCreationPersistenceFlights.delete(attempt.taskId);
    store.removeTaskCreationAttempt(attempt.slotId);
    store.removeTaskUiSlot(attempt.slotId);
    if (store.getState().selectedTaskId === attempt.slotId) {
      stopTaskSession();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
      store.clearTaskCompanion();
    }
    recoveryStartedTaskIds.delete(attempt.taskId);
    setUnownedErrorMessage(message);
  };

  // A machine is added so its work becomes reachable, so pairing owns loading
  // that work. Refreshing desktop metadata alone left the task lists empty
  // until something unrelated re-bootstrapped — a Bonjour publish (not
  // guaranteed: the browser already knows the service the claim just went to)
  // or the background poll, which never runs when the phone had no machine at
  // all and so was never connected. Flip the collection status to `loading`
  // first: every task surface then shows its loading state for the whole wait
  // instead of reading as an empty machine.
  const loadPairedMachineWork = async () => {
    store.setTaskCollectionStatus("loading");
    await bootstrap();
    if (store.getState().connectionState !== "connected") {
      // Bootstrap stops before reading anything when the connection is not
      // running, but the machine that was just added still has to appear in
      // the inventory the Machines screen renders.
      await refreshDesktops({ force: true });
    }
  };

  return {
    bootstrap,

    async pairMachineByCode(code) {
      if (!options.pairingService) {
        throw new Error("Machine pairing is not configured.");
      }
      const trusted = await options.pairingService.claimCode(code);
      const previous = store.getState().trustedDesktops;
      store.upsertTrustedDesktop(trusted);
      try {
        await options.persistSessionContext?.();
      } catch (error) {
        store.setTrustedDesktops(previous);
        throw error;
      }
      options.replaceClientForTrustChange?.();
      await loadPairedMachineWork();
      return trusted.desktopId;
    },

    async pairMachineByPayload(payload) {
      if (!options.pairingService) {
        throw new Error("Machine pairing is not configured.");
      }
      const trusted = await options.pairingService.claimPayload(payload);
      const previous = store.getState().trustedDesktops;
      store.upsertTrustedDesktop(trusted);
      try {
        await options.persistSessionContext?.();
      } catch (error) {
        store.setTrustedDesktops(previous);
        throw error;
      }
      options.replaceClientForTrustChange?.();
      await loadPairedMachineWork();
      return trusted.desktopId;
    },

    async removeManualMachine(desktopId) {
      const nextTrustedDesktops = store
        .getState()
        .trustedDesktops
        .filter((desktop) => desktop.desktopId !== desktopId);
      await options.persistSessionContext?.({
        ...store.getPersistedContext(),
        trustedDesktops: nextTrustedDesktops
      });
      store.setTrustedDesktops(nextTrustedDesktops);
      options.replaceClientForTrustChange?.();
      await refreshDesktops({ force: true });
    },

    async signInWithEmailPassword(email, password) {
      if (!authSession) {
        store.setAuthState({
          status: "error",
          message: "Firebase Auth is not configured.",
          user: null
        });
        return;
      }

      await authSession.signInWithEmailPassword({ email, password });
      const authState = authSession.getState();
      store.setAuthState(authState);
      if (authState.status === "signedIn") {
        await bootstrap();
      }
    },

    async createUserWithEmailPassword(email, password) {
      if (!authSession) {
        store.setAuthState({
          status: "error",
          message: "Firebase Auth is not configured.",
          user: null
        });
        return;
      }

      await authSession.createUserWithEmailPassword({ email, password });
      store.setAuthState(authSession.getState());
    },

    async refreshAccount() {
      if (!authSession) return;
      await authSession.refreshAccount();
      store.setAuthState(authSession.getState());
    },

    async signOut() {
      if (!authSession) {
        store.setAuthState({ status: "signedOut" });
        return;
      }

      await authSession.signOut();
      store.setAuthState(authSession.getState());
    },

    getIdToken(forceRefresh) {
      return authSession?.getIdToken(forceRefresh) ?? Promise.resolve(null);
    },

    async refresh(options) {
      store.setRefreshStatus("refreshing");
      if (
        store.getState().selectedTaskId &&
        !options?.preserveTaskSession
      ) {
        stopTaskSession();
      }
      await this.bootstrap();
      store.setRefreshStatus(
        store.getState().connectionState === "error" ? "error" : "updated"
      );
    },

    setNavigationView(view) {
      store.setActiveView(view);
      reconcileTaskSummarySubscriptions();
      const state = store.getState();
      if (
        view === "more" &&
        state.runningRepoCommandId === null &&
        state.pendingRepoCommandTask === null
      ) {
        void loadRepoCommands();
      }
    },

    setTaskDetailVisible(visible) {
      if (taskDetailVisible === visible) return;
      taskDetailVisible = visible;
      reconcileTaskSummarySubscriptions();
      reconcileSelectedTaskRead();
    },

    setAppForeground(foreground) {
      if (appForeground === foreground) return;
      appForeground = foreground;
      reconcileTaskSummarySubscriptions();
    },

    expireTaskTerminalGrace() {
      stopTaskTerminal();
    },

    async selectDesktop(desktopId) {
      taskCollectionsRevision += 1;
      stopTaskSession();
      store.selectDesktop(desktopId);
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
      store.clearTaskCompanion();
      await this.bootstrap();
    },

    async selectRepo(repoId) {
      const state = store.getState();
      if (state.runningRepoCommandId !== null) {
        return;
      }
      taskCollectionsRevision += 1;
      store.selectRepo(repoId);
      try {
        const committed = await loadRepoTasks(repoId);
        if (committed) {
          setUnownedErrorMessage(null);
        }
      } catch (error) {
        fail(error);
      }
      if (store.getState().activeView === "more") {
        await loadRepoCommands();
      }
    },

    loadRepoCommands,

    async runRepoCommand(commandId) {
      const state = store.getState();
      const repoId = state.selectedRepoId;
      const catalog = state.repoCommandCatalog;
      const command = catalog?.commands.find(
        (candidate) => candidate.id === commandId
      );
      if (!repoId || !catalog || catalog.repoId !== repoId || !command) {
        return null;
      }
      if (!store.beginRepoCommandRun(commandId)) {
        return null;
      }

      let reloadCatalog = false;
      let openedTaskId: string | null = null;
      try {
        const response = await client.runRepoCommand(
          repoId,
          commandId,
          catalog.revision
        );
        const responseRoute = getClientResolvedTaskRoute(response);
        if (responseRoute) {
          pendingTaskIdentities.set(response.taskId, responseRoute);
        }
        if (await loadCreatedRepoCommandTask({ commandId, taskId: response.taskId })) {
          this.openTask(response.taskId);
          openedTaskId = response.taskId;
        }
      } catch (error) {
        const commandState = store.getState();
        const repo = commandState.repos.find(
          (candidate) => candidate.id === repoId
        );
        const desktopId = commandState.selectedDesktopId;
        const desktopName = desktopId
          ? commandState.desktops.find((desktop) => desktop.id === desktopId)?.name ?? desktopId
          : null;
        if (
          error instanceof RepoNotRegisteredError &&
          repo &&
          desktopId &&
          desktopName
        ) {
          offerRepoCheckout(
            "repo-command",
            repo,
            desktopId,
            desktopName,
            commandId
          );
        }
        if (!(error instanceof RepoNotRegisteredError)) {
          fail(error);
        }
        reloadCatalog = isStaleRepoCommandError(error);
        if (!reloadCatalog) {
          const message =
            error instanceof RepoNotRegisteredError
              ? `${error.repoName} is not registered on ${error.desktopName}. Choose a machine that has this repo and try again.`
              : error instanceof Error
                ? error.message
                : "Repository command failed";
          store.setRepoCommandRunError(
            commandId,
            message
          );
        }
      } finally {
        store.finishRepoCommandRun(commandId);
      }
      if (reloadCatalog) {
        repoCommandCatalogs.delete(repoId);
        store.setRepoCommandLoading(repoId);
        await loadRepoCommands();
      }
      return openedTaskId;
    },

    async retryRepoCommand() {
      const commandState = store.getState();
      const pendingTask = store.beginRepoCommandTaskRefresh();
      if (!pendingTask) {
        if (
          commandState.runningRepoCommandId !== null ||
          commandState.pendingRepoCommandTask !== null
        ) {
          return null;
        }
        store.resetRepoCommandAvailability();
        await loadRepoCommands();
        return null;
      }

      let openedTaskId: string | null = null;
      try {
        if (await loadCreatedRepoCommandTask(pendingTask)) {
          this.openTask(pendingTask.taskId);
          openedTaskId = pendingTask.taskId;
        }
      } finally {
        store.finishRepoCommandRun(pendingTask.commandId);
      }
      store.resetRepoCommandAvailability();
      await loadRepoCommands();
      return openedTaskId;
    },

    dismissRepoCommandTaskLoadError() {
      store.dismissRepoCommandTaskLoadError();
    },

    subscribeRepoCommandTaskOpen(listener) {
      repoCommandTaskOpenListeners.add(listener);
      return () => repoCommandTaskOpenListeners.delete(listener);
    },

    openTask(taskId) {
      openTask(taskId);
    },

    closeTask(taskId) {
      if (taskId && store.getState().selectedTaskId !== taskId) {
        return;
      }
      taskCollectionsRevision += 1;
      taskDetailVisible = false;
      taskDetailGeneration += 1;
      activeTaskDetailIdentity = null;
      loadedTaskPrompt = null;
      stopTaskSession();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
      store.clearTaskCompanion();
      reconcileSelectedTaskRead();
    },

    openComposer() {
      const state = store.getState();
      const selectedRepoId = state.selectedRepoId;
      const selectedRepo = selectedRepoId
        ? state.repos.find((repo) => repo.id === selectedRepoId)
        : null;
      const profile = selectedRepoId
        ? state.repoCreationProfiles.find((candidate) => candidate.repoId === selectedRepoId)
        : null;
      const composerDesktopId =
        profile &&
        (!selectedRepo || repoIsRegisteredOnDesktop(selectedRepo, profile.desktopId))
          ? resolveKnownDesktopId(profile.desktopId)
          : selectedRepoId
            ? inferComposerDesktopId(selectedRepoId)
            : null;

      store.setComposerRepo(selectedRepoId);
      store.setComposerDesktop(composerDesktopId);
      store.setComposerAgentProvider(
        composerAgentProviderFor(composerDesktopId, profile?.agentProvider ?? null)
      );
      store.setComposerOptionsExpanded(!composerDesktopId);
      lastSubmittedTaskCreationId = null;
      store.setRepoCheckoutOffer(null);
      store.setComposerState(true, "");
    },

    closeComposer() {
      store.setRepoCheckoutOffer(null);
      store.setComposerState(false, "");
    },

    updateComposerPrompt(prompt) {
      store.setComposerState(store.getState().isComposerOpen, prompt);
    },

    selectComposerDesktop(desktopId) {
      const previous = store.getState().composerAgentProvider;
      store.setComposerDesktop(desktopId);
      store.setRepoCheckoutOffer(null);
      // A provider chosen for another machine must not follow the selection
      // onto a machine that cannot run it.
      store.setComposerAgentProvider(
        composerAgentProviderFor(desktopId, previous)
      );
    },

    setComposerOptionsExpanded(isExpanded) {
      store.setComposerOptionsExpanded(isExpanded);
    },

    selectComposerAgentProvider(provider) {
      store.setComposerAgentProvider(provider);
    },

    async searchTasks(query) {
      setUnownedErrorMessage(null);
      const searchRevision = ++taskCollectionsRevision;
      if (!query.trim()) {
        store.setSearchResults("", []);
        reconcileSelectedTaskRead();
        return;
      }

      try {
        const results = await client.searchTasks(query);
        if (taskCollectionsRevision !== searchRevision) {
          return;
        }
        taskCollectionsRevision += 1;
        store.setSearchResults(query, results);
        reconcileSelectedTaskRead();
      } catch (error) {
        if (taskCollectionsRevision === searchRevision) {
          fail(error);
        }
      }
    },

    async dismissActivity(taskId) {
      const task = store.getState().recentTasks.find(
        (candidate) => candidate.id === taskId
      );
      if (!task || task.activity !== "unread") {
        throw new Error("This activity is no longer available.");
      }
      // Dismissing is this phone hiding a row it has seen. It deliberately
      // does not mark the task read on the desktop: desktop unread state stays
      // authoritative for desktop UI and for supervisors.
      await updateLocalTaskListPreferences(
        (preferences) => dismissLocalActivity(preferences, task),
        (detail) => `Could not dismiss activity: ${detail}`
      );
    },

    async setTaskPinned(taskId, pinned) {
      const task = findTask(taskId);
      if (!task) {
        throw new Error("This task is no longer available.");
      }
      await updateLocalTaskListPreferences(
        (preferences) => setLocalTaskPinned(preferences, task, pinned),
        (detail) => `Could not ${pinned ? "pin" : "unpin"} task: ${detail}`
      );
    },

    createTask(terminalGeometry) {
      const state = store.getState();
      if (!state.isComposerOpen && lastSubmittedTaskCreationId) {
        const existing =
          ordinaryTaskCreationFlights.get(lastSubmittedTaskCreationId);
        if (existing) return existing;
      }
      if (!state.composerRepoId || !state.composerPrompt.trim()) {
        store.setComposerErrorMessage("Choose a repo and enter a task prompt first.");
        return Promise.resolve(null);
      }
      const composerDesktopId = resolveKnownDesktopId(state.composerDesktopId);
      if (!composerDesktopId) {
        store.setComposerDesktop(null);
        store.setComposerErrorMessage("Choose a machine for this repo first.");
        store.setComposerOptionsExpanded(true);
        return Promise.resolve(null);
      }

      const composerRepo = state.repos.find(
        (repo) => repo.id === state.composerRepoId
      );
      if (
        composerRepo &&
        !repoIsRegisteredOnDesktop(composerRepo, composerDesktopId)
      ) {
        const desktopName = state.desktops.find(
          (desktop) => desktop.id === composerDesktopId
        )?.name ?? composerDesktopId;
        const error = new RepoNotRegisteredError(composerRepo.name, desktopName);
        offerRepoCheckout(
          "create-task",
          composerRepo,
          composerDesktopId,
          desktopName
        );
        store.setComposerErrorMessage(error.message);
        store.setComposerOptionsExpanded(true);
        return Promise.resolve(null);
      }

      const agentProvider = composerAgentProviderFor(
        composerDesktopId,
        state.composerAgentProvider
      );
      if (!agentProvider) {
        const desktopName =
          knownDesktop(composerDesktopId)?.name ?? composerDesktopId;
        store.setComposerErrorMessage(
          `${desktopName} has no agent CLI installed. Install one on that machine, then try again.`
        );
        store.setComposerOptionsExpanded(true);
        return Promise.resolve(null);
      }
      if (agentProvider !== state.composerAgentProvider) {
        store.setComposerAgentProvider(agentProvider);
      }

      const { cols, rows } =
        terminalGeometry ?? DEFAULT_MOBILE_TERMINAL_GEOMETRY;
      const attempt: PendingTaskCreation = {
        slotId:
          options.createTaskSlotId?.() ??
          `create:${generateTaskCreationId()}`,
        taskId: (options.createTaskId ?? generateTaskCreationId)(),
        repoId: state.composerRepoId,
        prompt: state.composerPrompt.trim(),
        desktopId: composerDesktopId,
        agentProvider,
        terminalCols: cols,
        terminalRows: rows
      };
      recoveryStartedTaskIds.delete(attempt.taskId);
      store.setComposerRepo(attempt.repoId);
      store.addTaskCreationAttempt({ ...attempt, phase: "pending" });
      store.addTaskUiSlot(buildCreatingTaskUiSlot(attempt));
      store.setSelectedTask(attempt.slotId);
      store.setComposerState(false, attempt.prompt);
      store.setComposerErrorMessage(null);
      lastSubmittedTaskCreationId = attempt.taskId;
      let persistenceReady: Promise<void>;
      try {
        persistenceReady =
          options.persistSessionContext?.() ?? Promise.resolve();
      } catch (error) {
        persistenceReady = Promise.reject(error);
      }
      taskCreationPersistenceFlights.set(attempt.taskId, persistenceReady);
      let taskCreationPromise!: Promise<string | null>;
      taskCreationPromise = (async () => {
        let requestDispatched = false;
        try {
          await persistenceReady;
          if (
            !isCurrentTaskCreationAttempt(attempt) ||
            isTaskCreationAbortPending(attempt)
          ) {
            return null;
          }
          requestDispatched = true;
          const created = await submitFrozenTaskCreation(attempt);
          return completeTaskCreation(attempt, created);
        } catch (error) {
          if (!isCurrentTaskCreationAttempt(attempt)) {
            return null;
          }
          if (isTaskCreationAbortPending(attempt)) {
            return null;
          }
          if (recoveryStartedTaskIds.has(attempt.taskId)) {
            return null;
          }
          const message =
            error instanceof Error ? error.message : "Task creation failed";
          if (
            !requestDispatched ||
            (error instanceof TaskCreationError && error.outcome === "not-created")
          ) {
            failTaskCreationDefinitely(attempt, message);
            store.setComposerErrorMessage(message);
          } else {
            store.setTaskCreationAttemptPhase(attempt.slotId, "uncertain");
            store.setTaskCreationAttemptError(attempt.slotId, message);
          }
          return null;
        }
      })().finally(() => {
        if (
          ordinaryTaskCreationFlights.get(attempt.taskId) ===
          taskCreationPromise
        ) {
          ordinaryTaskCreationFlights.delete(attempt.taskId);
        }
      });
      ordinaryTaskCreationFlights.set(attempt.taskId, taskCreationPromise);
      return taskCreationPromise;
    },

    confirmRepoCheckout(terminalGeometry) {
      if (repoCheckoutFlight) {
        return repoCheckoutFlight;
      }
      const offer = store.getState().repoCheckoutOffer;
      const repo = offer
        ? store.getState().repos.find((candidate) => candidate.id === offer.repoId)
        : null;
      if (
        !offer ||
        offer.status === "running" ||
        !repo?.remoteUrl ||
        !repo.remoteUrlHash
      ) {
        return Promise.resolve(null);
      }
      const remoteUrl = repo.remoteUrl;
      const remoteUrlHash = repo.remoteUrlHash;

      const startRepoCheckout = client.startRepoCheckout;
      const getRepoCheckout = client.getRepoCheckout;
      const setCheckoutError = (message: string) => {
        store.setRepoCheckoutOffer({
          ...offer,
          status: "failed",
          errorMessage: message
        });
        if (offer.action === "create-task") {
          store.setComposerErrorMessage(message);
        } else {
          store.setRepoCommandError(offer.repoId, message);
        }
      };
      if (!startRepoCheckout || !getRepoCheckout) {
        setCheckoutError(
          `${offer.desktopName} must be updated before it can check out repositories remotely.`
        );
        return Promise.resolve(null);
      }

      store.setRepoCheckoutOffer({ ...offer, status: "running" });
      const progressMessage = `Checking out ${offer.repoName} on ${offer.desktopName}…`;
      if (offer.action === "create-task") {
        store.setComposerErrorMessage(progressMessage);
      } else {
        store.setRepoCommandError(offer.repoId, progressMessage);
      }

      let checkoutPromise!: Promise<string | null>;
      checkoutPromise = (async () => {
        try {
          let operation = await startRepoCheckout({
            desktopId: offer.desktopId,
            name: offer.repoName,
            remoteUrl,
            remoteUrlHash
          });
          while (operation.state === "running") {
            await new Promise<void>((resolve) => {
              setTimeout(
                resolve,
                options.repoCheckoutPollIntervalMs ??
                  DEFAULT_REPO_CHECKOUT_POLL_INTERVAL_MS
              );
            });
            operation = await getRepoCheckout(offer.desktopId, operation.id);
          }
          if (operation.state === "failed") {
            throw new Error(operation.error ?? "git clone failed");
          }

          const repos = await client.listRepos();
          lastExplicitRepos = repos;
          store.setRepos(
            mergeReposWithTaskRepos(repos, store.getState().recentTasks)
          );
          const currentOffer = store.getState().repoCheckoutOffer;
          if (
            currentOffer?.repoId !== offer.repoId ||
            currentOffer.desktopId !== offer.desktopId
          ) {
            return null;
          }
          store.setRepoCheckoutOffer(null);
          if (offer.action === "create-task") {
            store.setComposerErrorMessage(null);
            return this.createTask(terminalGeometry);
          }
          store.resetRepoCommandAvailability();
          if (!offer.commandId) {
            await loadRepoCommands();
            return null;
          }
          return this.runRepoCommand(offer.commandId);
        } catch {
          setCheckoutError(
            `Could not check out ${offer.repoName} on ${offer.desktopName}. ` +
              `Configure a credential-free origin and git credentials on ${offer.desktopName}, then try again.`
          );
          return null;
        }
      })().finally(() => {
        if (repoCheckoutFlight === checkoutPromise) {
          repoCheckoutFlight = null;
        }
      });
      repoCheckoutFlight = checkoutPromise;
      return checkoutPromise;
    },

    recoverTaskCreation(slotId) {
      const attempt = findTaskCreationAttempt(slotId);
      if (!attempt) {
        return Promise.resolve(null);
      }
      if (isTaskCreationAbortPending(attempt)) {
        return Promise.resolve(null);
      }
      const existingRecovery =
        recoveryTaskCreationFlights.get(attempt.taskId);
      if (existingRecovery) {
        return existingRecovery;
      }

      const persistenceReady =
        taskCreationPersistenceFlights.get(attempt.taskId) ?? Promise.resolve();
      store.setTaskCreationAttemptPhase(attempt.slotId, "recovering");
      store.setTaskCreationAttemptError(attempt.slotId, null);
      let recoveryPromise!: Promise<string | null>;
      recoveryPromise = (async () => {
        let requestDispatched = false;
        try {
          await persistenceReady;
          if (
            !isCurrentTaskCreationAttempt(attempt) ||
            isTaskCreationAbortPending(attempt)
          ) {
            return null;
          }
          recoveryStartedTaskIds.add(attempt.taskId);
          requestDispatched = true;
          const created = await submitFrozenTaskCreation(attempt);
          return completeTaskCreation(attempt, created);
        } catch (error) {
          if (
            !isCurrentTaskCreationAttempt(attempt)
          ) {
            return null;
          }
          if (!requestDispatched) {
            return null;
          }
          const message =
            error instanceof Error ? error.message : "Task recovery failed";
          if (
            error instanceof TaskCreationError &&
            error.outcome === "not-created"
          ) {
            failTaskCreationDefinitely(attempt, message);
            store.setComposerErrorMessage(message);
            return null;
          }
          store.setTaskCreationAttemptPhase(attempt.slotId, "uncertain");
          store.setTaskCreationAttemptError(attempt.slotId, message);
          return null;
        }
      })().finally(() => {
        if (
          recoveryTaskCreationFlights.get(attempt.taskId) === recoveryPromise
        ) {
          recoveryTaskCreationFlights.delete(attempt.taskId);
        }
      });
      recoveryTaskCreationFlights.set(attempt.taskId, recoveryPromise);
      return recoveryPromise;
    },

    async abortTaskCreation(slotId) {
      const attempt = findTaskCreationAttempt(slotId);
      if (
        !attempt ||
        !store.beginTaskCreationAction(slotId, "close-task")
      ) {
        return;
      }
      try {
        await client.abortTaskCreation({
          taskId: attempt.taskId,
          desktopId: attempt.desktopId
        });
        if (!isCurrentTaskCreationAttempt(attempt)) {
          return;
        }
        const slot = taskUiSlotForSelection(
          store.getState().taskUiSlots,
          attempt.slotId
        );
        const acknowledgedTaskId = slot?.taskId;
        store.removeTaskCreationAttempt(attempt.slotId);
        store.removeTaskUiSlot(attempt.slotId);
        taskCreationPersistenceFlights.delete(attempt.taskId);
        recoveryStartedTaskIds.delete(attempt.taskId);
        if (acknowledgedTaskId) {
          store.setRecentTasks(
            store.getState().recentTasks.filter(
              (task) => task.id !== acknowledgedTaskId
            )
          );
          store.setRepoTasks(
            store.getState().repoTasks.filter(
              (task) => task.id !== acknowledgedTaskId
            )
          );
        }
        if (store.getState().selectedTaskId === attempt.slotId) {
          taskCollectionsRevision += 1;
          taskDetailVisible = false;
          stopTaskSession();
          store.setSelectedTask(null);
          store.clearTaskTerminal();
          store.clearTaskAgent();
          store.clearTaskCompanion();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not abort task creation";
        if (isCurrentTaskCreationAttempt(attempt)) {
          store.setTaskCreationAttemptPhase(attempt.slotId, "uncertain");
          store.setTaskCreationAttemptError(attempt.slotId, message);
        }
      } finally {
        store.finishTaskCreationAction(slotId, "close-task");
      }
    },

    async runMergeAgent(taskId) {
      try {
        const sourceTask = findTask(taskId);
        const ownerDesktopId =
          sourceTask?.ownerDesktopId ??
          store.getState().selectedDesktopId;
        const ownerLocalRepoId = sourceTask?.ownerLocalRepoId ?? null;
        const response = await client.runMergeAgent(taskId);
        const responseOwnerDesktopId =
          response.ownerDesktopId ?? ownerDesktopId;
        const responseOwnerLocalRepoId =
          response.ownerLocalRepoId ?? ownerLocalRepoId;
        const responseRoute = getClientResolvedTaskRoute(response);
        if (response.taskId !== taskId && responseRoute) {
          pendingTaskIdentities.set(response.taskId, responseRoute);
        }
        taskCollectionsRevision += 1;
        await refreshTaskCollections();
        setUnownedErrorMessage(null);
        const displayTaskId = resolveTaskActionDisplayId(
          response.ownerLocalTaskId ??
            response.task?.ownerLocalTaskId ??
            response.taskId,
          responseOwnerDesktopId,
          responseOwnerLocalRepoId
        );
        if (
          response.task &&
          (!displayTaskId || displayTaskId === response.taskId)
        ) {
          rememberActionTaskSummary(response.task);
        }
        if (displayTaskId && displayTaskId !== response.taskId) {
          pendingTaskIdentities.delete(response.taskId);
        }
        const taskIdToOpen = displayTaskId ?? response.taskId;
        clearTaskSessionIfMissing(taskIdToOpen);
        this.openTask(taskIdToOpen);
        return store.getState().selectedTaskId;
      } catch (error) {
        fail(error);
        return null;
      }
    },

    async advanceDesktopTaskStage(taskId) {
      if (!store.beginTaskAction(taskId, "advance-stage")) {
        return null;
      }
      try {
        const sourceTask = findTask(taskId);
        const ownerDesktopId =
          sourceTask?.ownerDesktopId ??
          store.getState().selectedDesktopId;
        const ownerLocalRepoId = sourceTask?.ownerLocalRepoId ?? null;
        const response = await client.advanceTaskStage(taskId);
        const responseOwnerDesktopId =
          response.ownerDesktopId ?? ownerDesktopId;
        const responseOwnerLocalRepoId =
          response.ownerLocalRepoId ?? ownerLocalRepoId;
        const responseRoute = getClientResolvedTaskRoute(response);
        if (response.taskId !== taskId && responseRoute) {
          pendingTaskIdentities.set(response.taskId, responseRoute);
        }
        taskCollectionsRevision += 1;
        await refreshTaskCollections();
        setUnownedErrorMessage(null);
        const displayTaskId = resolveTaskActionDisplayId(
          response.ownerLocalTaskId ??
            response.task?.ownerLocalTaskId ??
            response.taskId,
          responseOwnerDesktopId,
          responseOwnerLocalRepoId
        );
        if (
          response.task &&
          (!displayTaskId || displayTaskId === response.taskId)
        ) {
          rememberActionTaskSummary(response.task);
        }
        if (displayTaskId && displayTaskId !== response.taskId) {
          pendingTaskIdentities.delete(response.taskId);
        }
        const taskIdToOpen = displayTaskId ?? response.taskId;
        clearTaskSessionIfMissing(taskIdToOpen);
        this.openTask(taskIdToOpen);
        return store.getState().selectedTaskId;
      } catch (error) {
        fail(error);
        return null;
      } finally {
        store.finishTaskAction(taskId, "advance-stage");
      }
    },

    readTaskFile(taskId, path) {
      return client.readTaskFile(taskId, path);
    },

    listTaskDirectory(taskId, path, showAllFiles, offset, filter) {
      return client.listTaskDirectory(taskId, path, showAllFiles, offset, filter);
    },

    readTaskFileRange(taskId, path, startLine, lineCount, metadataOnly, startByte) {
      return client.readTaskFileRange(taskId, path, startLine, lineCount, metadataOnly, startByte);
    },

    resolveTaskFileMentions(taskId, mentions) {
      return client.resolveTaskFileMentions(taskId, mentions);
    },

    readTaskDiff(taskId, request) {
      return client.readTaskDiff(taskId, request);
    },

    async sendTaskInput(taskId, input, attachment) {
      const submittedInput = input.trim();
      if (!submittedInput && !attachment) {
        return;
      }

      try {
        const task = findTask(taskId);
        // An attachment is a file the desktop writes and the injected message
        // names, so it only exists on the HTTP input path. The SDK-mode agent
        // stream carries text alone — the composer already hides the attach
        // control for those tasks, and this keeps a stale one from silently
        // dropping the image.
        if (
          !attachment &&
          task?.agentType === "agent" &&
          activeTaskAgent?.taskId === taskId
        ) {
          activeTaskAgent.subscription.sendInput(submittedInput);
        } else {
          await (attachment
            ? client.sendTaskInput(taskId, submittedInput, attachment)
            : client.sendTaskInput(taskId, submittedInput));
        }
        setUnownedErrorMessage(null);
      } catch (error) {
        // A message held behind an unsent line at that terminal is an ordinary
        // outcome of a healthy session, not a broken connection. Surface what
        // the desktop said and leave the app's connection state alone —
        // otherwise one held reply drops the whole app into its error state.
        if (isInputHeldByDraft(error)) {
          setUnownedErrorMessage(
            error instanceof Error ? error.message : "Mobile app request failed"
          );
          return;
        }
        fail(error);
      }
    },

    sendTaskTerminalInput(taskId, dataB64) {
      if (!dataB64 || activeTaskTerminal?.taskId !== taskId) {
        return;
      }
      // The production mobile terminal currently emits only alt-screen
      // mouse/scroll reports. Declare them as controls so they cannot create
      // a phantom composer draft and strand a queued logical message.
      activeTaskTerminal.subscription.sendInput?.(dataB64, false, true);
    },

    requestTaskTerminalScrollback(taskId) {
      if (activeTaskTerminal?.taskId !== taskId) {
        return;
      }
      const { taskTerminalScrollback: scrollback, taskTerminalOutput: output } =
        store.getState();
      if (
        !scrollback ||
        scrollback.loading ||
        scrollback.atClientLimit ||
        scrollback.remainingLines <= 0
      ) {
        return;
      }
      // The walk stops where the buffer would stop being contiguous. Making
      // room for an older chunk means dropping the frames directly below it —
      // a hole in the middle of the terminal — so the limit is a refusal, and
      // it is checked before the request rather than after the bytes have
      // already crossed the link.
      if (
        output.scrollbackLength + MAX_TERMINAL_SCROLLBACK_CHUNK_CHARS >
        MAX_TERMINAL_SCROLLBACK_CHARS
      ) {
        store.markTaskTerminalScrollbackAtClientLimit(taskId);
        return;
      }
      if (!store.setTaskTerminalScrollbackLoading(taskId, true)) {
        return;
      }
      activeTaskTerminal.subscription.requestScrollback?.({
        historyId: scrollback.historyId,
        beforeLine: scrollback.remainingLines,
        maxLines: TERMINAL_SCROLLBACK_CHUNK_LINES
      });
    },

    requestTaskAgentHistory(taskId) {
      if (activeTaskAgent?.taskId !== taskId) return;
      const history = store.getState().taskAgentHistory;
      if (!history || history.loading || history.beforeSeq <= history.afterSeq) {
        return;
      }
      if (!store.setTaskAgentHistoryLoading(taskId, true)) return;
      activeTaskAgent.subscription.requestHistory?.({
        beforeSeq: history.beforeSeq,
        afterSeq: history.afterSeq,
        maxEvents: 100
      });
    },

    resizeTaskTerminal(taskId, cols, rows) {
      if (
        !Number.isInteger(cols) ||
        cols <= 0 ||
        !Number.isInteger(rows) ||
        rows <= 0
      ) {
        return;
      }
      if (
        requestedTaskTerminalGeometry?.taskId === taskId &&
        requestedTaskTerminalGeometry.cols === cols &&
        requestedTaskTerminalGeometry.rows === rows
      ) {
        return;
      }
      requestedTaskTerminalGeometry = { taskId, cols, rows };
      if (activeTaskTerminal?.taskId === taskId) {
        activeTaskTerminal.subscription.resize?.(cols, rows);
      }
    },

    sendTaskAgentPermission(taskId, requestId, decision) {
      if (activeTaskAgent?.taskId !== taskId) {
        return;
      }
      activeTaskAgent.subscription.sendPermission(requestId, decision);
    },

    interruptTaskAgent(taskId) {
      if (activeTaskAgent?.taskId !== taskId) {
        return;
      }
      activeTaskAgent.subscription.interrupt();
    },

    setTaskCompanionOpen(taskId, isOpen) {
      if (activeTaskCompanion?.taskId !== taskId) return;
      activeTaskCompanion.setOpen(isOpen);
      if (isOpen) store.markTaskCompanionViewed(taskId);
    },

    sendTaskCompanionEvent(taskId, sessionId, revision, event) {
      if (activeTaskCompanion?.taskId !== taskId) return;
      const companionState = store.getState();
      if (
        companionState.taskCompanionStatus !== "available" ||
        companionState.taskCompanionSnapshot?.sessionId !== sessionId ||
        companionState.taskCompanionSnapshot.revision !== revision
      ) {
        return;
      }
      store.beginTaskCompanionEvent(taskId, event.event_id);
      if (
        !activeTaskCompanion.subscription.sendEvent(sessionId, revision, event)
      ) {
        store.applyTaskCompanionStreamEvent(
          taskId,
          { type: "connection", taskId, connected: false },
          false
        );
      }
    },

    async closeDesktopTask(taskId) {
      if (!store.beginTaskAction(taskId, "close-task")) {
        return;
      }
      try {
        await client.closeTask(taskId);
        pendingTaskIdentities.delete(taskId);
        taskCollectionsRevision += 1;
        stopTaskSession();
        await refreshTaskCollections();
        store.setSelectedTask(null);
        store.clearTaskTerminal();
        store.clearTaskAgent();
        store.clearTaskCompanion();
        setUnownedErrorMessage(null);
        reconcileSelectedTaskRead();
      } catch (error) {
        fail(error);
      } finally {
        store.finishTaskAction(taskId, "close-task");
      }
    },

    dispose() {
      taskSummaryStoreUnsubscribe();
      for (const subscription of taskSummarySubscriptions.values()) subscription.close();
      taskSummarySubscriptions.clear();
      stopTaskSession();
      stopCloudTaskSubscription();
      if (backgroundRefreshTimer) {
        clearInterval(backgroundRefreshTimer);
        backgroundRefreshTimer = null;
      }
      authUnsubscribe?.();
      authUnsubscribe = null;
      taskRoutesUnsubscribe?.();
      taskRoutesUnsubscribe = null;
      repoCommandTaskOpenListeners.clear();
    }
  };
}

function mapCreatedTask(response: CreateTaskResponse): TaskSummary {
  return {
    id: response.taskId,
    repoId: response.repoId,
    title: response.title,
    prompt: response.prompt,
    stage: response.stage,
    agentType: response.agentType ?? null
  };
}
function filterTasksForQuery(
  tasks: readonly TaskSummary[],
  query: string
): TaskSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(normalizedQuery) ||
      task.waitingPromptSnippet?.toLowerCase().includes(normalizedQuery) === true
  );
}

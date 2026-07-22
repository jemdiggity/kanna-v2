import type {
  CreateTaskResponse,
  RepoSummary,
  TaskActivity,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskSummary
} from "../lib/api/types";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskCompanionSubscription,
  TaskTerminalSubscription
} from "../lib/api/client";
import type { CompanionEvent } from "@kanna/agent-protocol";
import { TaskCreationError } from "../lib/api/client";
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
  SessionStore
} from "./sessionStore";
import type { PersistedSessionContext } from "./sessionPersistence";
import {
  buildCreatingTaskUiSlot,
  taskUiSlotForSelection,
  taskUiSlotToTaskSummary
} from "./taskUiSlots";

export interface MobileController {
  bootstrap(): Promise<void>;
  pairMachineByCode(code: string): Promise<string>;
  pairMachineByPayload(payload: string): Promise<string>;
  removeManualMachine(desktopId: string): Promise<void>;
  signInWithEmailPassword(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  refresh(): Promise<void>;
  setNavigationView(view: MobileView): void;
  setTaskDetailVisible(visible: boolean): void;
  selectDesktop(desktopId: string): Promise<void>;
  selectRepo(repoId: string): Promise<void>;
  loadRepoCommands(): Promise<void>;
  runRepoCommand(commandId: string): Promise<string | null>;
  retryRepoCommand(): Promise<string | null>;
  openTask(taskId: string): void;
  closeTask(taskId?: string): void;
  openComposer(): void;
  closeComposer(): void;
  updateComposerPrompt(prompt: string): void;
  selectComposerDesktop(desktopId: string): void;
  setComposerOptionsExpanded(isExpanded: boolean): void;
  selectComposerAgentProvider(provider: ComposerAgentProvider): void;
  searchTasks(query: string): Promise<void>;
  createTask(terminalGeometry?: MobileTerminalGeometry): Promise<string | null>;
  recoverTaskCreation(): Promise<string | null>;
  runMergeAgent(taskId: string): Promise<string | null>;
  advanceDesktopTaskStage(taskId: string): Promise<string | null>;
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
  readTaskDiff(taskId: string, request?: TaskDiffRequest): Promise<TaskDiffContent>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  sendTaskTerminalInput(taskId: string, dataB64: string): void;
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
const REPO_COMMAND_TASK_LOAD_ERROR =
  "The command launched successfully, but its task could not be loaded. Check your connection and try again.";

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
      return uuid;
    }
  } catch {
    // Some React Native runtimes expose a partial crypto shim. Try the next
    // source before falling back to the time/counter identity below.
  }

  try {
    if (cryptoObject?.getRandomValues) {
      const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to a process-local collision-resistant identity.
  }

  fallbackTaskCreationCounter = (fallbackTaskCreationCounter + 1) >>> 0;
  const timestamp = Date.now().toString(16).padStart(12, "0").slice(-12);
  const counter = fallbackTaskCreationCounter
    .toString(16)
    .padStart(8, "0")
    .slice(-8);
  let entropy = "";
  while (entropy.length < 12) {
    entropy += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  }
  return `${timestamp}${counter}${entropy.slice(0, 12)}`;
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
  let activeTaskDetailIdentity: string | null = null;
  let loadedTaskPrompt:
    | { taskId: string; routeIdentity: string; prompt: string }
    | null = null;
  let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundRefreshInFlight = false;
  let backgroundRefreshMode: "collections" | "desktops" = "collections";
  let authUnsubscribe: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let taskRoutesUnsubscribe: (() => void) | null = null;
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
  let liveRepositoryRevision = 0;
  let lastExplicitRepos: RepoSummary[] = [];
  let desktopCollectionsRevision = 0;
  let refreshDesktopsInFlight: Promise<void> | null = null;
  let ordinaryTaskCreationFlight:
    | { taskId: string; promise: Promise<string | null> }
    | null = null;
  let recoveryTaskCreationFlight:
    | { taskId: string; promise: Promise<string | null> }
    | null = null;
  let taskCreationPersistenceFlight:
    | { taskId: string; promise: Promise<void> }
    | null = null;
  let recoveryStartedTaskId: string | null = null;
  let repoCommandLoadGeneration = 0;
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
    const activities: TaskActivity[] = selectedTaskId
      ? [state.repoTasks, state.recentTasks, state.searchResults]
          .flatMap((tasks) => tasks.filter((task) => task.id === selectedTaskId))
          .map((task) => task.activity ?? "idle")
      : [];
    const activity =
      activities.length > 0 &&
      activities.every((candidate) => candidate === activities[0])
        ? activities[0]
        : null;

    return {
      taskId: selectedTaskId,
      visible:
        taskDetailVisible &&
        state.connectionState === "connected" &&
        selectedTaskId !== null,
      activities,
      activity
    };
  };

  const selectedTaskReadKey = (): string | null => {
    const { taskId, visible, activities } = selectedTaskReadState();
    const selectedTaskId = taskId;
    if (!selectedTaskId) return null;
    return `${selectedTaskId}\u0000${visible ? "visible" : "hidden"}\u0000${activities.join(",")}`;
  };

  const canMarkSelectedTaskRead = (taskId: string, generation: number) => {
    const selected = selectedTaskReadState();
    return (
      generation === markReadGeneration &&
      selected.taskId === taskId &&
      selected.visible &&
      selected.activity === "unread"
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
      void markSelectedTaskRead(taskId, generation, 1);
    }, MARK_READ_DEBOUNCE_MS);
  };

  const markSelectedTaskRead = async (
    taskId: string,
    generation: number,
    attempt: number
  ) => {
    if (!canMarkSelectedTaskRead(taskId, generation)) {
      return;
    }

    try {
      const response = await client.markTaskRead(taskId);
      if (
        !canMarkSelectedTaskRead(taskId, generation)
        || response.activity !== "idle"
      ) {
        return;
      }
      store.setTaskActivity(taskId, "idle");
      reconcileSelectedTaskRead();
    } catch {
      if (!canMarkSelectedTaskRead(taskId, generation)) return;
      if (attempt >= MARK_READ_MAX_ATTEMPTS) {
        exhaustedMarkReadGeneration = generation;
        return;
      }

      const retryDelay = MARK_READ_RETRY_BASE_MS * 2 ** (attempt - 1);
      markReadTimer = setTimeout(() => {
        markReadTimer = null;
        void markSelectedTaskRead(taskId, generation, attempt + 1);
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
    let repoId = commandState.selectedRepoId;
    if (
      !repoId ||
      commandState.runningRepoCommandId !== null ||
      commandState.pendingRepoCommandTask !== null
    ) {
      return;
    }
    const generation = ++repoCommandLoadGeneration;
    while (repoId) {
      store.setRepoCommandLoading(repoId);
      try {
        const catalog = await client.listRepoCommands(repoId);
        if (
          generation !== repoCommandLoadGeneration ||
          store.getState().selectedRepoId !== repoId
        ) {
          return;
        }
        store.setRepoCommandCatalog({ ...catalog, repoId });
        return;
      } catch (error) {
        if (
          generation !== repoCommandLoadGeneration ||
          store.getState().selectedRepoId !== repoId
        ) {
          return;
        }

        store.markRepoCommandsUnavailable(repoId);
        const nextRepo = store.getState().repos.find(
          (candidate) =>
            !store.getState().unavailableRepoCommandIds.includes(candidate.id)
        );
        if (!nextRepo) {
          store.setRepoCommandError(
            repoId,
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        taskCollectionsRevision += 1;
        store.selectRepo(nextRepo.id);
        void loadRepoTasks(nextRepo.id).catch(() => undefined);
        repoId = nextRepo.id;
      }
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
      const subscription = client.observeTaskTerminal(taskId, (event) => {
        if (generation !== taskTerminalGeneration) {
          return;
        }
        switch (event.type) {
          case "snapshot":
            store.replaceTaskTerminalSnapshot(
              streamTaskId,
              event.dataB64,
              event.cols,
              event.rows
            );
            break;
          case "output":
            store.appendTaskTerminal(streamTaskId, `${event.dataB64}\n`);
            break;
          case "exit":
            store.setTaskTerminalStatus(streamTaskId, "closed");
            break;
          case "error":
            store.setTaskTerminalError(streamTaskId, event.message);
            break;
        }
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

  const startTaskView = (taskId: string) => {
    const task = findTask(taskId);
    if (!task) {
      return;
    }
    loadSelectedTaskPrompt(taskId);
    if (task.agentType === "agent") {
      startTaskAgent(taskId);
    } else {
      stopTaskAgent();
      store.clearTaskAgent();
      startTaskTerminal(taskId);
    }
    startTaskCompanion(taskId);
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
    return true;
  };

  const loadCreatedRepoCommandTask = async (
    pendingTask: PendingRepoCommandTask
  ): Promise<boolean> => {
    try {
      const committed = await refreshTaskCollections();
      if (!committed || !findCollectionTask(pendingTask.taskId)) {
        store.setRepoCommandTaskLoadError(
          pendingTask,
          REPO_COMMAND_TASK_LOAD_ERROR
        );
        return false;
      }
    } catch {
      store.setRepoCommandTaskLoadError(
        pendingTask,
        REPO_COMMAND_TASK_LOAD_ERROR
      );
      return false;
    }

    store.resolveRepoCommandTask(pendingTask.taskId);
    setUnownedErrorMessage(null);
    return true;
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
    const reposById = new Map<string, string>();
    for (const task of tasks) {
      if (reposById.has(task.repoId)) continue;
      reposById.set(task.repoId, task.repoName?.trim() || task.repoId);
    }
    return Array.from(reposById, ([id, name]) => ({ id, name }));
  };

  const mergeReposWithTaskRepos = (
    repos: RepoSummary[],
    tasks: TaskSummary[]
  ): RepoSummary[] => {
    const mergedRepos = new Map(repos.map((repo) => [repo.id, repo.name]));
    for (const repo of reposFromTasks(tasks)) {
      if (!mergedRepos.has(repo.id)) {
        mergedRepos.set(repo.id, repo.name);
      }
    }
    return Array.from(mergedRepos, ([id, name]) => ({ id, name }));
  };

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

  const inferComposerDesktopId = (repoId: string): string | null => {
    const state = store.getState();
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

  const completeTaskCreation = (
    attempt: PendingTaskCreation,
    created: CreateTaskResponse
  ): string | null => {
    const currentState = store.getState();
    if (currentState.pendingTaskCreation?.taskId !== attempt.taskId) {
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
    store.setTaskCreationState({
      phase: "idle",
      pendingTaskCreation: null
    });
    if (taskCreationPersistenceFlight?.taskId === attempt.taskId) {
      taskCreationPersistenceFlight = null;
    }
    if (recoveryStartedTaskId === attempt.taskId) {
      recoveryStartedTaskId = null;
    }
    store.setComposerState(false, "");
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
    if (taskCreationPersistenceFlight?.taskId === attempt.taskId) {
      taskCreationPersistenceFlight = null;
    }
    store.setTaskCreationState({
      phase: "idle",
      pendingTaskCreation: null
    });
    store.removeTaskUiSlot(attempt.slotId);
    if (store.getState().selectedTaskId === attempt.slotId) {
      stopTaskSession();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
    }
    if (recoveryStartedTaskId === attempt.taskId) {
      recoveryStartedTaskId = null;
    }
    setUnownedErrorMessage(message);
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
      await refreshDesktops({ force: true });
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
      await refreshDesktops({ force: true });
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

    async refresh() {
      store.setRefreshStatus("refreshing");
      if (store.getState().selectedTaskId) {
        stopTaskSession();
      }
      await this.bootstrap();
      store.setRefreshStatus(
        store.getState().connectionState === "error" ? "error" : "updated"
      );
    },

    setNavigationView(view) {
      store.setActiveView(view);
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
      reconcileSelectedTaskRead();
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
      if (
        state.runningRepoCommandId !== null ||
        state.pendingRepoCommandTask !== null
      ) {
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
        fail(error);
        reloadCatalog = isStaleRepoCommandError(error);
      } finally {
        store.finishRepoCommandRun(commandId);
      }
      if (reloadCatalog) {
        await loadRepoCommands();
      }
      return openedTaskId;
    },

    async retryRepoCommand() {
      const pendingTask = store.beginRepoCommandTaskRefresh();
      if (!pendingTask) {
        if (!store.getState().pendingRepoCommandTask) {
          store.resetRepoCommandAvailability();
          await loadRepoCommands();
        }
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
      return openedTaskId;
    },

    openTask(taskId) {
      taskCollectionsRevision += 1;
      const slot = taskUiSlotForSelection(store.getState().taskUiSlots, taskId);
      const selectionId = slot?.slotId ?? taskId;
      const durableTaskId = slot?.taskId ?? findCollectionTask(taskId)?.id ?? null;
      store.setSelectedTask(selectionId);
      reconcileSelectedTaskRead();
      if (durableTaskId) {
        startTaskView(durableTaskId);
      }
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
      const pendingTaskCreation = state.pendingTaskCreation;
      if (pendingTaskCreation) {
        store.setSelectedTask(pendingTaskCreation.slotId);
        return;
      }
      const selectedRepoId = state.selectedRepoId;
      const profile = selectedRepoId
        ? state.repoCreationProfiles.find((candidate) => candidate.repoId === selectedRepoId)
        : null;
      const composerDesktopId =
        profile
          ? resolveKnownDesktopId(profile.desktopId)
          : selectedRepoId
            ? inferComposerDesktopId(selectedRepoId)
            : null;

      store.setComposerRepo(selectedRepoId);
      store.setComposerDesktop(composerDesktopId);
      store.setComposerAgentProvider(profile?.agentProvider ?? "claude");
      store.setComposerOptionsExpanded(!composerDesktopId);
      store.setComposerState(true, state.composerPrompt);
    },

    closeComposer() {
      const state = store.getState();
      if (state.pendingTaskCreation) {
        store.setComposerState(false, state.composerPrompt);
        return;
      }
      store.setComposerState(false, "");
    },

    updateComposerPrompt(prompt) {
      if (store.getState().pendingTaskCreation) {
        return;
      }
      store.setComposerState(store.getState().isComposerOpen, prompt);
    },

    selectComposerDesktop(desktopId) {
      if (store.getState().pendingTaskCreation) {
        return;
      }
      store.setComposerDesktop(desktopId);
    },

    setComposerOptionsExpanded(isExpanded) {
      if (store.getState().pendingTaskCreation) {
        return;
      }
      store.setComposerOptionsExpanded(isExpanded);
    },

    selectComposerAgentProvider(provider) {
      if (store.getState().pendingTaskCreation) {
        return;
      }
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

    createTask(terminalGeometry) {
      const state = store.getState();
      if (state.pendingTaskCreation) {
        if (
          ordinaryTaskCreationFlight?.taskId ===
          state.pendingTaskCreation.taskId
        ) {
          return ordinaryTaskCreationFlight.promise;
        }
        return Promise.resolve(null);
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
        agentProvider: state.composerAgentProvider,
        terminalCols: cols,
        terminalRows: rows
      };
      recoveryStartedTaskId = null;
      store.setComposerRepo(attempt.repoId);
      store.setTaskCreationState({
        phase: "pending",
        pendingTaskCreation: attempt
      });
      store.addTaskUiSlot(buildCreatingTaskUiSlot(attempt));
      store.setSelectedTask(attempt.slotId);
      store.setComposerState(false, attempt.prompt);
      store.setComposerErrorMessage(null);
      let persistenceReady: Promise<void>;
      try {
        persistenceReady =
          options.persistSessionContext?.() ?? Promise.resolve();
      } catch (error) {
        persistenceReady = Promise.reject(error);
      }
      taskCreationPersistenceFlight = {
        taskId: attempt.taskId,
        promise: persistenceReady
      };
      let taskCreationPromise!: Promise<string | null>;
      taskCreationPromise = (async () => {
        let requestDispatched = false;
        try {
          await persistenceReady;
          requestDispatched = true;
          const created = await submitFrozenTaskCreation(attempt);
          return completeTaskCreation(attempt, created);
        } catch (error) {
          const currentAttempt = store.getState().pendingTaskCreation;
          if (currentAttempt?.taskId !== attempt.taskId) {
            return null;
          }
          if (recoveryStartedTaskId === attempt.taskId) {
            return null;
          }
          const message =
            error instanceof Error ? error.message : "Task creation failed";
          if (
            !requestDispatched ||
            (error instanceof TaskCreationError && error.outcome === "not-created")
          ) {
            failTaskCreationDefinitely(attempt, message);
          } else {
            store.setTaskCreationState({
              phase: "uncertain",
              pendingTaskCreation: attempt
            });
          }
          store.setComposerErrorMessage(message);
          return null;
        }
      })().finally(() => {
        if (ordinaryTaskCreationFlight?.promise === taskCreationPromise) {
          ordinaryTaskCreationFlight = null;
        }
      });
      ordinaryTaskCreationFlight = {
        taskId: attempt.taskId,
        promise: taskCreationPromise
      };
      return taskCreationPromise;
    },

    recoverTaskCreation() {
      const attempt = store.getState().pendingTaskCreation;
      if (!attempt) {
        return Promise.resolve(null);
      }
      if (recoveryTaskCreationFlight?.taskId === attempt.taskId) {
        return recoveryTaskCreationFlight.promise;
      }

      const persistenceReady =
        taskCreationPersistenceFlight?.taskId === attempt.taskId
          ? taskCreationPersistenceFlight.promise
          : Promise.resolve();
      store.setTaskCreationState({
        phase: "recovering",
        pendingTaskCreation: attempt
      });
      store.setComposerErrorMessage(null);
      let recoveryPromise!: Promise<string | null>;
      recoveryPromise = (async () => {
        let requestDispatched = false;
        try {
          await persistenceReady;
          if (
            store.getState().pendingTaskCreation?.taskId !== attempt.taskId
          ) {
            return null;
          }
          recoveryStartedTaskId = attempt.taskId;
          requestDispatched = true;
          const created = await submitFrozenTaskCreation(attempt);
          return completeTaskCreation(attempt, created);
        } catch (error) {
          if (
            store.getState().pendingTaskCreation?.taskId !== attempt.taskId
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
          store.setTaskCreationState({
            phase: "uncertain",
            pendingTaskCreation: attempt
          });
          store.setComposerErrorMessage(message);
          return null;
        }
      })().finally(() => {
        if (recoveryTaskCreationFlight?.promise === recoveryPromise) {
          recoveryTaskCreationFlight = null;
        }
      });
      recoveryTaskCreationFlight = {
        taskId: attempt.taskId,
        promise: recoveryPromise
      };
      return recoveryPromise;
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

    readTaskDiff(taskId, request) {
      return client.readTaskDiff(taskId, request);
    },

    async sendTaskInput(taskId, input) {
      const submittedInput = input.trim();
      if (!submittedInput) {
        return;
      }

      try {
        const task = findTask(taskId);
        if (task?.agentType === "agent" && activeTaskAgent?.taskId === taskId) {
          activeTaskAgent.subscription.sendInput(submittedInput);
        } else {
          await client.sendTaskInput(taskId, submittedInput);
        }
        setUnownedErrorMessage(null);
      } catch (error) {
        fail(error);
      }
    },

    sendTaskTerminalInput(taskId, dataB64) {
      if (!dataB64 || activeTaskTerminal?.taskId !== taskId) {
        return;
      }
      activeTaskTerminal.subscription.sendInput?.(dataB64);
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

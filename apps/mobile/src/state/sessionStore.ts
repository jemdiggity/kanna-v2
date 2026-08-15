import type {
  DesktopMode,
  DesktopSummary,
  TaskActivity,
  TaskSummary,
  RepoSummary,
  RepoCommandCatalog,
} from "../lib/api/types";
import type {
  AgentProvider,
  FrameAgentEvent
} from "@kanna/agent-protocol";
import {
  initialCompanionState,
  reduceCompanionState,
  type CompanionAction,
  type CompanionEventStatus,
  type CompanionSnapshot,
  type CompanionState,
  type CompanionStatus
} from "@kanna/visual-companion";
import type { TaskCompanionStreamEvent } from "../lib/api/client";
import type { MobileAuthState } from "../lib/firebase/auth";
import type {
  PersistedSessionContext,
  RepoCreationProfile,
  TrustedDesktopRecord
} from "./sessionPersistence";
import {
  acknowledgeTaskUiSlot as acknowledgeTaskUiSlotState,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots as reconcileTaskUiSlotsState,
  removeTaskUiSlot as removeTaskUiSlotState,
  taskUiSlotForSelection,
  type TaskUiSlot
} from "./taskUiSlots";
import {
  appendTerminalOutput,
  createTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  type TerminalOutputBuffer
} from "./terminalOutputBuffer";

// Terminal output is accumulated as newline-delimited base64 frames and replayed
// into xterm.js on WebView (re)mount. The first frame is the full attachment
// snapshot and must survive intact; only subsequent live frames are bounded.
// Always evict at frame boundaries so replay never receives partial base64.
// The segmented buffer keeps completed ranges by reference. A live append
// copies at most one 64 KiB segment instead of the full retained megabyte,
// while outputStart preserves the authoritative logical cursor across eviction.

export type ConnectionState = "idle" | "connecting" | "connected" | "error";
export type MobileView = "tasks" | "recent" | "search" | "desktops" | "more";
export type TaskTerminalStatus = "idle" | "connecting" | "live" | "closed" | "error";
export type TaskCompanionStatus = CompanionStatus;
export type TaskCompanionEventStatus = CompanionEventStatus;
export type RefreshStatus = "idle" | "refreshing" | "updated" | "error";
export type TaskCollectionStatus = "loading" | "ready" | "error";
export type AuthState = MobileAuthState;
export type ComposerAgentProvider = AgentProvider;
export type TaskCreationPhase = "idle" | "pending" | "recovering" | "uncertain";
export type RepoCommandStatus = "idle" | "loading" | "ready" | "error";

export interface PendingRepoCommandTask {
  commandId: string;
  taskId: string;
}

export interface PendingTaskCreation {
  slotId: string;
  taskId: string;
  repoId: string;
  prompt: string;
  desktopId: string;
  agentProvider: ComposerAgentProvider;
  terminalCols?: number;
  terminalRows?: number;
}

export type ActiveTaskCreationPhase = Exclude<TaskCreationPhase, "idle">;

export type TaskCreationAction = "close-task";

export interface TaskCreationAttempt extends PendingTaskCreation {
  phase: ActiveTaskCreationPhase;
  pendingAction: TaskCreationAction | null;
  errorMessage: string | null;
}

type TaskCreationAttemptInput =
  Omit<TaskCreationAttempt, "pendingAction" | "errorMessage"> &
  Partial<Pick<TaskCreationAttempt, "pendingAction" | "errorMessage">>;

export type TaskCreationState =
  | { phase: "idle"; pendingTaskCreation: null }
  | {
      phase: Exclude<TaskCreationPhase, "idle">;
      pendingTaskCreation: PendingTaskCreation;
    };

export type TaskStageAction = "advance-stage" | "close-task";

export interface PendingTaskAction {
  taskId: string;
  action: TaskStageAction;
}

export interface SessionState {
  mobileDeviceId: string | null;
  connectionMode: DesktopMode | null;
  connectionState: ConnectionState;
  desktopId: string | null;
  desktopName: string | null;
  serverStatus: string | null;
  errorMessage: string | null;
  refreshStatus: RefreshStatus;
  taskCollectionStatus: TaskCollectionStatus;
  auth: AuthState;
  desktops: DesktopSummary[];
  accountDesktops: DesktopSummary[];
  liveLanDesktops: DesktopSummary[];
  trustedDesktops: TrustedDesktopRecord[];
  machineSourceWarnings: { account: string | null; local: string | null };
  repoCreationProfiles: RepoCreationProfile[];
  selectedDesktopId: string | null;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  repoTasks: TaskSummary[];
  repoCommandCatalog: RepoCommandCatalog | null;
  repoCommandStatus: RepoCommandStatus;
  repoCommandErrorMessage: string | null;
  runningRepoCommandId: string | null;
  pendingRepoCommandTask: PendingRepoCommandTask | null;
  unavailableRepoCommandIds: string[];
  recentTasks: TaskSummary[];
  searchQuery: string;
  searchResults: TaskSummary[];
  selectedTaskId: string | null;
  pendingTaskAction: PendingTaskAction | null;
  activeView: MobileView;
  pairingCode: string | null;
  isComposerOpen: boolean;
  composerPrompt: string;
  composerRepoId: string | null;
  composerDesktopId: string | null;
  composerAgentProvider: ComposerAgentProvider;
  isComposerOptionsExpanded: boolean;
  composerErrorMessage: string | null;
  taskCreationAttempts: TaskCreationAttempt[];
  /** Compatibility projection for callers not yet migrated to per-slot attempts. */
  pendingTaskCreation: PendingTaskCreation | null;
  taskCreationPhase: TaskCreationPhase;
  taskUiSlots: TaskUiSlot[];
  taskTerminalTaskId: string | null;
  taskTerminalStatus: TaskTerminalStatus;
  taskTerminalOutput: TerminalOutputBuffer;
  taskTerminalOutputEpoch: number;
  taskTerminalOutputStart: number;
  taskTerminalCols: number | null;
  taskTerminalRows: number | null;
  taskTerminalErrorMessage: string | null;
  taskAgentTaskId: string | null;
  taskAgentStatus: TaskTerminalStatus;
  taskAgentEvents: FrameAgentEvent[];
  taskAgentErrorMessage: string | null;
  taskCompanionTaskId: string | null;
  taskCompanionStatus: TaskCompanionStatus;
  taskCompanionSnapshot: CompanionSnapshot | null;
  taskCompanionUnread: boolean;
  taskCompanionErrorMessage: string | null;
  taskCompanionEventId: string | null;
  taskCompanionEventStatus: TaskCompanionEventStatus;
}

export interface TaskTerminalOutputSnapshot {
  taskId: string | null;
  output: TerminalOutputBuffer;
  outputEpoch: number;
  outputStart: number;
  status: TaskTerminalStatus;
}

export interface TaskTerminalOutputSource {
  getSnapshot(): TaskTerminalOutputSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface SessionStore {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  taskTerminalOutputSource: TaskTerminalOutputSource;
  getPersistedContext(): PersistedSessionContext;
  hydrateContext(context: PersistedSessionContext): void;
  ensureMobileDeviceId(generate: () => string): string;
  setConnectionMode(mode: DesktopMode | null): void;
  setConnectionState(state: ConnectionState): void;
  setDesktopStatus(status: string | null, desktopName: string | null, pairingCode: string | null, desktopId?: string | null): void;
  setErrorMessage(message: string | null): void;
  setRefreshStatus(status: RefreshStatus): void;
  setTaskCollectionStatus(status: TaskCollectionStatus): void;
  setAuthState(auth: AuthState): void;
  setDesktops(desktops: DesktopSummary[]): void;
  setMachineSourceDesktops(sources: {
    account: DesktopSummary[];
    local: DesktopSummary[];
  }): void;
  setTrustedDesktops(desktops: TrustedDesktopRecord[]): void;
  upsertTrustedDesktop(desktop: TrustedDesktopRecord): void;
  removeTrustedDesktop(desktopId: string): void;
  setMachineSourceWarnings(warnings: {
    account: string | null;
    local: string | null;
  }): void;
  upsertRepoCreationProfile(profile: RepoCreationProfile): void;
  selectDesktop(desktopId: string): void;
  setRepos(repos: RepoSummary[]): void;
  selectRepo(repoId: string): void;
  setRepoTasks(tasks: TaskSummary[]): void;
  setRepoCommandLoading(repoId: string): void;
  setRepoCommandCatalog(catalog: RepoCommandCatalog): void;
  setRepoCommandError(repoId: string, message: string): void;
  beginRepoCommandRun(commandId: string): boolean;
  setRepoCommandTaskLoadError(
    task: PendingRepoCommandTask,
    message: string
  ): void;
  beginRepoCommandTaskRefresh(): PendingRepoCommandTask | null;
  resolveRepoCommandTask(taskId: string): void;
  finishRepoCommandRun(commandId: string): void;
  markRepoCommandsUnavailable(repoId: string): void;
  resetRepoCommandAvailability(): void;
  setRecentTasks(tasks: TaskSummary[]): void;
  setSearchResults(query: string, results: TaskSummary[]): void;
  setTaskActivity(
    taskId: string,
    activity: TaskActivity,
    activityRevision?: number
  ): void;
  setTaskPinState(
    taskId: string,
    pinned: boolean,
    pinOrder: number | null
  ): void;
  setTaskPrompt(taskId: string, prompt: string): void;
  setSelectedTask(taskId: string | null): void;
  beginTaskAction(taskId: string, action: TaskStageAction): boolean;
  finishTaskAction(taskId: string, action: TaskStageAction): void;
  retagTaskIdentity(
    previousTaskId: string,
    nextTaskId: string,
    options?: { preserveSelection?: boolean }
  ): void;
  setActiveView(view: MobileView): void;
  setPairingCode(code: string | null): void;
  setComposerState(isOpen: boolean, prompt: string): void;
  setComposerRepo(repoId: string | null): void;
  setComposerDesktop(desktopId: string | null): void;
  setComposerAgentProvider(provider: ComposerAgentProvider): void;
  setComposerOptionsExpanded(isExpanded: boolean): void;
  setComposerErrorMessage(message: string | null): void;
  setTaskCreationState(taskCreationState: TaskCreationState): void;
  addTaskCreationAttempt(attempt: TaskCreationAttemptInput): void;
  setTaskCreationAttemptPhase(
    slotId: string,
    phase: ActiveTaskCreationPhase
  ): void;
  beginTaskCreationAction(
    slotId: string,
    action: TaskCreationAction
  ): boolean;
  finishTaskCreationAction(
    slotId: string,
    action: TaskCreationAction
  ): void;
  setTaskCreationAttemptError(
    slotId: string,
    message: string | null
  ): void;
  removeTaskCreationAttempt(slotId: string): void;
  addTaskUiSlot(slot: TaskUiSlot): void;
  acknowledgeTaskUiSlot(slotId: string, task: TaskSummary): void;
  reconcileTaskUiSlots(
    tasks: readonly TaskSummary[],
    options?: { authoritative?: boolean }
  ): void;
  removeTaskUiSlot(slotId: string): void;
  beginTaskTerminal(taskId: string, initialOutput: string): void;
  replaceTaskTerminalSnapshot(taskId: string, dataB64: string, cols: number, rows: number): void;
  appendTaskTerminal(taskId: string, chunk: string): void;
  setTaskTerminalStatus(taskId: string, status: TaskTerminalStatus): void;
  setTaskTerminalDims(taskId: string, cols: number, rows: number): void;
  setTaskTerminalError(taskId: string, message: string): void;
  beginTaskAgent(taskId: string): void;
  applyTaskAgentStreamEvent(taskId: string, event: { type: "snapshot"; events: FrameAgentEvent[] } | { type: "event"; seq: number; event: FrameAgentEvent["event"] } | { type: "status"; status: string } | { type: "exit"; code: number } | { type: "error"; message: string }): void;
  beginTaskCompanion(taskId: string): void;
  applyTaskCompanionStreamEvent(
    taskId: string,
    event: TaskCompanionStreamEvent,
    isOpen: boolean
  ): void;
  markTaskCompanionViewed(taskId: string): void;
  beginTaskCompanionEvent(taskId: string, eventId: string): void;
  reconcileSelectedTask(): void;
  clearTaskTerminal(): void;
  clearTaskAgent(): void;
  clearTaskCompanion(): void;
}

export function createSessionStore(): SessionStore {
  let state: SessionState = {
    mobileDeviceId: null,
    connectionMode: null,
    connectionState: "idle",
    desktopId: null,
    desktopName: null,
    serverStatus: null,
    errorMessage: null,
    refreshStatus: "idle",
    taskCollectionStatus: "loading",
    auth: { status: "signedOut" },
    desktops: [],
    accountDesktops: [],
    liveLanDesktops: [],
    trustedDesktops: [],
    machineSourceWarnings: { account: null, local: null },
    repoCreationProfiles: [],
    selectedDesktopId: null,
    repos: [],
    selectedRepoId: null,
    repoTasks: [],
    repoCommandCatalog: null,
    repoCommandStatus: "idle",
    repoCommandErrorMessage: null,
    runningRepoCommandId: null,
    pendingRepoCommandTask: null,
    unavailableRepoCommandIds: [],
    recentTasks: [],
    searchQuery: "",
    searchResults: [],
    selectedTaskId: null,
    pendingTaskAction: null,
    activeView: "tasks",
    pairingCode: null,
    isComposerOpen: false,
    composerPrompt: "",
    composerRepoId: null,
    composerDesktopId: null,
    composerAgentProvider: "claude",
    isComposerOptionsExpanded: true,
    composerErrorMessage: null,
    taskCreationAttempts: [],
    pendingTaskCreation: null,
    taskCreationPhase: "idle",
    taskUiSlots: [],
    taskTerminalTaskId: null,
    taskTerminalStatus: "idle",
    taskTerminalOutput: EMPTY_TERMINAL_OUTPUT,
    taskTerminalOutputEpoch: 0,
    taskTerminalOutputStart: 0,
    taskTerminalCols: null,
    taskTerminalRows: null,
    taskTerminalErrorMessage: null,
    taskAgentTaskId: null,
    taskAgentStatus: "idle",
    taskAgentEvents: [],
    taskAgentErrorMessage: null,
    taskCompanionTaskId: null,
    taskCompanionStatus: "idle",
    taskCompanionSnapshot: null,
    taskCompanionUnread: false,
    taskCompanionErrorMessage: null,
    taskCompanionEventId: null,
    taskCompanionEventStatus: "idle"
  };

  const listeners = new Set<() => void>();
  const terminalOutputListeners = new Set<() => void>();
  let terminalOutputSnapshot: TaskTerminalOutputSnapshot = {
    taskId: state.taskTerminalTaskId,
    output: state.taskTerminalOutput,
    outputEpoch: state.taskTerminalOutputEpoch,
    outputStart: state.taskTerminalOutputStart,
    status: state.taskTerminalStatus
  };
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const publishTerminalOutput = () => {
    terminalOutputSnapshot = {
      taskId: state.taskTerminalTaskId,
      output: state.taskTerminalOutput,
      outputEpoch: state.taskTerminalOutputEpoch,
      outputStart: state.taskTerminalOutputStart,
      status: state.taskTerminalStatus
    };
    for (const listener of terminalOutputListeners) {
      listener();
    }
  };
  const currentCompanionState = (): CompanionState => ({
    status: state.taskCompanionStatus,
    snapshot: state.taskCompanionSnapshot,
    unread: state.taskCompanionUnread,
    errorMessage: state.taskCompanionErrorMessage,
    eventId: state.taskCompanionEventId,
    eventStatus: state.taskCompanionEventStatus
  });
  const applyCompanionAction = (action: CompanionAction): boolean => {
    const current = currentCompanionState();
    const next = reduceCompanionState(current, action);
    if (next === current) return false;
    state = {
      ...state,
      taskCompanionStatus: next.status,
      taskCompanionSnapshot: next.snapshot,
      taskCompanionUnread: next.unread,
      taskCompanionErrorMessage: next.errorMessage,
      taskCompanionEventId: next.eventId,
      taskCompanionEventStatus: next.eventStatus
    };
    return true;
  };
  const areTaskIdListsEqual = (
    left: readonly string[] | undefined,
    right: readonly string[] | undefined
  ) => {
    const leftIds = left ?? [];
    const rightIds = right ?? [];
    return (
      leftIds.length === rightIds.length &&
      leftIds.every((id, index) => id === rightIds[index])
    );
  };
  const areTaskListsEqual = (
    left: readonly TaskSummary[],
    right: readonly TaskSummary[]
  ) => {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((task, index) => {
      const other = right[index];
      return (
        task.id === other.id &&
        task.repoId === other.repoId &&
        task.title === other.title &&
        (task.prompt ?? null) === (other.prompt ?? null) &&
        task.stage === other.stage &&
        (task.createdAt ?? null) === (other.createdAt ?? null) &&
        (task.activity ?? "idle") === (other.activity ?? "idle") &&
        (task.activityRevision ?? null) ===
          (other.activityRevision ?? null) &&
        (task.waitingPromptSnippet ?? null) ===
          (other.waitingPromptSnippet ?? null) &&
        (task.agentType ?? null) === (other.agentType ?? null) &&
        (task.parentTaskId ?? null) === (other.parentTaskId ?? null) &&
        areTaskIdListsEqual(task.blockedByTaskIds, other.blockedByTaskIds)
      );
    });
  };
  const dedupeTasksById = (tasks: readonly TaskSummary[]): TaskSummary[] => {
    const seen = new Set<string>();
    const uniqueTasks: TaskSummary[] = [];
    for (const task of tasks) {
      if (seen.has(task.id)) {
        continue;
      }
      seen.add(task.id);
      uniqueTasks.push(task);
    }
    return uniqueTasks;
  };
  const preserveNewerTaskActivities = (
    currentTasks: readonly TaskSummary[],
    incomingTasks: readonly TaskSummary[]
  ): TaskSummary[] => {
    const currentById = new Map(currentTasks.map((task) => [task.id, task]));
    return incomingTasks.map((task) => {
      const current = currentById.get(task.id);
      if (
        current?.activityRevision === undefined ||
        task.activityRevision === undefined ||
        task.activityRevision >= current.activityRevision
      ) {
        return task;
      }
      return {
        ...task,
        activity: current.activity,
        activityRevision: current.activityRevision
      };
    });
  };
  const hasTaskInCollections = (taskId: string | null) => {
    if (!taskId) {
      return false;
    }

    return (
      state.repoTasks.some((task) => task.id === taskId) ||
      state.recentTasks.some((task) => task.id === taskId) ||
      state.searchResults.some((task) => task.id === taskId)
    );
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    taskTerminalOutputSource: {
      getSnapshot: () => terminalOutputSnapshot,
      subscribe(listener) {
        terminalOutputListeners.add(listener);
        return () => {
          terminalOutputListeners.delete(listener);
        };
      }
    },
    getPersistedContext() {
      const selectedSlot = taskUiSlotForSelection(
        state.taskUiSlots,
        state.selectedTaskId
      );
      return {
        mobileDeviceId: state.mobileDeviceId,
        selectedDesktopId: state.selectedDesktopId,
        selectedRepoId: state.selectedRepoId,
        selectedTaskId:
          selectedSlot?.state === "ready"
            ? selectedSlot.taskId
            : state.selectedTaskId,
        activeView: state.activeView,
        authUser: state.auth.status === "signedIn" ? state.auth.user : null,
        trustedDesktops: state.trustedDesktops,
        repoCreationProfiles: state.repoCreationProfiles,
        taskCreationAttempts: state.taskCreationAttempts.map(
          ({
            phase: _phase,
            pendingAction: _pendingAction,
            errorMessage: _errorMessage,
            ...attempt
          }) => attempt
        )
      };
    },
    hydrateContext(context) {
      const persistedAttempts =
        context.taskCreationAttempts ??
        (context.pendingTaskCreation ? [context.pendingTaskCreation] : []);
      const taskCreationAttempts: TaskCreationAttempt[] =
        persistedAttempts.map((attempt) => ({
          ...attempt,
          phase: "uncertain",
          pendingAction: null,
          errorMessage: null
        }));
      const pendingTaskCreation = taskCreationAttempts[0] ?? null;
      const selectedTaskId =
        taskCreationAttempts.find(
          (attempt) =>
            context.selectedTaskId === attempt.taskId ||
            context.selectedTaskId === attempt.slotId
        )?.slotId ?? context.selectedTaskId;
      state = {
        ...state,
        mobileDeviceId: context.mobileDeviceId,
        selectedDesktopId: context.selectedDesktopId,
        selectedRepoId: context.selectedRepoId,
        selectedTaskId,
        activeView: context.activeView,
        auth: context.authUser
          ? { status: "signedIn", user: context.authUser }
          : state.auth,
        trustedDesktops: context.trustedDesktops ?? [],
        repoCreationProfiles: context.repoCreationProfiles ?? [],
        isComposerOpen: false,
        composerPrompt: "",
        composerRepoId: null,
        composerDesktopId: null,
        composerAgentProvider: "claude",
        composerErrorMessage: null,
        taskCreationAttempts,
        pendingTaskCreation,
        taskCreationPhase: pendingTaskCreation ? "uncertain" : "idle",
        taskUiSlots: [
          ...taskCreationAttempts.map(buildCreatingTaskUiSlot),
          ...state.taskUiSlots.filter(
            (slot) =>
              !taskCreationAttempts.some(
                (attempt) => attempt.slotId === slot.slotId
              )
          )
        ]
      };
      publish();
    },
    ensureMobileDeviceId(generate) {
      if (state.mobileDeviceId) {
        return state.mobileDeviceId;
      }

      const mobileDeviceId = generate().trim();
      if (!mobileDeviceId) {
        throw new Error("Mobile device ID generator returned an empty value.");
      }
      state = { ...state, mobileDeviceId };
      publish();
      return mobileDeviceId;
    },
    setConnectionMode(mode) {
      state = { ...state, connectionMode: mode };
      publish();
    },
    setConnectionState(connectionState) {
      state = { ...state, connectionState };
      publish();
    },
    setDesktopStatus(serverStatus, desktopName, pairingCode, desktopId = state.desktopId) {
      state = { ...state, serverStatus, desktopName, pairingCode, desktopId };
      publish();
    },
    setErrorMessage(errorMessage) {
      state = { ...state, errorMessage };
      publish();
    },
    setRefreshStatus(refreshStatus) {
      state = { ...state, refreshStatus };
      publish();
    },
    setTaskCollectionStatus(taskCollectionStatus) {
      state = { ...state, taskCollectionStatus };
      publish();
    },
    setAuthState(auth) {
      state = { ...state, auth };
      publish();
    },
    setDesktops(desktops) {
      const hasSelectedDesktop = desktops.some(
        (desktop) => desktop.id === state.selectedDesktopId
      );
      state = {
        ...state,
        desktops,
        selectedDesktopId: hasSelectedDesktop
          ? state.selectedDesktopId
          : desktops[0]?.id ?? null
      };
      publish();
    },
    setMachineSourceDesktops({ account, local }) {
      state = {
        ...state,
        accountDesktops: account,
        liveLanDesktops: local
      };
      publish();
    },
    setTrustedDesktops(trustedDesktops) {
      state = { ...state, trustedDesktops };
      publish();
    },
    upsertTrustedDesktop(desktop) {
      const existing = state.trustedDesktops.find(
        (candidate) => candidate.desktopId === desktop.desktopId
      );
      const trustedDesktops = existing
        ? state.trustedDesktops.map((candidate) =>
            candidate.desktopId === desktop.desktopId
              ? mergeTrustedDesktop(candidate, desktop)
              : candidate
          )
        : [desktop, ...state.trustedDesktops];

      if (areTrustedDesktopListsEqual(state.trustedDesktops, trustedDesktops)) {
        return;
      }

      state = { ...state, trustedDesktops };
      publish();
    },
    removeTrustedDesktop(desktopId) {
      const trustedDesktops = state.trustedDesktops.filter(
        (desktop) => desktop.desktopId !== desktopId
      );
      if (trustedDesktops.length === state.trustedDesktops.length) {
        return;
      }
      state = { ...state, trustedDesktops };
      publish();
    },
    setMachineSourceWarnings(machineSourceWarnings) {
      if (
        state.machineSourceWarnings.account === machineSourceWarnings.account &&
        state.machineSourceWarnings.local === machineSourceWarnings.local
      ) {
        return;
      }
      state = { ...state, machineSourceWarnings };
      publish();
    },
    upsertRepoCreationProfile(profile) {
      const existing = state.repoCreationProfiles.find(
        (candidate) => candidate.repoId === profile.repoId
      );
      const repoCreationProfiles = existing
        ? state.repoCreationProfiles.map((candidate) =>
            candidate.repoId === profile.repoId ? profile : candidate
          )
        : [profile, ...state.repoCreationProfiles];

      state = { ...state, repoCreationProfiles };
      publish();
    },
    selectDesktop(desktopId) {
      state = {
        ...state,
        selectedDesktopId: desktopId
      };
      publish();
    },
    setRepos(repos) {
      const hasSelectedRepo = repos.some((repo) => repo.id === state.selectedRepoId);
      const repoSelectionLocked =
        state.runningRepoCommandId !== null || state.pendingRepoCommandTask !== null;
      const selectedRepoId =
        hasSelectedRepo || repoSelectionLocked
          ? state.selectedRepoId
          : repos[0]?.id ?? null;
      const repoChanged = selectedRepoId !== state.selectedRepoId;
      state = {
        ...state,
        repos,
        selectedRepoId,
        ...(repoChanged
          ? {
              repoCommandCatalog: null,
              repoCommandStatus: "idle" as const,
              repoCommandErrorMessage: null,
              pendingRepoCommandTask: null
            }
          : {})
      };
      publish();
    },
    selectRepo(repoId) {
      if (
        repoId === state.selectedRepoId ||
        state.runningRepoCommandId !== null ||
        state.pendingRepoCommandTask !== null
      ) {
        return;
      }
      state = {
        ...state,
        selectedRepoId: repoId,
        repoCommandCatalog: null,
        repoCommandStatus: "idle",
        repoCommandErrorMessage: null,
        pendingRepoCommandTask: null
      };
      publish();
    },
    setRepoTasks(repoTasks) {
      const uniqueTasks = preserveNewerTaskActivities(
        state.repoTasks,
        dedupeTasksById(repoTasks)
      );
      if (areTaskListsEqual(state.repoTasks, uniqueTasks)) {
        return;
      }

      state = {
        ...state,
        repoTasks: uniqueTasks
      };
      publish();
    },
    setRepoCommandLoading(repoId) {
      if (
        state.selectedRepoId !== repoId ||
        state.runningRepoCommandId !== null ||
        state.pendingRepoCommandTask !== null
      ) return;
      state = {
        ...state,
        repoCommandCatalog: null,
        repoCommandStatus: "loading",
        repoCommandErrorMessage: null
      };
      publish();
    },
    setRepoCommandCatalog(repoCommandCatalog) {
      if (
        state.selectedRepoId !== repoCommandCatalog.repoId ||
        state.runningRepoCommandId !== null ||
        state.pendingRepoCommandTask !== null
      ) return;
      const unavailableRepoCommandIds = state.unavailableRepoCommandIds.filter(
        (repoId) => repoId !== repoCommandCatalog.repoId
      );
      state = {
        ...state,
        repoCommandCatalog,
        repoCommandStatus: "ready",
        repoCommandErrorMessage: null,
        unavailableRepoCommandIds
      };
      publish();
    },
    setRepoCommandError(repoId, repoCommandErrorMessage) {
      if (
        state.selectedRepoId !== repoId ||
        state.runningRepoCommandId !== null ||
        state.pendingRepoCommandTask !== null
      ) return;
      state = {
        ...state,
        repoCommandCatalog: null,
        repoCommandStatus: "error",
        repoCommandErrorMessage
      };
      publish();
    },
    beginRepoCommandRun(runningRepoCommandId) {
      if (state.runningRepoCommandId || state.pendingRepoCommandTask) return false;
      state = { ...state, runningRepoCommandId };
      publish();
      return true;
    },
    setRepoCommandTaskLoadError(pendingRepoCommandTask, repoCommandErrorMessage) {
      state = {
        ...state,
        pendingRepoCommandTask,
        repoCommandStatus: "error",
        repoCommandErrorMessage
      };
      publish();
    },
    beginRepoCommandTaskRefresh() {
      if (state.runningRepoCommandId || !state.pendingRepoCommandTask) {
        return null;
      }
      state = {
        ...state,
        runningRepoCommandId: state.pendingRepoCommandTask.commandId
      };
      publish();
      return state.pendingRepoCommandTask;
    },
    resolveRepoCommandTask(taskId) {
      if (state.pendingRepoCommandTask?.taskId !== taskId) return;
      state = {
        ...state,
        pendingRepoCommandTask: null,
        repoCommandStatus: state.repoCommandCatalog ? "ready" : "idle",
        repoCommandErrorMessage: null
      };
      publish();
    },
    finishRepoCommandRun(commandId) {
      if (state.runningRepoCommandId !== commandId) return;
      state = { ...state, runningRepoCommandId: null };
      publish();
    },
    markRepoCommandsUnavailable(repoId) {
      if (state.unavailableRepoCommandIds.includes(repoId)) return;
      state = {
        ...state,
        unavailableRepoCommandIds: [...state.unavailableRepoCommandIds, repoId]
      };
      publish();
    },
    resetRepoCommandAvailability() {
      if (state.unavailableRepoCommandIds.length === 0) return;
      state = { ...state, unavailableRepoCommandIds: [] };
      publish();
    },
    setRecentTasks(tasks) {
      const uniqueTasks = preserveNewerTaskActivities(
        state.recentTasks,
        dedupeTasksById(tasks)
      );
      if (areTaskListsEqual(state.recentTasks, uniqueTasks)) {
        return;
      }

      state = {
        ...state,
        recentTasks: uniqueTasks
      };
      publish();
    },
    setSearchResults(query, results) {
      const uniqueResults = preserveNewerTaskActivities(
        state.searchResults,
        dedupeTasksById(results)
      );
      state = {
        ...state,
        searchQuery: query,
        searchResults: uniqueResults
      };
      publish();
    },
    setTaskActivity(taskId, activity, activityRevision) {
      let changed = false;
      const updateTask = (task: TaskSummary): TaskSummary => {
        if (
          task.id !== taskId ||
          ((task.activity ?? "idle") === activity &&
            (activityRevision === undefined ||
              task.activityRevision === activityRevision))
        ) {
          return task;
        }
        changed = true;
        return {
          ...task,
          activity,
          ...(activityRevision === undefined ? {} : { activityRevision })
        };
      };
      const updateTasks = (tasks: readonly TaskSummary[]): TaskSummary[] =>
        tasks.map(updateTask);
      const repoTasks = updateTasks(state.repoTasks);
      const recentTasks = updateTasks(state.recentTasks);
      const searchResults = updateTasks(state.searchResults);
      const taskUiSlots = state.taskUiSlots.map((slot) =>
        slot.state === "ready" && slot.task.id === taskId
          ? { ...slot, task: updateTask(slot.task) }
          : slot
      );
      if (!changed) return;

      state = {
        ...state,
        repoTasks,
        recentTasks,
        searchResults,
        taskUiSlots
      };
      publish();
    },
    setTaskPinState(taskId, pinned, pinOrder) {
      let changed = false;
      const updateTask = (task: TaskSummary): TaskSummary => {
        if (
          task.id !== taskId ||
          ((task.pinned ?? false) === pinned &&
            (task.pinOrder ?? null) === pinOrder)
        ) {
          return task;
        }
        changed = true;
        return { ...task, pinned, pinOrder };
      };
      const updateTasks = (tasks: readonly TaskSummary[]): TaskSummary[] =>
        tasks.map(updateTask);
      const repoTasks = updateTasks(state.repoTasks);
      const recentTasks = updateTasks(state.recentTasks);
      const searchResults = updateTasks(state.searchResults);
      const taskUiSlots = state.taskUiSlots.map((slot) =>
        slot.state === "ready" && slot.task.id === taskId
          ? { ...slot, task: updateTask(slot.task) }
          : slot
      );
      if (!changed) return;

      state = {
        ...state,
        repoTasks,
        recentTasks,
        searchResults,
        taskUiSlots
      };
      publish();
    },
    setTaskPrompt(taskId, prompt) {
      let changed = false;
      const updateTasks = (tasks: readonly TaskSummary[]): TaskSummary[] =>
        tasks.map((task) => {
          if (task.id !== taskId || task.prompt === prompt) {
            return task;
          }
          changed = true;
          return { ...task, prompt };
        });
      const repoTasks = updateTasks(state.repoTasks);
      const recentTasks = updateTasks(state.recentTasks);
      const searchResults = updateTasks(state.searchResults);
      if (!changed) return;

      state = { ...state, repoTasks, recentTasks, searchResults };
      publish();
    },
    setSelectedTask(selectedTaskId) {
      state = {
        ...state,
        selectedTaskId,
        taskTerminalTaskId:
          selectedTaskId === null ? null : state.taskTerminalTaskId,
        taskTerminalStatus:
          selectedTaskId === null ? "idle" : state.taskTerminalStatus,
        taskTerminalOutput:
          selectedTaskId === null
            ? EMPTY_TERMINAL_OUTPUT
            : state.taskTerminalOutput,
        taskTerminalOutputEpoch:
          selectedTaskId === null
            ? state.taskTerminalOutputEpoch + 1
            : state.taskTerminalOutputEpoch,
        taskTerminalOutputStart:
          selectedTaskId === null ? 0 : state.taskTerminalOutputStart,
        taskTerminalCols:
          selectedTaskId === null ? null : state.taskTerminalCols,
        taskTerminalRows:
          selectedTaskId === null ? null : state.taskTerminalRows,
        taskTerminalErrorMessage:
          selectedTaskId === null ? null : state.taskTerminalErrorMessage,
        taskAgentTaskId:
          selectedTaskId === null ? null : state.taskAgentTaskId,
        taskAgentStatus:
          selectedTaskId === null ? "idle" : state.taskAgentStatus,
        taskAgentEvents:
          selectedTaskId === null ? [] : state.taskAgentEvents,
        taskAgentErrorMessage:
          selectedTaskId === null ? null : state.taskAgentErrorMessage,
        taskCompanionTaskId:
          selectedTaskId === null ? null : state.taskCompanionTaskId,
        taskCompanionStatus:
          selectedTaskId === null ? "idle" : state.taskCompanionStatus,
        taskCompanionSnapshot:
          selectedTaskId === null ? null : state.taskCompanionSnapshot,
        taskCompanionUnread:
          selectedTaskId === null ? false : state.taskCompanionUnread,
        taskCompanionErrorMessage:
          selectedTaskId === null ? null : state.taskCompanionErrorMessage,
        taskCompanionEventId:
          selectedTaskId === null ? null : state.taskCompanionEventId,
        taskCompanionEventStatus:
          selectedTaskId === null ? "idle" : state.taskCompanionEventStatus
      };
      if (selectedTaskId === null) {
        publishTerminalOutput();
      }
      publish();
    },
    beginTaskAction(taskId, action) {
      if (state.pendingTaskAction) return false;
      state = { ...state, pendingTaskAction: { taskId, action } };
      publish();
      return true;
    },
    finishTaskAction(taskId, action) {
      const pending = state.pendingTaskAction;
      if (!pending || pending.taskId !== taskId || pending.action !== action) {
        return;
      }
      state = { ...state, pendingTaskAction: null };
      publish();
    },
    retagTaskIdentity(previousTaskId, nextTaskId, options) {
      const selectedTaskId =
        !options?.preserveSelection && state.selectedTaskId === previousTaskId
          ? nextTaskId
          : state.selectedTaskId;
      const taskTerminalTaskId =
        state.taskTerminalTaskId === previousTaskId
          ? nextTaskId
          : state.taskTerminalTaskId;
      const taskAgentTaskId =
        state.taskAgentTaskId === previousTaskId
          ? nextTaskId
          : state.taskAgentTaskId;
      const taskCompanionTaskId =
        state.taskCompanionTaskId === previousTaskId
          ? nextTaskId
          : state.taskCompanionTaskId;
      if (
        selectedTaskId === state.selectedTaskId &&
        taskTerminalTaskId === state.taskTerminalTaskId &&
        taskAgentTaskId === state.taskAgentTaskId &&
        taskCompanionTaskId === state.taskCompanionTaskId
      ) {
        return;
      }

      state = {
        ...state,
        selectedTaskId,
        taskTerminalTaskId,
        taskAgentTaskId,
        taskCompanionTaskId
      };
      publish();
    },
    setActiveView(activeView) {
      state = { ...state, activeView };
      publish();
    },
    setPairingCode(code) {
      state = { ...state, pairingCode: code };
      publish();
    },
    setComposerState(isComposerOpen, composerPrompt) {
      state = {
        ...state,
        isComposerOpen,
        composerPrompt,
        composerErrorMessage:
          !isComposerOpen || composerPrompt !== state.composerPrompt
            ? null
            : state.composerErrorMessage
      };
      publish();
    },
    setComposerRepo(composerRepoId) {
      state = { ...state, composerRepoId, composerErrorMessage: null };
      publish();
    },
    setComposerDesktop(composerDesktopId) {
      state = { ...state, composerDesktopId, composerErrorMessage: null };
      publish();
    },
    setComposerAgentProvider(composerAgentProvider) {
      state = { ...state, composerAgentProvider, composerErrorMessage: null };
      publish();
    },
    setComposerOptionsExpanded(isComposerOptionsExpanded) {
      state = { ...state, isComposerOptionsExpanded };
      publish();
    },
    setComposerErrorMessage(composerErrorMessage) {
      state = { ...state, composerErrorMessage };
      publish();
    },
    setTaskCreationState(taskCreationState) {
      const attempts =
        taskCreationState.pendingTaskCreation === null
          ? []
          : [{
              ...taskCreationState.pendingTaskCreation,
              phase: taskCreationState.phase as ActiveTaskCreationPhase,
              pendingAction: null,
              errorMessage: null
            }];
      state = {
        ...state,
        taskCreationAttempts: attempts,
        pendingTaskCreation: taskCreationState.pendingTaskCreation,
        taskCreationPhase: taskCreationState.phase
      };
      publish();
    },
    addTaskCreationAttempt(attempt) {
      const normalizedAttempt = {
        ...attempt,
        pendingAction: attempt.pendingAction ?? null,
        errorMessage: attempt.errorMessage ?? null
      };
      const taskCreationAttempts = [
        normalizedAttempt,
        ...state.taskCreationAttempts.filter(
          (candidate) =>
            candidate.slotId !== normalizedAttempt.slotId &&
            candidate.taskId !== normalizedAttempt.taskId
        )
      ];
      state = {
        ...state,
        taskCreationAttempts,
        pendingTaskCreation: normalizedAttempt,
        taskCreationPhase: normalizedAttempt.phase
      };
      publish();
    },
    setTaskCreationAttemptPhase(slotId, phase) {
      const taskCreationAttempts = state.taskCreationAttempts.map((attempt) =>
        attempt.slotId === slotId ? { ...attempt, phase } : attempt
      );
      const projected =
        taskCreationAttempts.find(
          (attempt) => attempt.slotId === state.pendingTaskCreation?.slotId
        ) ?? taskCreationAttempts[0] ?? null;
      state = {
        ...state,
        taskCreationAttempts,
        pendingTaskCreation: projected,
        taskCreationPhase: projected?.phase ?? "idle"
      };
      publish();
    },
    beginTaskCreationAction(slotId, action) {
      const attempt = state.taskCreationAttempts.find(
        (candidate) => candidate.slotId === slotId
      );
      if (!attempt || attempt.pendingAction) {
        return false;
      }
      state = {
        ...state,
        taskCreationAttempts: state.taskCreationAttempts.map((candidate) =>
          candidate.slotId === slotId
            ? { ...candidate, pendingAction: action }
            : candidate
        )
      };
      publish();
      return true;
    },
    finishTaskCreationAction(slotId, action) {
      const attempt = state.taskCreationAttempts.find(
        (candidate) => candidate.slotId === slotId
      );
      if (!attempt || attempt.pendingAction !== action) {
        return;
      }
      state = {
        ...state,
        taskCreationAttempts: state.taskCreationAttempts.map((candidate) =>
          candidate.slotId === slotId
            ? { ...candidate, pendingAction: null }
            : candidate
        )
      };
      publish();
    },
    setTaskCreationAttemptError(slotId, errorMessage) {
      if (
        !state.taskCreationAttempts.some(
          (attempt) => attempt.slotId === slotId
        )
      ) {
        return;
      }
      state = {
        ...state,
        taskCreationAttempts: state.taskCreationAttempts.map((attempt) =>
          attempt.slotId === slotId
            ? { ...attempt, errorMessage }
            : attempt
        )
      };
      publish();
    },
    removeTaskCreationAttempt(slotId) {
      const taskCreationAttempts = state.taskCreationAttempts.filter(
        (attempt) => attempt.slotId !== slotId
      );
      const projected =
        taskCreationAttempts.find(
          (attempt) => attempt.slotId === state.pendingTaskCreation?.slotId
        ) ?? taskCreationAttempts[0] ?? null;
      state = {
        ...state,
        taskCreationAttempts,
        pendingTaskCreation: projected,
        taskCreationPhase: projected?.phase ?? "idle"
      };
      publish();
    },
    addTaskUiSlot(slot) {
      state = {
        ...state,
        taskUiSlots: [
          slot,
          ...state.taskUiSlots.filter(
            (candidate) =>
              candidate.slotId !== slot.slotId &&
              (!slot.taskId || candidate.taskId !== slot.taskId)
          )
        ]
      };
      publish();
    },
    acknowledgeTaskUiSlot(slotId, task) {
      state = {
        ...state,
        taskUiSlots: acknowledgeTaskUiSlotState(state.taskUiSlots, slotId, task)
      };
      publish();
    },
    reconcileTaskUiSlots(tasks, options) {
      state = {
        ...state,
        taskUiSlots: reconcileTaskUiSlotsState(
          state.taskUiSlots,
          tasks,
          options
        )
      };
      publish();
    },
    removeTaskUiSlot(slotId) {
      state = {
        ...state,
        taskUiSlots: removeTaskUiSlotState(state.taskUiSlots, slotId)
      };
      publish();
    },
    beginTaskTerminal(taskId, initialOutput) {
      const terminalOutput = createTerminalOutput(initialOutput);
      state = {
        ...state,
        taskTerminalTaskId: taskId,
        taskTerminalStatus: "connecting",
        taskTerminalOutput: terminalOutput,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: initialOutput.length - terminalOutput.length,
        taskTerminalCols: null,
        taskTerminalRows: null,
        taskTerminalErrorMessage: null
      };
      publishTerminalOutput();
      publish();
    },
    replaceTaskTerminalSnapshot(taskId, dataB64, cols, rows) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      const snapshotOutput = dataB64 ? `${dataB64}\n` : "";
      const terminalOutput = createTerminalOutput(snapshotOutput);
      state = {
        ...state,
        taskTerminalStatus: "live",
        taskTerminalOutput: terminalOutput,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: 0,
        taskTerminalCols: cols,
        taskTerminalRows: rows,
        taskTerminalErrorMessage: null
      };
      publishTerminalOutput();
      publish();
    },
    appendTaskTerminal(taskId, chunk) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      const terminalMetadataChanged =
        state.taskTerminalStatus !== "live" ||
        state.taskTerminalErrorMessage !== null;
      const appended =
        state.taskTerminalOutput.length === 0
          ? {
              output: createTerminalOutput(chunk),
              droppedChars: 0
            }
          : appendTerminalOutput(state.taskTerminalOutput, chunk);
      state = {
        ...state,
        taskTerminalStatus: "live",
        taskTerminalOutput: appended.output,
        taskTerminalOutputStart:
          state.taskTerminalOutputStart + appended.droppedChars,
        taskTerminalErrorMessage: null
      };
      // Live PTY bytes are an imperative terminal stream, not application
      // navigation state. Notify the mounted terminal directly so each frame
      // is retained and written once without invalidating the complete React
      // tree or re-running unrelated session persistence.
      publishTerminalOutput();
      if (terminalMetadataChanged) {
        publish();
      }
    },
    setTaskTerminalDims(taskId, cols, rows) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }
      if (state.taskTerminalCols === cols && state.taskTerminalRows === rows) {
        return;
      }

      state = { ...state, taskTerminalCols: cols, taskTerminalRows: rows };
      publish();
    },
    setTaskTerminalStatus(taskId, taskTerminalStatus) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      state = {
        ...state,
        taskTerminalStatus,
        taskTerminalErrorMessage:
          taskTerminalStatus === "error" ? state.taskTerminalErrorMessage : null
      };
      publishTerminalOutput();
      publish();
    },
    setTaskTerminalError(taskId, taskTerminalErrorMessage) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      state = {
        ...state,
        taskTerminalStatus: "error",
        taskTerminalErrorMessage
      };
      publishTerminalOutput();
      publish();
    },
    beginTaskAgent(taskId) {
      state = {
        ...state,
        taskAgentTaskId: taskId,
        taskAgentStatus: "connecting",
        taskAgentEvents: [],
        taskAgentErrorMessage: null
      };
      publish();
    },
    applyTaskAgentStreamEvent(taskId, event) {
      if (state.taskAgentTaskId !== taskId) {
        return;
      }

      if (event.type === "snapshot") {
        state = {
          ...state,
          taskAgentStatus: "live",
          taskAgentEvents: event.events,
          taskAgentErrorMessage: null
        };
        publish();
        return;
      }

      if (event.type === "event") {
        state = {
          ...state,
          taskAgentStatus: "live",
          taskAgentEvents: [...state.taskAgentEvents, { seq: event.seq, event: event.event }],
          taskAgentErrorMessage: null
        };
        publish();
        return;
      }

      if (event.type === "status") {
        state = {
          ...state,
          taskAgentStatus: event.status === "idle" ? "idle" : "live",
          taskAgentErrorMessage: null
        };
        publish();
        return;
      }

      if (event.type === "exit") {
        state = {
          ...state,
          taskAgentStatus: "closed",
          taskAgentErrorMessage: null
        };
        publish();
        return;
      }

      state = {
        ...state,
        taskAgentStatus: "error",
        taskAgentErrorMessage: event.message
      };
      publish();
    },
    beginTaskCompanion(taskId) {
      state = {
        ...state,
        taskCompanionTaskId: taskId
      };
      applyCompanionAction({ type: "begin" });
      publish();
    },
    applyTaskCompanionStreamEvent(taskId, event, isOpen) {
      if (state.taskCompanionTaskId !== taskId) return;

      if (event.type === "connection") {
        if (
          applyCompanionAction({
            type: "connection",
            connected: event.connected,
            // Mobile intentionally removes stale WebView controls while its
            // stream is reattaching.
            retainSnapshot: false
          })
        ) {
          publish();
        }
        return;
      }

      if (event.type === "snapshot") {
        applyCompanionAction({
          type: "snapshot",
          snapshot: {
            sessionId: event.sessionId,
            revision: event.revision,
            documentKind: event.documentKind,
            html: event.html,
            sourceOrigin: event.sourceOrigin,
            assets: []
          },
          viewed: isOpen
        });
        publish();
        return;
      }

      if (event.type === "unavailable") {
        applyCompanionAction({ type: "unavailable" });
        publish();
        return;
      }

      if (event.type === "error") {
        applyCompanionAction({ type: "error", message: event.message });
        publish();
        return;
      }

      if (event.type === "event_result") {
        if (
          applyCompanionAction({
            type: "event_result",
            result: event
          })
        ) {
          publish();
        }
      }
    },
    markTaskCompanionViewed(taskId) {
      if (
        state.taskCompanionTaskId !== taskId ||
        !state.taskCompanionUnread
      ) {
        return;
      }
      if (applyCompanionAction({ type: "viewed" })) publish();
    },
    beginTaskCompanionEvent(taskId, eventId) {
      if (state.taskCompanionTaskId !== taskId) return;
      applyCompanionAction({ type: "begin_event", eventId });
      publish();
    },
    reconcileSelectedTask() {
      const selectedSlot = taskUiSlotForSelection(
        state.taskUiSlots,
        state.selectedTaskId
      );
      if (
        selectedSlot?.state === "creating" ||
        (selectedSlot?.state === "ready" &&
          hasTaskInCollections(selectedSlot.taskId)) ||
        hasTaskInCollections(state.selectedTaskId)
      ) {
        return;
      }

      state = {
        ...state,
        selectedTaskId: null,
        taskTerminalTaskId: null,
        taskTerminalStatus: "idle",
        taskTerminalOutput: EMPTY_TERMINAL_OUTPUT,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: 0,
        taskTerminalErrorMessage: null,
        taskAgentTaskId: null,
        taskAgentStatus: "idle",
        taskAgentEvents: [],
        taskAgentErrorMessage: null,
        taskCompanionTaskId: null,
        taskCompanionStatus: "idle",
        taskCompanionSnapshot: null,
        taskCompanionUnread: false,
        taskCompanionErrorMessage: null,
        taskCompanionEventId: null,
        taskCompanionEventStatus: "idle"
      };
      publishTerminalOutput();
      publish();
    },
    clearTaskTerminal() {
      state = {
        ...state,
        taskTerminalTaskId: null,
        taskTerminalStatus: "idle",
        taskTerminalOutput: EMPTY_TERMINAL_OUTPUT,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: 0,
        taskTerminalErrorMessage: null
      };
      publishTerminalOutput();
      publish();
    },
    clearTaskAgent() {
      state = {
        ...state,
        taskAgentTaskId: null,
        taskAgentStatus: "idle",
        taskAgentEvents: [],
        taskAgentErrorMessage: null
      };
      publish();
    },
    clearTaskCompanion() {
      state = {
        ...state,
        taskCompanionTaskId: null
      };
      applyCompanionAction({ type: "reset" });
      publish();
    }
  };
}

function mergeTrustedDesktop(
  existing: TrustedDesktopRecord,
  incoming: TrustedDesktopRecord
): TrustedDesktopRecord {
  const endpointByUrl = new Map(
    existing.lanEndpoints.map((endpoint) => [endpoint.baseUrl, endpoint])
  );
  for (const endpoint of incoming.lanEndpoints) {
    endpointByUrl.set(endpoint.baseUrl, endpoint);
  }

  const lastSeenAt = [existing.lastSeenAt, incoming.lastSeenAt].sort()[1] ?? incoming.lastSeenAt;

  const deviceSecret = incoming.deviceSecret ?? existing.deviceSecret;
  return {
    desktopId: existing.desktopId,
    displayName: incoming.displayName || existing.displayName,
    lanEndpoints: Array.from(endpointByUrl.values()).sort((left, right) =>
      right.lastSeenAt.localeCompare(left.lastSeenAt)
    ),
    lastSeenAt,
    ...(deviceSecret ? { deviceSecret } : {})
  };
}

function areTrustedDesktopListsEqual(
  left: readonly TrustedDesktopRecord[],
  right: readonly TrustedDesktopRecord[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

import type {
  DesktopMode,
  DesktopSummary,
  TaskActivity,
  TaskSummary,
  RepoSummary,
  RepoCommandCatalog,
} from "../lib/api/types";
import type { AgentProvider, FrameAgentEvent } from "@kanna/agent-protocol";
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

// Terminal output is accumulated as newline-delimited base64 frames and replayed
// into xterm.js on WebView (re)mount. The first frame is the full attachment
// snapshot and must survive intact; only subsequent live frames are bounded.
// Always evict at frame boundaries so replay never receives partial base64.
// droppedChars tracks only evicted live-output characters, allowing an already
// mounted xterm to append from the logical stream end without replaying history.
const MAX_TERMINAL_LIVE_OUTPUT_CHARS = 1_000_000;

interface CappedTerminalOutput {
  output: string;
  droppedChars: number;
}

function capTerminalOutput(output: string): CappedTerminalOutput {
  const snapshotEnd = output.indexOf("\n") + 1;
  if (snapshotEnd === 0) {
    return { output, droppedChars: 0 };
  }

  const liveOutput = output.slice(snapshotEnd);
  if (liveOutput.length <= MAX_TERMINAL_LIVE_OUTPUT_CHARS) {
    return { output, droppedChars: 0 };
  }

  const cut = liveOutput.length - MAX_TERMINAL_LIVE_OUTPUT_CHARS;
  let retainedLiveStart: number;
  if (cut === 0 || liveOutput[cut - 1] === "\n") {
    retainedLiveStart = cut;
  } else {
    const nextFrameEnd = liveOutput.indexOf("\n", cut);
    if (nextFrameEnd >= 0 && nextFrameEnd + 1 < liveOutput.length) {
      retainedLiveStart = nextFrameEnd + 1;
    } else {
      // The newest frame alone crosses the soft limit (or is incomplete).
      // Keep it whole, starting after the preceding complete frame.
      retainedLiveStart = liveOutput.lastIndexOf("\n", cut - 1) + 1;
    }
  }

  return {
    output: `${output.slice(0, snapshotEnd)}${liveOutput.slice(retainedLiveStart)}`,
    droppedChars: retainedLiveStart
  };
}

export type ConnectionState = "idle" | "connecting" | "connected" | "error";
export type MobileView = "tasks" | "recent" | "search" | "desktops" | "more";
export type TaskTerminalStatus = "idle" | "connecting" | "live" | "closed" | "error";
export type RefreshStatus = "idle" | "refreshing" | "updated" | "error";
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

export type TaskCreationState =
  | { phase: "idle"; pendingTaskCreation: null }
  | {
      phase: Exclude<TaskCreationPhase, "idle">;
      pendingTaskCreation: PendingTaskCreation;
    };

export interface SessionState {
  mobileDeviceId: string | null;
  connectionMode: DesktopMode | null;
  connectionState: ConnectionState;
  desktopId: string | null;
  desktopName: string | null;
  serverStatus: string | null;
  errorMessage: string | null;
  refreshStatus: RefreshStatus;
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
  recentTasks: TaskSummary[];
  searchQuery: string;
  searchResults: TaskSummary[];
  selectedTaskId: string | null;
  activeView: MobileView;
  pairingCode: string | null;
  isComposerOpen: boolean;
  composerPrompt: string;
  composerRepoId: string | null;
  composerDesktopId: string | null;
  composerAgentProvider: ComposerAgentProvider;
  isComposerOptionsExpanded: boolean;
  composerErrorMessage: string | null;
  pendingTaskCreation: PendingTaskCreation | null;
  taskCreationPhase: TaskCreationPhase;
  taskUiSlots: TaskUiSlot[];
  taskTerminalTaskId: string | null;
  taskTerminalStatus: TaskTerminalStatus;
  taskTerminalOutput: string;
  taskTerminalOutputEpoch: number;
  taskTerminalOutputStart: number;
  taskTerminalCols: number | null;
  taskTerminalRows: number | null;
  taskTerminalErrorMessage: string | null;
  taskAgentTaskId: string | null;
  taskAgentStatus: TaskTerminalStatus;
  taskAgentEvents: FrameAgentEvent[];
  taskAgentErrorMessage: string | null;
}

export interface SessionStore {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  getPersistedContext(): PersistedSessionContext;
  hydrateContext(context: PersistedSessionContext): void;
  ensureMobileDeviceId(generate: () => string): string;
  setConnectionMode(mode: DesktopMode | null): void;
  setConnectionState(state: ConnectionState): void;
  setDesktopStatus(status: string | null, desktopName: string | null, pairingCode: string | null, desktopId?: string | null): void;
  setErrorMessage(message: string | null): void;
  setRefreshStatus(status: RefreshStatus): void;
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
  setRecentTasks(tasks: TaskSummary[]): void;
  setSearchResults(query: string, results: TaskSummary[]): void;
  setTaskActivity(taskId: string, activity: TaskActivity): void;
  setTaskPrompt(taskId: string, prompt: string): void;
  setSelectedTask(taskId: string | null): void;
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
  reconcileSelectedTask(): void;
  clearTaskTerminal(): void;
  clearTaskAgent(): void;
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
    recentTasks: [],
    searchQuery: "",
    searchResults: [],
    selectedTaskId: null,
    activeView: "tasks",
    pairingCode: null,
    isComposerOpen: false,
    composerPrompt: "",
    composerRepoId: null,
    composerDesktopId: null,
    composerAgentProvider: "claude",
    isComposerOptionsExpanded: true,
    composerErrorMessage: null,
    pendingTaskCreation: null,
    taskCreationPhase: "idle",
    taskUiSlots: [],
    taskTerminalTaskId: null,
    taskTerminalStatus: "idle",
    taskTerminalOutput: "",
    taskTerminalOutputEpoch: 0,
    taskTerminalOutputStart: 0,
    taskTerminalCols: null,
    taskTerminalRows: null,
    taskTerminalErrorMessage: null,
    taskAgentTaskId: null,
    taskAgentStatus: "idle",
    taskAgentEvents: [],
    taskAgentErrorMessage: null
  };

  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
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
        (task.waitingPromptSnippet ?? null) ===
          (other.waitingPromptSnippet ?? null) &&
        (task.agentType ?? null) === (other.agentType ?? null)
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
        pendingTaskCreation: state.pendingTaskCreation
      };
    },
    hydrateContext(context) {
      const pendingTaskCreation = context.pendingTaskCreation ?? null;
      const selectedTaskId =
        pendingTaskCreation &&
        (context.selectedTaskId === pendingTaskCreation.taskId ||
          context.selectedTaskId === pendingTaskCreation.slotId)
          ? pendingTaskCreation.slotId
          : context.selectedTaskId;
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
        isComposerOpen: pendingTaskCreation ? false : state.isComposerOpen,
        composerPrompt: pendingTaskCreation?.prompt ?? state.composerPrompt,
        composerRepoId: pendingTaskCreation?.repoId ?? state.composerRepoId,
        composerDesktopId:
          pendingTaskCreation?.desktopId ?? state.composerDesktopId,
        composerAgentProvider:
          pendingTaskCreation?.agentProvider ?? state.composerAgentProvider,
        composerErrorMessage: pendingTaskCreation
          ? null
          : state.composerErrorMessage,
        pendingTaskCreation,
        taskCreationPhase: pendingTaskCreation ? "uncertain" : "idle",
        taskUiSlots: pendingTaskCreation
          ? [buildCreatingTaskUiSlot(pendingTaskCreation)]
          : state.taskUiSlots
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
      const uniqueTasks = dedupeTasksById(repoTasks);
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
      state = {
        ...state,
        repoCommandCatalog,
        repoCommandStatus: "ready",
        repoCommandErrorMessage: null
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
    setRecentTasks(tasks) {
      const uniqueTasks = dedupeTasksById(tasks);
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
      const uniqueResults = dedupeTasksById(results);
      state = {
        ...state,
        searchQuery: query,
        searchResults: uniqueResults
      };
      publish();
    },
    setTaskActivity(taskId, activity) {
      let changed = false;
      const updateTasks = (tasks: readonly TaskSummary[]): TaskSummary[] =>
        tasks.map((task) => {
          if (task.id !== taskId || (task.activity ?? "idle") === activity) {
            return task;
          }
          changed = true;
          return { ...task, activity };
        });
      const repoTasks = updateTasks(state.repoTasks);
      const recentTasks = updateTasks(state.recentTasks);
      const searchResults = updateTasks(state.searchResults);
      if (!changed) return;

      state = { ...state, repoTasks, recentTasks, searchResults };
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
          selectedTaskId === null ? "" : state.taskTerminalOutput,
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
          selectedTaskId === null ? null : state.taskAgentErrorMessage
      };
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
      if (
        selectedTaskId === state.selectedTaskId &&
        taskTerminalTaskId === state.taskTerminalTaskId &&
        taskAgentTaskId === state.taskAgentTaskId
      ) {
        return;
      }

      state = {
        ...state,
        selectedTaskId,
        taskTerminalTaskId,
        taskAgentTaskId
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
      state = {
        ...state,
        pendingTaskCreation: taskCreationState.pendingTaskCreation,
        taskCreationPhase: taskCreationState.phase
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
      const capped = capTerminalOutput(initialOutput);
      state = {
        ...state,
        taskTerminalTaskId: taskId,
        taskTerminalStatus: "connecting",
        taskTerminalOutput: capped.output,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: capped.droppedChars,
        taskTerminalCols: null,
        taskTerminalRows: null,
        taskTerminalErrorMessage: null
      };
      publish();
    },
    replaceTaskTerminalSnapshot(taskId, dataB64, cols, rows) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      const snapshotOutput = dataB64 ? `${dataB64}\n` : "";
      const capped = capTerminalOutput(snapshotOutput);
      state = {
        ...state,
        taskTerminalStatus: "live",
        taskTerminalOutput: capped.output,
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: capped.droppedChars,
        taskTerminalCols: cols,
        taskTerminalRows: rows,
        taskTerminalErrorMessage: null
      };
      publish();
    },
    appendTaskTerminal(taskId, chunk) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      const nextOutput = `${state.taskTerminalOutput}${chunk}`;
      const capped = capTerminalOutput(nextOutput);
      state = {
        ...state,
        taskTerminalStatus: "live",
        taskTerminalOutput: capped.output,
        taskTerminalOutputStart:
          state.taskTerminalOutputStart + capped.droppedChars,
        taskTerminalErrorMessage: null
      };
      publish();
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
        taskTerminalOutput: "",
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: 0,
        taskTerminalErrorMessage: null,
        taskAgentTaskId: null,
        taskAgentStatus: "idle",
        taskAgentEvents: [],
        taskAgentErrorMessage: null
      };
      publish();
    },
    clearTaskTerminal() {
      state = {
        ...state,
        taskTerminalTaskId: null,
        taskTerminalStatus: "idle",
        taskTerminalOutput: "",
        taskTerminalOutputEpoch: state.taskTerminalOutputEpoch + 1,
        taskTerminalOutputStart: 0,
        taskTerminalErrorMessage: null
      };
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

  return {
    desktopId: existing.desktopId,
    displayName: incoming.displayName || existing.displayName,
    lanEndpoints: Array.from(endpointByUrl.values()).sort((left, right) =>
      right.lastSeenAt.localeCompare(left.lastSeenAt)
    ),
    lastSeenAt
  };
}

function areTrustedDesktopListsEqual(
  left: readonly TrustedDesktopRecord[],
  right: readonly TrustedDesktopRecord[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

import type {
  DesktopMode,
  DesktopSummary,
  TaskActivity,
  TaskSummary,
  RepoSummary,
} from "../lib/api/types";
import type { AgentProvider, FrameAgentEvent } from "@kanna/agent-protocol";
import type { MobileAuthState } from "../lib/firebase/auth";
import type {
  PersistedSessionContext,
  RepoCreationProfile,
  TrustedDesktopRecord
} from "./sessionPersistence";

// Terminal output is accumulated as newline-delimited base64 frames and replayed
// into xterm.js on WebView (re)mount. Cap the buffer by dropping whole oldest
// frames — never slice mid-base64, which corrupts decoding. The first frame is a
// full-screen snapshot (one large base64 line) that must survive intact or the
// terminal renders blank. 1MB comfortably holds a snapshot plus recent deltas.
const MAX_TERMINAL_OUTPUT_CHARS = 1_000_000;

function capTerminalOutput(output: string): string {
  if (output.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    return output;
  }
  const cut = output.length - MAX_TERMINAL_OUTPUT_CHARS;
  const newlineIndex = output.indexOf("\n", cut);
  // Keep whole frames only; if a single frame exceeds the cap, keep it rather
  // than emit a corrupt base64 fragment.
  return newlineIndex === -1 ? output : output.slice(newlineIndex + 1);
}

export type ConnectionState = "idle" | "connecting" | "connected" | "error";
export type MobileView = "tasks" | "recent" | "search" | "desktops" | "more";
export type TaskTerminalStatus = "idle" | "connecting" | "live" | "closed" | "error";
export type RefreshStatus = "idle" | "refreshing" | "updated" | "error";
export type AuthState = MobileAuthState;
export type ComposerAgentProvider = AgentProvider;
export type TaskCreationPhase = "idle" | "pending" | "recovering" | "uncertain";

export interface PendingTaskCreation {
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
  connectionMode: DesktopMode | null;
  connectionState: ConnectionState;
  desktopId: string | null;
  desktopName: string | null;
  serverStatus: string | null;
  errorMessage: string | null;
  refreshStatus: RefreshStatus;
  auth: AuthState;
  desktops: DesktopSummary[];
  trustedDesktops: TrustedDesktopRecord[];
  repoCreationProfiles: RepoCreationProfile[];
  selectedDesktopId: string | null;
  repos: RepoSummary[];
  selectedRepoId: string | null;
  repoTasks: TaskSummary[];
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
  taskTerminalTaskId: string | null;
  taskTerminalStatus: TaskTerminalStatus;
  taskTerminalOutput: string;
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
  setConnectionMode(mode: DesktopMode | null): void;
  setConnectionState(state: ConnectionState): void;
  setDesktopStatus(status: string | null, desktopName: string | null, pairingCode: string | null, desktopId?: string | null): void;
  setErrorMessage(message: string | null): void;
  setRefreshStatus(status: RefreshStatus): void;
  setAuthState(auth: AuthState): void;
  setDesktops(desktops: DesktopSummary[]): void;
  setTrustedDesktops(desktops: TrustedDesktopRecord[]): void;
  upsertTrustedDesktop(desktop: TrustedDesktopRecord): void;
  upsertRepoCreationProfile(profile: RepoCreationProfile): void;
  selectDesktop(desktopId: string): void;
  setRepos(repos: RepoSummary[]): void;
  selectRepo(repoId: string): void;
  setRepoTasks(tasks: TaskSummary[]): void;
  setRecentTasks(tasks: TaskSummary[]): void;
  setSearchResults(query: string, results: TaskSummary[]): void;
  setTaskActivity(taskId: string, activity: TaskActivity): void;
  setSelectedTask(taskId: string | null): void;
  retagTaskIdentity(previousTaskId: string, nextTaskId: string): void;
  setActiveView(view: MobileView): void;
  setPairingCode(code: string | null): void;
  setComposerState(isOpen: boolean, prompt: string): void;
  setComposerRepo(repoId: string | null): void;
  setComposerDesktop(desktopId: string | null): void;
  setComposerAgentProvider(provider: ComposerAgentProvider): void;
  setComposerOptionsExpanded(isExpanded: boolean): void;
  setComposerErrorMessage(message: string | null): void;
  setTaskCreationState(taskCreationState: TaskCreationState): void;
  beginTaskTerminal(taskId: string, initialOutput: string): void;
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
    connectionMode: null,
    connectionState: "idle",
    desktopId: null,
    desktopName: null,
    serverStatus: null,
    errorMessage: null,
    refreshStatus: "idle",
    auth: { status: "signedOut" },
    desktops: [],
    trustedDesktops: [],
    repoCreationProfiles: [],
    selectedDesktopId: null,
    repos: [],
    selectedRepoId: null,
    repoTasks: [],
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
    taskTerminalTaskId: null,
    taskTerminalStatus: "idle",
    taskTerminalOutput: "",
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
        task.stage === other.stage &&
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
      return {
        selectedDesktopId: state.selectedDesktopId,
        selectedRepoId: state.selectedRepoId,
        selectedTaskId: state.selectedTaskId,
        activeView: state.activeView,
        authUser: state.auth.status === "signedIn" ? state.auth.user : null,
        trustedDesktops: state.trustedDesktops,
        repoCreationProfiles: state.repoCreationProfiles,
        pendingTaskCreation: state.pendingTaskCreation
      };
    },
    hydrateContext(context) {
      const pendingTaskCreation = context.pendingTaskCreation ?? null;
      state = {
        ...state,
        selectedDesktopId: context.selectedDesktopId,
        selectedRepoId: context.selectedRepoId,
        selectedTaskId: context.selectedTaskId,
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
        taskCreationPhase: pendingTaskCreation ? "uncertain" : "idle"
      };
      publish();
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
      state = {
        ...state,
        repos,
        selectedRepoId: hasSelectedRepo ? state.selectedRepoId : repos[0]?.id ?? null
      };
      publish();
    },
    selectRepo(repoId) {
      state = {
        ...state,
        selectedRepoId: repoId
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
    retagTaskIdentity(previousTaskId, nextTaskId) {
      const selectedTaskId =
        state.selectedTaskId === previousTaskId
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
    beginTaskTerminal(taskId, initialOutput) {
      state = {
        ...state,
        taskTerminalTaskId: taskId,
        taskTerminalStatus: "connecting",
        taskTerminalOutput: initialOutput,
        taskTerminalCols: null,
        taskTerminalRows: null,
        taskTerminalErrorMessage: null
      };
      publish();
    },
    appendTaskTerminal(taskId, chunk) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      const nextOutput = `${state.taskTerminalOutput}${chunk}`;
      state = {
        ...state,
        taskTerminalStatus: "live",
        taskTerminalOutput: capTerminalOutput(nextOutput),
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
      if (hasTaskInCollections(state.selectedTaskId)) {
        return;
      }

      state = {
        ...state,
        selectedTaskId: null,
        taskTerminalTaskId: null,
        taskTerminalStatus: "idle",
        taskTerminalOutput: "",
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

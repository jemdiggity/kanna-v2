import type {
  DesktopMode,
  DesktopSummary,
  RepoSummary,
  TaskSummary
} from "../lib/api/types";
import type { MobileAuthState } from "../lib/firebase/auth";
import type {
  PersistedSessionContext,
  TrustedDesktopRecord
} from "./sessionPersistence";

export type ConnectionState = "idle" | "connecting" | "connected" | "error";
export type MobileView = "tasks" | "recent" | "search" | "desktops" | "more";
export type TaskTerminalStatus = "idle" | "connecting" | "live" | "closed" | "error";
export type RefreshStatus = "idle" | "refreshing" | "updated" | "error";
export type AuthState = MobileAuthState;

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
  taskTerminalTaskId: string | null;
  taskTerminalStatus: TaskTerminalStatus;
  taskTerminalOutput: string;
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
  selectDesktop(desktopId: string): void;
  setRepos(repos: RepoSummary[]): void;
  selectRepo(repoId: string): void;
  setRepoTasks(tasks: TaskSummary[]): void;
  setRecentTasks(tasks: TaskSummary[]): void;
  setSearchResults(query: string, results: TaskSummary[]): void;
  setSelectedTask(taskId: string | null): void;
  setActiveView(view: MobileView): void;
  setPairingCode(code: string | null): void;
  setComposerState(isOpen: boolean, prompt: string): void;
  beginTaskTerminal(taskId: string, initialOutput: string): void;
  appendTaskTerminal(taskId: string, chunk: string): void;
  setTaskTerminalStatus(taskId: string, status: TaskTerminalStatus): void;
  reconcileSelectedTask(): void;
  clearTaskTerminal(): void;
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
    taskTerminalTaskId: null,
    taskTerminalStatus: "idle",
    taskTerminalOutput: ""
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
        (task.snippet ?? null) === (other.snippet ?? null)
      );
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
    getPersistedContext() {
      return {
        selectedDesktopId: state.selectedDesktopId,
        selectedRepoId: state.selectedRepoId,
        selectedTaskId: state.selectedTaskId,
        activeView: state.activeView,
        authUser: state.auth.status === "signedIn" ? state.auth.user : null,
        trustedDesktops: state.trustedDesktops
      };
    },
    hydrateContext(context) {
      state = {
        ...state,
        selectedDesktopId: context.selectedDesktopId,
        selectedRepoId: context.selectedRepoId,
        selectedTaskId: context.selectedTaskId,
        activeView: context.activeView,
        auth: context.authUser
          ? { status: "signedIn", user: context.authUser }
          : state.auth,
        trustedDesktops: context.trustedDesktops ?? []
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
      if (areTaskListsEqual(state.repoTasks, repoTasks)) {
        return;
      }

      state = {
        ...state,
        repoTasks
      };
      publish();
    },
    setRecentTasks(tasks) {
      if (areTaskListsEqual(state.recentTasks, tasks)) {
        return;
      }

      state = {
        ...state,
        recentTasks: tasks
      };
      publish();
    },
    setSearchResults(query, results) {
      state = {
        ...state,
        searchQuery: query,
        searchResults: results
      };
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
          selectedTaskId === null ? "" : state.taskTerminalOutput
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
      state = { ...state, isComposerOpen, composerPrompt };
      publish();
    },
    beginTaskTerminal(taskId, initialOutput) {
      state = {
        ...state,
        taskTerminalTaskId: taskId,
        taskTerminalStatus: "connecting",
        taskTerminalOutput: initialOutput
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
        taskTerminalOutput: nextOutput.slice(-12000)
      };
      publish();
    },
    setTaskTerminalStatus(taskId, taskTerminalStatus) {
      if (state.taskTerminalTaskId !== taskId) {
        return;
      }

      state = {
        ...state,
        taskTerminalStatus
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
        taskTerminalOutput: ""
      };
      publish();
    },
    clearTaskTerminal() {
      state = {
        ...state,
        taskTerminalTaskId: null,
        taskTerminalStatus: "idle",
        taskTerminalOutput: ""
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

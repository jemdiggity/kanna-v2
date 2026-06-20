import type { CreateTaskResponse, RepoSummary, TaskSummary } from "../lib/api/types";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskTerminalSubscription
} from "../lib/api/client";
import type { MobileAuthSession } from "../lib/firebase/auth";
import type { MobileView, SessionStore } from "./sessionStore";

export interface MobileController {
  bootstrap(): Promise<void>;
  connectLocal(): Promise<void>;
  signInWithEmailPassword(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  refresh(): Promise<void>;
  showView(view: MobileView): void;
  selectDesktop(desktopId: string): Promise<void>;
  selectRepo(repoId: string): Promise<void>;
  openTask(taskId: string): void;
  closeTask(): void;
  openComposer(): void;
  closeComposer(): void;
  updateComposerPrompt(prompt: string): void;
  searchTasks(query: string): Promise<void>;
  createTask(): Promise<void>;
  runMergeAgent(taskId: string): Promise<void>;
  advanceDesktopTaskStage(taskId: string): Promise<void>;
  sendTaskInput(taskId: string, input: string): Promise<void>;
  sendTaskAgentPermission(taskId: string, requestId: string, decision: Parameters<TaskAgentSubscription["sendPermission"]>[1]): void;
  interruptTaskAgent(taskId: string): void;
  closeDesktopTask(taskId: string): Promise<void>;
}

const BACKGROUND_REFRESH_INTERVAL_MS = 3_000;

export interface MobileControllerOptions {
  // Live cloud task subscription (onSnapshot). When provided and signed in,
  // the controller reads tasks via this push stream instead of polling.
  subscribeCloudTasks?: (
    uid: string,
    onUpdate: (tasks: TaskSummary[]) => void,
  ) => () => void;
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
        subscription: TaskTerminalSubscription;
      }
    | null = null;
  let activeTaskAgent:
    | {
        taskId: string;
        subscription: TaskAgentSubscription;
      }
    | null = null;
  let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundRefreshInFlight = false;
  let authUnsubscribe: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let bootstrapInFlight: Promise<void> | null = null;
  let liveCloudTasksApplied = false;

  const setTerminalStartupError = (taskId: string, error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Terminal stream failed to start";
    store.setTaskTerminalError(taskId, message);
    store.setErrorMessage(message);
  };

  const findTask = (taskId: string): TaskSummary | null => {
    const state = store.getState();
    return (
      state.repoTasks.find((task) => task.id === taskId) ??
      state.recentTasks.find((task) => task.id === taskId) ??
      state.searchResults.find((task) => task.id === taskId) ??
      null
    );
  };

  const stopTaskTerminal = () => {
    activeTaskTerminal?.subscription.close();
    activeTaskTerminal = null;
  };

  const stopTaskAgent = () => {
    activeTaskAgent?.subscription.close();
    activeTaskAgent = null;
  };

  const stopTaskSession = () => {
    stopTaskTerminal();
    stopTaskAgent();
  };

  const reconcileSelectedTask = () => {
    const selectedTaskId = store.getState().selectedTaskId;
    if (!selectedTaskId || findTask(selectedTaskId)) {
      return;
    }

    stopTaskSession();
    store.reconcileSelectedTask();
  };

  const refreshSearchResults = async () => {
    const query = store.getState().searchQuery.trim();
    if (!query) {
      return;
    }

    const results = await client.searchTasks(query);
    if (store.getState().searchQuery.trim() !== query) {
      return;
    }

    store.setSearchResults(query, results);
  };

  const loadRepoTasks = async (repoId: string | null) => {
    if (!repoId) {
      store.setRepoTasks([]);
      return;
    }

    const repoTasks = await client.listRepoTasks(repoId);
    store.setRepoTasks(repoTasks);
  };

  const startTaskTerminal = (taskId: string) => {
    if (activeTaskTerminal?.taskId === taskId) {
      return;
    }

    stopTaskTerminal();

    store.beginTaskTerminal(taskId, "");

    try {
      const subscription = client.observeTaskTerminal(taskId, (event) => {
        switch (event.type) {
          case "ready":
            store.setTaskTerminalStatus(taskId, "live");
            break;
          case "output":
            store.appendTaskTerminal(taskId, `${event.dataB64}\n`);
            break;
          case "exit":
            store.setTaskTerminalStatus(taskId, "closed");
            break;
          case "error":
            store.setTaskTerminalError(taskId, event.message);
            break;
        }
      });

      activeTaskTerminal = { taskId, subscription };
    } catch (error) {
      setTerminalStartupError(taskId, error);
    }
  };

  const startTaskAgent = (taskId: string) => {
    if (activeTaskAgent?.taskId === taskId) {
      return;
    }

    stopTaskSession();
    store.clearTaskTerminal();
    store.beginTaskAgent(taskId);

    try {
      const subscription = client.observeTaskAgent(taskId, (event) => {
        store.applyTaskAgentStreamEvent(taskId, event);
      });

      activeTaskAgent = { taskId, subscription };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Agent stream failed to start";
      store.applyTaskAgentStreamEvent(taskId, { type: "error", message });
      store.setErrorMessage(message);
    }
  };

  const startTaskView = (taskId: string) => {
    const task = findTask(taskId);
    if (task?.agentType === "agent") {
      startTaskAgent(taskId);
    } else {
      stopTaskAgent();
      store.clearTaskAgent();
      startTaskTerminal(taskId);
    }
  };

  const loadCollections = async () => {
    const [desktops, repos, recentTasks] = await Promise.all([
      client.listDesktops(),
      client.listRepos(),
      client.listRecentTasks()
    ]);

    store.setDesktops(desktops);
    store.setRepos(mergeReposWithTaskRepos(repos, recentTasks));
    store.setRecentTasks(recentTasks);
    await loadRepoTasks(store.getState().selectedRepoId);
    await refreshSearchResults();
    reconcileSelectedTask();
  };

  const refreshTaskCollections = async () => {
    const selectedRepoId = store.getState().selectedRepoId;
    const [recentTasks, repoTasks] = await Promise.all([
      client.listRecentTasks(),
      selectedRepoId ? client.listRepoTasks(selectedRepoId) : Promise.resolve([])
    ]);
    store.setRepos(mergeReposWithTaskRepos(store.getState().repos, recentTasks));
    store.setRecentTasks(recentTasks);
    store.setRepoTasks(repoTasks);
    await refreshSearchResults();
    reconcileSelectedTask();
  };

  const applyLiveCloudTasks = (tasks: TaskSummary[]) => {
    liveCloudTasksApplied = true;
    tasks = uniqueTasksById(tasks);
    store.setRepos(mergeReposWithTaskRepos(store.getState().repos, tasks));
    store.setRecentTasks(tasks);
    let selectedRepoId = store.getState().selectedRepoId;
    const selectedRepoHasTasks = tasks.some((task) => task.repoId === selectedRepoId);
    if (!selectedRepoId || !selectedRepoHasTasks) {
      selectedRepoId = tasks[0]?.repoId ?? null;
      if (selectedRepoId) {
        store.selectRepo(selectedRepoId);
      }
    }
    store.setRepoTasks(
      selectedRepoId ? tasks.filter((task) => task.repoId === selectedRepoId) : [],
    );
    void refreshSearchResults();
    reconcileSelectedTask();
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

  const startCloudTaskSubscription = (uid: string): boolean => {
    if (!options.subscribeCloudTasks) return false;
    stopCloudTaskSubscription();
    cloudTasksUnsubscribe = options.subscribeCloudTasks(uid, applyLiveCloudTasks);
    return true;
  };

  const stopCloudTaskSubscription = () => {
    cloudTasksUnsubscribe?.();
    cloudTasksUnsubscribe = null;
    liveCloudTasksApplied = false;
  };

  const startBackgroundRefresh = () => {
    if (backgroundRefreshTimer) {
      return;
    }

    backgroundRefreshTimer = setInterval(() => {
      if (backgroundRefreshInFlight || store.getState().connectionState !== "connected") {
        return;
      }

      backgroundRefreshInFlight = true;
      void refreshTaskCollections()
        .catch(fail)
        .finally(() => {
          backgroundRefreshInFlight = false;
        });
    }, BACKGROUND_REFRESH_INTERVAL_MS);
  };

  const fail = (error: unknown) => {
    store.setConnectionState("error");
    store.setErrorMessage(error instanceof Error ? error.message : "Mobile app request failed");
  };

  const initializeAuth = async () => {
    if (!authSession) {
      return;
    }

    await authSession.initialize();
    store.setAuthState(authSession.getState());
    if (!authUnsubscribe) {
      authUnsubscribe = authSession.subscribe((authState) => {
        const previousAuthStatus = store.getState().auth.status;
        store.setAuthState(authState);
        if (authState.status !== "signedIn") {
          stopCloudTaskSubscription();
        }
        if (previousAuthStatus !== "signedIn" && authState.status === "signedIn") {
          void bootstrap().catch(fail);
        }
      });
    }
  };

  const bootstrap = (): Promise<void> => {
    if (!bootstrapInFlight) {
      bootstrapInFlight = doBootstrap().finally(() => {
        bootstrapInFlight = null;
      });
    }
    return bootstrapInFlight;
  };

  const doBootstrap = async () => {
      store.setErrorMessage(null);
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
          store.setConnectionState("idle");
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
        if (liveCloudTasksApplied) {
          store.setDesktops(await client.listDesktops());
          await refreshSearchResults();
          reconcileSelectedTask();
        } else {
          await loadCollections();
        }
        if (!useLiveCloudTasks) {
          startBackgroundRefresh();
        }
        const selectedTaskId = store.getState().selectedTaskId;
        if (selectedTaskId) {
          startTaskView(selectedTaskId);
        }
      } catch (error) {
        fail(error);
      }
    };

  return {
    bootstrap,

    async connectLocal() {
      store.setConnectionState("connecting");
      store.setErrorMessage(null);

      try {
        const pairing = await client.createPairingSession();
        await bootstrap();
        store.setPairingCode(pairing.code);
      } catch (error) {
        fail(error);
      }
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

    showView(view) {
      store.setActiveView(view);
    },

    async selectDesktop(desktopId) {
      stopTaskSession();
      store.selectDesktop(desktopId);
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
      await this.bootstrap();
      store.setActiveView("tasks");
    },

    async selectRepo(repoId) {
      store.selectRepo(repoId);
      try {
        await loadRepoTasks(repoId);
        store.setErrorMessage(null);
      } catch (error) {
        fail(error);
      }
    },

    openTask(taskId) {
      store.setSelectedTask(taskId);
      store.setActiveView("tasks");
      startTaskView(taskId);
    },

    closeTask() {
      stopTaskSession();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
    },

    openComposer() {
      store.setComposerState(true, store.getState().composerPrompt);
    },

    closeComposer() {
      store.setComposerState(false, "");
    },

    updateComposerPrompt(prompt) {
      store.setComposerState(store.getState().isComposerOpen, prompt);
    },

    async searchTasks(query) {
      store.setErrorMessage(null);
      if (!query.trim()) {
        store.setSearchResults("", []);
        store.setActiveView("tasks");
        return;
      }

      try {
        const results = await client.searchTasks(query);
        store.setSearchResults(query, results);
        store.setActiveView("search");
      } catch (error) {
        fail(error);
      }
    },

    async createTask() {
      const state = store.getState();
      if (!state.selectedRepoId || !state.composerPrompt.trim()) {
        store.setErrorMessage("Choose a repo and enter a task prompt first.");
        return;
      }

      try {
        const created = await client.createTask({
          repoId: state.selectedRepoId,
          prompt: state.composerPrompt.trim()
        });
        const createdTask = mapCreatedTask(created);
        const recentTasks = [
          createdTask,
          ...state.recentTasks.filter((task) => task.id !== createdTask.id)
        ];
        const repoTasks =
          state.selectedRepoId === createdTask.repoId
            ? [createdTask, ...state.repoTasks.filter((task) => task.id !== createdTask.id)]
            : state.repoTasks;

        store.setRecentTasks(recentTasks);
        store.setRepoTasks(repoTasks);
        store.setComposerState(false, "");
        store.setErrorMessage(null);
        this.openTask(createdTask.id);
      } catch (error) {
        fail(error);
      }
    },

    async runMergeAgent(taskId) {
      try {
        const response = await client.runMergeAgent(taskId);
        await refreshTaskCollections();
        store.setErrorMessage(null);
        this.openTask(response.taskId);
      } catch (error) {
        fail(error);
      }
    },

    async advanceDesktopTaskStage(taskId) {
      try {
        const response = await client.advanceTaskStage(taskId);
        await refreshTaskCollections();
        store.setErrorMessage(null);
        this.openTask(response.taskId);
      } catch (error) {
        fail(error);
      }
    },

    async sendTaskInput(taskId, input) {
      if (!input.trim()) {
        return;
      }

      try {
        const task = findTask(taskId);
        if (task?.agentType === "agent" && activeTaskAgent?.taskId === taskId) {
          activeTaskAgent.subscription.sendInput(input.trim());
        } else {
          await client.sendTaskInput(taskId, encodeSubmittedTaskInput(input, task));
        }
        store.setErrorMessage(null);
      } catch (error) {
        fail(error);
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

    async closeDesktopTask(taskId) {
      try {
        await client.closeTask(taskId);
        stopTaskSession();
        await refreshTaskCollections();
        store.setSelectedTask(null);
        store.clearTaskTerminal();
        store.clearTaskAgent();
        store.setActiveView("tasks");
        store.setErrorMessage(null);
      } catch (error) {
        fail(error);
      }
    }
  };
}

function mapCreatedTask(response: CreateTaskResponse): TaskSummary {
  return {
    id: response.taskId,
    repoId: response.repoId,
    title: response.title,
    stage: response.stage,
    agentType: response.agentType ?? null
  };
}

function encodeSubmittedTaskInput(input: string, task: TaskSummary | null): string {
  const submit = task?.agentProvider && task.agentProvider !== "claude" ? "\r" : "\x1b[13u";
  return `\x1b[200~${input}\x1b[201~${submit}`;
}

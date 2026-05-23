import type { CreateTaskResponse, TaskSummary } from "../lib/api/types";
import type { KannaClient, TaskTerminalSubscription } from "../lib/api/client";
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
  closeDesktopTask(taskId: string): Promise<void>;
}

const BACKGROUND_REFRESH_INTERVAL_MS = 3_000;

export function createMobileController(
  client: KannaClient,
  store: SessionStore,
  authSession?: MobileAuthSession
): MobileController {
  let activeTaskTerminal:
    | {
        taskId: string;
        subscription: TaskTerminalSubscription;
      }
    | null = null;
  let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundRefreshInFlight = false;
  let authUnsubscribe: (() => void) | null = null;

  const setTerminalStartupError = (taskId: string, error: unknown) => {
    store.setTaskTerminalStatus(taskId, "error");
    store.setErrorMessage(
      error instanceof Error ? error.message : "Terminal stream failed to start"
    );
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

  const reconcileSelectedTask = () => {
    const selectedTaskId = store.getState().selectedTaskId;
    if (!selectedTaskId || findTask(selectedTaskId)) {
      return;
    }

    stopTaskTerminal();
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

    const task = findTask(taskId);
    store.beginTaskTerminal(taskId, task?.snippet?.trim() ? `${task.snippet}\n\n` : "");

    try {
      const subscription = client.observeTaskTerminal(taskId, (event) => {
        switch (event.type) {
          case "ready":
            store.setTaskTerminalStatus(taskId, "live");
            break;
          case "output":
            store.appendTaskTerminal(taskId, event.text);
            break;
          case "exit":
            store.setTaskTerminalStatus(taskId, "closed");
            break;
          case "error":
            store.setTaskTerminalStatus(taskId, "error");
            break;
        }
      });

      activeTaskTerminal = { taskId, subscription };
    } catch (error) {
      setTerminalStartupError(taskId, error);
    }
  };

  const loadCollections = async () => {
    const [desktops, repos, recentTasks] = await Promise.all([
      client.listDesktops(),
      client.listRepos(),
      client.listRecentTasks()
    ]);

    store.setDesktops(desktops);
    store.setRepos(repos);
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
    store.setRecentTasks(recentTasks);
    store.setRepoTasks(repoTasks);
    await refreshSearchResults();
    reconcileSelectedTask();
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
        store.setAuthState(authState);
      });
    }
  };

  return {
    async bootstrap() {
      store.setErrorMessage(null);
      await initializeAuth();

      try {
        const status = await client.getStatus();
        store.setDesktopStatus(status.state, status.desktopName, status.pairingCode);

        if (status.state !== "running") {
          store.setConnectionState("idle");
          return;
        }

        store.setConnectionMode(status.lanHost === "cloud" ? "remote" : "lan");
        store.setConnectionState("connected");
        await loadCollections();
        startBackgroundRefresh();
        const selectedTaskId = store.getState().selectedTaskId;
        if (selectedTaskId) {
          startTaskTerminal(selectedTaskId);
        }
      } catch (error) {
        fail(error);
      }
    },

    async connectLocal() {
      store.setConnectionState("connecting");
      store.setErrorMessage(null);

      try {
        const pairing = await client.createPairingSession();
        await this.bootstrap();
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

    async refresh() {
      store.setRefreshStatus("refreshing");
      if (store.getState().selectedTaskId) {
        stopTaskTerminal();
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
      stopTaskTerminal();
      store.selectDesktop(desktopId);
      store.setSelectedTask(null);
      store.clearTaskTerminal();
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
      startTaskTerminal(taskId);
    },

    closeTask() {
      stopTaskTerminal();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
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
        await client.sendTaskInput(taskId, normalizeSubmittedInput(input));
        store.setErrorMessage(null);
      } catch (error) {
        fail(error);
      }
    },

    async closeDesktopTask(taskId) {
      try {
        await client.closeTask(taskId);
        stopTaskTerminal();
        await refreshTaskCollections();
        store.setSelectedTask(null);
        store.clearTaskTerminal();
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
    stage: response.stage
  };
}

function normalizeSubmittedInput(input: string): string {
  return input.endsWith("\n") ? input : `${input}\n`;
}

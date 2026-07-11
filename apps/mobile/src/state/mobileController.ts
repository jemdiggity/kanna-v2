import type { CreateTaskResponse, RepoSummary, TaskSummary } from "../lib/api/types";
import type {
  KannaClient,
  TaskAgentSubscription,
  TaskTerminalSubscription
} from "../lib/api/client";
import type { MobileAuthSession } from "../lib/firebase/auth";
import type { ComposerAgentProvider, MobileView, SessionStore } from "./sessionStore";

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
  selectComposerDesktop(desktopId: string): void;
  setComposerOptionsExpanded(isExpanded: boolean): void;
  selectComposerAgentProvider(provider: ComposerAgentProvider): void;
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
    onError?: (error: unknown) => void,
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
  let backgroundRefreshMode: "collections" | "desktops" = "collections";
  let authUnsubscribe: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
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
  let liveRepositoryRevision = 0;
  let desktopCollectionsRevision = 0;
  let refreshDesktopsInFlight: Promise<void> | null = null;
  const pendingActionTaskIdentities = new Map<
    string,
    { ownerDesktopId: string | null }
  >();

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

  const setTerminalStartupError = (taskId: string, error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Terminal stream failed to start";
    store.setTaskTerminalError(taskId, message);
    setUnownedErrorMessage(message);
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

  const resolveTaskActionDisplayId = (
    responseTaskId: string,
    ownerDesktopId: string | null
  ): string | null => {
    const state = store.getState();
    const candidates = new Map<string, TaskSummary>();
    for (const task of [
      ...state.repoTasks,
      ...state.recentTasks,
      ...state.searchResults
    ]) {
      if (task.id === responseTaskId) continue;
      if (task.ownerLocalTaskId !== responseTaskId) continue;
      if (ownerDesktopId && task.ownerDesktopId !== ownerDesktopId) continue;
      candidates.set(task.id, task);
    }
    if (candidates.size === 1) {
      return candidates.values().next().value!.id;
    }
    return findTask(responseTaskId)?.id ?? null;
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
    if (!selectedTaskId) {
      return;
    }

    const pendingIdentity = pendingActionTaskIdentities.get(selectedTaskId);
    if (pendingIdentity) {
      const displayTaskId = resolveTaskActionDisplayId(
        selectedTaskId,
        pendingIdentity.ownerDesktopId
      );
      if (displayTaskId) {
        if (displayTaskId !== selectedTaskId) {
          pendingActionTaskIdentities.delete(selectedTaskId);
          store.setSelectedTask(displayTaskId);
        }
      }
      return;
    }

    if (findTask(selectedTaskId)) {
      return;
    }

    stopTaskSession();
    store.reconcileSelectedTask();
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
    return true;
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
            if (event.cols && event.rows) {
              store.setTaskTerminalDims(taskId, event.cols, event.rows);
            }
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
      setUnownedErrorMessage(message);
    }
  };

  const startTaskView = (taskId: string) => {
    const task = findTask(taskId);
    if (!task) {
      return;
    }
    if (task.agentType === "agent") {
      startTaskAgent(taskId);
    } else {
      stopTaskAgent();
      store.clearTaskAgent();
      startTaskTerminal(taskId);
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
    store.setRepos(mergeReposWithTaskRepos(repos, recentTasks));
    store.setRecentTasks(recentTasks);
    if (!(await loadRepoTasks(store.getState().selectedRepoId))) {
      return;
    }
    if (!(await refreshSearchResults())) {
      return;
    }
    reconcileSelectedTask();
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

  const refreshTaskCollections = async () => {
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
        return;
      }
      throw error;
    }
    if (
      taskCollectionsRevision !== readRevision ||
      store.getState().selectedRepoId !== selectedRepoId
    ) {
      return;
    }

    taskCollectionsRevision += 1;
    store.setRepos(mergeReposWithTaskRepos(store.getState().repos, recentTasks));
    store.setRecentTasks(recentTasks);
    store.setRepoTasks(repoTasks);
    if (!(await refreshSearchResults())) {
      return;
    }
    reconcileSelectedTask();
  };

  const applyLiveCloudTasks = (tasks: TaskSummary[], subscriptionEpoch: number) => {
    tasks = uniqueTasksById(tasks);
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
        selectedRepo && !selectedRepoHasTask ? [selectedRepo] : [],
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
    reconcileSelectedTask();
    const ownedError = cloudSubscriptionError;
    if (ownedError?.epoch === subscriptionEpoch) {
      cloudSubscriptionError = null;
      publishOwnedErrorMessage();
    }
    const selectedTaskId = store.getState().selectedTaskId;
    if (selectedTaskId && findTask(selectedTaskId)) {
      startTaskView(selectedTaskId);
    }

    void client.listRepos().then((repos) => {
      if (
        subscriptionEpoch !== cloudSubscriptionEpoch ||
        repositoryRevision !== liveRepositoryRevision
      ) {
        return;
      }
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
      (tasks) => {
        if (epoch !== cloudSubscriptionEpoch) {
          return;
        }
        applyLiveCloudTasks(tasks, epoch);
      },
      (error) => {
        if (epoch !== cloudSubscriptionEpoch) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Cloud task subscription failed";
        cloudSubscriptionError = { epoch, message };
        publishOwnedErrorMessage();
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
    store.setRepos([]);
    store.setRecentTasks([]);
    store.setRepoTasks([]);
    store.setSearchResults(store.getState().searchQuery, []);
    pendingActionTaskIdentities.clear();
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
        if (selectedTaskId && findTask(selectedTaskId)) {
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
      setUnownedErrorMessage(null);

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
      taskCollectionsRevision += 1;
      stopTaskSession();
      store.selectDesktop(desktopId);
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
      await this.bootstrap();
      store.setActiveView("tasks");
    },

    async selectRepo(repoId) {
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
    },

    openTask(taskId) {
      taskCollectionsRevision += 1;
      store.setSelectedTask(taskId);
      store.setActiveView("tasks");
      startTaskView(taskId);
    },

    closeTask() {
      taskCollectionsRevision += 1;
      stopTaskSession();
      store.setSelectedTask(null);
      store.clearTaskTerminal();
      store.clearTaskAgent();
    },

    openComposer() {
      const state = store.getState();
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

      store.setComposerDesktop(composerDesktopId);
      store.setComposerAgentProvider(profile?.agentProvider ?? "claude");
      store.setComposerOptionsExpanded(!composerDesktopId);
      store.setComposerState(true, state.composerPrompt);
    },

    closeComposer() {
      store.setComposerState(false, "");
    },

    updateComposerPrompt(prompt) {
      store.setComposerState(store.getState().isComposerOpen, prompt);
    },

    selectComposerDesktop(desktopId) {
      store.setComposerDesktop(desktopId);
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
        store.setActiveView("tasks");
        return;
      }

      try {
        const results = await client.searchTasks(query);
        if (taskCollectionsRevision !== searchRevision) {
          return;
        }
        taskCollectionsRevision += 1;
        store.setSearchResults(query, results);
        store.setActiveView("search");
      } catch (error) {
        if (taskCollectionsRevision === searchRevision) {
          fail(error);
        }
      }
    },

    async createTask() {
      const state = store.getState();
      if (!state.selectedRepoId || !state.composerPrompt.trim()) {
        store.setComposerErrorMessage("Choose a repo and enter a task prompt first.");
        store.setComposerSubmitting(false);
        return;
      }

      const composerDesktopId = resolveKnownDesktopId(state.composerDesktopId);
      if (!composerDesktopId) {
        store.setComposerDesktop(null);
        store.setComposerErrorMessage("Choose a machine for this repo first.");
        store.setComposerOptionsExpanded(true);
        store.setComposerSubmitting(false);
        return;
      }

      store.setComposerSubmitting(true);
      store.setComposerErrorMessage(null);
      try {
        const created = await client.createTask({
          repoId: state.selectedRepoId,
          prompt: state.composerPrompt.trim(),
          desktopId: composerDesktopId,
          agentProvider: state.composerAgentProvider,
          agentType: "pty"
        });
        taskCollectionsRevision += 1;
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
        store.upsertRepoCreationProfile({
          repoId: state.selectedRepoId,
          desktopId: composerDesktopId,
          agentProvider: state.composerAgentProvider,
          updatedAt: new Date().toISOString()
        });
        store.setComposerState(false, "");
        setUnownedErrorMessage(null);
        this.openTask(createdTask.id);
      } catch (error) {
        store.setComposerErrorMessage(
          error instanceof Error ? error.message : "Task creation failed"
        );
      } finally {
        store.setComposerSubmitting(false);
      }
    },

    async runMergeAgent(taskId) {
      try {
        const ownerDesktopId =
          findTask(taskId)?.ownerDesktopId ??
          store.getState().selectedDesktopId;
        const response = await client.runMergeAgent(taskId);
        if (response.taskId !== taskId) {
          pendingActionTaskIdentities.set(response.taskId, { ownerDesktopId });
        }
        taskCollectionsRevision += 1;
        await refreshTaskCollections();
        setUnownedErrorMessage(null);
        const displayTaskId = resolveTaskActionDisplayId(
          response.taskId,
          ownerDesktopId
        );
        if (displayTaskId && displayTaskId !== response.taskId) {
          pendingActionTaskIdentities.delete(response.taskId);
        }
        this.openTask(displayTaskId ?? response.taskId);
      } catch (error) {
        fail(error);
      }
    },

    async advanceDesktopTaskStage(taskId) {
      try {
        const ownerDesktopId =
          findTask(taskId)?.ownerDesktopId ??
          store.getState().selectedDesktopId;
        const response = await client.advanceTaskStage(taskId);
        if (response.taskId !== taskId) {
          pendingActionTaskIdentities.set(response.taskId, { ownerDesktopId });
        }
        taskCollectionsRevision += 1;
        await refreshTaskCollections();
        setUnownedErrorMessage(null);
        const displayTaskId = resolveTaskActionDisplayId(
          response.taskId,
          ownerDesktopId
        );
        if (displayTaskId && displayTaskId !== response.taskId) {
          pendingActionTaskIdentities.delete(response.taskId);
        }
        this.openTask(displayTaskId ?? response.taskId);
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
        setUnownedErrorMessage(null);
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
        taskCollectionsRevision += 1;
        stopTaskSession();
        await refreshTaskCollections();
        store.setSelectedTask(null);
        store.clearTaskTerminal();
        store.clearTaskAgent();
        store.setActiveView("tasks");
        setUnownedErrorMessage(null);
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
      task.snippet?.toLowerCase().includes(normalizedQuery) === true
  );
}

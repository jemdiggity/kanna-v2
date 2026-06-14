import { createKannaClient, type KannaClient } from "./lib/api/client";
import {
  createBonjourBrowser,
  type BonjourBrowser
} from "./lib/discovery/bonjour";
import { resolveTrustedBonjourEndpoint } from "./lib/discovery/trustedBonjour";
import type { MobileAuthSession } from "./lib/firebase/auth";
import { createConfiguredMobileAuthSession } from "./lib/firebase/sdk";
import {
  createFirestoreTaskIndex,
  type CloudTaskIndex
} from "./lib/firebase/taskIndex";
import { createLanTransport, type FetchLike } from "./lib/transports/lanTransport";
import {
  createRelayDesktopClient,
  type RelayDesktopClient
} from "./lib/transports/relayClient";
import { createRemoteTransport } from "./lib/transports/remoteTransport";
import { readExpoConfig } from "./lib/expoConfig";
import { createRootNavigator } from "./navigation/RootNavigator";
import { installE2eTrustSeedHandler } from "./e2eTrustSeed";
import {
  createMobileController,
  type MobileController
} from "./state/mobileController";
import { createSessionStore, type SessionStore } from "./state/sessionStore";
import {
  createDefaultSessionPersistence,
  type SessionPersistence,
  type TrustedDesktopRecord
} from "./state/sessionPersistence";
import { readKannaExpoExtra } from "./mobileEnvironment";
import type { RepoSummary, TaskSummary } from "./lib/api/types";

const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";

interface ExpoPublicEnv {
  EXPO_PUBLIC_KANNA_RELAY_URL?: string;
  EXPO_PUBLIC_KANNA_FORCE_CLOUD?: string;
}

interface RelayUrlOptions {
  dev?: boolean;
  extraRelayUrl?: string | null;
}

export interface AppModel {
  client: KannaClient;
  controller: MobileController;
  initialize(): Promise<void>;
  navigator: ReturnType<typeof createRootNavigator>;
  sessionStore: SessionStore;
  setForceCloud(enabled: boolean): void;
}

interface AppModelOptions {
  forceCloud?: boolean;
  relayUrl?: string | null;
  taskIndex?: CloudTaskIndex;
  bonjourBrowser?: BonjourBrowser;
  enableE2eTrustSeed?: boolean;
  createRelayClient?: (input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
  }) => RelayDesktopClient;
}

export interface CreateAppModelInput {
  fetchImpl?: FetchLike;
  persistence?: SessionPersistence;
  authSession?: MobileAuthSession;
  options?: AppModelOptions;
}

function readExpoPublicEnv(): ExpoPublicEnv {
  const globalEnv = (globalThis as { process?: { env?: ExpoPublicEnv } }).process?.env;
  return globalEnv ?? {};
}

function isDevRuntime(): boolean {
  return (globalThis as { __DEV__?: boolean }).__DEV__ === true;
}

export function resolveRelayUrl(
  env: ExpoPublicEnv = readExpoPublicEnv(),
  options: RelayUrlOptions = {},
): string | null {
  if (env.EXPO_PUBLIC_KANNA_RELAY_URL !== undefined) {
    const relayUrl = env.EXPO_PUBLIC_KANNA_RELAY_URL.trim();
    return relayUrl && relayUrl.length > 0 ? relayUrl : null;
  }

  const extraRelayUrl = normalizeOptionalString(options.extraRelayUrl);
  if (extraRelayUrl) {
    return extraRelayUrl;
  }

  if (options.dev ?? isDevRuntime()) return null;

  return PRODUCTION_RELAY_URL;
}

export function resolveForceCloud(env: ExpoPublicEnv = readExpoPublicEnv()): boolean {
  const rawValue = env.EXPO_PUBLIC_KANNA_FORCE_CLOUD?.trim().toLowerCase();
  return rawValue === "1" || rawValue === "true" || rawValue === "yes";
}

export function createAppModel(input: CreateAppModelInput = {}): AppModel {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const persistence = input.persistence;
  const authSession = input.authSession ?? createConfiguredMobileAuthSession();
  const options = input.options ?? {};
  const bonjourBrowser = options.bonjourBrowser ?? createBonjourBrowser();
  const sessionStore = createSessionStore();
  const extra = readKannaExpoExtra(readExpoConfig());
  let forceCloud = options.forceCloud ?? resolveForceCloud();
  // Lazily create the cloud task index only when the live subscription is
  // actually used (sign-in time, when Firebase is initialized). Creating it
  // eagerly would call getFirestore() before any Firebase app exists in
  // LAN-only / no-Firebase paths.
  let cloudTaskIndex: ReturnType<typeof createFirestoreTaskIndex> | null = null;
  let liveCloudHasTasks = false;
  let liveCloudTasks: TaskSummary[] = [];
  let liveCloudSubscriptionActive = false;
  const getCloudTaskIndex = () =>
    (cloudTaskIndex ??= options.taskIndex ?? createFirestoreTaskIndex());
  const resolveClient = () =>
    createClientForMode({
      authSession,
      bonjourBrowser,
      createRelayClient: options.createRelayClient ?? createRelayDesktopClient,
      fetchImpl,
      forceCloud,
      getSelectedDesktopId: () => sessionStore.getState().selectedDesktopId,
      getTrustedDesktops: () => sessionStore.getState().trustedDesktops,
      getLiveCloudTasks: () => liveCloudTasks,
      hasLiveCloudTasks: () => liveCloudHasTasks,
      isLiveCloudSubscriptionActive: () => liveCloudSubscriptionActive,
      relayUrl: options.relayUrl ?? resolveRelayUrl(readExpoPublicEnv(), {
        extraRelayUrl: extra?.relayUrl
      }),
      taskIndex: options.taskIndex
    });
  let activeClient = resolveClient();
  const client = createDelegatingClient(() => activeClient);
  const controller = createMobileController(client, sessionStore, authSession, {
    subscribeCloudTasks: (uid, onUpdate) => {
      liveCloudSubscriptionActive = true;
      const unsubscribe = getCloudTaskIndex().subscribeRecentTasks(uid, (tasks) => {
        liveCloudTasks = tasks;
        liveCloudHasTasks = tasks.length > 0;
        onUpdate(tasks);
      });
      return () => {
        liveCloudSubscriptionActive = false;
        liveCloudTasks = [];
        liveCloudHasTasks = false;
        unsubscribe();
      };
    },
  });
  let persistencePromise: Promise<SessionPersistence> | null = persistence
    ? Promise.resolve(persistence)
    : null;

  const getPersistence = () => {
    if (!persistencePromise) {
      persistencePromise = createDefaultSessionPersistence();
    }

    return persistencePromise;
  };

  let lastSavedContextJson: string | null = null;
  const hydratePersistedContext = async () => {
    const resolvedPersistence = await getPersistence();
    const persistedContext = await resolvedPersistence.load();
    if (persistedContext) {
      sessionStore.hydrateContext(persistedContext);
      lastSavedContextJson = JSON.stringify(persistedContext);
    }
    activeClient = resolveClient();
  };
  const persistContext = () => {
    const context = sessionStore.getPersistedContext();
    const serializedContext = JSON.stringify(context);
    if (serializedContext === lastSavedContextJson) {
      return;
    }

    lastSavedContextJson = serializedContext;
    void getPersistence().then((resolvedPersistence) => resolvedPersistence.save(context));
  };

  sessionStore.subscribe(persistContext);
  authSession.subscribe(() => {
    activeClient = resolveClient();
  });

  if (options.enableE2eTrustSeed) {
    installE2eTrustSeedHandler({
      getPersistence,
      async reload() {
        await hydratePersistedContext();
        await controller.bootstrap();
      }
    });
  }

  return {
    client,
    controller,
    async initialize() {
      bonjourBrowser.start();
      await hydratePersistedContext();
      await controller.bootstrap();
    },
    navigator: createRootNavigator(),
    sessionStore,
    setForceCloud(enabled) {
      forceCloud = enabled;
      activeClient = resolveClient();
    }
  };
}

function createClientForMode({
  authSession,
  bonjourBrowser,
  createRelayClient,
  fetchImpl,
  forceCloud,
  getSelectedDesktopId,
  getTrustedDesktops,
  getLiveCloudTasks,
  hasLiveCloudTasks,
  isLiveCloudSubscriptionActive,
  relayUrl,
  taskIndex,
}: {
  authSession: MobileAuthSession;
  bonjourBrowser: BonjourBrowser;
  createRelayClient(input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
  }): RelayDesktopClient;
  fetchImpl: FetchLike;
  forceCloud: boolean;
  getSelectedDesktopId(): string | null;
  getTrustedDesktops(): readonly TrustedDesktopRecord[];
  getLiveCloudTasks(): TaskSummary[];
  hasLiveCloudTasks(): boolean;
  isLiveCloudSubscriptionActive(): boolean;
  relayUrl: string | null;
  taskIndex?: CloudTaskIndex;
}): KannaClient {
  const authState = authSession.getState();
  if (authState.status === "signedIn" && relayUrl) {
    const relayClient = createRelayClient({
      relayUrl,
      getIdToken: (forceRefresh) => authSession.getIdToken(forceRefresh),
    });
    const resolvedTaskIndex = taskIndex ?? createFirestoreTaskIndex();
    const listCloudTasksForRouting = async () => {
      const liveTasks = getLiveCloudTasks();
      if (liveTasks.length > 0 || hasLiveCloudTasks()) {
        return liveTasks;
      }
      return resolvedTaskIndex.listRecentTasks(authState.user.uid);
    };
    const cloudClient = createKannaClient(
      createRemoteTransport({
        async listDesktopRecords() {
          return getTrustedDesktops().map(mapTrustedDesktopRecord);
        },
        getSelectedDesktopId,
        invokeDesktop: relayClient.invokeDesktop,
        observeTaskTerminal: relayClient.observeTaskTerminal,
        observeTaskAgent: relayClient.observeTaskAgent,
        sendTaskInput: relayClient.sendTaskInput,
        listCloudTasks: listCloudTasksForRouting,
      }),
    );
    const lanClient = createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktops
    });

    return createCloudWithLanFallbackClient(cloudClient, lanClient, {
      getLiveCloudTasks,
      hasLiveCloudTasks,
      isLiveCloudSubscriptionActive,
      isLanFallbackEnabled: () =>
        !forceCloud && hasTrustedLanPeer(getTrustedDesktops())
    });
  }

  if (hasTrustedLanPeer(getTrustedDesktops())) {
    return createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktops
    });
  }

  return createDisconnectedClient();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function createDisconnectedClient(): KannaClient {
  const unavailable = async () => {
    throw new Error("No trusted desktop is available. Sign in or pair a desktop.");
  };

  return {
    getStatus: async () => ({
      state: "stopped",
      desktopId: "none",
      desktopName: "No desktop",
      lanHost: "none",
      lanPort: 0,
      pairingCode: null
    }),
    listDesktops: async () => [],
    listRepos: async () => [],
    listRepoTasks: async () => [],
    listRecentTasks: async () => [],
    searchTasks: async () => [],
    createTask: unavailable,
    runMergeAgent: unavailable,
    advanceTaskStage: unavailable,
    closeTask: unavailable,
    sendTaskInput: unavailable,
    observeTaskTerminal(taskId, listener) {
      listener({
        type: "error",
        taskId,
        message: "No trusted desktop is available."
      });
      return { close() {} };
    },
    observeTaskAgent(taskId, listener) {
      listener({
        type: "error",
        taskId,
        message: "No trusted desktop is available."
      });
      return {
        close() {},
        sendInput() {},
        sendPermission() {},
        interrupt() {}
      };
    },
    createPairingSession: unavailable
  };
}

export interface CloudWithLanFallbackOptions {
  getLiveCloudTasks?: () => TaskSummary[];
  hasLiveCloudTasks?: () => boolean;
  isLiveCloudSubscriptionActive?: () => boolean;
  isLanFallbackEnabled(): boolean;
}

export function createCloudWithLanFallbackClient(
  cloudClient: KannaClient,
  lanClient: KannaClient,
  options: CloudWithLanFallbackOptions
): KannaClient {
  const lanFallbackEnabled = () => options.isLanFallbackEnabled();
  const liveCloudTasks = () => options.getLiveCloudTasks?.() ?? [];
  const cloudHasVisibleTasks = () =>
    liveCloudTasks().length > 0 || options.hasLiveCloudTasks?.() === true;
  const liveCloudSubscriptionActive = () =>
    options.isLiveCloudSubscriptionActive?.() === true;

  const listRecentTasks = async () => {
    const tasks = liveCloudTasks();
    if (tasks.length > 0) {
      return tasks;
    }
    if (liveCloudSubscriptionActive()) {
      return lanFallbackEnabled() ? lanClient.listRecentTasks() : [];
    }
    if (!lanFallbackEnabled()) return cloudClient.listRecentTasks();
    return lanClient.listRecentTasks();
  };

  const useLanFallback = () => lanFallbackEnabled() && !cloudHasVisibleTasks();

  return {
    getStatus: async () => {
      if (!lanFallbackEnabled()) {
        return cloudClient.getStatus();
      }

      try {
        if (cloudHasVisibleTasks()) {
          return cloudClient.getStatus();
        }
      } catch {
      }

      return lanClient.getStatus().catch(() => cloudClient.getStatus());
    },
    listDesktops: async () => {
      const desktops = await cloudClient.listDesktops();
      return desktops.length || !lanFallbackEnabled()
        ? desktops
        : lanClient.listDesktops().catch(() => desktops);
    },
    listRepos: async () => {
      const repos = reposFromTasks(liveCloudTasks());
      if (repos.length > 0) {
        return repos;
      }
      if (liveCloudSubscriptionActive()) {
        return lanFallbackEnabled() ? lanClient.listRepos() : [];
      }
      if (!lanFallbackEnabled()) return cloudClient.listRepos();
      if (useLanFallback()) {
        return lanClient.listRepos();
      }
      return [];
    },
    listRepoTasks: async (repoId) => {
      const tasks = liveCloudTasks();
      if (tasks.length > 0) {
        return tasks.filter((task) => task.repoId === repoId);
      }
      if (liveCloudSubscriptionActive()) {
        return lanFallbackEnabled() ? lanClient.listRepoTasks(repoId) : [];
      }
      if (!lanFallbackEnabled()) return cloudClient.listRepoTasks(repoId);
      if (useLanFallback()) {
        return lanClient.listRepoTasks(repoId);
      }
      return [];
    },
    listRecentTasks,
    searchTasks: (query) =>
      useLanFallback() ? lanClient.searchTasks(query) : cloudClient.searchTasks(query),
    createTask: (input) =>
      useLanFallback() ? lanClient.createTask(input) : cloudClient.createTask(input),
    runMergeAgent: (taskId) =>
      useLanFallback()
        ? lanClient.runMergeAgent(taskId)
        : cloudClient.runMergeAgent(taskId),
    advanceTaskStage: (taskId) =>
      useLanFallback()
        ? lanClient.advanceTaskStage(taskId)
        : cloudClient.advanceTaskStage(taskId),
    closeTask: (taskId) =>
      useLanFallback() ? lanClient.closeTask(taskId) : cloudClient.closeTask(taskId),
    sendTaskInput: (taskId, input) =>
      useLanFallback()
        ? lanClient.sendTaskInput(taskId, input)
        : cloudClient.sendTaskInput(taskId, input),
    observeTaskTerminal: (taskId, listener) =>
      useLanFallback()
        ? lanClient.observeTaskTerminal(taskId, listener)
        : cloudClient.observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      useLanFallback()
        ? lanClient.observeTaskAgent(taskId, listener)
        : cloudClient.observeTaskAgent(taskId, listener),
    createPairingSession: () => lanClient.createPairingSession()
  };
}

function createTrustedLanFallbackClient({
  bonjourBrowser,
  fetchImpl,
  getSelectedDesktopId,
  getTrustedDesktops
}: {
  bonjourBrowser: BonjourBrowser;
  fetchImpl: FetchLike;
  getSelectedDesktopId(): string | null;
  getTrustedDesktops(): readonly TrustedDesktopRecord[];
}): KannaClient {
  let validatedBaseUrl: string | null = null;
  const clientForBaseUrl = (resolvedBaseUrl: string) =>
    createKannaClient(createLanTransport(resolvedBaseUrl, fetchImpl));
  const resolveClient = async () => {
    const endpoint = await resolveTrustedBonjourEndpoint({
      fetchImpl,
      services: bonjourBrowser.getServices(),
      selectedDesktopId: getSelectedDesktopId(),
      trustedDesktops: getTrustedDesktops()
    });
    if (!endpoint) {
      return createDisconnectedClient();
    }
    validatedBaseUrl = endpoint.baseUrl;
    return clientForBaseUrl(endpoint.baseUrl);
  };
  const currentClient = () =>
    validatedBaseUrl ? clientForBaseUrl(validatedBaseUrl) : createDisconnectedClient();

  return {
    getStatus: async () => (await resolveClient()).getStatus(),
    listDesktops: async () => (await resolveClient()).listDesktops(),
    listRepos: async () => (await resolveClient()).listRepos(),
    listRepoTasks: async (repoId) => (await resolveClient()).listRepoTasks(repoId),
    listRecentTasks: async () => (await resolveClient()).listRecentTasks(),
    searchTasks: async (query) => (await resolveClient()).searchTasks(query),
    createTask: async (input) => (await resolveClient()).createTask(input),
    runMergeAgent: async (taskId) => (await resolveClient()).runMergeAgent(taskId),
    advanceTaskStage: async (taskId) => (await resolveClient()).advanceTaskStage(taskId),
    closeTask: async (taskId) => (await resolveClient()).closeTask(taskId),
    sendTaskInput: async (taskId, input) =>
      (await resolveClient()).sendTaskInput(taskId, input),
    observeTaskTerminal: (taskId, listener) =>
      currentClient().observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      currentClient().observeTaskAgent(taskId, listener),
    createPairingSession: async () => (await resolveClient()).createPairingSession()
  };
}

function hasTrustedLanPeer(
  trustedDesktops: readonly TrustedDesktopRecord[]
): boolean {
  return trustedDesktops.length > 0;
}

function reposFromTasks(tasks: readonly TaskSummary[]): RepoSummary[] {
  const reposById = new Map<string, string>();
  for (const task of tasks) {
    if (reposById.has(task.repoId)) continue;
    reposById.set(task.repoId, task.repoName?.trim() || task.repoId);
  }
  return Array.from(reposById, ([id, name]) => ({ id, name }));
}

function mapTrustedDesktopRecord(desktop: TrustedDesktopRecord) {
  return {
    desktopId: desktop.desktopId,
    displayName: desktop.displayName,
    online: true,
    reachableViaRelay: false,
    connectionMode: "lan" as const,
    lastSeenAt: desktop.lastSeenAt
  };
}

function createDelegatingClient(getClient: () => KannaClient): KannaClient {
  return {
    getStatus: () => getClient().getStatus(),
    listDesktops: () => getClient().listDesktops(),
    listRepos: () => getClient().listRepos(),
    listRepoTasks: (repoId) => getClient().listRepoTasks(repoId),
    listRecentTasks: () => getClient().listRecentTasks(),
    searchTasks: (query) => getClient().searchTasks(query),
    createTask: (input) => getClient().createTask(input),
    runMergeAgent: (taskId) => getClient().runMergeAgent(taskId),
    advanceTaskStage: (taskId) => getClient().advanceTaskStage(taskId),
    closeTask: (taskId) => getClient().closeTask(taskId),
    sendTaskInput: (taskId, input) => getClient().sendTaskInput(taskId, input),
    observeTaskTerminal: (taskId, listener) =>
      getClient().observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      getClient().observeTaskAgent(taskId, listener),
    createPairingSession: () => getClient().createPairingSession()
  };
}

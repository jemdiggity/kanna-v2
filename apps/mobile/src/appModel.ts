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

const PRODUCTION_RELAY_URL = "wss://kanna-relay-402613185450.us-central1.run.app";

interface ExpoPublicEnv {
  EXPO_PUBLIC_KANNA_RELAY_URL?: string;
}

interface RelayUrlOptions {
  dev?: boolean;
}

export interface AppModel {
  client: KannaClient;
  controller: MobileController;
  initialize(): Promise<void>;
  navigator: ReturnType<typeof createRootNavigator>;
  sessionStore: SessionStore;
}

interface AppModelOptions {
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

  if (options.dev ?? isDevRuntime()) return null;

  return PRODUCTION_RELAY_URL;
}

export function createAppModel(input: CreateAppModelInput = {}): AppModel {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const persistence = input.persistence;
  const authSession = input.authSession ?? createConfiguredMobileAuthSession();
  const options = input.options ?? {};
  const bonjourBrowser = options.bonjourBrowser ?? createBonjourBrowser();
  const sessionStore = createSessionStore();
  const resolveClient = () =>
    createClientForMode({
      authSession,
      bonjourBrowser,
      createRelayClient: options.createRelayClient ?? createRelayDesktopClient,
      fetchImpl,
      getSelectedDesktopId: () => sessionStore.getState().selectedDesktopId,
      getTrustedDesktops: () => sessionStore.getState().trustedDesktops,
      relayUrl: options.relayUrl ?? resolveRelayUrl(),
      taskIndex: options.taskIndex
    });
  let activeClient = resolveClient();
  const client = createDelegatingClient(() => activeClient);
  const controller = createMobileController(client, sessionStore, authSession);
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
    sessionStore
  };
}

function createClientForMode({
  authSession,
  bonjourBrowser,
  createRelayClient,
  fetchImpl,
  getSelectedDesktopId,
  getTrustedDesktops,
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
  getSelectedDesktopId(): string | null;
  getTrustedDesktops(): readonly TrustedDesktopRecord[];
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
        listCloudTasks: () => resolvedTaskIndex.listRecentTasks(authState.user.uid),
      }),
    );
    const lanClient = createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktops
    });

    return createCloudWithLanFallbackClient(cloudClient, lanClient, {
      isLanFallbackEnabled: () => hasTrustedLanPeer(getTrustedDesktops())
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

function createCloudWithLanFallbackClient(
  cloudClient: KannaClient,
  lanClient: KannaClient,
  options: { isLanFallbackEnabled(): boolean }
): KannaClient {
  let cloudHasTasks = false;
  const lanFallbackEnabled = () => options.isLanFallbackEnabled();

  const listRecentTasks = async () => {
    try {
      const tasks = await cloudClient.listRecentTasks();
      cloudHasTasks = tasks.length > 0;
      return cloudHasTasks || !lanFallbackEnabled()
        ? tasks
        : lanClient.listRecentTasks();
    } catch {
      cloudHasTasks = false;
      if (!lanFallbackEnabled()) {
        return [];
      }
      return lanClient.listRecentTasks();
    }
  };

  const useLanFallback = () => lanFallbackEnabled() && !cloudHasTasks;

  return {
    getStatus: async () => {
      if (!lanFallbackEnabled()) {
        return cloudClient.getStatus();
      }

      try {
        const tasks = await cloudClient.listRecentTasks();
        cloudHasTasks = tasks.length > 0;
        if (cloudHasTasks) {
          return cloudClient.getStatus();
        }
      } catch {
        cloudHasTasks = false;
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
      if (useLanFallback()) {
        return lanClient.listRepos();
      }
      const repos = await cloudClient.listRepos();
      return repos.length || !lanFallbackEnabled()
        ? repos
        : lanClient.listRepos().catch(() => repos);
    },
    listRepoTasks: async (repoId) => {
      if (useLanFallback()) {
        return lanClient.listRepoTasks(repoId);
      }
      const tasks = await cloudClient.listRepoTasks(repoId);
      return tasks.length || !lanFallbackEnabled()
        ? tasks
        : lanClient.listRepoTasks(repoId).catch(() => tasks);
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

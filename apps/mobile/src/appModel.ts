import { createKannaClient, type KannaClient } from "./lib/api/client";
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
import {
  createMobileController,
  type MobileController
} from "./state/mobileController";
import { createSessionStore, type SessionStore } from "./state/sessionStore";
import {
  createDefaultSessionPersistence,
  type SessionPersistence
} from "./state/sessionPersistence";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 48120;
const DEFAULT_SERVER_BASE_URL = `http://${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`;

interface ExpoPublicEnv {
  EXPO_PUBLIC_KANNA_SERVER_URL?: string;
  EXPO_PUBLIC_KANNA_RELAY_URL?: string;
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
  createRelayClient?: (input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
  }) => RelayDesktopClient;
}

function readExpoPublicEnv(): ExpoPublicEnv {
  const globalEnv = (globalThis as { process?: { env?: ExpoPublicEnv } }).process?.env;
  return globalEnv ?? {};
}

interface SourceCodeModule {
  getConstants?: () => { scriptURL?: string | null };
  scriptURL?: string | null;
}

interface BatchedBridgeModuleConfig {
  0?: string;
  1?: { scriptURL?: string | null } | null;
}

function readReactNativeBundleUrl(): string | null {
  const runtime = globalThis as {
    __fbBatchedBridgeConfig?: {
      remoteModuleConfig?: BatchedBridgeModuleConfig[];
    };
    nativeModuleProxy?: { SourceCode?: SourceCodeModule };
  };

  const sourceCodeModule = runtime.nativeModuleProxy?.SourceCode;
  const sourceCodeConstants = sourceCodeModule?.getConstants?.();
  const scriptUrl = sourceCodeConstants?.scriptURL ?? sourceCodeModule?.scriptURL;
  if (typeof scriptUrl === "string" && scriptUrl.length > 0) {
    return scriptUrl;
  }

  const sourceCodeBridgeConfig = runtime.__fbBatchedBridgeConfig?.remoteModuleConfig?.find(
    (entry) => entry[0] === "SourceCode"
  );
  const bridgeScriptUrl = sourceCodeBridgeConfig?.[1]?.scriptURL;
  if (typeof bridgeScriptUrl === "string" && bridgeScriptUrl.length > 0) {
    return bridgeScriptUrl;
  }

  return typeof scriptUrl === "string" && scriptUrl.length > 0 ? scriptUrl : null;
}

function inferServerBaseUrl(bundleUrl: string | null): string | null {
  if (!bundleUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(bundleUrl);
    if (!parsedUrl.hostname) {
      return null;
    }

    return `http://${parsedUrl.hostname}:${DEFAULT_SERVER_PORT}`;
  } catch {
    return null;
  }
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const parsedUrl = new URL(baseUrl);
    return (
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveServerBaseUrl(
  env: ExpoPublicEnv = readExpoPublicEnv(),
  bundleUrl: string | null = readReactNativeBundleUrl()
): string {
  const configuredBaseUrl = env.EXPO_PUBLIC_KANNA_SERVER_URL?.trim();
  const inferredBaseUrl = inferServerBaseUrl(bundleUrl);

  if (
    configuredBaseUrl &&
    inferredBaseUrl &&
    isLoopbackBaseUrl(configuredBaseUrl) &&
    !isLoopbackBaseUrl(inferredBaseUrl)
  ) {
    return inferredBaseUrl;
  }

  return configuredBaseUrl || inferredBaseUrl || DEFAULT_SERVER_BASE_URL;
}

export function resolveRelayUrl(env: ExpoPublicEnv = readExpoPublicEnv()): string | null {
  const relayUrl = env.EXPO_PUBLIC_KANNA_RELAY_URL?.trim();
  return relayUrl && relayUrl.length > 0 ? relayUrl : null;
}

export function createAppModel(
  baseUrl = resolveServerBaseUrl(),
  fetchImpl = globalThis.fetch as unknown as FetchLike,
  persistence?: SessionPersistence,
  authSession: MobileAuthSession = createConfiguredMobileAuthSession(),
  options: AppModelOptions = {}
): AppModel {
  const sessionStore = createSessionStore();
  const resolveClient = () =>
    createClientForMode({
      authSession,
      baseUrl,
      createRelayClient: options.createRelayClient ?? createRelayDesktopClient,
      fetchImpl,
      getSelectedDesktopId: () => sessionStore.getState().selectedDesktopId,
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

  return {
    client,
    controller,
    async initialize() {
      const resolvedPersistence = await getPersistence();
      const persistedContext = await resolvedPersistence.load();
      if (persistedContext) {
        sessionStore.hydrateContext(persistedContext);
        lastSavedContextJson = JSON.stringify(persistedContext);
      }

      await controller.bootstrap();
    },
    navigator: createRootNavigator(),
    sessionStore
  };
}

function createClientForMode({
  authSession,
  baseUrl,
  createRelayClient,
  fetchImpl,
  getSelectedDesktopId,
  relayUrl,
  taskIndex,
}: {
  authSession: MobileAuthSession;
  baseUrl: string;
  createRelayClient(input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
  }): RelayDesktopClient;
  fetchImpl: FetchLike;
  getSelectedDesktopId(): string | null;
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
          return [];
        },
        getSelectedDesktopId,
        invokeDesktop: relayClient.invokeDesktop,
        observeTaskTerminal: relayClient.observeTaskTerminal,
        listCloudTasks: () => resolvedTaskIndex.listRecentTasks(authState.user.uid),
      }),
    );
    const lanClient = createKannaClient(createLanTransport(baseUrl, fetchImpl));

    return createCloudWithLanFallbackClient(cloudClient, lanClient);
  }

  return createKannaClient(createLanTransport(baseUrl, fetchImpl));
}

function createCloudWithLanFallbackClient(
  cloudClient: KannaClient,
  lanClient: KannaClient
): KannaClient {
  let cloudHasTasks = false;

  const listRecentTasks = async () => {
    try {
      const tasks = await cloudClient.listRecentTasks();
      cloudHasTasks = tasks.length > 0;
      return cloudHasTasks ? tasks : lanClient.listRecentTasks();
    } catch {
      cloudHasTasks = false;
      return lanClient.listRecentTasks();
    }
  };

  const useLanFallback = () => !cloudHasTasks;

  return {
    getStatus: () => cloudClient.getStatus(),
    listDesktops: async () => {
      const desktops = await cloudClient.listDesktops();
      return desktops.length ? desktops : lanClient.listDesktops();
    },
    listRepos: async () => {
      if (useLanFallback()) {
        return lanClient.listRepos();
      }
      const repos = await cloudClient.listRepos();
      return repos.length ? repos : lanClient.listRepos();
    },
    listRepoTasks: async (repoId) => {
      if (useLanFallback()) {
        return lanClient.listRepoTasks(repoId);
      }
      const tasks = await cloudClient.listRepoTasks(repoId);
      return tasks.length ? tasks : lanClient.listRepoTasks(repoId);
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
    createPairingSession: () => lanClient.createPairingSession()
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
    createPairingSession: () => getClient().createPairingSession()
  };
}

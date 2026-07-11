import { createKannaClient, type KannaClient } from "./lib/api/client";
import {
  createBonjourBrowser,
  type BonjourBrowser
} from "./lib/discovery/bonjour";
import { resolveTrustedBonjourEndpoint } from "./lib/discovery/trustedBonjour";
import type { MobileAuthSession, MobileAuthState } from "./lib/firebase/auth";
import { createConfiguredMobileAuthSession } from "./lib/firebase/sdk";
import {
  createFirestoreTaskIndex,
  type CloudDesktopRecord,
  type CloudTaskIndex,
  type CloudTaskIndexError
} from "./lib/firebase/taskIndex";
import { createLanTransport, type FetchLike } from "./lib/transports/lanTransport";
import {
  createRelayDesktopClient,
  type RelayDesktopClient
} from "./lib/transports/relayClient";
import {
  createRemoteTransport,
  type RemoteDesktopRecord
} from "./lib/transports/remoteTransport";
import { createCloudLanClient } from "./lib/sources/cloudLanClient";
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
import type { TaskSummary } from "./lib/api/types";

const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";
const CLOUD_TASK_RECOVERY_RETRY_MS = 1_000;

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
    onAuthError(): void;
  }) => RelayDesktopClient;
}

interface ResolvedAppClient {
  client: KannaClient;
  listCurrentCloudTasks?: () => Promise<TaskSummary[]>;
  listRecentTasksWithSupplement?: (
    onSupplement: (tasks: TaskSummary[]) => void
  ) => Promise<TaskSummary[]>;
  dispose(): void;
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

function signedInUid(authState: MobileAuthState): string | null {
  return authState.status === "signedIn" ? authState.user.uid : null;
}

function formatCloudTaskIndexError(indexError: CloudTaskIndexError): Error {
  const scope = indexError.desktopId
    ? `${indexError.scope} (${indexError.desktopId})`
    : indexError.scope;
  const message = indexError.error instanceof Error
    ? indexError.error.message
    : String(indexError.error);
  return new Error(`Cloud task index ${scope}: ${message}`);
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
  let liveCloudTasks: TaskSummary[] = [];
  let liveCloudTasksUid: string | null = null;
  let liveCloudTasksReady = false;
  let liveSubscriptionEpoch = 0;
  let clientGeneration = 0;
  let currentLiveTaskRepublish: (() => Promise<void>) | null = null;
  let activeAuthUid = signedInUid(authSession.getState());
  const invalidateLiveCloudState = () => {
    liveSubscriptionEpoch += 1;
    liveCloudTasks = [];
    liveCloudTasksUid = null;
    liveCloudTasksReady = false;
  };
  const getCloudTaskIndex = () =>
    (cloudTaskIndex ??= options.taskIndex ?? createFirestoreTaskIndex());
  const resolveClient = (generation: number) =>
    createClientForMode({
      authSession,
      bonjourBrowser,
      createRelayClient: options.createRelayClient ?? createRelayDesktopClient,
      fetchImpl,
      forceCloud,
      getSelectedDesktopId: () => sessionStore.getState().selectedDesktopId,
      getTrustedDesktops: () => sessionStore.getState().trustedDesktops,
      getLiveCloudTasks: () => liveCloudTasks,
      getLiveCloudTasksUid: () => liveCloudTasksUid,
      isLiveCloudTasksReady: () => liveCloudTasksReady,
      onActiveDesktopIdsChanged: () => {
        if (generation === clientGeneration) {
          return currentLiveTaskRepublish?.();
        }
      },
      relayUrl: options.relayUrl ?? resolveRelayUrl(readExpoPublicEnv(), {
        extraRelayUrl: extra?.relayUrl
      }),
      taskIndex: options.taskIndex
    });
  let activeClient = resolveClient(clientGeneration);
  const replaceActiveClient = () => {
    const previousClient = activeClient;
    const nextGeneration = clientGeneration + 1;
    currentLiveTaskRepublish = null;
    const nextClient = resolveClient(nextGeneration);
    clientGeneration = nextGeneration;
    activeClient = nextClient;
    previousClient.dispose();
  };
  const client = createDelegatingClient(() => activeClient.client);
  const controller = createMobileController(client, sessionStore, authSession, {
    subscribeCloudTasks: (uid, onUpdate, onError) => {
      const epoch = ++liveSubscriptionEpoch;
      let updateRevision = 0;
      let recoveryRevision = 0;
      let taskIndexSubscriptionRevision = 0;
      let taskIndexUnsubscribe: (() => void) | null = null;
      let taskIndexRestartTimer: ReturnType<typeof setTimeout> | null = null;
      let presenceRepublishPending = false;
      let currentTaskRecovery: {
        revision: number;
        readSucceeded: boolean;
        succeeded: boolean;
      } | null = null;
      liveCloudTasks = [];
      liveCloudTasksUid = uid;
      liveCloudTasksReady = false;
      const isCurrent = (revision: number, generation: number) =>
        epoch === liveSubscriptionEpoch &&
        revision === updateRevision &&
        generation === clientGeneration &&
        liveCloudTasksUid === uid;
      const publishCurrentTasks = async (revision: number): Promise<boolean> => {
        const generation = clientGeneration;
        const source = activeClient;
        let published = false;
        try {
          if (source.listCurrentCloudTasks) {
            const cloudTasks = await source.listCurrentCloudTasks();
            if (!isCurrent(revision, generation)) return false;
            onUpdate(cloudTasks);
            published = true;
            if (!isCurrent(revision, generation)) return published;
          }

          const tasks = await (
            source.listRecentTasksWithSupplement
              ? source.listRecentTasksWithSupplement((supplement) => {
                  if (isCurrent(revision, generation)) onUpdate(supplement);
                })
              : source.client.listRecentTasks()
          );
          if (isCurrent(revision, generation)) {
            onUpdate(tasks);
            published = true;
          }
        } catch (error) {
          if (isCurrent(revision, generation)) onError?.(error);
        }
        return published;
      };
      const republishCurrentLiveTasks = async () => {
        if (
          epoch !== liveSubscriptionEpoch ||
          liveCloudTasksUid !== uid ||
          !liveCloudTasksReady
        ) {
          return;
        }
        if (currentTaskRecovery) {
          presenceRepublishPending = true;
          return;
        }
        presenceRepublishPending = false;
        const revision = ++updateRevision;
        await publishCurrentTasks(revision);
      };
      currentLiveTaskRepublish = republishCurrentLiveTasks;
      const clearTaskIndexRestartTimer = () => {
        if (taskIndexRestartTimer === null) return;
        clearTimeout(taskIndexRestartTimer);
        taskIndexRestartTimer = null;
      };
      const stopTaskIndexSubscription = () => {
        clearTaskIndexRestartTimer();
        taskIndexSubscriptionRevision += 1;
        const unsubscribe = taskIndexUnsubscribe;
        taskIndexUnsubscribe = null;
        unsubscribe?.();
      };
      let startTaskIndexSubscription: () => void = () => undefined;
      const scheduleTaskIndexSubscriptionRestart = () => {
        clearTaskIndexRestartTimer();
        if (epoch !== liveSubscriptionEpoch || liveCloudTasksUid !== uid) return;
        taskIndexRestartTimer = setTimeout(() => {
          taskIndexRestartTimer = null;
          startTaskIndexSubscription();
        }, CLOUD_TASK_RECOVERY_RETRY_MS);
      };
      const recoverCurrentTasks = (indexError: CloudTaskIndexError) => {
        if (epoch !== liveSubscriptionEpoch || liveCloudTasksUid !== uid) return;
        if (indexError.scope === "document") {
          onError?.(formatCloudTaskIndexError(indexError));
          return;
        }
        stopTaskIndexSubscription();
        onError?.(formatCloudTaskIndexError(indexError));
        const revision = ++updateRevision;
        const generation = clientGeneration;
        const recovery = {
          revision: ++recoveryRevision,
          readSucceeded: false,
          succeeded: false
        };
        currentTaskRecovery = recovery;
        void getCloudTaskIndex().listRecentTasks(uid).then((tasks) => {
          recovery.readSucceeded = true;
          if (
            currentTaskRecovery !== recovery ||
            recovery.revision !== recoveryRevision ||
            !isCurrent(revision, generation)
          ) {
            return false;
          }
          liveCloudTasks = tasks;
          liveCloudTasksUid = uid;
          liveCloudTasksReady = true;
          return publishCurrentTasks(revision);
        }).then((published) => {
          if (!published || !isCurrent(revision, generation)) return;
          recovery.succeeded = published;
        }).catch((error) => {
          if (isCurrent(revision, generation)) onError?.(error);
        }).finally(() => {
          if (currentTaskRecovery === recovery) {
            currentTaskRecovery = null;
            if (recovery.readSucceeded) {
              startTaskIndexSubscription();
            } else {
              scheduleTaskIndexSubscriptionRestart();
            }
            if (recovery.succeeded && presenceRepublishPending) {
              presenceRepublishPending = false;
              void republishCurrentLiveTasks();
            }
          }
        });
      };
      startTaskIndexSubscription = () => {
        if (epoch !== liveSubscriptionEpoch || liveCloudTasksUid !== uid) return;
        clearTaskIndexRestartTimer();
        const subscriptionRevision = ++taskIndexSubscriptionRevision;
        const isCurrentSubscription = () =>
          epoch === liveSubscriptionEpoch &&
          liveCloudTasksUid === uid &&
          subscriptionRevision === taskIndexSubscriptionRevision;
        const unsubscribe = getCloudTaskIndex().subscribeRecentTasks(
          uid,
          (tasks) => {
            if (!isCurrentSubscription()) return;
            presenceRepublishPending = false;
            currentLiveTaskRepublish = republishCurrentLiveTasks;
            const revision = ++updateRevision;
            liveCloudTasks = tasks;
            liveCloudTasksUid = uid;
            liveCloudTasksReady = true;
            void publishCurrentTasks(revision);
          },
          (indexError) => {
            if (isCurrentSubscription()) recoverCurrentTasks(indexError);
          }
        );
        if (isCurrentSubscription()) {
          taskIndexUnsubscribe = unsubscribe;
        } else {
          unsubscribe();
        }
      };
      startTaskIndexSubscription();
      return () => {
        if (currentLiveTaskRepublish === republishCurrentLiveTasks) {
          currentLiveTaskRepublish = null;
        }
        if (epoch === liveSubscriptionEpoch) {
          invalidateLiveCloudState();
        }
        stopTaskIndexSubscription();
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
    replaceActiveClient();
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
  authSession.subscribe((authState) => {
    const nextAuthUid = signedInUid(authState);
    if (nextAuthUid !== activeAuthUid) {
      invalidateLiveCloudState();
      activeAuthUid = nextAuthUid;
      replaceActiveClient();
    }
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
      replaceActiveClient();
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
  getLiveCloudTasksUid,
  isLiveCloudTasksReady,
  onActiveDesktopIdsChanged,
  relayUrl,
  taskIndex,
}: {
  authSession: MobileAuthSession;
  bonjourBrowser: BonjourBrowser;
  createRelayClient(input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
    onAuthError(): void;
  }): RelayDesktopClient;
  fetchImpl: FetchLike;
  forceCloud: boolean;
  getSelectedDesktopId(): string | null;
  getTrustedDesktops(): readonly TrustedDesktopRecord[];
  getLiveCloudTasks(): TaskSummary[];
  getLiveCloudTasksUid(): string | null;
  isLiveCloudTasksReady(): boolean;
  onActiveDesktopIdsChanged(): Promise<void> | void;
  relayUrl: string | null;
  taskIndex?: CloudTaskIndex;
}): ResolvedAppClient {
  const authState = authSession.getState();
  if (authState.status === "signedIn" && relayUrl) {
    const relayClient = createRelayClient({
      relayUrl,
      getIdToken: (forceRefresh) => authSession.getIdToken(forceRefresh),
      onAuthError: () => authSession.notifyAuthExpired(),
    });
    let disposed = false;
    let lastActiveDesktopIds: Set<string> | null = null;
    let activeDesktopIdsRefresh: Promise<void> | null = null;
    const refreshActiveDesktopIds = () => {
      if (activeDesktopIdsRefresh) {
        return;
      }
      let presenceRead: Promise<Set<string>>;
      try {
        presenceRead = relayClient.listActiveDesktopIds();
      } catch {
        return;
      }
      const refresh = presenceRead
        .then((activeDesktopIds) => {
          if (disposed) {
            return;
          }
          const nextActiveDesktopIds = new Set(activeDesktopIds);
          if (!areStringSetsEqual(lastActiveDesktopIds, nextActiveDesktopIds)) {
            lastActiveDesktopIds = nextActiveDesktopIds;
            return onActiveDesktopIdsChanged();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (activeDesktopIdsRefresh === refresh) {
            activeDesktopIdsRefresh = null;
          }
        });
      activeDesktopIdsRefresh = refresh;
    };
    const resolvedTaskIndex = taskIndex ?? createFirestoreTaskIndex();
    const listCloudTasksForRouting = async () => {
      refreshActiveDesktopIds();
      const tasks =
        isLiveCloudTasksReady() && getLiveCloudTasksUid() === authState.user.uid
        ? getLiveCloudTasks()
        : await resolvedTaskIndex.listRecentTasks(authState.user.uid);
      return preferActiveCloudTaskRoutes(tasks, lastActiveDesktopIds);
    };
    const listCloudDesktopRecords = async () => {
      refreshActiveDesktopIds();
      const records = await resolvedTaskIndex.listDesktops(authState.user.uid);
      return records.map((record) =>
        mapCloudDesktopRecord(record, lastActiveDesktopIds)
      );
    };
    const cloudClient = createKannaClient(
      createRemoteTransport({
        listDesktopRecords: listCloudDesktopRecords,
        getSelectedDesktopId,
        invokeDesktop: relayClient.invokeDesktop,
        observeTaskTerminal: relayClient.observeTaskTerminal,
        observeTaskAgent: relayClient.observeTaskAgent,
        sendTaskInput: relayClient.sendTaskInput,
        listCloudTasks: listCloudTasksForRouting,
      }),
    );
    const trustedLanClient = createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktops
    });

    const composedClient = createCloudLanClient(
      cloudClient,
      trustedLanClient.client,
      {
        isLanEnabled: () =>
          !forceCloud && hasTrustedLanPeer(getTrustedDesktops()),
        lanClientForDesktop: trustedLanClient.clientForDesktop
      }
    );

    return {
      client: composedClient,
      listCurrentCloudTasks: () => composedClient.listCurrentCloudTasks(),
      listRecentTasksWithSupplement: (onSupplement) =>
        composedClient.listRecentTasksWithSupplement(onSupplement),
      dispose() {
        if (disposed) return;
        disposed = true;
        relayClient.close();
      }
    };
  }

  if (hasTrustedLanPeer(getTrustedDesktops())) {
    return {
      client: createTrustedLanFallbackClient({
        bonjourBrowser,
        fetchImpl,
        getSelectedDesktopId,
        getTrustedDesktops
      }).client,
      dispose() {}
    };
  }

  return { client: createDisconnectedClient(), dispose() {} };
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
}): {
  client: KannaClient;
  clientForDesktop(desktopId: string): KannaClient | null;
} {
  const validatedBaseUrls = new Map<string, string>();
  let lastValidatedDesktopId: string | null = null;
  const clientForBaseUrl = (resolvedBaseUrl: string) =>
    createKannaClient(createLanTransport(resolvedBaseUrl, fetchImpl));
  const resolveClient = async (desktopId: string | null) => {
    const trustedDesktops = desktopId
      ? getTrustedDesktops().filter((desktop) => desktop.desktopId === desktopId)
      : getTrustedDesktops();
    const services = desktopId
      ? bonjourBrowser
          .getServices()
          .filter((service) => service.txt.desktopId === desktopId)
      : bonjourBrowser.getServices();
    const endpoint = await resolveTrustedBonjourEndpoint({
      fetchImpl,
      services,
      selectedDesktopId: desktopId ?? getSelectedDesktopId(),
      trustedDesktops
    });
    if (!endpoint) {
      return createDisconnectedClient();
    }
    validatedBaseUrls.set(endpoint.desktopId, endpoint.baseUrl);
    lastValidatedDesktopId = endpoint.desktopId;
    return clientForBaseUrl(endpoint.baseUrl);
  };
  const currentClient = (desktopId: string | null) => {
    const cachedDesktopId = desktopId ?? lastValidatedDesktopId;
    const baseUrl = cachedDesktopId
      ? validatedBaseUrls.get(cachedDesktopId)
      : undefined;
    return baseUrl ? clientForBaseUrl(baseUrl) : createDisconnectedClient();
  };
  const createResolvingClient = (desktopId: string | null): KannaClient => ({
    getStatus: async () => (await resolveClient(desktopId)).getStatus(),
    listDesktops: async () => (await resolveClient(desktopId)).listDesktops(),
    listRepos: async () => (await resolveClient(desktopId)).listRepos(),
    listRepoTasks: async (repoId) =>
      (await resolveClient(desktopId)).listRepoTasks(repoId),
    listRecentTasks: async () => (await resolveClient(desktopId)).listRecentTasks(),
    searchTasks: async (query) =>
      (await resolveClient(desktopId)).searchTasks(query),
    createTask: async (input) => (await resolveClient(desktopId)).createTask(input),
    runMergeAgent: async (taskId) =>
      (await resolveClient(desktopId)).runMergeAgent(taskId),
    advanceTaskStage: async (taskId) =>
      (await resolveClient(desktopId)).advanceTaskStage(taskId),
    closeTask: async (taskId) =>
      (await resolveClient(desktopId)).closeTask(taskId),
    sendTaskInput: async (taskId, input) =>
      (await resolveClient(desktopId)).sendTaskInput(taskId, input),
    observeTaskTerminal: (taskId, listener) =>
      currentClient(desktopId).observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      currentClient(desktopId).observeTaskAgent(taskId, listener),
    createPairingSession: async () =>
      (await resolveClient(desktopId)).createPairingSession()
  });
  const client = createResolvingClient(null);
  return {
    client,
    clientForDesktop(desktopId) {
      return getTrustedDesktops().some(
        (desktop) => desktop.desktopId === desktopId
      )
        ? createResolvingClient(desktopId)
        : null;
    }
  };
}

function hasTrustedLanPeer(
  trustedDesktops: readonly TrustedDesktopRecord[]
): boolean {
  return trustedDesktops.length > 0;
}

function areStringSetsEqual(
  left: ReadonlySet<string> | null,
  right: ReadonlySet<string>
): boolean {
  if (!left || left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function preferActiveCloudTaskRoutes<T extends TaskSummary>(
  tasks: T[],
  activeDesktopIds: Set<string> | null
): T[] {
  const tasksById = new Map<string, T>();
  for (const task of tasks) {
    const candidate = activeDesktopIds
      ? markCloudTaskOwnerOnline(task, activeDesktopIds)
      : task;
    const existing = tasksById.get(task.id);
    if (!existing) {
      tasksById.set(task.id, candidate);
      continue;
    }

    if (
      activeDesktopIds &&
      !isOwnedByActiveDesktop(existing, activeDesktopIds) &&
      isOwnedByActiveDesktop(candidate, activeDesktopIds)
    ) {
      tasksById.set(task.id, candidate);
    }
  }

  return Array.from(tasksById.values());
}

function markCloudTaskOwnerOnline<T extends TaskSummary>(
  task: T,
  activeDesktopIds: Set<string>
): T {
  const ownerDesktopId = getCloudTaskOwnerDesktopId(task);
  if (!ownerDesktopId) {
    return task;
  }

  const ownerOnline = activeDesktopIds.has(ownerDesktopId);
  if ((task as { ownerOnline?: unknown }).ownerOnline === ownerOnline) {
    return task;
  }

  return {
    ...task,
    ownerOnline
  };
}

function isOwnedByActiveDesktop(
  task: TaskSummary,
  activeDesktopIds: Set<string>
): boolean {
  const ownerDesktopId = getCloudTaskOwnerDesktopId(task);
  return ownerDesktopId ? activeDesktopIds.has(ownerDesktopId) : false;
}

function getCloudTaskOwnerDesktopId(task: TaskSummary): string | null {
  const ownerDesktopId = (task as { ownerDesktopId?: unknown }).ownerDesktopId;
  return typeof ownerDesktopId === "string" && ownerDesktopId.length > 0
    ? ownerDesktopId
    : null;
}

function mapCloudDesktopRecord(
  desktop: CloudDesktopRecord,
  activeDesktopIds: Set<string> | null
): RemoteDesktopRecord {
  const online = activeDesktopIds?.has(desktop.desktopId) ?? false;
  return {
    desktopId: desktop.desktopId,
    displayName: desktop.displayName,
    online,
    reachableViaRelay: online,
    connectionMode: "internet",
    lastSeenAt: desktop.updatedAt
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

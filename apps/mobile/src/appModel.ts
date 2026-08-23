import {
  createKannaClient,
  TaskCreationError,
  type KannaClient
} from "./lib/api/client";
import {
  createBonjourBrowser,
  type BonjourBrowser
} from "./lib/discovery/bonjour";
import {
  resolveTrustedBonjourEndpoint,
  resolveTrustedBonjourEndpoints
} from "./lib/discovery/trustedBonjour";
import { createMachinePairingService } from "./lib/pairing/machinePairing";
import type { MobileAuthSession, MobileAuthState } from "./lib/firebase/auth";
import { createConfiguredMobileAuthSession } from "./lib/firebase/sdk";
import {
  createFirestoreTaskIndex,
  type CloudDesktopRecord,
  type CloudTaskIndex,
  type CloudTaskIndexError
} from "./lib/firebase/taskIndex";
import {
  createLanTransport,
  type FetchLike,
  type LanDeviceCredentials
} from "./lib/transports/lanTransport";
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
import type { DesktopSummary, TaskSummary } from "./lib/api/types";

const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";
const CLOUD_TASK_RECOVERY_INITIAL_RETRY_MS = 1_000;
const CLOUD_TASK_RECOVERY_MAX_RETRY_MS = 30_000;

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
  getAuthIdToken(forceRefresh?: boolean): Promise<string | null>;
  sessionStore: SessionStore;
  setForceCloud(enabled: boolean): void;
  setForeground?(foreground: boolean): void;
}

interface AppModelOptions {
  forceCloud?: boolean;
  relayUrl?: string | null;
  taskIndex?: CloudTaskIndex;
  bonjourBrowser?: BonjourBrowser;
  enableE2eTrustSeed?: boolean;
  desktopRepoWaitMs?: number;
  createRelayClient?: (input: {
    relayUrl: string;
    getIdToken(forceRefresh?: boolean): Promise<string | null>;
    onAuthError(): void;
  }) => RelayDesktopClient;
}

interface ResolvedAppClient {
  client: KannaClient;
  listRecentTasksWithSupplement?: (
    onSupplement: (tasks: TaskSummary[]) => void
  ) => Promise<TaskSummary[]>;
  dispose(): void;
  setForeground(foreground: boolean): void;
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
  let liveCloudTasksReadError: unknown | null = null;
  let liveSubscriptionEpoch = 0;
  let clientGeneration = 0;
  let currentLiveTaskRepublish: (() => Promise<void>) | null = null;
  let currentLiveTaskRecoveryInvalidation: (() => void) | null = null;
  let currentLanInventoryRefresh: (() => Promise<void>) | null = null;
  let currentLanDiscoveryRefresh: (() => Promise<void>) | null = null;
  let lanDiscoveryRefreshQueued = false;
  let activeAuthUid = signedInUid(authSession.getState());
  const taskRouteListeners = new Set<() => void>();
  const publishTaskRouteChange = () => {
    for (const listener of taskRouteListeners) listener();
  };
  // Native discovery can settle after the first cloud snapshot and relay
  // presence read. Feed it through the same complete-snapshot drain so the
  // newly reachable LAN source is incorporated without publishing a partial
  // workspace or waiting for an unrelated cloud callback.
  bonjourBrowser.subscribe(() => {
    const signedIn = authSession.getState().status === "signedIn";
    const hasTrustedPeer = hasTrustedLanPeer(
      sessionStore.getState().trustedDesktops
    );
    if (
      forceCloud ||
      (!signedIn && !hasTrustedPeer)
    ) {
      return;
    }
    if (signedIn && !hasTrustedPeer) {
      void currentLiveTaskRepublish?.();
      return;
    }
    if (lanDiscoveryRefreshQueued) return;
    lanDiscoveryRefreshQueued = true;
    void Promise.resolve().then(async () => {
      lanDiscoveryRefreshQueued = false;
      const republishLiveTasks = currentLiveTaskRepublish;
      if (signedIn) {
        await currentLanInventoryRefresh?.();
        const republish = currentLiveTaskRepublish ?? republishLiveTasks;
        if (republish) {
          await republish();
          return;
        }
      }
      await currentLanDiscoveryRefresh?.();
    });
  });
  const invalidateLiveCloudState = () => {
    liveSubscriptionEpoch += 1;
    liveCloudTasks = [];
    liveCloudTasksUid = null;
    liveCloudTasksReady = false;
    liveCloudTasksReadError = null;
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
      getMobileDeviceId: () => sessionStore.getState().mobileDeviceId,
      getMachineSourceDesktops: () => ({
        account: sessionStore.getState().accountDesktops,
        local: sessionStore.getState().liveLanDesktops
      }),
      getLiveCloudTasks: () => liveCloudTasks,
      getLiveCloudTasksUid: () => liveCloudTasksUid,
      getLiveCloudTasksReadError: () => liveCloudTasksReadError,
      isLiveCloudTasksReady: () => liveCloudTasksReady,
      onActiveDesktopIdsChanged: () => {
        if (generation === clientGeneration) {
          return currentLiveTaskRepublish?.();
        }
      },
      onMachineSourceWarnings: (warnings) => {
        if (generation !== clientGeneration) {
          return;
        }
        sessionStore.setMachineSourceWarnings(warnings);
      },
      // A superseded client can still have a desktop read in flight, and its
      // result describes the account (or trust set) we just left. Only the
      // current client may write the machine list, or a read that started
      // before sign-out lands after it and restores the account's machines.
      onMachineSourcesChanged: (sources) => {
        if (generation !== clientGeneration) {
          return;
        }
        sessionStore.setMachineSourceDesktops(sources);
      },
      onTaskRoutesChanged: publishTaskRouteChange,
      relayUrl: options.relayUrl ?? resolveRelayUrl(readExpoPublicEnv(), {
        extraRelayUrl: extra?.relayUrl
      }),
      taskIndex: options.taskIndex,
      desktopRepoWaitMs: options.desktopRepoWaitMs
    });
  let appForeground = true;
  let activeClient = resolveClient(clientGeneration);
  const replaceActiveClient = () => {
    const currentState = sessionStore.getState();
    const trustedIds = new Set([
      ...currentState.accountDesktops.map((desktop) => desktop.id),
      ...currentState.trustedDesktops.map((desktop) => desktop.desktopId)
    ]);
    const retainedLocalDesktops = currentState.liveLanDesktops.filter((desktop) =>
      trustedIds.has(desktop.id)
    );
    if (retainedLocalDesktops.length !== currentState.liveLanDesktops.length) {
      sessionStore.setMachineSourceDesktops({
        account: currentState.accountDesktops,
        local: retainedLocalDesktops
      });
    }
    const previousClient = activeClient;
    currentLiveTaskRecoveryInvalidation?.();
    currentLiveTaskRepublish = null;
    // The generation advances before the client is built: a client publishes
    // machine sources while it is being constructed, and those publications
    // belong to the incoming generation, not the one being replaced.
    const nextGeneration = ++clientGeneration;
    const nextClient = resolveClient(nextGeneration);
    nextClient.setForeground(appForeground);
    activeClient = nextClient;
    previousClient.dispose();
    publishTaskRouteChange();
  };
  const client = createDelegatingClient(() => activeClient.client);
  let persistencePromise: Promise<SessionPersistence> | null = persistence
    ? Promise.resolve(persistence)
    : null;

  const getPersistence = () => {
    if (!persistencePromise) {
      persistencePromise = createDefaultSessionPersistence();
    }

    return persistencePromise;
  };

  let lastEnqueuedContextJson: string | null = null;
  let lastEnqueuedSave: Promise<void> = Promise.resolve();
  let persistenceTail: Promise<void> = Promise.resolve();
  const persistContext = (
    context = sessionStore.getPersistedContext()
  ): Promise<void> => {
    const serializedContext = JSON.stringify(context);
    if (serializedContext === lastEnqueuedContextJson) {
      return lastEnqueuedSave;
    }

    const save = persistenceTail
      .catch(() => undefined)
      .then(async () => {
        const resolvedPersistence = await getPersistence();
        await resolvedPersistence.save(context);
      })
      .catch((error) => {
        if (lastEnqueuedSave === save) {
          lastEnqueuedContextJson = null;
        }
        throw error;
      });
    lastEnqueuedContextJson = serializedContext;
    lastEnqueuedSave = save;
    persistenceTail = save;
    return save;
  };

  const hydratePersistedContext = async () => {
    const resolvedPersistence = await getPersistence();
    const persistedContext = await resolvedPersistence.load();
    if (persistedContext) {
      const serializedContext = JSON.stringify(persistedContext);
      lastEnqueuedContextJson = serializedContext;
      lastEnqueuedSave = Promise.resolve();
      sessionStore.hydrateContext(persistedContext);
    }
    replaceActiveClient();
  };
  const pairingService = createMachinePairingService({
    bonjourBrowser,
    fetchImpl,
    getDeviceIdentity: () => ({
      deviceId:
        sessionStore.getState().mobileDeviceId ??
        sessionStore.ensureMobileDeviceId(generateMobileDeviceId),
      deviceName: "Kanna Mobile"
    })
  });
  const controller = createMobileController(client, sessionStore, authSession, {
    pairingService,
    persistSessionContext: persistContext,
    replaceClientForTrustChange: replaceActiveClient,
    subscribeTaskRouteChanges(listener) {
      taskRouteListeners.add(listener);
      return () => taskRouteListeners.delete(listener);
    },
    subscribeCloudTasks: (uid, onUpdate, onError) => {
      const epoch = ++liveSubscriptionEpoch;
      let updateRevision = 0;
      let recoveryRevision = 0;
      let taskIndexSubscriptionRevision = 0;
      let taskIndexUnsubscribe: (() => void) | null = null;
      let taskIndexRestartTimer: ReturnType<typeof setTimeout> | null = null;
      let taskIndexRestartAttempt = 0;
      let presenceRepublishPending = false;
      let livePublicationPendingGeneration: number | null = null;
      let livePublicationDrain: Promise<void> | null = null;
      let currentTaskRecovery: {
        revision: number;
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
      const publishCurrentTasks = async (
        revision: number,
        cloudAuthoritative = true,
        reportError = true
      ): Promise<boolean> => {
        const generation = clientGeneration;
        const source = activeClient;
        let published = false;
        try {
          const tasks = await (
            source.listRecentTasksWithSupplement
              ? source.listRecentTasksWithSupplement((supplement) => {
                  if (isCurrent(revision, generation)) {
                    onUpdate(supplement, { cloudAuthoritative: false });
                  }
                })
              : source.client.listRecentTasks()
          );
          if (isCurrent(revision, generation)) {
            onUpdate(tasks, { cloudAuthoritative });
            published = true;
          }
        } catch (error) {
          if (reportError && isCurrent(revision, generation)) onError?.(error);
        }
        return published;
      };
      const drainLivePublicationQueue = (): Promise<void> => {
        if (livePublicationDrain) return livePublicationDrain;
        const drain = (async () => {
          while (livePublicationPendingGeneration !== null) {
            const generation = livePublicationPendingGeneration;
            livePublicationPendingGeneration = null;
            if (
              epoch !== liveSubscriptionEpoch ||
              liveCloudTasksUid !== uid ||
              !liveCloudTasksReady ||
              generation !== clientGeneration
            ) {
              continue;
            }
            const revision = ++updateRevision;
            await publishCurrentTasks(revision);
          }
        })().finally(() => {
          if (livePublicationDrain === drain) {
            livePublicationDrain = null;
            if (livePublicationPendingGeneration !== null) {
              void drainLivePublicationQueue();
            }
          }
        });
        livePublicationDrain = drain;
        return drain;
      };
      const enqueueCurrentLiveTasks = (): Promise<void> => {
        if (
          epoch !== liveSubscriptionEpoch ||
          liveCloudTasksUid !== uid ||
          !liveCloudTasksReady
        ) {
          return Promise.resolve();
        }
        livePublicationPendingGeneration = clientGeneration;
        return drainLivePublicationQueue();
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
        await enqueueCurrentLiveTasks();
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
      const invalidateTaskIndexRecovery = () => {
        clearTaskIndexRestartTimer();
        recoveryRevision += 1;
        currentTaskRecovery = null;
        presenceRepublishPending = false;
      };
      currentLiveTaskRecoveryInvalidation = invalidateTaskIndexRecovery;
      let startTaskIndexSubscription: (generation: number) => void = () => undefined;
      const isTaskIndexOwnerCurrent = (generation: number) =>
        epoch === liveSubscriptionEpoch &&
        liveCloudTasksUid === uid &&
        generation === clientGeneration;
      const scheduleTaskIndexSubscriptionRestart = (generation: number) => {
        clearTaskIndexRestartTimer();
        if (!isTaskIndexOwnerCurrent(generation)) return;
        const delay = Math.min(
          CLOUD_TASK_RECOVERY_INITIAL_RETRY_MS * 2 ** taskIndexRestartAttempt,
          CLOUD_TASK_RECOVERY_MAX_RETRY_MS
        );
        taskIndexRestartAttempt += 1;
        const restartTimer = setTimeout(() => {
          if (taskIndexRestartTimer !== restartTimer) return;
          taskIndexRestartTimer = null;
          if (!isTaskIndexOwnerCurrent(generation)) return;
          startTaskIndexSubscription(generation);
        }, delay);
        taskIndexRestartTimer = restartTimer;
      };
      const recoverCurrentTasks = (indexError: CloudTaskIndexError) => {
        if (epoch !== liveSubscriptionEpoch || liveCloudTasksUid !== uid) return;
        if (indexError.scope === "document") {
          onError?.(formatCloudTaskIndexError(indexError));
          return;
        }
        stopTaskIndexSubscription();
        onError?.(formatCloudTaskIndexError(indexError));
        livePublicationPendingGeneration = null;
        const revision = ++updateRevision;
        const generation = clientGeneration;
        const recovery = {
          revision: ++recoveryRevision,
          succeeded: false
        };
        currentTaskRecovery = recovery;
        const isCurrentRecovery = () =>
          currentTaskRecovery === recovery &&
          recovery.revision === recoveryRevision &&
          isCurrent(revision, generation);
        void getCloudTaskIndex().listRecentTasks(uid).then((tasks) => {
          if (!isCurrentRecovery()) {
            return false;
          }
          liveCloudTasks = tasks;
          liveCloudTasksUid = uid;
          liveCloudTasksReady = true;
          liveCloudTasksReadError = null;
          return publishCurrentTasks(revision);
        }).catch((error) => {
          if (!isCurrentRecovery()) {
            return false;
          }
          liveCloudTasksReadError = error;
          return publishCurrentTasks(revision, false, false);
        }).then((published) => {
          if (!published || !isCurrentRecovery()) return;
          recovery.succeeded = published;
        }).finally(() => {
          if (currentTaskRecovery === recovery) {
            currentTaskRecovery = null;
            // A one-shot read can repair the data snapshot, but only a live
            // listener callback proves listener health and resets backoff.
            scheduleTaskIndexSubscriptionRestart(generation);
            if (recovery.succeeded && presenceRepublishPending) {
              presenceRepublishPending = false;
              void republishCurrentLiveTasks();
            }
          }
        });
      };
      startTaskIndexSubscription = (generation) => {
        if (!isTaskIndexOwnerCurrent(generation)) return;
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
            liveCloudTasks = tasks;
            liveCloudTasksUid = uid;
            liveCloudTasksReady = true;
            liveCloudTasksReadError = null;
            taskIndexRestartAttempt = 0;
            void enqueueCurrentLiveTasks();
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
      startTaskIndexSubscription(clientGeneration);
      return () => {
        livePublicationPendingGeneration = null;
        invalidateTaskIndexRecovery();
        if (
          currentLiveTaskRecoveryInvalidation === invalidateTaskIndexRecovery
        ) {
          currentLiveTaskRecoveryInvalidation = null;
        }
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
  currentLanInventoryRefresh = async () => {
    try {
      await activeClient.client.listDesktops();
    } catch {
      // Source-specific inventory warnings are published by the client.
    }
  };
  currentLanDiscoveryRefresh = async () => {
    await currentLanInventoryRefresh?.();
    await controller.bootstrap();
  };
  sessionStore.subscribe(() => {
    void persistContext().catch(() => undefined);
  });
  authSession.subscribe((authState) => {
    const nextAuthUid = signedInUid(authState);
    if (nextAuthUid !== activeAuthUid) {
      invalidateLiveCloudState();
      activeAuthUid = nextAuthUid;
      // Clear before the client is rebuilt: the next client seeds its desktop
      // sources from the store, so the account's machines must already be gone
      // or it republishes them as its own.
      sessionStore.resetAccountScopedMachines();
      replaceActiveClient();
    }
  });

  if (options.enableE2eTrustSeed) {
    installE2eTrustSeedHandler({
      getPersistence,
      pairPayload: (payload) => controller.pairMachineByPayload(payload),
      async reload() {
        await hydratePersistedContext();
        await controller.bootstrap();
      }
    });
  }

  return {
    client,
    controller,
    getAuthIdToken(forceRefresh) {
      return authSession.getIdToken(forceRefresh);
    },
    async initialize() {
      bonjourBrowser.start();
      await hydratePersistedContext();
      const hadMobileDeviceId = Boolean(sessionStore.getState().mobileDeviceId);
      sessionStore.ensureMobileDeviceId(generateMobileDeviceId);
      if (!hadMobileDeviceId) {
        await persistContext();
      }
      await controller.bootstrap();
    },
    sessionStore,
    setForceCloud(enabled) {
      forceCloud = enabled;
      replaceActiveClient();
    },
    setForeground(foreground) {
      appForeground = foreground;
      activeClient.setForeground(foreground);
    }
  };
}

function generateMobileDeviceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `mobile-${uuid}`;
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createClientForMode({
  authSession,
  bonjourBrowser,
  createRelayClient,
  fetchImpl,
  forceCloud,
  getSelectedDesktopId,
  getTrustedDesktops,
  getMobileDeviceId,
  getMachineSourceDesktops,
  getLiveCloudTasks,
  getLiveCloudTasksUid,
  getLiveCloudTasksReadError,
  isLiveCloudTasksReady,
  onActiveDesktopIdsChanged,
  onMachineSourceWarnings,
  onMachineSourcesChanged,
  onTaskRoutesChanged,
  relayUrl,
  taskIndex,
  desktopRepoWaitMs,
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
  getMobileDeviceId(): string | null;
  getMachineSourceDesktops(): {
    account: DesktopSummary[];
    local: DesktopSummary[];
  };
  getLiveCloudTasks(): TaskSummary[];
  getLiveCloudTasksUid(): string | null;
  getLiveCloudTasksReadError(): unknown | null;
  isLiveCloudTasksReady(): boolean;
  onActiveDesktopIdsChanged(): Promise<void> | void;
  onMachineSourceWarnings(warnings: {
    account: string | null;
    local: string | null;
  }): void;
  onMachineSourcesChanged(sources: {
    account: DesktopSummary[];
    local: DesktopSummary[];
  }): void;
  onTaskRoutesChanged(): void;
  relayUrl: string | null;
  taskIndex?: CloudTaskIndex;
  desktopRepoWaitMs?: number;
}): ResolvedAppClient {
  const authState = authSession.getState();
  if (authState.status === "signedIn" && relayUrl) {
    const relayClient = createRelayClient({
      relayUrl,
      getIdToken: (forceRefresh) => authSession.getIdToken(forceRefresh),
      onAuthError: () => authSession.notifyAuthExpired(),
    });
    let disposed = false;
    let accountDesktopIds = new Set(
      getMachineSourceDesktops().account.map((desktop) => desktop.id)
    );
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
      let tasks: TaskSummary[];
      if (
        isLiveCloudTasksReady() &&
        getLiveCloudTasksUid() === authState.user.uid
      ) {
        tasks = getLiveCloudTasks();
      } else {
        const readError = getLiveCloudTasksReadError();
        if (readError !== null) {
          throw readError;
        }
        tasks = await resolvedTaskIndex.listRecentTasks(authState.user.uid);
      }
      return preferActiveCloudTaskRoutes(tasks, lastActiveDesktopIds);
    };
    const listCloudDesktopRecords = async () => {
      refreshActiveDesktopIds();
      const records = await resolvedTaskIndex.listDesktops(authState.user.uid);
      accountDesktopIds = new Set(records.map((record) => record.desktopId));
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
        observeTaskCompanion: relayClient.observeTaskCompanion,
        observeDesktopTaskSummaries: relayClient.observeDesktopTaskSummaries,
        listCloudTasks: listCloudTasksForRouting,
        desktopRepoWaitMs,
      }),
    );
    const getTrustedDesktopIds = () => Array.from(new Set([
      ...accountDesktopIds,
      ...getTrustedDesktops().map((desktop) => desktop.desktopId)
    ]));
    const trustedLanClient = createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktopIds,
      getLanDeviceCredentials: (desktopId) =>
        lanDeviceCredentialsForDesktop(getTrustedDesktops, getMobileDeviceId, desktopId),
      onValidatedRoutesChanged: onTaskRoutesChanged
    });

    const composedClient = createCloudLanClient(
      cloudClient,
      trustedLanClient.client,
      {
        isLanEnabled: () =>
          !forceCloud && getTrustedDesktopIds().length > 0,
        canUseLanTaskStreams: (desktopId) =>
          lanDeviceCredentialsForDesktop(
            getTrustedDesktops,
            getMobileDeviceId,
            desktopId
          ) !== null,
        lanClientForDesktop: trustedLanClient.clientForDesktop,
        initialDesktopSources: getMachineSourceDesktops(),
        onDesktopSourceWarnings: onMachineSourceWarnings,
        onDesktopSourcesChanged: onMachineSourcesChanged,
        onLanReadUnavailable:
          trustedLanClient.invalidatePendingValidatedRoutes
      }
    );

    return {
      client: composedClient,
      listRecentTasksWithSupplement: (onSupplement) =>
        composedClient.listRecentTasksWithSupplement(onSupplement),
      dispose() {
        if (disposed) return;
        disposed = true;
        relayClient.close();
      },
      setForeground(foreground) {
        relayClient.setForeground?.(foreground);
      }
    };
  }

  if (hasTrustedLanPeer(getTrustedDesktops())) {
    const trustedLanClient = createTrustedLanFallbackClient({
      bonjourBrowser,
      fetchImpl,
      getSelectedDesktopId,
      getTrustedDesktopIds: () =>
        getTrustedDesktops().map((desktop) => desktop.desktopId),
      getLanDeviceCredentials: (desktopId) =>
        lanDeviceCredentialsForDesktop(getTrustedDesktops, getMobileDeviceId, desktopId),
      onValidatedRoutesChanged: onTaskRoutesChanged
    });
    const sourceTrackingClient: KannaClient = {
      ...trustedLanClient.client,
      async listDesktops() {
        const local = await trustedLanClient.client.listDesktops();
        onMachineSourcesChanged({ account: [], local });
        return local;
      }
    };
    return {
      client: sourceTrackingClient,
      dispose() {},
      setForeground() {}
    };
  }

  onMachineSourcesChanged({ account: [], local: [] });
  return { client: createDisconnectedClient(), dispose() {}, setForeground() {} };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function createDisconnectedClient(): KannaClient {
  const unavailableMessage =
    "No trusted desktop is available. Sign in or pair a desktop.";
  const unavailable = async () => {
    throw new Error(unavailableMessage);
  };
  const createUnavailable = async () => {
    throw new TaskCreationError("not-created", unavailableMessage);
  };

  return {
    getStatus: async () => ({
      state: "stopped",
      desktopId: "none",
      desktopName: "No desktop",
      version: "unavailable",
      environment: "development",
      serverVersion: null,
      lanHost: "none",
      lanPort: 0,
      pairingCode: null,
      writePathHealth: {
        healthy: false,
        status: "unavailable",
        activeWorkspaceCommands: 0,
        maxWorkspaceCommands: 0,
        longRunningWorkspaceCommands: 0,
        oldestWorkspaceCommandSeconds: null
      }
    }),
    listDesktops: async () => [],
    listRepos: async () => [],
    listRepoTasks: async () => [],
    listRepoCommands: unavailable,
    runRepoCommand: unavailable,
    listRecentTasks: async () => [],
    searchTasks: async () => [],
    createTask: createUnavailable,
    abortTaskCreation: unavailable,
    runMergeAgent: unavailable,
    advanceTaskStage: unavailable,
    markTaskRead: unavailable,
    closeTask: unavailable,
    sendTaskInput: unavailable,
    // No desktop is reachable, so nothing can receive a photo.
    supportsTaskInputAttachments: async () => false,
    readTaskFile: unavailable,
    listTaskDirectory: unavailable,
    readTaskFileRange: unavailable,
    resolveTaskFileMentions: unavailable,
    readTaskDiff: unavailable,
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
    observeTaskCompanion(taskId, listener) {
      listener({
        type: "error",
        taskId,
        code: "desktop_unavailable",
        message: "No trusted desktop is available."
      });
      return { close() {}, sendEvent: () => false };
    }
  };
}

function createTrustedLanFallbackClient({
  bonjourBrowser,
  fetchImpl,
  getSelectedDesktopId,
  getTrustedDesktopIds,
  getLanDeviceCredentials,
  onValidatedRoutesChanged
}: {
  bonjourBrowser: BonjourBrowser;
  fetchImpl: FetchLike;
  getSelectedDesktopId(): string | null;
  getTrustedDesktopIds(): readonly string[];
  getLanDeviceCredentials(desktopId: string): LanDeviceCredentials | null;
  onValidatedRoutesChanged(): void;
}): {
  client: KannaClient;
  clientForDesktop(desktopId: string): KannaClient | null;
  invalidatePendingValidatedRoutes(): void;
} {
  const validatedBaseUrls = new Map<string, string>();
  const validatedClients = new Map<string, {
    baseUrl: string;
    deviceId: string | null;
    deviceSecret: string | null;
    client: KannaClient;
  }>();
  let lastValidatedDesktopId: string | null = null;
  let pendingValidationCount = 0;
  const replaceValidatedBaseUrls = (
    endpoints: readonly { desktopId: string; baseUrl: string }[]
  ) => {
    const nextBaseUrls = new Map(
      endpoints.map((endpoint) => [endpoint.desktopId, endpoint.baseUrl])
    );
    const changed = !areStringMapsEqual(validatedBaseUrls, nextBaseUrls);
    validatedBaseUrls.clear();
    for (const [desktopId, baseUrl] of nextBaseUrls) {
      validatedBaseUrls.set(desktopId, baseUrl);
    }
    for (const [desktopId, cached] of validatedClients) {
      if (nextBaseUrls.get(desktopId) !== cached.baseUrl) {
        validatedClients.delete(desktopId);
      }
    }
    lastValidatedDesktopId = endpoints[0]?.desktopId ?? null;
    if (changed) onValidatedRoutesChanged();
  };
  const setValidatedBaseUrl = (desktopId: string, baseUrl: string) => {
    const changed = validatedBaseUrls.get(desktopId) !== baseUrl;
    validatedBaseUrls.set(desktopId, baseUrl);
    if (changed) validatedClients.delete(desktopId);
    lastValidatedDesktopId = desktopId;
    if (changed) onValidatedRoutesChanged();
  };
  const invalidateValidatedRoutes = () => {
    replaceValidatedBaseUrls([]);
  };
  const withPendingValidation = async <T>(read: () => Promise<T>) => {
    pendingValidationCount += 1;
    try {
      return await read();
    } finally {
      pendingValidationCount -= 1;
    }
  };
  const invalidatePendingValidatedRoutes = () => {
    if (pendingValidationCount > 0) invalidateValidatedRoutes();
  };
  const clientForBaseUrl = (resolvedBaseUrl: string, desktopId: string) => {
    const credentials = getLanDeviceCredentials(desktopId);
    const cached = validatedClients.get(desktopId);
    if (
      cached?.baseUrl === resolvedBaseUrl
      && cached.deviceId === (credentials?.deviceId ?? null)
      && cached.deviceSecret === (credentials?.deviceSecret ?? null)
    ) {
      return cached.client;
    }
    const client = createKannaClient(
      createLanTransport(resolvedBaseUrl, fetchImpl, undefined, {
        deviceCredentials: credentials
      })
    );
    validatedClients.set(desktopId, {
      baseUrl: resolvedBaseUrl,
      deviceId: credentials?.deviceId ?? null,
      deviceSecret: credentials?.deviceSecret ?? null,
      client
    });
    return client;
  };
  const resolveClient = async (desktopId: string | null) => {
    const trustedDesktopIds = desktopId
      ? getTrustedDesktopIds().filter((trustedId) => trustedId === desktopId)
      : getTrustedDesktopIds();
    const services = desktopId
      ? bonjourBrowser
          .getServices()
          .filter((service) => service.txt.desktopId === desktopId)
      : bonjourBrowser.getServices();
    const endpoint = await withPendingValidation(() =>
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services,
        preferredDesktopId: desktopId ?? getSelectedDesktopId(),
        trustedDesktopIds
      })
    );
    if (!endpoint) {
      if (desktopId) {
        if (validatedBaseUrls.delete(desktopId)) {
          validatedClients.delete(desktopId);
          if (lastValidatedDesktopId === desktopId) {
            lastValidatedDesktopId = validatedBaseUrls.keys().next().value ?? null;
          }
          onValidatedRoutesChanged();
        }
      } else {
        invalidateValidatedRoutes();
      }
      return createDisconnectedClient();
    }
    setValidatedBaseUrl(endpoint.desktopId, endpoint.baseUrl);
    return clientForBaseUrl(endpoint.baseUrl, endpoint.desktopId);
  };
  const currentClient = (desktopId: string | null) => {
    const cachedDesktopId = desktopId ?? lastValidatedDesktopId;
    const baseUrl = cachedDesktopId
      ? validatedBaseUrls.get(cachedDesktopId)
      : undefined;
    return baseUrl && cachedDesktopId
      ? clientForBaseUrl(baseUrl, cachedDesktopId)
      : createDisconnectedClient();
  };
  const createResolvingClient = (desktopId: string | null): KannaClient => ({
    observeMobileNotifications(listener) {
      return currentClient(desktopId).observeMobileNotifications?.(listener) ?? {
        close() {}
      };
    },
    getStatus: async () => (await resolveClient(desktopId)).getStatus(),
    listDesktops: async () => (await resolveClient(desktopId)).listDesktops(),
    listRepos: async () => (await resolveClient(desktopId)).listRepos(),
    listRepoTasks: async (repoId) =>
      (await resolveClient(desktopId)).listRepoTasks(repoId),
    listRepoCommands: async (repoId) =>
      (await resolveClient(desktopId)).listRepoCommands(repoId),
    runRepoCommand: async (repoId, commandId, catalogRevision) =>
      (await resolveClient(desktopId)).runRepoCommand(
        repoId,
        commandId,
        catalogRevision
      ),
    listRecentTasks: async () => (await resolveClient(desktopId)).listRecentTasks(),
    getTask: async (taskId) => {
      const resolvedClient = await resolveClient(desktopId);
      if (!resolvedClient.getTask) {
        throw new Error("Task detail is not available from this desktop.");
      }
      return resolvedClient.getTask(taskId);
    },
    searchTasks: async (query) =>
      (await resolveClient(desktopId)).searchTasks(query),
    createTask: async (input) => (await resolveClient(desktopId)).createTask(input),
    abortTaskCreation: async (input) =>
      (await resolveClient(input.desktopId)).abortTaskCreation(input),
    runMergeAgent: async (taskId) =>
      (await resolveClient(desktopId)).runMergeAgent(taskId),
    advanceTaskStage: async (taskId) =>
      (await resolveClient(desktopId)).advanceTaskStage(taskId),
    markTaskRead: async (taskId, expectedActivityRevision) =>
      expectedActivityRevision === undefined
        ? (await resolveClient(desktopId)).markTaskRead(taskId)
        : (await resolveClient(desktopId)).markTaskRead(
            taskId,
            expectedActivityRevision
          ),
    closeTask: async (taskId) =>
      (await resolveClient(desktopId)).closeTask(taskId),
    sendTaskInput: async (taskId, input, attachment) => {
      const client = await resolveClient(desktopId);
      return attachment
        ? client.sendTaskInput(taskId, input, attachment)
        : client.sendTaskInput(taskId, input);
    },
    supportsTaskInputAttachments: async (taskId) =>
      (await resolveClient(desktopId)).supportsTaskInputAttachments(taskId),
    readTaskFile: async (taskId, path) =>
      (await resolveClient(desktopId)).readTaskFile(taskId, path),
    listTaskDirectory: async (taskId, path, showAllFiles, offset, filter) =>
      (await resolveClient(desktopId)).listTaskDirectory(taskId, path, showAllFiles, offset, filter),
    readTaskFileRange: async (taskId, path, startLine, lineCount, metadataOnly, startByte) =>
      (await resolveClient(desktopId)).readTaskFileRange(taskId, path, startLine, lineCount, metadataOnly, startByte),
    resolveTaskFileMentions: async (taskId, mentions) =>
      (await resolveClient(desktopId)).resolveTaskFileMentions(
        taskId,
        mentions
      ),
    readTaskDiff: async (taskId, request) =>
      (await resolveClient(desktopId)).readTaskDiff(taskId, request),
    observeTaskTerminal: (taskId, listener) =>
      currentClient(desktopId).observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      currentClient(desktopId).observeTaskAgent(taskId, listener),
    observeTaskCompanion: (taskId, listener) =>
      currentClient(desktopId).observeTaskCompanion(taskId, listener)
  });
  const client: KannaClient = {
    ...createResolvingClient(null),
    observeMobileNotifications(listener) {
      const subscriptions = [...validatedClients.values()]
        .map(({ client }) => client.observeMobileNotifications?.(listener))
        .filter((subscription) => subscription !== undefined);
      return {
        close() {
          for (const subscription of subscriptions) subscription.close();
        }
      };
    },
    async listDesktops() {
      const endpoints = await withPendingValidation(() =>
        resolveTrustedBonjourEndpoints({
          fetchImpl,
          services: bonjourBrowser.getServices(),
          preferredDesktopId: getSelectedDesktopId(),
          trustedDesktopIds: getTrustedDesktopIds()
        })
      );
      replaceValidatedBaseUrls(endpoints);
      return endpoints.map((endpoint): DesktopSummary => ({
        id: endpoint.desktopId,
        name: endpoint.displayName,
        online: true,
        mode: "lan",
        reachableViaRelay: false,
        connectionMode: "lan",
        lastSeenAt: new Date().toISOString(),
        ...(endpoint.agentProviders
          ? { agentProviders: endpoint.agentProviders }
          : {})
      }));
    }
  };
  return {
    client,
    invalidatePendingValidatedRoutes,
    clientForDesktop(desktopId) {
      if (
        !getTrustedDesktopIds().includes(desktopId)
      ) {
        return null;
      }
      const validatedBaseUrl = validatedBaseUrls.get(desktopId);
      return validatedBaseUrl ? clientForBaseUrl(validatedBaseUrl, desktopId) : null;
    }
  };
}

function lanDeviceCredentialsForDesktop(
  getTrustedDesktops: () => readonly TrustedDesktopRecord[],
  getMobileDeviceId: () => string | null,
  desktopId: string
): LanDeviceCredentials | null {
  const deviceId = getMobileDeviceId();
  if (!deviceId) return null;
  const deviceSecret = getTrustedDesktops().find(
    (desktop) => desktop.desktopId === desktopId
  )?.deviceSecret;
  return deviceSecret ? { deviceId, deviceSecret } : null;
}

function hasTrustedLanPeer(
  trustedDesktops: readonly TrustedDesktopRecord[]
): boolean {
  return trustedDesktops.length > 0;
}

function areStringMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
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
    lastSeenAt: desktop.updatedAt,
    ...(desktop.agentProviders
      ? { agentProviders: desktop.agentProviders }
      : {})
  };
}

function createDelegatingClient(getClient: () => KannaClient): KannaClient {
  return {
    observeMobileNotifications(listener) {
      return getClient().observeMobileNotifications?.(listener) ?? { close() {} };
    },
    getTaskRouteIdentity: (taskId) =>
      getClient().getTaskRouteIdentity?.(taskId) ?? taskId,
    getStatus: () => getClient().getStatus(),
    listDesktops: () => getClient().listDesktops(),
    listRepos: () => getClient().listRepos(),
    listRepoTasks: (repoId) => getClient().listRepoTasks(repoId),
    listRepoCommands: (repoId) => getClient().listRepoCommands(repoId),
    runRepoCommand: (repoId, commandId, catalogRevision) =>
      getClient().runRepoCommand(repoId, commandId, catalogRevision),
    listRecentTasks: () => getClient().listRecentTasks(),
    getTask: (taskId) => {
      const client = getClient();
      if (!client.getTask) {
        return Promise.reject(
          new Error("Task detail is not available from this client.")
        );
      }
      return client.getTask(taskId);
    },
    searchTasks: (query) => getClient().searchTasks(query),
    createTask: (input) => getClient().createTask(input),
    abortTaskCreation: (input) => getClient().abortTaskCreation(input),
    runMergeAgent: (taskId) => getClient().runMergeAgent(taskId),
    advanceTaskStage: (taskId) => getClient().advanceTaskStage(taskId),
    markTaskRead: (taskId, expectedActivityRevision) =>
      expectedActivityRevision === undefined
        ? getClient().markTaskRead(taskId)
        : getClient().markTaskRead(taskId, expectedActivityRevision),
    closeTask: (taskId) => getClient().closeTask(taskId),
    sendTaskInput: (taskId, input, attachment) =>
      attachment
        ? getClient().sendTaskInput(taskId, input, attachment)
        : getClient().sendTaskInput(taskId, input),
    supportsTaskInputAttachments: (taskId) =>
      getClient().supportsTaskInputAttachments(taskId),
    readTaskFile: (taskId, path) => getClient().readTaskFile(taskId, path),
    listTaskDirectory: (taskId, path, showAllFiles, offset, filter) => getClient().listTaskDirectory(taskId, path, showAllFiles, offset, filter),
    readTaskFileRange: (taskId, path, startLine, lineCount, metadataOnly, startByte) => getClient().readTaskFileRange(taskId, path, startLine, lineCount, metadataOnly, startByte),
    resolveTaskFileMentions: (taskId, mentions) =>
      getClient().resolveTaskFileMentions(taskId, mentions),
    readTaskDiff: (taskId, request) => getClient().readTaskDiff(taskId, request),
    observeTaskTerminal: (taskId, listener) =>
      getClient().observeTaskTerminal(taskId, listener),
    observeTaskAgent: (taskId, listener) =>
      getClient().observeTaskAgent(taskId, listener),
    observeTaskCompanion: (taskId, listener) =>
      getClient().observeTaskCompanion(taskId, listener)
  };
}

import type { TaskSummary } from "../api/types";
import type { DesktopPushIdentity, PushPairingCertificate } from "../api/types";
import { taskLocalId } from "../api/taskIdentity";

const AUTHORIZED = 1;
const PROVISIONAL = 2;

export interface MobileNotificationTaskTarget {
  desktopId: string;
  taskId: string;
}

interface RemoteMessageLike {
  data?: Record<string, unknown>;
}

interface ForegroundNotificationBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

interface ForegroundNotificationHandler {
  handleNotification(): Promise<ForegroundNotificationBehavior>;
}

interface MobilePushSdk {
  setNotificationHandler(handler: ForegroundNotificationHandler): void;
  requestPermission(): Promise<number>;
  getToken(): Promise<string>;
  onTokenRefresh(listener: (token: string) => void): () => void;
  getInitialNotification(): Promise<RemoteMessageLike | null>;
  onNotificationOpened(
    listener: (message: RemoteMessageLike) => void
  ): () => void;
  onNotificationResponse(
    listener: (message: RemoteMessageLike) => void
  ): () => void;
}

export interface AnonymousPushPairing {
  desktopId: string;
  desktopPushIdentity: DesktopPushIdentity;
  pushPairingCert: PushPairingCertificate;
}

interface StartMobilePushInput {
  deviceId: string;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  onTaskOpen(target: MobileNotificationTaskTarget): void;
  relayUrl: string;
  fetchImpl?: typeof fetch;
  sdk?: MobilePushSdk;
  anonymousPairings?: readonly AnonymousPushPairing[];
  anonymousBindingCoordinator?: AnonymousPushBindingCoordinator;
  accountRegistrationCoordinator?: AccountPushRegistrationCoordinator;
}

/**
 * The account registration this device should hold on the relay.
 * `getIdToken` is kept so a retry, or an unregister long after the token the
 * registration used has expired, can mint a fresh one.
 */
export interface AccountPushRegistrationDesire {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

export interface AccountPushRegistrationSnapshot {
  deviceToken: string;
  registrationId: string;
}

export interface AccountPushRegistrationLease {
  relayUrl: string;
  deviceId: string;
  generation: number;
}

export interface AccountPushRegistrationAttempt {
  lease: AccountPushRegistrationLease;
  settled: Promise<void>;
}

/**
 * Serializes account push registration per device and reconciles the relay
 * toward the latest declared state.
 *
 * Before this existed, every re-run of the push effect fired a fire-and-forget
 * unregister for the previous registration while the new run registered the
 * same FCM token. On 2026-09-03 three such runs landed within 700 ms on
 * staging and the last cleanup deleted the live row (task 34047a85). Here the
 * desired state is owned by the latest lifecycle lease, one worker per device
 * applies it in order, a registration failure is retried instead of being
 * remembered as registered, and every registration carries an id the relay
 * compares on unregister.
 */
export interface AccountPushRegistrationCoordinator {
  /**
   * Declare the registration this device should hold. Resolves once the
   * first attempt has settled: applied, superseded, or failed with a retry
   * scheduled. Retries continue in the background until applied or replaced.
   */
  register(desire: AccountPushRegistrationDesire): AccountPushRegistrationAttempt;
  /**
   * Release a lifecycle's registration desire. A stale lease is ignored so
   * an older effect cleanup cannot retire the current lifecycle's registration.
   */
  unregister(lease: AccountPushRegistrationLease): Promise<void>;
  /** What the relay is believed to hold right now; `null` when nothing. */
  applied(relayUrl: string, deviceId: string): AccountPushRegistrationSnapshot | null;
}

interface AccountPushRegistrationCoordinatorOptions {
  fetchImpl?: typeof fetch;
  /** Delay before retry number `attempt` (1-based). Tests shorten it. */
  retryDelayMs?: (attempt: number) => number;
  /** How many times an unregister is retried before the local record is dropped. */
  maxUnregisterAttempts?: number;
  createRegistrationId?: () => string;
}

interface AppliedAccountRegistration extends AccountPushRegistrationSnapshot {
  idToken: string;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
}

interface AccountRegistrationState {
  desired: AccountPushRegistrationDesire | null;
  activeLease: AccountPushRegistrationLease | null;
  applied: AppliedAccountRegistration | null;
  worker: Promise<void> | null;
  /** Resolves the current retry sleep early when the desire changes. */
  wake: (() => void) | null;
  /** Resolvers waiting for the current or next attempt to settle. */
  settled: (() => void)[];
  forceRefresh: boolean;
}

const DEFAULT_MAX_UNREGISTER_ATTEMPTS = 5;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function defaultRegistrationId(): string {
  return `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function accountRegistrationKey(relayUrl: string, deviceId: string): string {
  return `${relayUrl}\0${deviceId}`;
}

export function createAccountPushRegistrationCoordinator(
  options: AccountPushRegistrationCoordinatorOptions = {}
): AccountPushRegistrationCoordinator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const maxUnregisterAttempts =
    options.maxUnregisterAttempts ?? DEFAULT_MAX_UNREGISTER_ATTEMPTS;
  const createRegistrationId = options.createRegistrationId ?? defaultRegistrationId;
  const states = new Map<string, AccountRegistrationState>();
  let nextLeaseGeneration = 0;

  const stateFor = (relayUrl: string, deviceId: string): AccountRegistrationState => {
    const key = accountRegistrationKey(relayUrl, deviceId);
    const existing = states.get(key);
    if (existing) return existing;
    const created: AccountRegistrationState = {
      desired: null,
      activeLease: null,
      applied: null,
      worker: null,
      wake: null,
      settled: [],
      forceRefresh: false
    };
    states.set(key, created);
    return created;
  };

  const settle = (state: AccountRegistrationState) => {
    const waiters = state.settled;
    state.settled = [];
    for (const resolve of waiters) resolve();
  };

  const sleep = (state: AccountRegistrationState, ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.wake = null;
        resolve();
      }, ms);
      state.wake = () => {
        clearTimeout(timer);
        state.wake = null;
        resolve();
      };
    });

  const postJson = async (url: string, body: Record<string, string>) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.status;
  };

  const isReconciled = (state: AccountRegistrationState): boolean =>
    state.desired
      ? state.applied?.deviceToken === state.desired.deviceToken
      : state.applied === null;

  const runWorker = async (
    relayUrl: string,
    deviceId: string,
    state: AccountRegistrationState
  ): Promise<void> => {
    let registerAttempts = 0;
    let unregisterAttempts = 0;
    while (!isReconciled(state)) {
      const desired = state.desired;
      if (desired) {
        const registrationUrl = pushRegistrationUrl(desired.relayUrl);
        if (!registrationUrl) {
          console.error("Account push registration skipped: relay URL is invalid.");
          state.desired = null;
          settle(state);
          continue;
        }
        let failure: string | null = null;
        let idToken: string | null = null;
        try {
          idToken = await desired.getIdToken(state.forceRefresh);
        } catch (error: unknown) {
          failure = `id token unavailable (${String(error)})`;
        }
        if (!failure && !idToken) failure = "id token unavailable";
        const registrationId = createRegistrationId();
        if (!failure && idToken) {
          try {
            const status = await postJson(registrationUrl, {
              idToken,
              deviceId: desired.deviceId,
              deviceToken: desired.deviceToken,
              registrationId
            });
            if (status >= 200 && status < 300) {
              if (state.desired === desired) {
                state.applied = {
                  deviceToken: desired.deviceToken,
                  registrationId,
                  idToken,
                  getIdToken: desired.getIdToken
                };
              } else {
                // Superseded while in flight: the relay now holds this
                // registration, so record it and let the loop reconcile
                // toward the newer desire.
                state.applied = {
                  deviceToken: desired.deviceToken,
                  registrationId,
                  idToken,
                  getIdToken: desired.getIdToken
                };
              }
              state.forceRefresh = false;
              registerAttempts = 0;
              settle(state);
              continue;
            }
            failure = `relay answered ${status}`;
            if (status === 401) state.forceRefresh = true;
          } catch (error: unknown) {
            failure = String(error);
          }
        }
        registerAttempts += 1;
        console.error(
          `Account push registration failed (attempt ${registerAttempts}): ${failure}; retrying`
        );
        settle(state);
        if (state.desired !== desired) continue;
        await sleep(state, retryDelayMs(registerAttempts));
        continue;
      }

      const applied = state.applied;
      if (!applied) continue;
      const unregistrationUrl = pushUnregistrationUrl(relayUrl);
      if (!unregistrationUrl) {
        state.applied = null;
        settle(state);
        continue;
      }
      let failure: string | null = null;
      try {
        let idToken: string | null = applied.idToken;
        if (unregisterAttempts > 0) {
          idToken = (await applied.getIdToken(true)) ?? applied.idToken;
        }
        const status = await postJson(unregistrationUrl, {
          idToken,
          deviceId,
          deviceToken: applied.deviceToken,
          registrationId: applied.registrationId
        });
        if (status >= 200 && status < 300) {
          state.applied = null;
          unregisterAttempts = 0;
          settle(state);
          continue;
        }
        failure = `relay answered ${status}`;
      } catch (error: unknown) {
        failure = String(error);
      }
      unregisterAttempts += 1;
      if (unregisterAttempts >= maxUnregisterAttempts) {
        // The relay keeps the row until the next registration replaces it or
        // the push provider retires it; the local record is dropped so the
        // worker does not spin forever on a relay that is down.
        console.error(
          `Mobile notification unregistration gave up after ${unregisterAttempts} attempts: ${failure}`
        );
        state.applied = null;
        settle(state);
        continue;
      }
      console.error(
        `Mobile notification unregistration failed (attempt ${unregisterAttempts}): ${failure}; retrying`
      );
      settle(state);
      if (state.desired !== null) continue;
      await sleep(state, retryDelayMs(unregisterAttempts));
    }
    settle(state);
  };

  const kick = (
    relayUrl: string,
    deviceId: string,
    state: AccountRegistrationState
  ): Promise<void> => {
    const settled = new Promise<void>((resolve) => state.settled.push(resolve));
    if (state.worker) {
      state.wake?.();
    } else {
      state.worker = runWorker(relayUrl, deviceId, state)
        .catch((error: unknown) => {
          console.error("Account push registration worker failed:", error);
        })
        .finally(() => {
          state.worker = null;
          settle(state);
          if (!isReconciled(state)) void kick(relayUrl, deviceId, state);
        });
    }
    return settled;
  };

  return {
    register(desire) {
      const state = stateFor(desire.relayUrl, desire.deviceId);
      const lease = {
        relayUrl: desire.relayUrl,
        deviceId: desire.deviceId,
        generation: ++nextLeaseGeneration
      };
      state.activeLease = lease;
      state.desired = desire;
      return {
        lease,
        settled: isReconciled(state)
          ? Promise.resolve()
          : kick(desire.relayUrl, desire.deviceId, state)
      };
    },
    unregister(lease) {
      const state = stateFor(lease.relayUrl, lease.deviceId);
      if (state.activeLease !== lease) return Promise.resolve();
      state.activeLease = null;
      state.desired = null;
      if (isReconciled(state) && !state.worker) return Promise.resolve();
      return kick(lease.relayUrl, lease.deviceId, state);
    },
    applied(relayUrl, deviceId) {
      const applied = stateFor(relayUrl, deviceId).applied;
      return applied
        ? { deviceToken: applied.deviceToken, registrationId: applied.registrationId }
        : null;
    }
  };
}

const defaultAccountRegistrationCoordinator = createAccountPushRegistrationCoordinator();

type AnonymousPushFetch = (
  input: string,
  init: {
    method: "POST" | "DELETE";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{ ok: boolean; status: number }>;

function anonymousPairingKey(pairing: AnonymousPushPairing): string {
  return [
    pairing.desktopPushIdentity.relayUrl,
    pairing.desktopPushIdentity.publicKey,
    pairing.pushPairingCert.deviceId
  ].join("\0");
}

export interface AnonymousPushBindingCoordinator {
  begin(pairings: readonly AnonymousPushPairing[]): number;
  register(generation: number, deviceToken: string): Promise<void>;
  revoke(pairing: AnonymousPushPairing): Promise<void>;
  end(generation: number): void;
}

export function createAnonymousPushBindingCoordinator(
  fetchImpl: AnonymousPushFetch = fetch
): AnonymousPushBindingCoordinator {
  let generation = 0;
  let activeGeneration: number | null = null;
  let desiredPairings = new Map<string, AnonymousPushPairing>();
  let operationTail = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => undefined);
    return result;
  };
  const updatePairing = async (
    pairing: AnonymousPushPairing,
    method: "POST" | "DELETE",
    deviceToken?: string
  ) => {
    const url = pushEndpointUrl(
      pairing.desktopPushIdentity.relayUrl,
      "/push/pairings"
    );
    if (!url) {
      throw new Error("Anonymous push pairing has an invalid relay URL.");
    }
    const response = await fetchImpl(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: pairing.desktopPushIdentity.publicKey,
        deviceId: pairing.pushPairingCert.deviceId,
        ...(deviceToken ? { fcmToken: deviceToken } : {}),
        cert: pairing.pushPairingCert
      })
    });
    if (!response.ok) {
      throw new Error(
        `Anonymous push pairing ${method === "POST" ? "registration" : "revocation"} failed (${response.status}).`
      );
    }
  };

  return {
    begin(pairings) {
      generation += 1;
      activeGeneration = generation;
      desiredPairings = new Map(
        pairings.map((pairing) => [anonymousPairingKey(pairing), pairing])
      );
      return generation;
    },
    register(sessionGeneration, deviceToken) {
      if (activeGeneration !== sessionGeneration) return Promise.resolve();
      const registrations = [...desiredPairings.values()];
      return enqueue(async () => {
        if (activeGeneration !== sessionGeneration) return;
        for (const pairing of registrations) {
          if (desiredPairings.get(anonymousPairingKey(pairing)) !== pairing) continue;
          await updatePairing(pairing, "POST", deviceToken);
        }
      });
    },
    revoke(pairing) {
      desiredPairings.delete(anonymousPairingKey(pairing));
      return enqueue(() => updatePairing(pairing, "DELETE"));
    },
    end(sessionGeneration) {
      if (activeGeneration === sessionGeneration) activeGeneration = null;
    }
  };
}

const defaultAnonymousBindingCoordinator = createAnonymousPushBindingCoordinator();

export async function startMobilePushNotifications(
  input: StartMobilePushInput
): Promise<() => void> {
  const anonymousBindingCoordinator = input.anonymousBindingCoordinator
    ?? (input.fetchImpl
      ? createAnonymousPushBindingCoordinator(input.fetchImpl)
      : defaultAnonymousBindingCoordinator);
  const accountRegistrationCoordinator = input.accountRegistrationCoordinator
    ?? (input.fetchImpl
      ? createAccountPushRegistrationCoordinator({ fetchImpl: input.fetchImpl })
      : defaultAccountRegistrationCoordinator);
  const anonymousGeneration = anonymousBindingCoordinator.begin(
    input.anonymousPairings ?? []
  );
  const registrationUrl = pushRegistrationUrl(input.relayUrl);
  const unregistrationUrl = pushUnregistrationUrl(input.relayUrl);
  if (
    (!registrationUrl || !unregistrationUrl)
    && (input.anonymousPairings?.length ?? 0) === 0
  ) {
    return () => anonymousBindingCoordinator.end(anonymousGeneration);
  }

  const sdk = input.sdk ?? await loadMobilePushSdk();
  sdk.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false
    })
  });
  const translateAnonymousTarget = (
    target: MobileNotificationTaskTarget | null
  ): MobileNotificationTaskTarget | null => {
    if (!target) return null;
    const pairing = input.anonymousPairings?.find(
      (candidate) =>
        candidate.desktopPushIdentity.publicKey === target.desktopId
    );
    return pairing ? { ...target, desktopId: pairing.desktopId } : target;
  };
  const openedUnsubscribe = sdk.onNotificationOpened((message) => {
    const target = translateAnonymousTarget(parseNotificationTaskTarget(message));
    if (target) input.onTaskOpen(target);
  });
  const responseUnsubscribe = sdk.onNotificationResponse((message) => {
    const target = translateAnonymousTarget(parseNotificationTaskTarget(message));
    if (target) input.onTaskOpen(target);
  });
  const initial = await sdk.getInitialNotification();
  const initialTarget = translateAnonymousTarget(parseNotificationTaskTarget(initial));
  if (initialTarget) input.onTaskOpen(initialTarget);

  const permission = await sdk.requestPermission();
  if (permission !== AUTHORIZED && permission !== PROVISIONAL) {
    return () => {
      anonymousBindingCoordinator.end(anonymousGeneration);
      openedUnsubscribe();
      responseUnsubscribe();
    };
  }

  let stopped = false;
  let accountLease: AccountPushRegistrationLease | null = null;
  const registerToken = async (deviceToken: string) => {
    const idToken = await input.getIdToken();
    const pairings = input.anonymousPairings ?? [];
    let anonymousRegistered = false;
    if (idToken && registrationUrl && unregistrationUrl && !stopped) {
      // The coordinator owns the account registration from here: it retries a
      // failed attempt with backoff and remembers only what the relay
      // acknowledged, so a failed re-registration is never "registered" in
      // memory. The first attempt is awaited so a rejection is logged now.
      const registration = accountRegistrationCoordinator.register({
        relayUrl: input.relayUrl,
        deviceId: input.deviceId,
        deviceToken,
        getIdToken: input.getIdToken
      });
      accountLease = registration.lease;
      await registration.settled;
    }
    if (pairings.length > 0) {
      try {
        await anonymousBindingCoordinator.register(anonymousGeneration, deviceToken);
        anonymousRegistered = true;
      } catch (error: unknown) {
        console.error("Anonymous push registration failed:", error);
        if (!accountLease) throw error;
      }
    }
    if (!accountLease && !anonymousRegistered) {
      throw new Error("Cannot register mobile notifications without an account or pairing.");
    }
  };

  await registerToken(await sdk.getToken());
  const tokenUnsubscribe = sdk.onTokenRefresh((token) => {
    void registerToken(token).catch((error: unknown) => {
      console.error("Mobile notification token refresh failed:", error);
    });
  });
  return () => {
    stopped = true;
    anonymousBindingCoordinator.end(anonymousGeneration);
    tokenUnsubscribe();
    openedUnsubscribe();
    responseUnsubscribe();
    if (accountLease) {
      // Release only this lifecycle's lease. If a newer effect run has already
      // registered the same device, the coordinator ignores this stale cleanup.
      void accountRegistrationCoordinator
        .unregister(accountLease)
        .catch((error: unknown) => {
          console.error("Mobile notification unregistration failed:", error);
        });
    }
  };
}

export function parseNotificationTaskTarget(
  message: RemoteMessageLike | null
): MobileNotificationTaskTarget | null {
  const data = message?.data;
  if (
    data?.kannaNotificationVersion !== "1" ||
    data.kind !== "task" ||
    typeof data.desktopId !== "string" ||
    typeof data.taskId !== "string" ||
    !data.desktopId.trim() ||
    !data.taskId.trim()
  ) {
    return null;
  }
  return {
    desktopId: data.desktopId,
    taskId: data.taskId
  };
}

export function resolveNotificationTaskId(
  target: MobileNotificationTaskTarget,
  tasks: readonly TaskSummary[]
): string | null {
  return tasks.find(
    (task) =>
      task.ownerDesktopId === target.desktopId &&
      taskLocalId(task) === target.taskId
  )?.id ?? null;
}

export function pushRegistrationUrl(relayUrl: string): string | null {
  return pushEndpointUrl(relayUrl, "/push/register");
}

export function pushUnregistrationUrl(relayUrl: string): string | null {
  return pushEndpointUrl(relayUrl, "/push/unregister");
}

function pushEndpointUrl(relayUrl: string, path: string): string | null {
  if (relayUrl.startsWith("wss://")) {
    return `https://${relayUrl.slice("wss://".length)}${path}`;
  }
  if (relayUrl.startsWith("ws://")) {
    return `http://${relayUrl.slice("ws://".length)}${path}`;
  }
  if (relayUrl.startsWith("https://") || relayUrl.startsWith("http://")) {
    return `${relayUrl.replace(/\/+$/, "")}${path}`;
  }
  return null;
}

async function loadMobilePushSdk(): Promise<MobilePushSdk> {
  const [{ getApp }, messagingModule, Notifications] = await Promise.all([
    import("@react-native-firebase/app"),
    import("@react-native-firebase/messaging"),
    import("expo-notifications")
  ]);
  const messaging = messagingModule.getMessaging(getApp());
  return {
    setNotificationHandler: (handler) =>
      Notifications.setNotificationHandler(handler),
    requestPermission: () => messagingModule.requestPermission(messaging),
    getToken: () => messagingModule.getToken(messaging),
    onTokenRefresh: (listener) =>
      messagingModule.onTokenRefresh(messaging, listener),
    getInitialNotification: () =>
      messagingModule.getInitialNotification(messaging),
    onNotificationOpened: (listener) =>
      messagingModule.onNotificationOpenedApp(messaging, listener),
    onNotificationResponse: (listener) => {
      const subscription = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          listener({ data: response.notification.request.content.data });
        }
      );
      return () => subscription.remove();
    }
  };
}

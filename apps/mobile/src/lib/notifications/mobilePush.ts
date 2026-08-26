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
}

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

  let registration: { idToken: string; deviceToken: string } | null = null;
  let stopped = false;
  const unregisterDevice = async (registered: {
    idToken: string;
    deviceToken: string;
  }) => {
    if (!unregistrationUrl) return;
    const response = await (input.fetchImpl ?? fetch)(unregistrationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idToken: registered.idToken,
        deviceId: input.deviceId,
        deviceToken: registered.deviceToken
      })
    });
    if (!response.ok) {
      throw new Error(
        `Mobile notification unregistration failed (${response.status}).`
      );
    }
  };
  const registerToken = async (deviceToken: string) => {
    const idToken = await input.getIdToken();
    if (idToken) {
      if (!registrationUrl) {
        throw new Error("Mobile notification relay URL is invalid.");
      }
      const response = await (input.fetchImpl ?? fetch)(registrationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId: input.deviceId,
          deviceToken
        })
      });
      if (!response.ok) {
        throw new Error(
          `Mobile notification registration failed (${response.status}).`
        );
      }
    } else {
      const pairings = input.anonymousPairings ?? [];
      if (pairings.length === 0) {
        throw new Error("Cannot register mobile notifications without an account or pairing.");
      }
      await anonymousBindingCoordinator.register(anonymousGeneration, deviceToken);
    }
    if (stopped) {
      if (idToken) await unregisterDevice({ idToken, deviceToken });
    } else if (idToken) {
      registration = { idToken, deviceToken };
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
    if (registration) {
      void unregisterDevice(registration).catch((error: unknown) => {
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

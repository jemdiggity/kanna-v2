import type { TaskSummary } from "../api/types";
import { taskLocalId } from "../api/taskIdentity";

const AUTHORIZED = 1;
const PROVISIONAL = 2;

export interface MobileNotificationTaskTarget {
  desktopId: string;
  taskId: string;
}

interface RemoteMessageLike {
  data?: Record<string, string | object>;
}

interface MobilePushSdk {
  requestPermission(): Promise<number>;
  getToken(): Promise<string>;
  onTokenRefresh(listener: (token: string) => void): () => void;
  getInitialNotification(): Promise<RemoteMessageLike | null>;
  onNotificationOpened(
    listener: (message: RemoteMessageLike) => void
  ): () => void;
}

interface StartMobilePushInput {
  deviceId: string;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  onTaskOpen(target: MobileNotificationTaskTarget): void;
  relayUrl: string;
  fetchImpl?: typeof fetch;
  sdk?: MobilePushSdk;
}

export async function startMobilePushNotifications(
  input: StartMobilePushInput
): Promise<() => void> {
  const registrationUrl = pushRegistrationUrl(input.relayUrl);
  if (!registrationUrl) {
    return () => undefined;
  }
  const unregistrationUrl = pushUnregistrationUrl(input.relayUrl);
  if (!unregistrationUrl) {
    return () => undefined;
  }

  const sdk = input.sdk ?? await loadMobilePushSdk();
  const openedUnsubscribe = sdk.onNotificationOpened((message) => {
    const target = parseNotificationTaskTarget(message);
    if (target) input.onTaskOpen(target);
  });
  const initial = await sdk.getInitialNotification();
  const initialTarget = parseNotificationTaskTarget(initial);
  if (initialTarget) input.onTaskOpen(initialTarget);

  const permission = await sdk.requestPermission();
  if (permission !== AUTHORIZED && permission !== PROVISIONAL) {
    return openedUnsubscribe;
  }

  let registration: { idToken: string; deviceToken: string } | null = null;
  let stopped = false;
  const unregisterDevice = async (registered: {
    idToken: string;
    deviceToken: string;
  }) => {
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
    if (!idToken) {
      throw new Error("Cannot register mobile notifications while signed out.");
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
    if (stopped) {
      await unregisterDevice({ idToken, deviceToken });
    } else {
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
    tokenUnsubscribe();
    openedUnsubscribe();
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
  const [{ getApp }, messagingModule] = await Promise.all([
    import("@react-native-firebase/app"),
    import("@react-native-firebase/messaging")
  ]);
  const messaging = messagingModule.getMessaging(getApp());
  return {
    requestPermission: () => messagingModule.requestPermission(messaging),
    getToken: () => messagingModule.getToken(messaging),
    onTokenRefresh: (listener) =>
      messagingModule.onTokenRefresh(messaging, listener),
    getInitialNotification: () =>
      messagingModule.getInitialNotification(messaging),
    onNotificationOpened: (listener) =>
      messagingModule.onNotificationOpenedApp(messaging, listener)
  };
}

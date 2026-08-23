import { AppState } from "react-native";
import type { NotificationResponse } from "expo-notifications";
import type { MobileNotificationFrame } from "@kanna/stream-client";
import type {
  MobileNotificationSubscription
} from "../api/client";
import type { MobileNotificationTaskTarget } from "./mobilePush";

interface LanNotificationSource {
  observeMobileNotifications?(
    listener: (notification: MobileNotificationFrame) => void
  ): MobileNotificationSubscription;
}

interface LanNotificationSdk {
  requestPermissions(): Promise<boolean>;
  schedule(notification: MobileNotificationFrame): Promise<void>;
  buzz(): Promise<void>;
  initialTaskTarget(): Promise<MobileNotificationTaskTarget | null>;
  onTaskOpen(
    listener: (target: MobileNotificationTaskTarget) => void
  ): Promise<() => void>;
}

interface StartLanNotificationsInput {
  source: LanNotificationSource;
  onForeground(notification: MobileNotificationFrame): void;
  onTaskOpen(target: MobileNotificationTaskTarget): void;
  getAppState?: () => string;
  sdk?: LanNotificationSdk;
}

export async function startLanMobileNotifications(
  input: StartLanNotificationsInput
): Promise<() => void> {
  const sdk = input.sdk ?? expoLanNotificationSdk;
  const getAppState = input.getAppState ?? (() => AppState.currentState);
  const permissionGranted = await sdk.requestPermissions();
  const openedUnsubscribe = await sdk.onTaskOpen(input.onTaskOpen);
  const initialTarget = await sdk.initialTaskTarget();
  if (initialTarget) input.onTaskOpen(initialTarget);

  const streamSubscription = input.source.observeMobileNotifications?.(
    (notification) => {
      if (getAppState() === "active") {
        input.onForeground(notification);
        void sdk.buzz().catch((error: unknown) => {
          console.error("LAN notification haptic failed:", error);
        });
        return;
      }
      if (permissionGranted) {
        void sdk.schedule(notification).catch((error: unknown) => {
          console.error("LAN local notification scheduling failed:", error);
        });
      }
    }
  );

  return () => {
    streamSubscription?.close();
    openedUnsubscribe();
  };
}

const expoLanNotificationSdk: LanNotificationSdk = {
  async requestPermissions() {
    const Notifications = await import("expo-notifications");
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    return (await Notifications.requestPermissionsAsync()).granted;
  },
  async schedule(notification) {
    const Notifications = await import("expo-notifications");
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notification.title,
        body: notification.body,
        data: notificationTaskData(notification)
      },
      trigger: null
    });
  },
  async buzz() {
    const Haptics = await import("expo-haptics");
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  },
  async initialTaskTarget() {
    const Notifications = await import("expo-notifications");
    const response = await Notifications.getLastNotificationResponseAsync();
    const target = notificationResponseTaskTarget(response);
    if (response) await Notifications.clearLastNotificationResponseAsync();
    return target;
  },
  async onTaskOpen(listener) {
    const Notifications = await import("expo-notifications");
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const target = notificationResponseTaskTarget(response);
        if (target) listener(target);
      }
    );
    return () => subscription.remove();
  }
};

function notificationTaskData(
  notification: MobileNotificationFrame
): Record<string, string> {
  return {
    kannaNotificationVersion: "1",
    kind: "task",
    desktopId: notification.desktopId,
    ...(notification.taskId ? { taskId: notification.taskId } : {})
  };
}

function notificationResponseTaskTarget(
  response: NotificationResponse | null
): MobileNotificationTaskTarget | null {
  const data = response?.notification.request.content.data;
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
  return { desktopId: data.desktopId, taskId: data.taskId };
}

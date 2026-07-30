import type { DocumentReference } from "firebase-admin/firestore";
import { getFirebaseServices } from "./firebase.js";

const MAX_PUSH_DEVICES = 500;
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

export interface MobileNotification {
  title: string;
  body: string;
  taskId?: string;
}

export interface MobileNotificationDelivery {
  acceptedCount: number;
  failedCount: number;
}

interface RegisteredPushDevice {
  ref: DocumentReference;
  token: string;
}

export function parseMobileNotification(value: unknown): MobileNotification {
  if (!isRecord(value)) {
    throw new Error("notification must be an object");
  }

  const title = requiredText(value.title, "notification.title", 200);
  const body = requiredText(value.body, "notification.body", 2_000);
  const taskId = optionalText(value.taskId, "notification.taskId", 256);
  return {
    title,
    body,
    ...(taskId ? { taskId } : {}),
  };
}

export async function sendMobileNotification(input: {
  userId: string;
  desktopId: string;
  notification: MobileNotification;
}): Promise<MobileNotificationDelivery> {
  const { db, messaging } = getFirebaseServices();
  const snapshot = await db
    .collection("users")
    .doc(input.userId)
    .collection("pushDevices")
    .limit(MAX_PUSH_DEVICES)
    .get();
  const devices = snapshot.docs.flatMap((doc): RegisteredPushDevice[] => {
    const token = doc.data().token;
    return typeof token === "string" && token.trim()
      ? [{ ref: doc.ref, token: token.trim() }]
      : [];
  });
  if (devices.length === 0) {
    return { acceptedCount: 0, failedCount: 0 };
  }

  const response = await messaging.sendEachForMulticast({
    tokens: devices.map(({ token }) => token),
    notification: {
      title: input.notification.title,
      body: input.notification.body,
    },
    data: {
      kannaNotificationVersion: "1",
      kind: input.notification.taskId ? "task" : "general",
      desktopId: input.desktopId,
      ...(input.notification.taskId ? { taskId: input.notification.taskId } : {}),
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  });

  const staleDeviceDeletes = response.responses.flatMap((result, index) => {
    const code = result.error?.code;
    return code && INVALID_TOKEN_CODES.has(code)
      ? [devices[index]?.ref.delete()]
      : [];
  }).filter((deletion): deletion is Promise<FirebaseFirestore.WriteResult> =>
    deletion !== undefined
  );
  if (staleDeviceDeletes.length > 0) {
    await Promise.allSettled(staleDeviceDeletes);
  }

  return {
    acceptedCount: response.successCount,
    failedCount: response.failureCount,
  };
}

function requiredText(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  const text = value.trim();
  if ([...text].length > maxChars) {
    throw new Error(`${path} must be at most ${maxChars} characters`);
  }
  return text;
}

function optionalText(
  value: unknown,
  path: string,
  maxChars: number
): string | undefined {
  return value === undefined ? undefined : requiredText(value, path, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

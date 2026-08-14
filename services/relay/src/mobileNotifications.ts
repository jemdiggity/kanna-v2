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
  failureReasons: MobileNotificationFailureReason[];
}

export interface MobileNotificationFailureReason {
  providerCode: string;
  category:
    | "invalidToken"
    | "relayPermission"
    | "firebaseProjectMismatch"
    | "apnsCredentials"
    | "payload"
    | "rateLimit"
    | "temporary"
    | "provider";
  count: number;
  message: string;
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
    return { acceptedCount: 0, failedCount: 0, failureReasons: [] };
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
    failureReasons: summarizeMessagingFailures(
      response.responses.flatMap((result) => result.error ? [result.error] : [])
    ),
  };
}

function summarizeMessagingFailures(
  errors: readonly { code: string; message: string }[]
): MobileNotificationFailureReason[] {
  const summaries = new Map<string, MobileNotificationFailureReason>();
  for (const error of errors) {
    const reason = diagnoseMessagingFailure(error);
    const key = `${reason.category}:${reason.providerCode}`;
    const current = summaries.get(key);
    if (current) {
      current.count += 1;
    } else {
      summaries.set(key, reason);
    }
  }
  return [...summaries.values()].sort((left, right) =>
    left.providerCode.localeCompare(right.providerCode)
  );
}

export function diagnoseMessagingFailure(error: {
  code: string;
  message: string;
}): MobileNotificationFailureReason {
  const providerCode = /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(error.code)
    ? error.code
    : "messaging/unknown-error";
  if (
    error.message.includes("cloudmessaging.messages.create")
    && error.message.toLowerCase().includes("permission")
    && error.message.toLowerCase().includes("denied")
  ) {
    return failureReason(
      providerCode,
      "relayPermission",
      "The relay service account cannot send Firebase Cloud Messaging messages in this environment. Grant roles/firebasecloudmessaging.admin to the relay VM service account."
    );
  }
  if (INVALID_TOKEN_CODES.has(providerCode)) {
    return failureReason(
      providerCode,
      "invalidToken",
      "The registered push token is invalid or expired and was removed. Reopen the matching mobile app environment to register a current token."
    );
  }
  if (providerCode === "messaging/mismatched-credential") {
    return failureReason(
      providerCode,
      "firebaseProjectMismatch",
      "The push token and relay Firebase credentials do not belong to the same project. Confirm the mobile app and relay use the same environment."
    );
  }
  if (providerCode === "messaging/third-party-auth-error") {
    return failureReason(
      providerCode,
      "apnsCredentials",
      "Firebase rejected the environment's APNs credentials. Verify the APNs key or certificate and the matching iOS bundle ID in Firebase."
    );
  }
  if (PAYLOAD_ERROR_CODES.has(providerCode)) {
    return failureReason(
      providerCode,
      "payload",
      "Firebase rejected the notification payload. Check the provider code and Firebase payload constraints."
    );
  }
  if (RATE_LIMIT_ERROR_CODES.has(providerCode)) {
    return failureReason(
      providerCode,
      "rateLimit",
      "Firebase rate-limited notification delivery. Retry later and review the environment's messaging quota."
    );
  }
  if (TEMPORARY_ERROR_CODES.has(providerCode)) {
    return failureReason(
      providerCode,
      "temporary",
      "Firebase could not deliver the notification because of a temporary provider error. Retry later."
    );
  }
  return failureReason(
    providerCode,
    "provider",
    "Firebase rejected notification delivery. Use the provider code to inspect the matching environment's relay and Firebase configuration."
  );
}

const PAYLOAD_ERROR_CODES = new Set([
  "messaging/data-payload-size-limit-exceeded",
  "messaging/invalid-argument",
  "messaging/invalid-data-payload-key",
  "messaging/invalid-options",
  "messaging/invalid-package-name",
  "messaging/invalid-payload",
  "messaging/payload-size-limit-exceeded",
]);

const RATE_LIMIT_ERROR_CODES = new Set([
  "messaging/device-message-rate-exceeded",
  "messaging/message-rate-exceeded",
  "messaging/quota-exceeded",
  "messaging/topics-message-rate-exceeded",
]);

const TEMPORARY_ERROR_CODES = new Set([
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unknown-error",
]);

function failureReason(
  providerCode: string,
  category: MobileNotificationFailureReason["category"],
  message: string
): MobileNotificationFailureReason {
  return { providerCode, category, count: 1, message };
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

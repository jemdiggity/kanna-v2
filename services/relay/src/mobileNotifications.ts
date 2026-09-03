import { randomUUID } from "node:crypto";
import type { DocumentReference } from "firebase-admin/firestore";
import { getFirebaseServices } from "./firebase.js";
import {
  MAX_ACCOUNT_PUSH_DEVICES,
  describeNoPushDevices,
  livePushToken,
  retirePushDeviceAfterProviderRejection,
  type NoPushDevicesReason,
} from "./pushDevices.js";

const MAX_PUSH_DEVICES = MAX_ACCOUNT_PUSH_DEVICES;
const INVALID_TOKEN_CODES = new Set([
  // Per-device invalid-argument responses are token failures. Invalid message
  // payloads reject the whole multicast call instead of producing one result
  // per registration token.
  "messaging/invalid-argument",
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
  /**
   * Distinct device tokens the delivery resolved. Reported for every
   * delivery so a caller can tell "sent to zero" from "sent to some"; it is
   * the whole answer of a registration probe, which resolves targets without
   * sending.
   */
  targetedDeviceCount: number;
  /** Present exactly when `targetedDeviceCount` is zero. Never carries a token. */
  noDevicesReason?: NoPushDevicesReason;
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

export interface MobileNotificationPublicationAck {
  ok: boolean;
  delivery?: MobileNotificationDelivery;
  error?: string;
}

interface MobileNotificationPublicationDependencies {
  send?: typeof sendMobileNotification;
  createIncidentId?: () => string;
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
  /** Resolve targets and explain a zero-target result without sending. */
  dryRun?: boolean;
}): Promise<MobileNotificationDelivery> {
  const { db, messaging } = getFirebaseServices();
  const snapshot = await db
    .collection("users")
    .doc(input.userId)
    .collection("pushDevices")
    .limit(MAX_PUSH_DEVICES)
    .get();
  const devices = snapshot.docs.flatMap((doc): RegisteredPushDevice[] => {
    const token = livePushToken(doc.data());
    return token ? [{ ref: doc.ref, token }] : [];
  });
  if (devices.length === 0) {
    const noDevicesReason = describeNoPushDevices(snapshot.docs.map((doc) => doc.data()));
    console.warn(
      `[push] No mobile push device targeted for desktop ${input.desktopId}`
      + ` (${noDevicesReason.code}${input.dryRun ? ", probe" : ""})`,
    );
    return {
      acceptedCount: 0,
      failedCount: 0,
      failureReasons: [],
      targetedDeviceCount: 0,
      noDevicesReason,
    };
  }
  if (input.dryRun) {
    return {
      acceptedCount: 0,
      failedCount: 0,
      failureReasons: [],
      targetedDeviceCount: devices.length,
    };
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

  const staleDeviceRetirements = response.responses.flatMap((result, index) => {
    const code = result.error?.code;
    const device = devices[index];
    if (!code || !INVALID_TOKEN_CODES.has(code) || !device) {
      return [];
    }
    return [retirePushDeviceAfterProviderRejection(db, {
      ref: device.ref,
      expectedToken: device.token,
      providerCode: code,
      desktopId: input.desktopId,
    })];
  });
  if (staleDeviceRetirements.length > 0) {
    await Promise.allSettled(staleDeviceRetirements);
  }

  return {
    acceptedCount: response.successCount,
    failedCount: response.failureCount,
    failureReasons: summarizeMessagingFailures(
      response.responses.flatMap((result) => result.error ? [result.error] : [])
    ),
    targetedDeviceCount: devices.length,
  };
}

export async function publishMobileNotification(input: {
  userId: string;
  desktopId: string;
  notification: MobileNotification;
  dryRun?: boolean;
  sendAck: (ack: MobileNotificationPublicationAck) => void;
}, dependencies: MobileNotificationPublicationDependencies = {}): Promise<void> {
  const send = dependencies.send ?? sendMobileNotification;

  let delivery: MobileNotificationDelivery;
  try {
    delivery = await send({
      userId: input.userId,
      desktopId: input.desktopId,
      notification: input.notification,
      ...(input.dryRun ? { dryRun: true } : {}),
    });
  } catch {
    const incidentId = (dependencies.createIncidentId ?? randomUUID)();
    const category = "relayDependency";
    const safeError =
      `mobile notification delivery failed (category=${category}, incident=${incidentId}); `
      + "retry later and inspect the matching environment's relay logs";
    console.warn(
      `[push] Mobile notification delivery failed for desktop ${input.desktopId} `
      + `(category=${category}, incident=${incidentId})`
    );
    input.sendAck({ ok: false, error: safeError });
    return;
  }

  if (delivery.failedCount > 0) {
    console.warn(
      `[push] Mobile notification delivery failed for desktop ${input.desktopId}: `
      + JSON.stringify(delivery.failureReasons)
    );
  }
  input.sendAck({ ok: true, delivery });
}

export function summarizeMessagingFailures(
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
      "No valid device token — the rejected token was removed. Open the matching mobile app environment to re-register."
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

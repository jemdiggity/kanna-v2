import { createHash } from "node:crypto";
import type {
  DocumentData,
  DocumentReference,
  Firestore,
} from "firebase-admin/firestore";
import { getFirebaseServices } from "./firebase.js";
import {
  ACCOUNT_DELETIONS_COLLECTION,
  AccountDeletionInProgressError,
} from "./accountDeletion.js";

/**
 * Account push registrations: one document per mobile installation under
 * `users/{uid}/pushDevices/{sha256(deviceId)}`.
 *
 * A live registration carries the FCM token. A retired registration keeps the
 * document with `token: null` plus the retirement record, so a later
 * zero-target delivery can say *why* nothing was targeted instead of only that
 * the row is gone. The 2026-09-03 loss on staging was exactly a bare delete
 * with no record: the mobile effect re-ran three times in 700 ms, each
 * cleanup unregistered the previous registration with the same token, and the
 * last cleanup to land deleted the freshly written row (task 34047a85).
 *
 * The `registrationId` is minted by the phone per registration attempt. An
 * unregister that names it retires only that registration; a newer
 * registration of the same device with the same token is left alone. Token
 * matching remains as the compatibility guard for phones that predate the id.
 */
export const MAX_ACCOUNT_PUSH_DEVICES = 500;
export const MAX_REGISTRATION_ID_LENGTH = 128;

export type PushDeviceRetirementReason = "unregistered" | "tokenRejected";

export type NoPushDevicesReasonCode =
  | "neverRegistered"
  | "unregistered"
  | "tokenRejected"
  | "unknown";

export interface NoPushDevicesReason {
  code: NoPushDevicesReasonCode;
  message: string;
  retiredAt?: string;
  providerCode?: string;
  retiredByDesktopId?: string;
}

export type UnregisterPushDeviceOutcome =
  | "retired"
  | "stale"
  | "absent"
  | "alreadyRetired";

interface RegisteredPushDeviceRecord extends DocumentData {
  deviceId: string;
  token: string;
  registrationId?: string;
  updatedAt: string;
}

interface RetiredPushDeviceRecord extends DocumentData {
  deviceId: string | null;
  token: null;
  registrationId: null;
  updatedAt: string;
  retiredAt: string;
  retiredReason: PushDeviceRetirementReason;
  retiredProviderCode?: string;
  retiredByDesktopId?: string;
}

export function hashPushDeviceId(deviceId: string): string {
  return createHash("sha256").update(deviceId, "utf8").digest("hex");
}

export function pushDeviceRef(
  db: Firestore,
  userId: string,
  deviceId: string,
): DocumentReference {
  return db
    .collection("users")
    .doc(userId)
    .collection("pushDevices")
    .doc(hashPushDeviceId(deviceId));
}

export function isLivePushDevice(data: DocumentData | undefined): data is RegisteredPushDeviceRecord {
  return typeof data?.token === "string" && data.token.trim().length > 0;
}

export function livePushToken(data: DocumentData | undefined): string | null {
  return isLivePushDevice(data) ? data.token.trim() : null;
}

export async function registerPushDevice(
  userId: string,
  deviceId: string,
  deviceToken: string,
  registrationId?: string,
): Promise<void> {
  try {
    const { db } = getFirebaseServices();
    await db.runTransaction(async (transaction) => {
      const deletion = await transaction.get(
        db.collection(ACCOUNT_DELETIONS_COLLECTION).doc(userId),
      );
      if (deletion.exists) throw new AccountDeletionInProgressError();
      const record: RegisteredPushDeviceRecord = {
        deviceId,
        token: deviceToken,
        ...(registrationId ? { registrationId } : {}),
        updatedAt: new Date().toISOString(),
      };
      transaction.set(pushDeviceRef(db, userId, deviceId), record);
    });
    console.log(
      `[auth] Registered mobile push device ${deviceId} for user ${userId}`
      + (registrationId ? ` (registration ${registrationId})` : " (no registration id)"),
    );
  } catch (err) {
    if (err instanceof AccountDeletionInProgressError) throw err;
    console.error("[auth] Failed to register mobile push device:", err);
    throw err;
  }
}

export interface UnregisterPushDeviceIdentity {
  /** FCM token the phone observed for the registration it is retiring. */
  deviceToken?: string;
  /** Registration id the phone minted when it registered. Preferred guard. */
  registrationId?: string;
}

/**
 * Retire the registration the phone names. With a `registrationId`, only that
 * registration is retired; with only a token, the token must still match;
 * with neither (legacy phones), the registration is retired unconditionally.
 * Every outcome is logged so a disappearing registration is attributable.
 */
export async function unregisterPushDevice(
  userId: string,
  deviceId: string,
  identity: UnregisterPushDeviceIdentity = {},
): Promise<UnregisterPushDeviceOutcome> {
  try {
    const { db } = getFirebaseServices();
    const ref = pushDeviceRef(db, userId, deviceId);
    const nowIso = new Date().toISOString();
    const outcome = await db.runTransaction(async (transaction): Promise<UnregisterPushDeviceOutcome> => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return "absent";
      const current = snapshot.data();
      if (!isLivePushDevice(current)) return "alreadyRetired";
      if (identity.registrationId !== undefined) {
        if (current.registrationId !== identity.registrationId) return "stale";
      } else if (identity.deviceToken !== undefined) {
        if (current.token !== identity.deviceToken) return "stale";
      }
      transaction.set(ref, retiredRecord(current, nowIso, { reason: "unregistered" }));
      return "retired";
    });
    const guard = identity.registrationId !== undefined
      ? `registration ${identity.registrationId}`
      : identity.deviceToken !== undefined
        ? "token-guarded"
        : "legacy unguarded";
    console.log(
      `[auth] Unregister mobile push device ${deviceId} for user ${userId}: ${outcome} (${guard})`,
    );
    return outcome;
  } catch (err) {
    console.error("[auth] Failed to unregister mobile push device:", err);
    throw err;
  }
}

/**
 * Retire a registration whose token the push provider rejected as invalid.
 * The rejection is attributed to the desktop whose delivery met it, so a
 * later zero-target result on any desktop of the account can name it.
 */
export async function retirePushDeviceAfterProviderRejection(
  db: Firestore,
  input: {
    ref: DocumentReference;
    expectedToken: string;
    providerCode: string;
    desktopId: string;
    nowIso?: string;
  },
): Promise<boolean> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const retired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(input.ref);
    const current = snapshot.data();
    if (!isLivePushDevice(current) || current.token !== input.expectedToken) return false;
    transaction.set(input.ref, retiredRecord(current, nowIso, {
      reason: "tokenRejected",
      providerCode: input.providerCode,
      desktopId: input.desktopId,
    }));
    return true;
  });
  if (retired) {
    console.warn(
      `[push] Retired mobile push device registration ${input.ref.path} `
      + `after ${input.providerCode} during delivery for desktop ${input.desktopId}`,
    );
  }
  return retired;
}

/**
 * Explain why an account delivery targeted nothing, from the registration
 * records alone. Never includes a token.
 */
export function describeNoPushDevices(records: readonly DocumentData[]): NoPushDevicesReason {
  if (records.length === 0) {
    return {
      code: "neverRegistered",
      message:
        "No mobile push device has ever registered for this account. "
        + "Open Kanna on the phone while signed in and allow notifications.",
    };
  }
  const latest = [...records].sort((left, right) =>
    retirementOrder(right).localeCompare(retirementOrder(left)))[0];
  const retiredAt = typeof latest?.retiredAt === "string" ? latest.retiredAt : undefined;
  if (latest?.retiredReason === "tokenRejected") {
    const providerCode = typeof latest.retiredProviderCode === "string"
      ? latest.retiredProviderCode
      : "messaging/unknown-error";
    const retiredByDesktopId = typeof latest.retiredByDesktopId === "string"
      ? latest.retiredByDesktopId
      : undefined;
    return {
      code: "tokenRejected",
      message:
        `The push provider rejected the last device token (${providerCode})`
        + (retiredByDesktopId ? ` during a delivery from desktop ${retiredByDesktopId}` : "")
        + (retiredAt ? ` at ${retiredAt}` : "")
        + ", so that registration was retired. Open Kanna on the phone while signed in to register again.",
      ...(retiredAt ? { retiredAt } : {}),
      providerCode,
      ...(retiredByDesktopId ? { retiredByDesktopId } : {}),
    };
  }
  if (latest?.retiredReason === "unregistered") {
    return {
      code: "unregistered",
      message:
        "The mobile app unregistered the last push device"
        + (retiredAt ? ` at ${retiredAt}` : "")
        + ". Open Kanna on the phone while signed in to register again.",
      ...(retiredAt ? { retiredAt } : {}),
    };
  }
  return {
    code: "unknown",
    message:
      "The last push registration was retired before the relay recorded why. "
      + "Open Kanna on the phone while signed in to register again.",
    ...(retiredAt ? { retiredAt } : {}),
  };
}

function retirementOrder(record: DocumentData): string {
  if (typeof record.retiredAt === "string") return record.retiredAt;
  if (typeof record.updatedAt === "string") return record.updatedAt;
  return "";
}

function retiredRecord(
  current: DocumentData,
  nowIso: string,
  retirement:
    | { reason: "unregistered" }
    | { reason: "tokenRejected"; providerCode: string; desktopId: string },
): RetiredPushDeviceRecord {
  return {
    deviceId: typeof current.deviceId === "string" ? current.deviceId : null,
    token: null,
    registrationId: null,
    updatedAt: nowIso,
    retiredAt: nowIso,
    retiredReason: retirement.reason,
    ...(retirement.reason === "tokenRejected"
      ? {
          retiredProviderCode: retirement.providerCode,
          retiredByDesktopId: retirement.desktopId,
        }
      : {}),
  };
}

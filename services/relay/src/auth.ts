import { getFirebaseServices, isAuthBypassed } from "./firebase.js";
import { createHash, timingSafeEqual } from "node:crypto";

function bypassUserIdFromToken(token: string): string {
  const separator = token.indexOf(":");
  if (separator > 0) {
    return token.slice(0, separator);
  }

  return "test-user";
}

/**
 * Verify a Firebase Auth ID token (sent by the phone client).
 * Returns the userId or null if verification fails.
 */
export async function verifyPhoneToken(
  idToken: string
): Promise<string | null> {
  if (isAuthBypassed()) {
    return bypassUserIdFromToken(idToken);
  }

  try {
    const { auth } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    console.error("[auth] Failed to verify phone token:", err);
    return null;
  }
}

/**
 * Verify a device token (sent by kanna-server).
 * Looks up the device token in Firestore: devices/{deviceToken}.userId
 * Returns the userId or null if not found.
 */
export async function verifyDeviceToken(
  deviceToken: string
): Promise<string | null> {
  if (isAuthBypassed()) {
    return bypassUserIdFromToken(deviceToken);
  }

  try {
    const { db } = getFirebaseServices();
    const doc = await db.collection("devices").doc(deviceToken).get();
    if (!doc.exists) {
      console.warn("[auth] Device token not found:", deviceToken);
      return null;
    }
    const data = doc.data();
    return (data?.userId as string) ?? null;
  } catch (err) {
    console.error("[auth] Failed to verify device token:", err);
    return null;
  }
}

export interface DesktopPrincipal {
  userId: string;
  desktopId: string;
}

export function hashDesktopSecret(desktopSecret: string): string {
  return createHash("sha256").update(desktopSecret, "utf8").digest("hex");
}

export function desktopSecretMatchesHash(
  desktopSecret: string,
  desktopSecretHash: unknown
): boolean {
  if (typeof desktopSecretHash !== "string" || desktopSecretHash.length === 0) {
    return false;
  }

  const actual = Buffer.from(hashDesktopSecret(desktopSecret), "hex");
  const expected = Buffer.from(desktopSecretHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyDesktopCredentials(
  desktopId: string,
  desktopSecret: string
): Promise<DesktopPrincipal | null> {
  if (isAuthBypassed()) {
    return {
      userId: "test-user",
      desktopId,
    };
  }

  try {
    const { db } = getFirebaseServices();
    const snapshot = await db
      .collectionGroup("desktops")
      .where("desktopId", "==", desktopId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.warn("[auth] Desktop not found:", desktopId);
      return null;
    }

    const doc = snapshot.docs[0]!;
    const data = doc.data();
    if (data.revokedAt) {
      console.warn("[auth] Desktop revoked:", desktopId);
      return null;
    }

    if (!desktopSecretMatchesHash(desktopSecret, data.desktopSecretHash)) {
      console.warn("[auth] Desktop secret mismatch:", desktopId);
      return null;
    }

    const desktopDoc = doc.ref;
    const userDoc = desktopDoc.parent.parent;
    if (!userDoc) {
      console.warn("[auth] Desktop missing parent user:", desktopId);
      return null;
    }

    return {
      userId: userDoc.id,
      desktopId,
    };
  } catch (err) {
    console.error("[auth] Failed to verify desktop credentials:", err);
    return null;
  }
}

/**
 * Register a device token for a user.
 * Called from POST /register after phone auth verification.
 */
export async function registerDevice(
  userId: string,
  deviceToken: string
): Promise<void> {
  if (isAuthBypassed()) {
    console.log(
      `[auth] SKIP_AUTH — would register device ${deviceToken} for user ${userId}`
    );
    return;
  }

  try {
    const { db } = getFirebaseServices();
    await db.collection("devices").doc(deviceToken).set({
      userId,
      createdAt: new Date().toISOString(),
    });
    console.log(
      `[auth] Registered device ${deviceToken} for user ${userId}`
    );
  } catch (err) {
    console.error("[auth] Failed to register device:", err);
    throw err;
  }
}

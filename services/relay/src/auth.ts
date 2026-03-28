import { initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

const SKIP_AUTH = process.env.SKIP_AUTH === "true";

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

function ensureInitialized(): void {
  if (app) return;

  if (SKIP_AUTH) {
    console.log("[auth] SKIP_AUTH=true — all verifications return 'test-user'");
    return;
  }

  app = initializeApp({
    credential: cert(
      JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}")
    ),
  });
  auth = getAuth(app);
  db = getFirestore(app);
}

/**
 * Verify a Firebase Auth ID token (sent by the phone client).
 * Returns the userId or null if verification fails.
 */
export async function verifyPhoneToken(
  idToken: string
): Promise<string | null> {
  ensureInitialized();

  if (SKIP_AUTH) {
    return "test-user";
  }

  try {
    const decoded = await auth!.verifyIdToken(idToken);
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
  ensureInitialized();

  if (SKIP_AUTH) {
    return "test-user";
  }

  try {
    const doc = await db!.collection("devices").doc(deviceToken).get();
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

/**
 * Register a device token for a user.
 * Called from POST /register after phone auth verification.
 */
export async function registerDevice(
  userId: string,
  deviceToken: string
): Promise<void> {
  ensureInitialized();

  if (SKIP_AUTH) {
    console.log(
      `[auth] SKIP_AUTH — would register device ${deviceToken} for user ${userId}`
    );
    return;
  }

  try {
    await db!.collection("devices").doc(deviceToken).set({
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

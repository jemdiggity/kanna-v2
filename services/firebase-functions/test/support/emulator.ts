/**
 * Firestore-emulator plumbing shared by the billing tests.
 *
 * Every test that touches Firestore is gated on `FIRESTORE_EMULATOR_HOST`, so
 * `pnpm test` stays green without emulators and `./kd emulators exec -- pnpm test`
 * runs the real thing.
 */
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const EMULATOR_PROJECT_ID = "kanna-local";

export const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

/** True when the Firestore emulator is reachable for this run. */
export const hasFirestoreEmulator = Boolean(firestoreEmulatorHost);

let app: App | null = null;

export function emulatorFirestore(): Firestore {
  if (!firestoreEmulatorHost) {
    throw new Error("FIRESTORE_EMULATOR_HOST is required for the billing emulator tests");
  }
  app ??= initializeApp({ projectId: EMULATOR_PROJECT_ID }, `billing-tests-${process.pid}`);
  return getFirestore(app);
}

export async function shutdownEmulatorFirestore(): Promise<void> {
  if (!app) return;
  await deleteApp(app);
  app = null;
}

/** Wipe every document, bypassing rules, between tests. */
export async function clearFirestoreEmulator(): Promise<void> {
  if (!firestoreEmulatorHost) return;
  const response = await fetch(
    `http://${firestoreEmulatorHost}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(`Failed to clear the Firestore emulator: ${response.status} ${await response.text()}`);
  }
}

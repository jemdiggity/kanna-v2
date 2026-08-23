import type { FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore
} from "firebase/firestore";
import {
  parseMobileFirebaseConfig,
  type MobileFirestoreEmulatorConfig
} from "./config";

const emulatorConnectedFirestoreInstances = new WeakSet<Firestore>();

export function getConfiguredFirestore(app?: FirebaseApp): Firestore {
  const db = app ? getFirestore(app) : getFirestore();
  connectConfiguredFirestoreEmulator(
    db,
    parseMobileFirebaseConfig().firestoreEmulator
  );
  return db;
}

function connectConfiguredFirestoreEmulator(
  db: Firestore,
  emulator: MobileFirestoreEmulatorConfig | null
): void {
  if (!emulator) return;
  if (emulatorConnectedFirestoreInstances.has(db)) return;
  connectFirestoreEmulator(db, emulator.host, emulator.port);
  emulatorConnectedFirestoreInstances.add(db);
}

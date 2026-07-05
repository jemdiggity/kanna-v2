import type { Persistence } from "firebase/auth";
import {
  deleteDesktopSetting,
  getDesktopSetting,
  putDesktopSetting,
} from "./desktopServerClient";

export type FirebaseAuthIndexedDbOperation =
  | "unavailable"
  | "open"
  | "transaction"
  | "write"
  | "read"
  | "cleanup";

export type FirebaseAuthIndexedDbStorageStatus =
  | { available: true }
  | { available: false; operation: FirebaseAuthIndexedDbOperation; message: string };

const FIREBASE_AUTH_DB_NAME = "firebaseLocalStorageDb";
const FIREBASE_AUTH_STORE_NAME = "firebaseLocalStorage";
const PROBE_KEY = "kanna:firebase-auth-storage-probe";
const SETTINGS_KEY_PREFIX = "firebaseAuth:";

interface DesktopAuthSettingsPersistenceOptions {
  getSetting?: (key: string) => Promise<string | null>;
  putSetting?: (key: string, value: string) => Promise<unknown>;
  deleteSetting?: (key: string) => Promise<unknown>;
}

export interface DesktopAuthSettingsPersistenceInstance {
  readonly type: "LOCAL";
  _isAvailable(): Promise<boolean>;
  _set(key: string, value: unknown): Promise<void>;
  _get<T = unknown>(key: string): Promise<T | null>;
  _remove(key: string): Promise<void>;
  _addListener(key: string, listener: (value: unknown) => void): void;
  _removeListener(key: string, listener: (value: unknown) => void): void;
  _shouldAllowMigration?: boolean;
}

export type DesktopAuthSettingsPersistence = Persistence & {
  new(): DesktopAuthSettingsPersistenceInstance;
};

export function createDesktopAuthSettingsPersistence(
  options: DesktopAuthSettingsPersistenceOptions = {},
): DesktopAuthSettingsPersistence {
  const settingsKey = (key: string) => `${SETTINGS_KEY_PREFIX}${key}`;
  const getSetting = options.getSetting ?? getDesktopSetting;
  const putSetting = options.putSetting ?? putDesktopSetting;
  const deleteSetting = options.deleteSetting ?? deleteDesktopSetting;

  class DesktopAuthSettingsPersistenceClass implements DesktopAuthSettingsPersistenceInstance {
    static readonly type = "LOCAL";
    readonly type = "LOCAL";
    readonly _shouldAllowMigration = true;

    async _isAvailable() {
      try {
        await getSetting(settingsKey("__availability_probe__"));
        return true;
      } catch (error) {
        console.warn("[cloud] desktop auth settings persistence unavailable:", error);
        return false;
      }
    }

    async _set(key: string, value: unknown) {
      await putSetting(settingsKey(key), JSON.stringify(value));
    }

    async _get<T = unknown>(key: string): Promise<T | null> {
      const raw = await getSetting(settingsKey(key));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    }

    async _remove(key: string) {
      await deleteSetting(settingsKey(key));
    }

    _addListener() {
      // Kanna owns a single desktop webview session; cross-tab auth storage events are unnecessary.
    }

    _removeListener() {
      // See _addListener.
    }
  }

  return DesktopAuthSettingsPersistenceClass as DesktopAuthSettingsPersistence;
}

export async function verifyFirebaseAuthIndexedDbStorage(
  factory: IDBFactory | undefined = readGlobalIndexedDb(),
): Promise<FirebaseAuthIndexedDbStorageStatus> {
  if (!factory) {
    return unavailable("unavailable", "IndexedDB is not available.");
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase(factory);
  } catch (error) {
    return unavailable("open", errorMessage(error));
  }

  try {
    const store = openObjectStore(db, "readwrite");
    await requestToPromise(store.put({ checkedAt: Date.now() }, PROBE_KEY), "write");
    await requestToPromise(store.get(PROBE_KEY), "read");
    await requestToPromise(store.delete(PROBE_KEY), "cleanup");
    return { available: true };
  } catch (error) {
    const operation = classifyStorageError(error);
    return unavailable(operation, errorMessage(error));
  } finally {
    db.close();
  }
}

function readGlobalIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch (error) {
    console.debug("[cloud] IndexedDB global is unavailable:", error);
    return undefined;
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(FIREBASE_AUTH_DB_NAME);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FIREBASE_AUTH_STORE_NAME)) {
        db.createObjectStore(FIREBASE_AUTH_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

function openObjectStore(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  try {
    return db.transaction(FIREBASE_AUTH_STORE_NAME, mode).objectStore(FIREBASE_AUTH_STORE_NAME);
  } catch (error) {
    throw new StorageProbeError("transaction", error);
  }
}

function requestToPromise<T>(
  request: IDBRequest<T>,
  operation: FirebaseAuthIndexedDbOperation,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageProbeError(
      operation,
      request.error ?? new Error(`IndexedDB ${operation} failed.`),
    ));
  });
}

function classifyStorageError(error: unknown): FirebaseAuthIndexedDbOperation {
  if (error instanceof StorageProbeError) return error.operation;
  return "transaction";
}

function unavailable(
  operation: FirebaseAuthIndexedDbOperation,
  message: string,
): FirebaseAuthIndexedDbStorageStatus {
  return { available: false, operation, message };
}

function errorMessage(error: unknown): string {
  if (error instanceof StorageProbeError) return errorMessage(error.cause);
  if (error instanceof Error) return error.message;
  return String(error);
}

class StorageProbeError extends Error {
  constructor(
    readonly operation: FirebaseAuthIndexedDbOperation,
    readonly cause: unknown,
  ) {
    super(errorMessage(cause));
  }
}

import type { Persistence } from "firebase/auth";
import type { DbHandle } from "@kanna/db";

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
  loadDatabase?: () => Promise<{ db: DbHandle }>;
}

interface SettingValueRow {
  value: string;
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
  let dbPromise: Promise<DbHandle> | null = null;

  const getDb = async () => {
    if (!dbPromise) {
      dbPromise = (options.loadDatabase?.() ?? import("../stores/db").then((module) => module.loadDatabase()))
        .then(({ db }) => db);
    }
    return dbPromise;
  };

  const ensureSettingsTable = async (db: DbHandle) => {
    await db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  };

  const settingsKey = (key: string) => `${SETTINGS_KEY_PREFIX}${key}`;

  class DesktopAuthSettingsPersistenceClass implements DesktopAuthSettingsPersistenceInstance {
    static readonly type = "LOCAL";
    readonly type = "LOCAL";
    readonly _shouldAllowMigration = true;

    async _isAvailable() {
      try {
        await ensureSettingsTable(await getDb());
        return true;
      } catch (error) {
        console.warn("[cloud] desktop auth settings persistence unavailable:", error);
        return false;
      }
    }

    async _set(key: string, value: unknown) {
      const db = await getDb();
      await ensureSettingsTable(db);
      await db.execute(
        `INSERT INTO settings (key, value)
           VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [settingsKey(key), JSON.stringify(value)],
      );
    }

    async _get<T = unknown>(key: string): Promise<T | null> {
      const db = await getDb();
      await ensureSettingsTable(db);
      const rows = await db.select<SettingValueRow>(
        "SELECT value FROM settings WHERE key = ?",
        [settingsKey(key)],
      );
      const raw = rows[0]?.value;
      if (raw === undefined) return null;
      return JSON.parse(raw) as T;
    }

    async _remove(key: string) {
      const db = await getDb();
      await ensureSettingsTable(db);
      await db.execute("DELETE FROM settings WHERE key = ?", [settingsKey(key)]);
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
  } catch {
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

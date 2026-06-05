import type { Persistence } from "firebase/auth";

const KEY_PREFIX = "firebaseAuth:";

export interface ReactNativeAuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ReactNativeAuthPersistenceInstance {
  readonly type: "LOCAL";
  _isAvailable(): Promise<boolean>;
  _set(key: string, value: unknown): Promise<void>;
  _get<T = unknown>(key: string): Promise<T | null>;
  _remove(key: string): Promise<void>;
  _addListener(key: string, listener: (value: unknown) => void): void;
  _removeListener(key: string, listener: (value: unknown) => void): void;
}

export type ReactNativeAuthPersistence = Persistence & {
  new(): ReactNativeAuthPersistenceInstance;
};

export function createReactNativeAuthPersistence(
  storage: ReactNativeAuthStorage
): ReactNativeAuthPersistence {
  const storageKey = (key: string) => `${KEY_PREFIX}${key}`;

  class ReactNativeAuthPersistenceClass implements ReactNativeAuthPersistenceInstance {
    static readonly type = "LOCAL";
    readonly type = "LOCAL";

    async _isAvailable() {
      return true;
    }

    async _set(key: string, value: unknown) {
      await storage.setItem(storageKey(key), JSON.stringify(value));
    }

    async _get<T = unknown>(key: string): Promise<T | null> {
      const raw = await storage.getItem(storageKey(key));
      if (raw === null) {
        return null;
      }

      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    async _remove(key: string) {
      await storage.removeItem(storageKey(key));
    }

    _addListener() {
      // React Native AsyncStorage has no cross-tab storage events.
    }

    _removeListener() {
      // See _addListener.
    }
  }

  return ReactNativeAuthPersistenceClass as ReactNativeAuthPersistence;
}

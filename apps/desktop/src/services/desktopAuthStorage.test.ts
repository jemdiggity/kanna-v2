import { describe, expect, it } from "vitest";
import {
  createDesktopAuthSettingsPersistence,
  verifyFirebaseAuthIndexedDbStorage,
} from "./desktopAuthStorage";

type FakeRequest<T = unknown> = IDBRequest<T> & {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onupgradeneeded?: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null;
};

interface FakeIndexedDbOptions {
  failOpen?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
  missingStore?: boolean;
}

function createFakeIndexedDb({
  failOpen = false,
  failRead = false,
  failWrite = false,
  missingStore = false,
}: FakeIndexedDbOptions = {}): IDBFactory {
  const store = new Map<IDBValidKey, unknown>();
  const objectStoreNames = {
    contains: (name: string) => !missingStore && name === "firebaseLocalStorage",
  } as DOMStringList;
  const db = {
    objectStoreNames,
    close: () => undefined,
    createObjectStore: () => undefined,
    transaction: (storeName: string) => {
      if (storeName !== "firebaseLocalStorage" || missingStore) {
        throw new DOMException("One of the specified object stores was not found.", "NotFoundError");
      }
      return {
        objectStore: () => ({
          put: (value: unknown, key: IDBValidKey) => {
            const request = createRequest(undefined);
            queueMicrotask(() => {
              if (failWrite) {
                request.error = new DOMException("The operation was aborted.", "AbortError");
                request.onerror?.(new Event("error"));
              } else {
                store.set(key, value);
                request.onsuccess?.(new Event("success"));
              }
            });
            return request;
          },
          get: (key: IDBValidKey) => {
            const request = createRequest<unknown>(undefined);
            queueMicrotask(() => {
              if (failRead) {
                request.error = new DOMException("One of the specified object stores was not found.", "NotFoundError");
                request.onerror?.(new Event("error"));
              } else {
                request.result = store.get(key);
                request.onsuccess?.(new Event("success"));
              }
            });
            return request;
          },
          delete: (key: IDBValidKey) => {
            const request = createRequest(undefined);
            queueMicrotask(() => {
              store.delete(key);
              request.onsuccess?.(new Event("success"));
            });
            return request;
          },
        }),
      };
    },
  } as unknown as IDBDatabase;

  return {
    open: () => {
      const request = createRequest<IDBDatabase>(db);
      queueMicrotask(() => {
        if (failOpen) {
          request.error = new DOMException("The operation was aborted.", "AbortError");
          request.onerror?.(new Event("error"));
        } else {
          request.onsuccess?.(new Event("success"));
        }
      });
      return request as IDBOpenDBRequest;
    },
    deleteDatabase: () => createRequest(undefined) as IDBOpenDBRequest,
  } as IDBFactory;
}

function createRequest<T>(result: T): FakeRequest<T> {
  return {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  } as FakeRequest<T>;
}

describe("verifyFirebaseAuthIndexedDbStorage", () => {
  it("reports available when Firebase Auth IndexedDB open/read/write succeeds", async () => {
    await expect(verifyFirebaseAuthIndexedDbStorage(createFakeIndexedDb())).resolves.toEqual({
      available: true,
    });
  });

  it("treats IndexedDB open failures as unavailable", async () => {
    await expect(verifyFirebaseAuthIndexedDbStorage(createFakeIndexedDb({ failOpen: true })))
      .resolves.toMatchObject({ available: false, operation: "open" });
  });

  it("treats Firebase Auth object store read failures as unavailable", async () => {
    await expect(verifyFirebaseAuthIndexedDbStorage(createFakeIndexedDb({ failRead: true })))
      .resolves.toMatchObject({ available: false, operation: "read" });
  });

  it("treats Firebase Auth object store write failures as unavailable", async () => {
    await expect(verifyFirebaseAuthIndexedDbStorage(createFakeIndexedDb({ failWrite: true })))
      .resolves.toMatchObject({ available: false, operation: "write" });
  });

  it("treats a missing Firebase Auth object store as unavailable", async () => {
    await expect(verifyFirebaseAuthIndexedDbStorage(createFakeIndexedDb({ missingStore: true })))
      .resolves.toMatchObject({ available: false, operation: "transaction" });
  });
});

function createFakeSettingsClient() {
  const settings = new Map<string, string>();
  return {
    async getSetting(key: string) {
      return settings.get(key) ?? null;
    },
    async putSetting(key: string, value: string) {
      settings.set(key, value);
    },
    async deleteSetting(key: string) {
      settings.delete(key);
    },
  };
}

describe("createDesktopAuthSettingsPersistence", () => {
  it("persists Firebase Auth values through the desktop settings API", async () => {
    const settingsClient = createFakeSettingsClient();
    const firstPersistence = createDesktopAuthSettingsPersistence(settingsClient);
    const secondPersistence = createDesktopAuthSettingsPersistence(settingsClient);
    const firstPersistenceInstance = new firstPersistence();
    const secondPersistenceInstance = new secondPersistence();

    await expect(firstPersistenceInstance._isAvailable()).resolves.toBe(true);
    await firstPersistenceInstance._set("firebase:user", { uid: "user-1", refreshToken: "token-1" });

    await expect(secondPersistenceInstance._get("firebase:user")).resolves.toEqual({
      uid: "user-1",
      refreshToken: "token-1",
    });

    await secondPersistenceInstance._remove("firebase:user");
    await expect(firstPersistenceInstance._get("firebase:user")).resolves.toBeNull();
  });
});

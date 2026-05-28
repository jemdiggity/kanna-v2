import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  initializeAuth: vi.fn(),
  getAuth: vi.fn(),
  connectAuthEmulator: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  firebaseSignOut: vi.fn(),
  resolveDesktopFirebaseConfig: vi.fn(),
  verifyFirebaseAuthIndexedDbStorage: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("firebase/app", () => ({
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: { type: "LOCAL" },
  connectAuthEmulator: mocks.connectAuthEmulator,
  getAuth: mocks.getAuth,
  indexedDBLocalPersistence: { type: "INDEXEDDB" },
  inMemoryPersistence: { type: "NONE" },
  initializeAuth: mocks.initializeAuth,
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signOut: mocks.firebaseSignOut,
}));

vi.mock("../invoke", () => ({
  invoke: mocks.invoke,
}));

vi.mock("./desktopFirebaseConfig", () => ({
  resolveDesktopFirebaseConfig: mocks.resolveDesktopFirebaseConfig,
}));

vi.mock("./desktopAuthStorage", () => ({
  verifyFirebaseAuthIndexedDbStorage: mocks.verifyFirebaseAuthIndexedDbStorage,
}));

describe("getConfiguredDesktopAuthSession", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getApps.mockReset().mockReturnValue([]);
    mocks.initializeApp.mockReset().mockReturnValue({ name: "[DEFAULT]" });
    mocks.initializeAuth.mockReset().mockReturnValue({ currentUser: null });
    mocks.getAuth.mockReset().mockReturnValue({ currentUser: null });
    mocks.connectAuthEmulator.mockReset();
    mocks.onAuthStateChanged.mockReset().mockImplementation((_auth, onNext) => {
      onNext(null);
      return () => undefined;
    });
    mocks.signInWithEmailAndPassword.mockReset();
    mocks.firebaseSignOut.mockReset();
    mocks.invoke.mockReset();
    mocks.resolveDesktopFirebaseConfig.mockReset().mockResolvedValue({
      app: {
        apiKey: "kanna-local",
        authDomain: "kanna-local.firebaseapp.com",
        projectId: "kanna-local",
        storageBucket: "kanna-local.firebasestorage.app",
        messagingSenderId: "sender",
        appId: "app",
      },
      authEmulator: null,
      firestoreEmulator: null,
      functionsEndpoint: "http://127.0.0.1:5001/upsertTaskSnapshot",
    });
    mocks.verifyFirebaseAuthIndexedDbStorage.mockReset().mockResolvedValue({ available: true });
  });

  it("initializes Firebase Auth with non-IndexedDB persistence when Auth IndexedDB storage is unavailable", async () => {
    mocks.verifyFirebaseAuthIndexedDbStorage.mockResolvedValue({
      available: false,
      operation: "open",
      message: "The operation was aborted.",
    });

    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();

    expect(mocks.initializeAuth).toHaveBeenCalledWith(
      { name: "[DEFAULT]" },
      {
        persistence: [{ type: "LOCAL" }, { type: "NONE" }],
      },
    );
    expect(mocks.getAuth).not.toHaveBeenCalled();
    await expect(session.getIdToken()).resolves.toBeNull();
    expect(session.getState()).toEqual({ status: "signedOut" });
  });

  it("prefers IndexedDB persistence when the Firebase Auth storage probe succeeds", async () => {
    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();

    expect(mocks.initializeAuth).toHaveBeenCalledWith(
      { name: "[DEFAULT]" },
      {
        persistence: [{ type: "INDEXEDDB" }, { type: "LOCAL" }, { type: "NONE" }],
      },
    );
    expect(mocks.getAuth).not.toHaveBeenCalled();
  });

  it("keeps auth state signed out when Firebase observer initialization reports an error", async () => {
    mocks.onAuthStateChanged.mockImplementation((_auth, _onNext, onError) => {
      onError(new DOMException("The operation was aborted.", "AbortError"));
      return () => undefined;
    });

    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();

    expect(session.getState()).toEqual({ status: "signedOut" });
  });
});

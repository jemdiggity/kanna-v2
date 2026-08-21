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
  createDesktopAuthSettingsPersistence: vi.fn(),
  verifyFirebaseAuthIndexedDbStorage: vi.fn(),
  invoke: vi.fn(),
  revokeDesktopCloudCredential: vi.fn(),
}));

const MockDesktopPersistence = vi.hoisted(() => class {
  static readonly type = "LOCAL";
  readonly type = "LOCAL";
});

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
  createDesktopAuthSettingsPersistence: mocks.createDesktopAuthSettingsPersistence,
  verifyFirebaseAuthIndexedDbStorage: mocks.verifyFirebaseAuthIndexedDbStorage,
}));

vi.mock("./desktopCloudAssociation", () => ({
  revokeDesktopCloudCredential: mocks.revokeDesktopCloudCredential,
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
    mocks.firebaseSignOut.mockReset().mockResolvedValue(undefined);
    mocks.invoke.mockReset();
    mocks.revokeDesktopCloudCredential.mockReset().mockResolvedValue(undefined);
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
      functionsEndpoint: null,
    });
    mocks.createDesktopAuthSettingsPersistence.mockReset().mockReturnValue(MockDesktopPersistence);
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
        persistence: [MockDesktopPersistence, { type: "LOCAL" }, { type: "NONE" }],
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
        persistence: [MockDesktopPersistence, { type: "INDEXEDDB" }, { type: "LOCAL" }, { type: "NONE" }],
      },
    );
    expect(mocks.getAuth).not.toHaveBeenCalled();
  });

  it("revokes the desktop cloud credential before ending the local session", async () => {
    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();

    await expect(session.signOut()).resolves.toEqual({ desktopCredentialError: null });

    expect(mocks.revokeDesktopCloudCredential).toHaveBeenCalledOnce();
    expect(mocks.firebaseSignOut).toHaveBeenCalledOnce();
    expect(mocks.revokeDesktopCloudCredential.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.firebaseSignOut.mock.invocationCallOrder[0]!,
    );
  });

  it("signs out locally even when revoking the desktop cloud credential fails", async () => {
    mocks.revokeDesktopCloudCredential.mockRejectedValue(
      Object.assign(new Error("Missing or insufficient permissions."), {
        code: "permission-denied",
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();

    await expect(session.signOut()).resolves.toEqual({
      desktopCredentialError: "Missing or insufficient permissions.",
    });

    expect(mocks.firebaseSignOut).toHaveBeenCalledOnce();
    expect(session.getState()).toEqual({ status: "signedOut" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[cloud] failed to release desktop credential during sign-out:",
      expect.objectContaining({ code: "permission-denied" }),
    );

    warnSpy.mockRestore();
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

  it("degrades a deleted account to signed out on credential refresh", async () => {
    const getIdToken = vi.fn().mockRejectedValue(
      Object.assign(new Error("The user's credential is no longer valid."), {
        code: "auth/user-token-expired",
      }),
    );
    const firebaseUser = {
      uid: "deleted-user",
      email: "deleted@example.com",
      displayName: null,
      getIdToken,
    };
    const auth: { currentUser: typeof firebaseUser | null } = { currentUser: firebaseUser };
    mocks.initializeAuth.mockReturnValue(auth);
    let authObserver: ((user: typeof firebaseUser | null) => void) | null = null;
    mocks.onAuthStateChanged.mockImplementation((_auth, onNext) => {
      authObserver = onNext;
      onNext(firebaseUser);
      return () => undefined;
    });
    mocks.firebaseSignOut.mockImplementation(async () => {
      auth.currentUser = null;
      authObserver?.(null);
    });

    const { getConfiguredDesktopAuthSession } = await import("./desktopAuthSdk");
    const session = await getConfiguredDesktopAuthSession();
    await session.initialize();
    expect(session.getState().status).toBe("signedIn");

    await expect(session.getIdToken(true)).resolves.toBeNull();
    expect(mocks.firebaseSignOut).toHaveBeenCalledWith(auth);
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(session.getState()).toEqual({ status: "signedOut" });
  });
});

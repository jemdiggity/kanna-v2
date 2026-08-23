import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { name: "[DEFAULT]" },
  auth: { currentUser: null },
  initializeApp: vi.fn(),
  getApps: vi.fn(),
  initializeAuth: vi.fn(),
  getAuth: vi.fn(),
  connectAuthEmulator: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  inMemoryPersistence: { type: "NONE" },
  asyncStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}));

vi.mock("firebase/app", () => ({
  initializeApp: mocks.initializeApp,
  getApps: mocks.getApps
}));

vi.mock("firebase/auth", () => ({
  initializeAuth: mocks.initializeAuth,
  getAuth: mocks.getAuth,
  inMemoryPersistence: mocks.inMemoryPersistence,
  connectAuthEmulator: mocks.connectAuthEmulator,
  onAuthStateChanged: mocks.onAuthStateChanged,
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signOut: mocks.signOut
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: mocks.asyncStorage
}));

describe("createConfiguredMobileAuthSession", () => {
  it("initializes Firebase Auth with AsyncStorage-backed persistence", async () => {
    vi.stubGlobal("navigator", { product: "ReactNative" });
    mocks.getApps.mockReturnValue([]);
    mocks.initializeApp.mockReturnValue(mocks.app);
    mocks.initializeAuth.mockReturnValue(mocks.auth);
    mocks.getAuth.mockReturnValue(mocks.auth);
    mocks.onAuthStateChanged.mockImplementation((_auth, listener) => {
      listener(null);
      return () => undefined;
    });
    const { createConfiguredMobileAuthSession } = await import("./sdk");

    const session = createConfiguredMobileAuthSession({
      app: {
        apiKey: "api-key",
        projectId: "project-id",
        appId: "app-id"
      },
      authEmulator: null,
      firestoreEmulator: null
    });

    await session.initialize();

    expect(mocks.initializeAuth).toHaveBeenCalledWith(
      mocks.app,
      expect.objectContaining({
        persistence: expect.any(Function)
      })
    );
    const persistence = mocks.initializeAuth.mock.calls[0]?.[1]?.persistence;
    expect(persistence.type).toBe("LOCAL");
    vi.unstubAllGlobals();
  });

  it("stays signed out without initializing Firebase when config is disabled", async () => {
    mocks.initializeApp.mockClear();
    mocks.initializeAuth.mockClear();
    const { createConfiguredMobileAuthSession } = await import("./sdk");

    const session = createConfiguredMobileAuthSession({
      app: null,
      authEmulator: null,
      firestoreEmulator: null
    });

    await session.initialize();

    expect(session.getState()).toEqual({ status: "signedOut" });
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.initializeAuth).not.toHaveBeenCalled();
  });
});

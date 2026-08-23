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
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  signOut: vi.fn(),
  firestore: { kind: "firestore" },
  getFirestore: vi.fn(),
  connectFirestoreEmulator: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
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
  createUserWithEmailAndPassword: mocks.createUserWithEmailAndPassword,
  sendEmailVerification: mocks.sendEmailVerification,
  signOut: mocks.signOut
}));

vi.mock("firebase/firestore", () => ({
  getFirestore: mocks.getFirestore,
  connectFirestoreEmulator: mocks.connectFirestoreEmulator,
  doc: mocks.doc,
  getDoc: mocks.getDoc
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
    mocks.getFirestore.mockReturnValue(mocks.firestore);
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

  it("creates an account, sends verification, and reads its entitlement", async () => {
    const firebaseUser = {
      uid: "new-user",
      email: "new@example.com",
      displayName: null,
      emailVerified: false,
      reload: vi.fn(),
      getIdToken: vi.fn().mockResolvedValue("fresh-id-token")
    };
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user: firebaseUser });
    mocks.doc.mockReturnValue({ path: "cloud-access" });
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ status: "grace" })
    });

    const { createFirebaseMobileAuthSdk } = await import("./sdk");
    const sdk = createFirebaseMobileAuthSdk(
      mocks.auth as never,
      mocks.app as never
    );

    await expect(
      sdk.createUserWithEmailPassword("new@example.com", "secret1")
    ).resolves.toMatchObject({
      uid: "new-user",
      emailVerified: false
    });
    expect(mocks.sendEmailVerification).toHaveBeenCalledWith(firebaseUser);
    await expect(sdk.getCloudAccess("new-user")).resolves.toBe("active");
    expect(mocks.doc).toHaveBeenCalledWith(
      mocks.firestore,
      "users",
      "new-user",
      "entitlements",
      "cloud_access"
    );
    mocks.auth.currentUser = firebaseUser;
    await expect(sdk.getIdToken(true)).resolves.toBe("fresh-id-token");
    expect(firebaseUser.getIdToken).toHaveBeenCalledWith(true);
  });
});

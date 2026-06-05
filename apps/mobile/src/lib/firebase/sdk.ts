import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  inMemoryPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
  type User
} from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  parseMobileFirebaseConfig,
  type MobileFirebaseConfig
} from "./config";
import {
  createDisabledMobileAuthSession,
  createMobileAuthSession,
  type MobileAuthSdk,
  type MobileAuthSession,
  type MobileAuthUser
} from "./auth";
import { createReactNativeAuthPersistence } from "./authPersistence";

export function createConfiguredMobileAuthSession(
  config: MobileFirebaseConfig = parseMobileFirebaseConfig()
): MobileAuthSession {
  if (!config.app) {
    return createDisabledMobileAuthSession();
  }

  const app = getApps()[0] ?? initializeApp(config.app);
  const auth = initializeMobileAuth(app);
  if (config.authEmulator) {
    connectAuthEmulator(auth, config.authEmulator.url, {
      disableWarnings: true
    });
  }

  return createMobileAuthSession({
    sdk: createFirebaseMobileAuthSdk(auth, app)
  });
}

function initializeMobileAuth(app: FirebaseApp): Auth {
  try {
    return initializeAuth(app, {
      persistence: isReactNativeRuntime()
        ? createReactNativeAuthPersistence(AsyncStorage)
        : inMemoryPersistence
    });
  } catch (error) {
    if (isFirebaseAuthAlreadyInitializedError(error)) {
      return getAuth(app);
    }
    throw error;
  }
}

function isFirebaseAuthAlreadyInitializedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "auth/already-initialized"
  );
}

function isReactNativeRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as { product?: string }).product === "ReactNative"
  );
}

export function createFirebaseMobileAuthSdk(auth: Auth, _app: FirebaseApp): MobileAuthSdk {
  return {
    getCurrentUser: () => mapFirebaseUser(auth.currentUser),
    onAuthStateChanged(listener) {
      return onAuthStateChanged(auth, (user) => listener(mapFirebaseUser(user)));
    },
    async signInWithEmailPassword(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return mapSignedInFirebaseUser(credential.user);
    },
    async signOut() {
      await firebaseSignOut(auth);
    },
    async getIdToken(forceRefresh) {
      return auth.currentUser?.getIdToken(forceRefresh) ?? null;
    }
  };
}

function mapFirebaseUser(user: User | null): MobileAuthUser | null {
  if (!user) {
    return null;
  }

  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName
  };
}

function mapSignedInFirebaseUser(user: User): MobileAuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName
  };
}

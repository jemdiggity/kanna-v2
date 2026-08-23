import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  inMemoryPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
  type User
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
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
import { getConfiguredFirestore } from "./configuredFirestore";

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

export function createFirebaseMobileAuthSdk(auth: Auth, app: FirebaseApp): MobileAuthSdk {
  const db = getConfiguredFirestore(app);
  return {
    getCurrentUser: () => mapFirebaseUser(auth.currentUser),
    onAuthStateChanged(listener) {
      return onAuthStateChanged(auth, (user) => listener(mapFirebaseUser(user)));
    },
    async signInWithEmailPassword(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return mapSignedInFirebaseUser(credential.user);
    },
    async createUserWithEmailPassword(email, password) {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(credential.user);
      return mapSignedInFirebaseUser(credential.user);
    },
    async reloadUser() {
      if (!auth.currentUser) return null;
      await auth.currentUser.reload();
      return mapFirebaseUser(auth.currentUser);
    },
    async getCloudAccess(uid) {
      try {
        const snapshot = await getDoc(doc(db, "users", uid, "entitlements", "cloud_access"));
        if (!snapshot.exists()) return "inactive";
        const status = snapshot.data().status;
        return status === "active" || status === "grace" ? "active" : "inactive";
      } catch (error) {
        console.error("Could not load cloud entitlement:", error);
        return "unknown";
      }
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
    displayName: user.displayName,
    emailVerified: user.emailVerified
  };
}

function mapSignedInFirebaseUser(user: User): MobileAuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified
  };
}

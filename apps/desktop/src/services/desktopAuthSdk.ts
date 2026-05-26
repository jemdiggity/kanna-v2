import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import { invoke } from "../invoke";
import {
  createDesktopAuthSession,
  createDisabledDesktopAuthSession,
  type DesktopAuthSdk,
  type DesktopAuthSession,
  type DesktopAuthUser,
} from "./desktopAuth";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";
import { verifyFirebaseAuthIndexedDbStorage } from "./desktopAuthStorage";

let sessionPromise: Promise<DesktopAuthSession> | null = null;
let connectedAuthEmulatorUrl: string | null = null;

export function getConfiguredDesktopAuthSession(): Promise<DesktopAuthSession> {
  sessionPromise ??= createConfiguredDesktopAuthSession();
  return sessionPromise;
}

async function createConfiguredDesktopAuthSession(): Promise<DesktopAuthSession> {
  const config = await resolveDesktopFirebaseConfig({
    readEnv: (name) => invoke<string>("read_env_var", { name }),
    dev: import.meta.env.DEV,
  });

  if (!config.app) {
    return createDisabledDesktopAuthSession("Firebase Auth is not configured.");
  }

  const storageStatus = await verifyFirebaseAuthIndexedDbStorage();
  if (!storageStatus.available) {
    console.warn(
      `[cloud] Firebase Auth storage unavailable (${storageStatus.operation}): ${storageStatus.message}`,
    );
    return createDisabledDesktopAuthSession("Firebase Auth storage is not available.");
  }

  let app: FirebaseApp;
  let auth: Auth;
  try {
    app = getApps()[0] ?? initializeApp(config.app);
    auth = getAuth(app);
  } catch (error) {
    console.warn("[cloud] failed to initialize Firebase Auth:", error);
    return createDisabledDesktopAuthSession("Firebase Auth failed to initialize.");
  }
  if (config.authEmulator && connectedAuthEmulatorUrl !== config.authEmulator.url) {
    connectAuthEmulator(auth, config.authEmulator.url, {
      disableWarnings: true,
    });
    connectedAuthEmulatorUrl = config.authEmulator.url;
  }

  return createDesktopAuthSession({
    sdk: createFirebaseDesktopAuthSdk(auth, app),
  });
}

export function createFirebaseDesktopAuthSdk(auth: Auth, _app: FirebaseApp): DesktopAuthSdk {
  return {
    getCurrentUser: () => mapFirebaseUser(auth.currentUser),
    onAuthStateChanged(listener) {
      return onAuthStateChanged(
        auth,
        (user) => listener(mapFirebaseUser(user)),
        (error) => {
          console.warn("[cloud] Firebase Auth state observer failed:", error);
          listener(null);
        },
      );
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
    },
  };
}

function mapFirebaseUser(user: User | null): DesktopAuthUser | null {
  if (!user) return null;
  return mapSignedInFirebaseUser(user);
}

function mapSignedInFirebaseUser(user: User): DesktopAuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}

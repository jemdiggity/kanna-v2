import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  type User
} from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import type { CheckoutSessionRequest, CheckoutSessionResponse, CloudEntitlement } from "./types";

function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name]?.trim();
  if (!value) throw new Error(`Missing required portal configuration: ${name}`);
  return value;
}

const app = initializeApp({
  apiKey: required("VITE_FIREBASE_API_KEY"),
  authDomain: required("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: required("VITE_FIREBASE_PROJECT_ID"),
  appId: required("VITE_FIREBASE_APP_ID")
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "us-central1");

if (import.meta.env.VITE_FIREBASE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth, `http://127.0.0.1:${import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099"}`, { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", Number(import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || "8080"));
  connectFunctionsEmulator(functions, "127.0.0.1", Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || "5001"));
}

export const portalFirebase = {
  observeUser(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(auth, callback);
  },
  async register(email: string, password: string): Promise<User> {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(credential.user);
    return credential.user;
  },
  async signIn(email: string, password: string): Promise<User> {
    return (await signInWithEmailAndPassword(auth, email, password)).user;
  },
  signOut(): Promise<void> {
    return signOut(auth);
  },
  async reloadUser(user: User): Promise<User> {
    await user.reload();
    return auth.currentUser ?? user;
  },
  async entitlement(uid: string): Promise<CloudEntitlement | null> {
    const snapshot = await getDoc(doc(db, "users", uid, "entitlements", "cloud_access"));
    return snapshot.exists() ? snapshot.data() as CloudEntitlement : null;
  },
  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
    const callable = httpsCallable<CheckoutSessionRequest, CheckoutSessionResponse>(functions, "createCheckoutSession");
    return (await callable(request)).data;
  },
  async deleteAccount(): Promise<void> {
    const callable = httpsCallable<Record<string, never>, { deleted: true }>(functions, "deleteAccount");
    await callable({});
  }
};

export type PortalFirebase = typeof portalFirebase;

import { initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

export function isAuthBypassed(): boolean {
  if (process.env.SKIP_AUTH !== "true") {
    return false;
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  return Boolean(
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.KANNA_RELAY_ALLOW_AUTH_BYPASS === "true"
  );
}

export function getFirebaseServices(): { auth: Auth; db: Firestore } {
  if (isAuthBypassed()) {
    throw new Error("Firebase services are unavailable when SKIP_AUTH=true");
  }

  if (!app) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
    app = credentialsJson
      ? initializeApp({
          credential: cert(JSON.parse(credentialsJson)),
        })
      : initializeApp();
    auth = getAuth(app);
    db = getFirestore(app);
  }

  return { auth: auth!, db: db! };
}

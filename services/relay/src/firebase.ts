import { initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

const SKIP_AUTH = process.env.SKIP_AUTH === "true";

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

export function isAuthBypassed(): boolean {
  return SKIP_AUTH;
}

export function getFirebaseServices(): { auth: Auth; db: Firestore } {
  if (SKIP_AUTH) {
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

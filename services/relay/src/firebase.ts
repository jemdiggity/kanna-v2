import { initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let messaging: Messaging | undefined;

export function getFirebaseServices(): { auth: Auth; db: Firestore; messaging: Messaging } {
  if (!app) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    app = credentialsJson
      ? initializeApp({
          credential: cert(JSON.parse(credentialsJson)),
          ...(projectId ? { projectId } : {}),
        })
      : initializeApp(projectId ? { projectId } : undefined);
    auth = getAuth(app);
    db = getFirestore(app);
    messaging = getMessaging(app);
  }

  return { auth: auth!, db: db!, messaging: messaging! };
}

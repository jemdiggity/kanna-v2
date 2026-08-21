import { getApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { readExpoFirebaseEnv } from "./config";

let connectedEmulator = "";

export async function requestMobileAccountDeletion(): Promise<void> {
  const functions = getFunctions(getApp(), "us-central1");
  const env = readExpoFirebaseEnv();
  const host = env.EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_HOST?.trim();
  const port = Number(env.EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT);
  if (host && Number.isInteger(port) && port > 0 && port <= 65_535) {
    const endpoint = `${host}:${port}`;
    if (connectedEmulator !== endpoint) {
      connectFunctionsEmulator(functions, host, port);
      connectedEmulator = endpoint;
    }
  }
  const callable = httpsCallable<Record<string, never>, { deleted: true }>(
    functions,
    "deleteAccount",
  );
  await callable({});
}

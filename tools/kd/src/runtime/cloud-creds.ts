/**
 * Production Firebase web client config. Public client values — keep in sync
 * with productionDesktopFirebaseAppConfig in
 * apps/desktop/src/services/desktopFirebaseConfig.ts.
 */
export const PRODUCTION_FIREBASE_CLIENT_ENV: Readonly<Record<string, string>> = {
  KANNA_FIREBASE_API_KEY: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
  KANNA_FIREBASE_AUTH_DOMAIN: "kanna-build.firebaseapp.com",
  KANNA_FIREBASE_PROJECT_ID: "kanna-build",
  KANNA_FIREBASE_STORAGE_BUCKET: "kanna-build.firebasestorage.app",
  KANNA_FIREBASE_MESSAGING_SENDER_ID: "402613185450",
  KANNA_FIREBASE_APP_ID: "1:402613185450:web:252b2c98d1ef13bed859d3",
  KANNA_FIREBASE_MEASUREMENT_ID: "G-091WQZN4SS",
};

export const PRODUCTION_RELAY_URL = "wss://relay.kanna.build";

/**
 * Point an environment at the production cloud. KANNA_CLOUD_ENV is the
 * explicit selector the app honors — when it names a remote cloud, the app
 * itself ignores any emulator pointer env vars that leak in from dev
 * workspaces (see desktopFirebaseConfig.ts). The Firebase client values and
 * relay URL fill in without overriding explicit values.
 */
export function applyProductionCloudEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env, KANNA_CLOUD_ENV: "production" };
  for (const [key, value] of Object.entries(PRODUCTION_FIREBASE_CLIENT_ENV)) {
    if (!merged[key]?.trim()) merged[key] = value;
  }
  if (!merged.KANNA_RELAY_URL?.trim()) merged.KANNA_RELAY_URL = PRODUCTION_RELAY_URL;
  return merged;
}

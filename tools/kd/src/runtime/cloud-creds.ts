import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Local-only cloud test credentials. `~/.kanna/dev/creds.toml` holds the
 * disposable production test user and is never committed:
 *
 *   [cloud_test_user]
 *   email = "..."
 *   password = "..."
 */
export interface CloudTestCredentials {
  email: string;
  password: string;
}

export function cloudTestCredsPath(homeDir: string = homedir()): string {
  return join(homeDir, ".kanna", "dev", "creds.toml");
}

export function parseCloudTestCreds(body: string): CloudTestCredentials | null {
  let parsed: unknown;
  try {
    parsed = parseToml(body);
  } catch (error) {
    throw new Error(`creds.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const user = (parsed as { cloud_test_user?: unknown }).cloud_test_user;
  if (!user || typeof user !== "object") return null;
  const email = (user as { email?: unknown }).email;
  const password = (user as { password?: unknown }).password;
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password.trim()) {
    return null;
  }
  return { email: email.trim(), password: password.trim() };
}

export function readCloudTestCredentials(path: string = cloudTestCredsPath()): CloudTestCredentials | null {
  if (!existsSync(path)) return null;
  const creds = parseCloudTestCreds(readFileSync(path, "utf8"));
  if (!creds) {
    throw new Error(`${path} exists but has no [cloud_test_user] email/password entries.`);
  }
  return creds;
}

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

/** Fill cloud test user env vars from creds.toml without overriding explicit values. */
export function applyCloudTestCredentialEnv(
  env: NodeJS.ProcessEnv,
  creds: CloudTestCredentials | null,
): NodeJS.ProcessEnv {
  if (!creds) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  if (!merged.KANNA_CLOUD_TEST_EMAIL?.trim()) merged.KANNA_CLOUD_TEST_EMAIL = creds.email;
  if (!merged.KANNA_CLOUD_TEST_PASSWORD?.trim()) merged.KANNA_CLOUD_TEST_PASSWORD = creds.password;
  return merged;
}

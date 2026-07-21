import { randomUUID } from "node:crypto";
import {
  fetchFirebaseIdToken,
  readMobileFirebaseApiKey
} from "../../../tools/kd/src/runtime/staging-relay";

export const STAGING_BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
export const STAGING_DEVICE_TOKEN_ENV = "KANNA_E2E_DEVICE_TOKEN";
export const STAGING_PASSWORD_ENV = "KANNA_STAGING_TEST_PASSWORD";
export const STAGING_DEVICE_TOKEN = "staging-buffy-device-token";
export const STAGING_RELAY_URL = "wss://relay-staging.kanna.build";
export const STAGING_FIREBASE_PROJECT_ID = "kanna-staging";
export const STAGING_DESKTOP_NAME = "Remote E2E Staging Desktop";

export interface StagingBuffyCredentials {
  deviceToken: string;
  email: string;
  password: string;
}

export type StagingCredentialsResult =
  | { ok: true; credentials: StagingBuffyCredentials }
  | { ok: false; missing: string[] };

export interface StagingServerEnvironment {
  credentials: StagingBuffyCredentials;
  desktopId: string;
  firebaseProjectId: string;
  relayUrl: string;
}

export type StagingServerEnvironmentResult =
  | ({ ok: true } & StagingServerEnvironment)
  | { ok: false; missing: string[] };

export function buffyStagingCredentialsFromEnv(env: NodeJS.ProcessEnv): StagingCredentialsResult {
  const missing: string[] = [];
  const deviceToken = env[STAGING_DEVICE_TOKEN_ENV]?.trim();
  const password = env[STAGING_PASSWORD_ENV]?.trim();
  if (!deviceToken) missing.push(STAGING_DEVICE_TOKEN_ENV);
  if (!password) missing.push(STAGING_PASSWORD_ENV);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    credentials: {
      deviceToken: deviceToken!,
      email: STAGING_BUFFY_EMAIL,
      password: password!
    }
  };
}

export function stagingRemoteE2eSkipMessage(missing: string[]): string {
  return `SKIP staging remote-e2e: missing ${missing.join(", ")}`;
}

export function stagingServerEnvironment(env: NodeJS.ProcessEnv): StagingServerEnvironmentResult {
  const credentials = buffyStagingCredentialsFromEnv(env);
  if (!credentials.ok) {
    return credentials;
  }
  return {
    ok: true,
    credentials: credentials.credentials,
    desktopId: `remote-e2e-staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    firebaseProjectId: STAGING_FIREBASE_PROJECT_ID,
    relayUrl: STAGING_RELAY_URL
  };
}

export function stagingServerTomlLines(input: {
  daemonDir: string;
  dbPath: string;
  desktopId: string;
  deviceToken: string;
  kannaCliPath: string;
  lanPort: number;
  pairingStorePath: string;
}): string[] {
  return [
    `relay_url = "${STAGING_RELAY_URL}"`,
    `device_token = "${shellTomlString(input.deviceToken)}"`,
    `firebase_project_id = "${STAGING_FIREBASE_PROJECT_ID}"`,
    `daemon_dir = "${shellTomlString(input.daemonDir)}"`,
    `db_path = "${shellTomlString(input.dbPath)}"`,
    `kanna_cli_path = "${shellTomlString(input.kannaCliPath)}"`,
    `desktop_id = "${shellTomlString(input.desktopId)}"`,
    `desktop_name = "${STAGING_DESKTOP_NAME}"`,
    `version = "0.0.69-staging.1"`,
    `environment = "staging"`,
    `lan_host = "127.0.0.1"`,
    `lan_port = ${input.lanPort}`,
    `pairing_store_path = "${shellTomlString(input.pairingStorePath)}"`
  ];
}

export async function fetchStagingBuffyIdToken(input: {
  repoRoot: string;
  credentials: StagingBuffyCredentials;
}): Promise<string> {
  const apiKey = await readMobileFirebaseApiKey(input.repoRoot, "staging");
  return fetchFirebaseIdToken(apiKey, {
    email: input.credentials.email,
    password: input.credentials.password
  });
}

function shellTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

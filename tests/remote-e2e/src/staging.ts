import { randomUUID } from "node:crypto";
import {
  buffyStagingCredentialsFromEnv,
  type StagingBuffyCredentials
} from "../../../tools/kd/src/runtime/staging-credentials";
import {
  fetchFirebaseIdToken,
  readMobileFirebaseApiKey
} from "../../../tools/kd/src/runtime/staging-relay";

export {
  STAGING_BUFFY_EMAIL,
  STAGING_DEVICE_TOKEN_ENV,
  STAGING_PASSWORD_ENV,
  buffyStagingCredentialsFromEnv,
  stagingRemoteE2eSkipMessage,
  type StagingBuffyCredentials,
  type StagingCredentialsResult
} from "../../../tools/kd/src/runtime/staging-credentials";

export const STAGING_DEVICE_TOKEN = "staging-buffy-device-token";
export const STAGING_RELAY_URL = "wss://relay-staging.kanna.build";
export const STAGING_FIREBASE_PROJECT_ID = "kanna-staging";
export const STAGING_DESKTOP_NAME = "Remote E2E Staging Desktop";

export interface StagingServerEnvironment {
  credentials: StagingBuffyCredentials;
  desktopId: string;
  firebaseProjectId: string;
  relayUrl: string;
}

export type StagingServerEnvironmentResult =
  | ({ ok: true } & StagingServerEnvironment)
  | { ok: false; missing: string[] };

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
  transferPort: number;
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
    `transfer_port = ${input.transferPort}`,
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

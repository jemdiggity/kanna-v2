/**
 * Staging Buffy credential detection, shared between the staging remote E2E
 * suite (`tests/remote-e2e/src/staging.ts` re-exports this module) and the kd
 * staging smoke. It lives on the kd side because kd must stay buildable from
 * `tools/kd` alone (the launcher's cache identity hashes only kd sources),
 * and `tests/remote-e2e` already depends on kd runtime modules.
 */

export const STAGING_BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
export const STAGING_DEVICE_TOKEN_ENV = "KANNA_E2E_DEVICE_TOKEN";
export const STAGING_PASSWORD_ENV = "KANNA_STAGING_TEST_PASSWORD";

export interface StagingBuffyCredentials {
  deviceToken: string;
  email: string;
  password: string;
}

export type StagingCredentialsResult =
  | { ok: true; credentials: StagingBuffyCredentials }
  | { ok: false; missing: string[] };

export function buffyStagingCredentialsFromEnv(env: NodeJS.ProcessEnv): StagingCredentialsResult {
  const deviceToken = env[STAGING_DEVICE_TOKEN_ENV]?.trim();
  const password = env[STAGING_PASSWORD_ENV]?.trim();
  if (!deviceToken || !password) {
    const missing: string[] = [];
    if (!deviceToken) missing.push(STAGING_DEVICE_TOKEN_ENV);
    if (!password) missing.push(STAGING_PASSWORD_ENV);
    return { ok: false, missing };
  }
  return {
    ok: true,
    credentials: {
      deviceToken,
      email: STAGING_BUFFY_EMAIL,
      password
    }
  };
}

export function stagingRemoteE2eSkipMessage(missing: string[]): string {
  return `SKIP staging remote-e2e: missing ${missing.join(", ")}`;
}

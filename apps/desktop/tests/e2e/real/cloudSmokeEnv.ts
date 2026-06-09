export const requiredCloudSmokeEnv = [
  "KANNA_FIREBASE_API_KEY",
  "KANNA_CLOUD_TEST_EMAIL",
  "KANNA_CLOUD_TEST_PASSWORD",
  "KANNA_FIREBASE_PROJECT_ID",
] as const;

export function missingCloudSmokeEnv(env: Record<string, string | undefined>): string[] {
  return requiredCloudSmokeEnv.filter((name) => !env[name]?.trim());
}

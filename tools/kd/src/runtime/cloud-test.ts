export type CloudEnvironment = "staging" | "production";

export function buildCloudEmulatorTestCommand(): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-task-sync.test.ts"],
  ];
}

export function buildCloudSmokeCommand(): [string, string[]] {
  return [
    "pnpm",
    ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-prod-smoke.test.ts"],
  ];
}

export function buildCloudSmokeEnv(
  env: NodeJS.ProcessEnv,
  cloudEnv: CloudEnvironment,
): NodeJS.ProcessEnv {
  return {
    ...env,
    KANNA_CLOUD_ENV: cloudEnv,
  };
}

export function requireCloudSmokeEnv(
  env: NodeJS.ProcessEnv,
  cloudEnv: CloudEnvironment,
): void {
  const required = [
    "KANNA_FIREBASE_API_KEY",
    "KANNA_FIREBASE_PROJECT_ID",
    "KANNA_FIREBASE_APP_ID",
    "KANNA_CLOUD_TEST_EMAIL",
    "KANNA_CLOUD_TEST_PASSWORD",
  ];
  for (const name of required) {
    if (!env[name]?.trim()) {
      throw new Error(`${name} is required for ${cloudEnv} cloud tests.`);
    }
  }
}

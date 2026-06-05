import { buildFirebaseCommandEnv } from "./firebase";

export interface DevWindow {
  name: string;
  cwd: string;
  command: string;
  env: NodeJS.ProcessEnv;
}

export interface DevPlan {
  windows: DevWindow[];
}

export interface BuildDevPlanInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  mobile: boolean;
  emulators: boolean;
  firebaseConfigPath: string;
  mobileServerUrl: string;
}

function shellEnvPrefix(env: Record<string, string | undefined>): string {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function mobileFirebaseEnv(input: BuildDevPlanInput): Record<string, string | undefined> {
  if (!input.emulators) {
    return {};
  }

  const authPort = input.env.KANNA_FIREBASE_AUTH_PORT;
  if (!authPort) {
    return {};
  }

  return {
    EXPO_PUBLIC_FIREBASE_API_KEY: input.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "kanna-local",
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN:
      input.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "kanna-local.firebaseapp.com",
    EXPO_PUBLIC_FIREBASE_PROJECT_ID:
      input.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "kanna-local",
    EXPO_PUBLIC_FIREBASE_APP_ID:
      input.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? "kanna-mobile-local",
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST:
      input.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ??
      resolveHostFromUrl(input.mobileServerUrl),
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT:
      input.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT ?? authPort
  };
}

function resolveHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function resolveRelayUrl(input: BuildDevPlanInput): string | undefined {
  if (input.env.EXPO_PUBLIC_KANNA_RELAY_URL?.trim()) {
    return input.env.EXPO_PUBLIC_KANNA_RELAY_URL;
  }

  if (!input.emulators) {
    return undefined;
  }

  const relayPort = input.env.KANNA_RELAY_PORT;
  if (!relayPort) {
    return undefined;
  }

  return `ws://${resolveHostFromUrl(input.mobileServerUrl)}:${relayPort}`;
}

export function buildDevPlan(input: BuildDevPlanInput): DevPlan {
  const windows: DevWindow[] = [];
  const sharedEnv = { ...input.env };

  if (input.emulators) {
    windows.push({
      name: "emulators",
      cwd: input.repoRoot,
      env: buildFirebaseCommandEnv(input.repoRoot, sharedEnv),
      command: `pnpm --dir services/firebase-functions build && pnpm exec firebase emulators:start --project kanna-local --config ${JSON.stringify(input.firebaseConfigPath)}`
    });
    const relayEnv = shellEnvPrefix({
      PORT: input.env.KANNA_RELAY_PORT ?? "9080",
      SKIP_AUTH: "true"
    });
    windows.push({
      name: "relay",
      cwd: `${input.repoRoot}/services/relay`,
      env: {
        ...sharedEnv,
        SKIP_AUTH: "true",
        PORT: input.env.KANNA_RELAY_PORT ?? "9080"
      },
      command: `${relayEnv} pnpm run dev`
    });
  }

  const localConfigPath = `${input.repoRoot}/apps/desktop/src-tauri/tauri.conf.local.json`;
  windows.push({
    name: "desktop",
    cwd: `${input.repoRoot}/apps/desktop`,
    env: sharedEnv,
    command: `pnpm run build:sidecars && pnpm exec tauri dev --config ${JSON.stringify(localConfigPath)}`
  });

  if (input.mobile) {
    const mobileEnv = shellEnvPrefix({
      EXPO_PUBLIC_KANNA_RELAY_URL: resolveRelayUrl(input),
      RCT_METRO_PORT: input.env.KANNA_MOBILE_PORT ?? "8081",
      ...mobileFirebaseEnv(input)
    });
    windows.push({
      name: "mobile",
      cwd: `${input.repoRoot}/apps/mobile`,
      env: sharedEnv,
      command: `unset NO_COLOR; ${mobileEnv} pnpm run dev -- --port ${input.env.KANNA_MOBILE_PORT ?? "8081"}`
    });
  }

  return { windows };
}

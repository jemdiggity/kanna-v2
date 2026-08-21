import { buildFirebaseCommandEnv, buildFirebaseEmulatorArgs } from "./firebase";
import {
  cloudEnvironmentToKdEnvironment,
  resolveCloudRuntimeEnv,
  resolveKdEnvironment,
  type CloudEnvironmentName
} from "./environment";
import { selectPreferredLanAddress } from "./lan-address";

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
  desktopSecretEnv?: NodeJS.ProcessEnv;
  mobile: boolean;
  emulators: boolean;
  firebaseConfigPath: string;
  mobileServerUrl: string;
  resolveLanAddress?: () => string | undefined;
}

export interface BuildProductionMobilePlanInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  environment?: CloudEnvironmentName;
}

function shellEnvPrefix(env: Record<string, string | undefined>): string {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(args: string[]): string {
  return args.map((arg) => (arg.includes("/") ? shellQuote(arg) : arg)).join(" ");
}

function isPhysicalDeviceTarget(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.KANNA_IOS_DEVICE_UDID?.trim() || env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim());
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolveMobileHost(input: BuildDevPlanInput): string {
  const host = resolveHostFromUrl(input.mobileServerUrl);
  if (!isPhysicalDeviceTarget(input.env) || !isLoopbackHostname(host)) {
    return host;
  }

  const lanAddress = (input.resolveLanAddress ?? selectPreferredLanAddress)();
  if (!lanAddress) {
    throw new Error(
      "Could not determine a host LAN IP address for physical-device mobile dev. " +
        "Connect the phone to the same network as this Mac or set EXPO_PUBLIC_KANNA_SERVER_URL explicitly."
    );
  }
  return lanAddress;
}

function resolveMobileServerUrl(input: BuildDevPlanInput): string {
  const parsedUrl = new URL(input.mobileServerUrl);
  parsedUrl.hostname = resolveMobileHost(input);
  return parsedUrl.toString().replace(/\/$/, "");
}

function resolveMobileServerUrlEnv(input: BuildDevPlanInput): string | undefined {
  if (input.env.EXPO_PUBLIC_KANNA_SERVER_URL?.trim()) {
    return input.env.EXPO_PUBLIC_KANNA_SERVER_URL;
  }
  return isPhysicalDeviceTarget(input.env) ? resolveMobileServerUrl(input) : undefined;
}

function resolveReactNativePackagerHostname(input: BuildDevPlanInput): string | undefined {
  if (!isPhysicalDeviceTarget(input.env)) {
    return undefined;
  }
  return resolveMobileHost(input);
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
      resolveMobileHost(input),
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT:
      input.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT ?? authPort,
    EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST:
      input.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST ??
      resolveMobileHost(input),
    EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT:
      input.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT ??
      input.env.KANNA_FIREBASE_FIRESTORE_PORT,
    EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_HOST:
      input.env.EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_HOST ??
      resolveMobileHost(input),
    EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT:
      input.env.EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT ??
      input.env.KANNA_FIREBASE_FUNCTIONS_PORT
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

  return `ws://${resolveMobileHost(input)}:${relayPort}`;
}

function relayFirebaseEnv(input: BuildDevPlanInput): Record<string, string | undefined> {
  return {
    FIREBASE_PROJECT_ID: input.env.FIREBASE_PROJECT_ID ?? "kanna-local",
    FIREBASE_AUTH_EMULATOR_HOST: input.env.FIREBASE_AUTH_EMULATOR_HOST ??
      (input.env.KANNA_FIREBASE_AUTH_PORT ? `127.0.0.1:${input.env.KANNA_FIREBASE_AUTH_PORT}` : undefined),
    FIRESTORE_EMULATOR_HOST: input.env.FIRESTORE_EMULATOR_HOST ??
      (input.env.KANNA_FIREBASE_FIRESTORE_PORT ? `127.0.0.1:${input.env.KANNA_FIREBASE_FIRESTORE_PORT}` : undefined),
  };
}

function e2eEnv(input: BuildDevPlanInput): Record<string, string | undefined> {
  const entries = Object.entries(input.env).filter(([key]) => key.startsWith("KANNA_E2E_"));
  return Object.fromEntries(entries);
}

function productionMobileEnv(input: BuildProductionMobilePlanInput): Record<string, string | undefined> {
  const identity = input.environment
    ? resolveKdEnvironment(cloudEnvironmentToKdEnvironment(input.environment))
    : undefined;
  return {
    KANNA_APP_ENV: identity?.name === "prod" ? "production" : identity?.name,
    EXPO_PUBLIC_KANNA_RELAY_URL: input.env.EXPO_PUBLIC_KANNA_RELAY_URL ?? identity?.relayUrl,
    EXPO_PUBLIC_FIREBASE_API_KEY: input.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: input.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: input.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? identity?.firebaseProjectId,
    EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: input.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
    EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
      input.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    EXPO_PUBLIC_FIREBASE_APP_ID: input.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: input.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
    RCT_METRO_PORT: input.env.KANNA_MOBILE_PORT ?? "8081"
  };
}

export function buildDevPlan(input: BuildDevPlanInput): DevPlan {
  const windows: DevWindow[] = [];
  const sharedEnv = resolveCloudRuntimeEnv(input.env);

  if (input.emulators) {
    windows.push({
      name: "emulators",
      cwd: input.repoRoot,
      env: buildFirebaseCommandEnv(input.repoRoot, sharedEnv),
      command: `pnpm --dir services/firebase-functions build && ${shellCommand(["pnpm", ...buildFirebaseEmulatorArgs(input.firebaseConfigPath, [])])}`
    });
    const relayProcessEnv = {
      PORT: input.env.KANNA_RELAY_PORT ?? "9080",
      ...relayFirebaseEnv(input),
    };
    const relayEnv = shellEnvPrefix(relayProcessEnv);
    windows.push({
      name: "relay",
      cwd: `${input.repoRoot}/services/relay`,
      env: {
        ...sharedEnv,
        ...relayProcessEnv,
      },
      command: `${relayEnv} pnpm run dev`
    });
  }

  const localConfigPath = `${input.repoRoot}/apps/desktop/src-tauri/tauri.conf.local.json`;
  const desktopEnv = shellEnvPrefix(e2eEnv(input));
  windows.push({
    name: "desktop",
    cwd: `${input.repoRoot}/apps/desktop`,
    env: {
      ...sharedEnv,
      ...(input.desktopSecretEnv ?? {}),
    },
    // KANNA_REQUIRE_SIDECARS keeps the Tauri build script's `externalBin`
    // requirement hard for a build that produces a runnable app. Only
    // check/lint/test builds are allowed to drop unstaged sidecars — see
    // apps/desktop/src-tauri/build_support/sidecars.rs.
    command: `${desktopEnv ? `${desktopEnv} ` : ""}pnpm run build:sidecars && KANNA_REQUIRE_SIDECARS=1 ${desktopEnv ? `${desktopEnv} ` : ""}pnpm exec tauri dev --config ${JSON.stringify(localConfigPath)}`
  });

  if (input.mobile) {
    const mobileEnv = shellEnvPrefix({
      // Expo config resolution refuses to guess an environment, so the window
      // has to name one. The registry sets this to "staging" for the staging
      // path and passes its own env through otherwise, which is the dev path.
      KANNA_APP_ENV: input.env.KANNA_APP_ENV ?? "dev",
      EXPO_PUBLIC_KANNA_SERVER_URL: resolveMobileServerUrlEnv(input),
      EXPO_PUBLIC_KANNA_RELAY_URL: resolveRelayUrl(input),
      REACT_NATIVE_PACKAGER_HOSTNAME: resolveReactNativePackagerHostname(input),
      RCT_METRO_PORT: input.env.KANNA_MOBILE_PORT ?? "8081",
      ...mobileFirebaseEnv(input)
    });
    const startCommand = `${mobileEnv} pnpm run dev -- --port ${input.env.KANNA_MOBILE_PORT ?? "8081"} --dev-client`;
    const resilientStartCommand = isPhysicalDeviceTarget(input.env)
      ? `while true; do ${startCommand}; echo 'Metro exited; restarting in 2s'; sleep 2; done`
      : startCommand;
    windows.push({
      name: "mobile",
      cwd: `${input.repoRoot}/apps/mobile`,
      env: sharedEnv,
      command: `unset NO_COLOR; ${resilientStartCommand}`
    });
  }

  return { windows };
}

export function buildProductionMobilePlan(input: BuildProductionMobilePlanInput): DevPlan {
  const mobileEnv = shellEnvPrefix(productionMobileEnv(input));
  return {
    windows: [
      {
        name: "mobile",
        cwd: `${input.repoRoot}/apps/mobile`,
        env: { ...input.env },
        command: `unset NO_COLOR; ${mobileEnv} pnpm run dev -- --port ${input.env.KANNA_MOBILE_PORT ?? "8081"} --dev-client`
      }
    ]
  };
}

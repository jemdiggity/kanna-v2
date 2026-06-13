// Environment data lives in a JSON file so the Expo config loader can read it
// from app.config.ts (which require()s plain JS/JSON, not TS) while this typed
// module remains the single runtime source. One data source keeps the
// build-time and runtime views of an environment from drifting.
import registry from "./mobileEnvironments.json";

export type KannaAppEnvironmentName = "dev" | "staging" | "prod";

export interface MobileFirebaseExtraConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export interface MobileAppEnvironment {
  name: KannaAppEnvironmentName;
  displayName: string;
  scheme: string;
  iosBundleId: string;
  iosGoogleServicesFile: string;
  firebase: MobileFirebaseExtraConfig;
  relayUrl: string;
}

export interface KannaExpoExtra {
  kanna?: {
    appEnv?: KannaAppEnvironmentName;
    firebase?: Partial<MobileFirebaseExtraConfig>;
    relayUrl?: string;
  };
}

export const mobileEnvironmentRegistry: Record<
  KannaAppEnvironmentName,
  MobileAppEnvironment
> = registry as Record<KannaAppEnvironmentName, MobileAppEnvironment>;

export function resolveMobileAppEnvironment(
  rawName: string | undefined
): MobileAppEnvironment {
  const name = rawName?.trim();
  if (name === "dev" || name === "staging" || name === "prod") {
    return mobileEnvironmentRegistry[name];
  }

  return mobileEnvironmentRegistry.prod;
}

export function readKannaExpoExtra(
  expoConfig: { extra?: unknown } | null | undefined
): KannaExpoExtra["kanna"] {
  const extra = expoConfig?.extra;
  if (!isRecord(extra)) {
    return undefined;
  }

  const kanna = extra.kanna;
  if (!isRecord(kanna)) {
    return undefined;
  }

  const firebase = isRecord(kanna.firebase)
    ? parseFirebaseExtra(kanna.firebase)
    : undefined;
  const appEnv =
    kanna.appEnv === "dev" || kanna.appEnv === "staging" || kanna.appEnv === "prod"
      ? kanna.appEnv
      : undefined;
  const relayUrl = typeof kanna.relayUrl === "string" ? kanna.relayUrl : undefined;

  return { appEnv, firebase, relayUrl };
}

function parseFirebaseExtra(
  input: Record<string, unknown>
): Partial<MobileFirebaseExtraConfig> {
  return {
    apiKey: readString(input.apiKey),
    authDomain: readString(input.authDomain),
    projectId: readString(input.projectId),
    storageBucket: readString(input.storageBucket),
    messagingSenderId: readString(input.messagingSenderId),
    appId: readString(input.appId),
    measurementId: readString(input.measurementId)
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

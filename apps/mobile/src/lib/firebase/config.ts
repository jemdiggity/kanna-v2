export interface ExpoFirebaseEnv {
  EXPO_PUBLIC_FIREBASE_API_KEY?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
  EXPO_PUBLIC_FIREBASE_PROJECT_ID?: string;
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET?: string;
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?: string;
  EXPO_PUBLIC_FIREBASE_APP_ID?: string;
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT?: string;
}

export interface MobileFirebaseAppConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export interface MobileFirebaseAuthEmulatorConfig {
  host: string;
  port: number;
  url: string;
}

export interface MobileFirebaseConfig {
  app: MobileFirebaseAppConfig | null;
  authEmulator: MobileFirebaseAuthEmulatorConfig | null;
}

export function readExpoFirebaseEnv(): ExpoFirebaseEnv {
  const globalEnv = (globalThis as { process?: { env?: ExpoFirebaseEnv } }).process?.env;
  return globalEnv ?? {};
}

export function parseMobileFirebaseConfig(
  env: ExpoFirebaseEnv = readExpoFirebaseEnv()
): MobileFirebaseConfig {
  const authEmulator = parseAuthEmulator(env);
  const appDefaults = authEmulator ? null : productionMobileFirebaseAppConfig;
  const apiKey =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_API_KEY) ?? appDefaults?.apiKey;
  const projectId =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_PROJECT_ID) ?? appDefaults?.projectId;
  const appId =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_APP_ID) ?? appDefaults?.appId;
  const app =
    apiKey && projectId && appId
      ? compactAppConfig({
          apiKey,
          authDomain:
            normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN) ??
            appDefaults?.authDomain,
          projectId,
          storageBucket:
            normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET) ??
            appDefaults?.storageBucket,
          messagingSenderId:
            normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID) ??
            appDefaults?.messagingSenderId,
          appId,
          measurementId:
            normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID) ??
            appDefaults?.measurementId
        })
      : null;

  return {
    app,
    authEmulator
  };
}

const productionMobileFirebaseAppConfig: MobileFirebaseAppConfig = {
  apiKey: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
  authDomain: "kanna-build.firebaseapp.com",
  projectId: "kanna-build",
  storageBucket: "kanna-build.firebasestorage.app",
  messagingSenderId: "402613185450",
  appId: "1:402613185450:web:252b2c98d1ef13bed859d3",
  measurementId: "G-091WQZN4SS"
};

function compactAppConfig(config: MobileFirebaseAppConfig): MobileFirebaseAppConfig {
  const compacted: MobileFirebaseAppConfig = {
    apiKey: config.apiKey,
    projectId: config.projectId,
    appId: config.appId
  };

  if (config.authDomain) {
    compacted.authDomain = config.authDomain;
  }
  if (config.storageBucket) {
    compacted.storageBucket = config.storageBucket;
  }
  if (config.messagingSenderId) {
    compacted.messagingSenderId = config.messagingSenderId;
  }
  if (config.measurementId) {
    compacted.measurementId = config.measurementId;
  }

  return compacted;
}

function parseAuthEmulator(
  env: ExpoFirebaseEnv
): MobileFirebaseAuthEmulatorConfig | null {
  const host = normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST);
  const rawPort = normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT);
  if (!host || !rawPort) {
    return null;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    host,
    port,
    url: `http://${host}:${port}`
  };
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

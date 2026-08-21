import {
  readKannaExpoExtra,
  type MobileFirebaseExtraConfig
} from "../../mobileEnvironment";
import { readExpoConfig } from "../expoConfig";

export interface ExpoFirebaseEnv {
  EXPO_PUBLIC_KANNA_CLOUD_ENV?: string;
  EXPO_PUBLIC_FIREBASE_API_KEY?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
  EXPO_PUBLIC_FIREBASE_PROJECT_ID?: string;
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET?: string;
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?: string;
  EXPO_PUBLIC_FIREBASE_APP_ID?: string;
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?: string;
  EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT?: string;
  EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST?: string;
  EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT?: string;
  EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_HOST?: string;
  EXPO_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT?: string;
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

export interface MobileFirestoreEmulatorConfig {
  host: string;
  port: number;
}

export interface MobileFirebaseConfig {
  app: MobileFirebaseAppConfig | null;
  authEmulator: MobileFirebaseAuthEmulatorConfig | null;
  firestoreEmulator: MobileFirestoreEmulatorConfig | null;
}

type ExpoFirebaseExtra = Partial<MobileFirebaseExtraConfig>;

export function readExpoFirebaseEnv(): ExpoFirebaseEnv {
  const globalEnv = (globalThis as { process?: { env?: ExpoFirebaseEnv } }).process?.env;
  return globalEnv ?? {};
}

export function parseMobileFirebaseConfig(
  env: ExpoFirebaseEnv = readExpoFirebaseEnv(),
  extra: ExpoFirebaseExtra | null | undefined = readKannaExpoExtra(readExpoConfig())
    ?.firebase
): MobileFirebaseConfig {
  const authEmulator = parseAuthEmulator(env);
  const firestoreEmulator = parseFirestoreEmulator(env);
  const profileDefaults = profileMobileFirebaseAppConfig(env);
  const appDefaults = authEmulator
    ? profileDefaults ?? extra ?? null
    : profileDefaults ?? extra ?? productionMobileFirebaseAppConfig;
  const app = resolveMobileFirebaseAppConfig(env, appDefaults);

  return {
    app,
    authEmulator,
    firestoreEmulator
  };
}

export function resolveMobileFirebaseAppConfig(
  env: ExpoFirebaseEnv,
  appDefaults: ExpoFirebaseExtra | null | undefined
): MobileFirebaseAppConfig | null {
  const apiKey =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_API_KEY) ?? appDefaults?.apiKey;
  const projectId =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_PROJECT_ID) ?? appDefaults?.projectId;
  const appId =
    normalizeEnvValue(env.EXPO_PUBLIC_FIREBASE_APP_ID) ?? appDefaults?.appId;
  return apiKey && projectId && appId
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
}

function profileMobileFirebaseAppConfig(
  env: ExpoFirebaseEnv
): MobileFirebaseAppConfig | null {
  const cloudEnv = normalizeEnvValue(env.EXPO_PUBLIC_KANNA_CLOUD_ENV);
  if (cloudEnv === "staging") {
    return stagingMobileFirebaseAppConfig;
  }
  if (cloudEnv === "local") {
    return localMobileFirebaseAppConfig;
  }
  if (cloudEnv === "production" || cloudEnv === "prod") {
    return productionMobileFirebaseAppConfig;
  }
  return null;
}

const localMobileFirebaseAppConfig: MobileFirebaseAppConfig = {
  apiKey: "kanna-local",
  authDomain: "kanna-local.firebaseapp.com",
  projectId: "kanna-local",
  appId: "kanna-mobile-local"
};

const stagingMobileFirebaseAppConfig: MobileFirebaseAppConfig = {
  apiKey: "AIzaSyCWjrhJDZobI1LUwL70ACSZg_GewcYnn3Q",
  authDomain: "kanna-staging.firebaseapp.com",
  projectId: "kanna-staging",
  storageBucket: "kanna-staging.firebasestorage.app",
  messagingSenderId: "1073113006696",
  appId: "1:1073113006696:web:3bca4e7586f5587e1c71dd",
  measurementId: "G-BZNH6TMDCK"
};

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
  const emulator = parseEmulator(
    env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
    env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT
  );
  return emulator
    ? {
        ...emulator,
        url: `http://${emulator.host}:${emulator.port}`
      }
    : null;
}

function parseFirestoreEmulator(
  env: ExpoFirebaseEnv
): MobileFirestoreEmulatorConfig | null {
  return parseEmulator(
    env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST,
    env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT
  );
}

function parseEmulator(
  rawHost: string | undefined,
  rawPort: string | undefined
): MobileFirestoreEmulatorConfig | null {
  const host = normalizeEnvValue(rawHost);
  const rawPortValue = normalizeEnvValue(rawPort);
  if (!host || !rawPortValue) {
    return null;
  }

  const port = Number(rawPortValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    host,
    port
  };
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

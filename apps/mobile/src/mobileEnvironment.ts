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
> = {
  dev: {
    name: "dev",
    displayName: "Kanna Dev",
    scheme: "kanna-dev",
    iosBundleId: "build.kanna.app.dev",
    iosGoogleServicesFile: "./firebase/GoogleService-Info.production.plist",
    firebase: {
      apiKey: "kanna-local",
      authDomain: "kanna-local.firebaseapp.com",
      projectId: "kanna-local",
      storageBucket: "kanna-local.firebasestorage.app",
      messagingSenderId: "0",
      appId: "kanna-mobile-local"
    },
    relayUrl: "ws://127.0.0.1:9080"
  },
  staging: {
    name: "staging",
    displayName: "Kanna Staging",
    scheme: "kanna-staging",
    iosBundleId: "build.kanna.app.staging",
    iosGoogleServicesFile: "./firebase/GoogleService-Info.staging.plist",
    firebase: {
      apiKey: "AIzaSyCRsov6oQu8Fg0clB2mdB5RgwM8GGwCQXk",
      authDomain: "kanna-staging.firebaseapp.com",
      projectId: "kanna-staging",
      storageBucket: "kanna-staging.firebasestorage.app",
      messagingSenderId: "1073113006696",
      appId: "1:1073113006696:ios:612ea270319b137c1c71dd"
    },
    relayUrl: "wss://relay-staging.kanna.build"
  },
  prod: {
    name: "prod",
    displayName: "Kanna",
    scheme: "kanna",
    iosBundleId: "build.kanna.app",
    iosGoogleServicesFile: "./firebase/GoogleService-Info.production.plist",
    firebase: {
      apiKey: "AIzaSyDvGtzo25dQO2zr5itGsDL-adr5dhrfm2c",
      authDomain: "kanna-build.firebaseapp.com",
      projectId: "kanna-build",
      storageBucket: "kanna-build.firebasestorage.app",
      messagingSenderId: "402613185450",
      appId: "1:402613185450:ios:adcedeadcd241285d859d3"
    },
    relayUrl: "wss://relay.kanna.build"
  }
};

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

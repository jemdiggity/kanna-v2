export interface DesktopFirebaseAppConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export interface DesktopFirebaseAuthEmulatorConfig {
  host: string;
  port: number;
  url: string;
}

export interface DesktopFirebaseConfig {
  app: DesktopFirebaseAppConfig | null;
  authEmulator: DesktopFirebaseAuthEmulatorConfig | null;
  firestoreEmulator: DesktopFirebaseAuthEmulatorConfig | null;
  functionsEndpoint: string | null;
}

export interface ResolveDesktopFirebaseConfigOptions {
  readEnv(name: string): Promise<string>;
  dev: boolean;
}

export async function resolveDesktopFirebaseConfig({
  readEnv,
  dev,
}: ResolveDesktopFirebaseConfigOptions): Promise<DesktopFirebaseConfig> {
  const app = readAppConfig(dev);
  const [authPort, firestorePort, functionsPort] = await Promise.all([
    readEnv("KANNA_FIREBASE_AUTH_PORT").catch(() => ""),
    readEnv("KANNA_FIREBASE_FIRESTORE_PORT").catch(() => ""),
    readEnv("KANNA_FIREBASE_FUNCTIONS_PORT").catch(() => ""),
  ]);

  return {
    app,
    authEmulator: parseAuthEmulatorPort(authPort),
    firestoreEmulator: parseAuthEmulatorPort(firestorePort),
    functionsEndpoint: parseFunctionsEndpoint(functionsPort),
  };
}

function readAppConfig(dev: boolean): DesktopFirebaseAppConfig | null {
  const env = import.meta.env;
  const apiKey = normalizeEnvValue(env.VITE_FIREBASE_API_KEY);
  const projectId = normalizeEnvValue(env.VITE_FIREBASE_PROJECT_ID);
  const appId = normalizeEnvValue(env.VITE_FIREBASE_APP_ID);

  if (apiKey && projectId && appId) {
    return compactAppConfig({
      apiKey,
      authDomain: normalizeEnvValue(env.VITE_FIREBASE_AUTH_DOMAIN),
      projectId,
      storageBucket: normalizeEnvValue(env.VITE_FIREBASE_STORAGE_BUCKET),
      messagingSenderId: normalizeEnvValue(env.VITE_FIREBASE_MESSAGING_SENDER_ID),
      appId,
    });
  }

  if (dev) {
    return {
      apiKey: "kanna-local",
      authDomain: "kanna-local.firebaseapp.com",
      projectId: "kanna-local",
      appId: "kanna-desktop-local",
    };
  }

  return productionDesktopFirebaseAppConfig;
}

const productionDesktopFirebaseAppConfig: DesktopFirebaseAppConfig = {
  apiKey: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
  authDomain: "kanna-build.firebaseapp.com",
  projectId: "kanna-build",
  storageBucket: "kanna-build.firebasestorage.app",
  messagingSenderId: "402613185450",
  appId: "1:402613185450:web:252b2c98d1ef13bed859d3",
  measurementId: "G-091WQZN4SS",
};

function compactAppConfig(config: DesktopFirebaseAppConfig): DesktopFirebaseAppConfig {
  const compacted: DesktopFirebaseAppConfig = {
    apiKey: config.apiKey,
    projectId: config.projectId,
    appId: config.appId,
  };

  if (config.authDomain) compacted.authDomain = config.authDomain;
  if (config.storageBucket) compacted.storageBucket = config.storageBucket;
  if (config.messagingSenderId) compacted.messagingSenderId = config.messagingSenderId;
  if (config.measurementId) compacted.measurementId = config.measurementId;

  return compacted;
}

function parseAuthEmulatorPort(
  rawPort: string | undefined
): DesktopFirebaseAuthEmulatorConfig | null {
  const normalized = normalizeEnvValue(rawPort);
  if (!normalized) return null;

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

function parseFunctionsEndpoint(rawPort: string | undefined): string | null {
  const parsed = parseAuthEmulatorPort(rawPort);
  return parsed
    ? `${parsed.url}/kanna-local/us-central1/upsertTaskSnapshot`
    : null;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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
  portalBaseUrl: string;
}

export interface ResolveDesktopFirebaseConfigOptions {
  readEnv(name: string): Promise<string>;
  dev: boolean;
}

type DesktopCloudEnv = "staging" | "production";

export async function resolveDesktopFirebaseConfig({
  readEnv,
  dev,
}: ResolveDesktopFirebaseConfigOptions): Promise<DesktopFirebaseConfig> {
  const [
    runtimeApp,
    authPort,
    firestorePort,
    runtimeFunctionsEndpoint,
    runtimePortalBaseUrl,
    webPortalPort,
    cloudEnvRaw,
  ] =
    await Promise.all([
      readRuntimeAppConfig(readEnv),
      readEnv("KANNA_FIREBASE_AUTH_PORT").catch(() => ""),
      readEnv("KANNA_FIREBASE_FIRESTORE_PORT").catch(() => ""),
      readEnv("KANNA_CLOUD_FUNCTIONS_ENDPOINT").catch(() => ""),
      readEnv("KANNA_PORTAL_BASE_URL").catch(() => ""),
      readEnv("KANNA_WEB_PORTAL_PORT").catch(() => ""),
      readEnv("KANNA_CLOUD_ENV").catch(() => ""),
    ]);

  const cloudEnv = normalizeCloudEnv(cloudEnvRaw);
  const app =
    runtimeApp ?? (cloudEnv ? cloudDesktopFirebaseAppConfig[cloudEnv] : readBuildTimeAppConfig(dev));

  // Firebase emulators are a local-development concept. When the desktop is
  // pointed at a real cloud environment, leaked workspace emulator env vars
  // must not drag the session onto localhost.
  const useEmulators = cloudEnv === null;

  return {
    app,
    authEmulator: useEmulators ? parseAuthEmulatorPort(authPort) : null,
    firestoreEmulator: useEmulators ? parseAuthEmulatorPort(firestorePort) : null,
    functionsEndpoint: useEmulators ? parseFunctionsEndpoint(runtimeFunctionsEndpoint) : null,
    portalBaseUrl: resolvePortalBaseUrl({
      runtimePortalBaseUrl,
      webPortalPort,
      cloudEnv,
    }),
  };
}

function resolvePortalBaseUrl(input: {
  runtimePortalBaseUrl: string;
  webPortalPort: string;
  cloudEnv: DesktopCloudEnv | null;
}): string {
  const runtime = parseHttpBaseUrl(input.runtimePortalBaseUrl);
  if (runtime) return runtime;
  if (input.cloudEnv === "staging") return "https://kanna-staging-account.web.app";
  if (input.cloudEnv === "production") return "https://kanna-build-account.web.app";

  const port = parsePort(input.webPortalPort) ?? 5173;
  return `http://127.0.0.1:${port}`;
}

function normalizeCloudEnv(raw: string | undefined): DesktopCloudEnv | null {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "staging") return "staging";
  if (normalized === "production" || normalized === "prod") return "production";
  return null;
}

async function readRuntimeAppConfig(
  readEnv: ResolveDesktopFirebaseConfigOptions["readEnv"],
): Promise<DesktopFirebaseAppConfig | null> {
  const [
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket,
    messagingSenderId,
    measurementId,
  ] = await Promise.all([
    readEnv("KANNA_FIREBASE_API_KEY").catch(() => ""),
    readEnv("KANNA_FIREBASE_AUTH_DOMAIN").catch(() => ""),
    readEnv("KANNA_FIREBASE_PROJECT_ID").catch(() => ""),
    readEnv("KANNA_FIREBASE_APP_ID").catch(() => ""),
    readEnv("KANNA_FIREBASE_STORAGE_BUCKET").catch(() => ""),
    readEnv("KANNA_FIREBASE_MESSAGING_SENDER_ID").catch(() => ""),
    readEnv("KANNA_FIREBASE_MEASUREMENT_ID").catch(() => ""),
  ]);

  const normalizedApiKey = normalizeEnvValue(apiKey);
  const normalizedProjectId = normalizeEnvValue(projectId);
  const normalizedAppId = normalizeEnvValue(appId);
  if (!normalizedApiKey || !normalizedProjectId || !normalizedAppId) return null;

  return compactAppConfig({
    apiKey: normalizedApiKey,
    authDomain: normalizeEnvValue(authDomain),
    projectId: normalizedProjectId,
    storageBucket: normalizeEnvValue(storageBucket),
    messagingSenderId: normalizeEnvValue(messagingSenderId),
    appId: normalizedAppId,
    measurementId: normalizeEnvValue(measurementId),
  });
}

function readBuildTimeAppConfig(dev: boolean): DesktopFirebaseAppConfig | null {
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
    return localDesktopFirebaseAppConfig;
  }

  return productionDesktopFirebaseAppConfig;
}

const localDesktopFirebaseAppConfig: DesktopFirebaseAppConfig = {
  apiKey: "kanna-local",
  authDomain: "kanna-local.firebaseapp.com",
  projectId: "kanna-local",
  appId: "kanna-desktop-local",
};

const stagingDesktopFirebaseAppConfig: DesktopFirebaseAppConfig = {
  apiKey: "AIzaSyCWjrhJDZobI1LUwL70ACSZg_GewcYnn3Q",
  authDomain: "kanna-staging.firebaseapp.com",
  projectId: "kanna-staging",
  storageBucket: "kanna-staging.firebasestorage.app",
  messagingSenderId: "1073113006696",
  appId: "1:1073113006696:web:3bca4e7586f5587e1c71dd",
  measurementId: "G-BZNH6TMDCK",
};

const productionDesktopFirebaseAppConfig: DesktopFirebaseAppConfig = {
  apiKey: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
  authDomain: "kanna-build.firebaseapp.com",
  projectId: "kanna-build",
  storageBucket: "kanna-build.firebasestorage.app",
  messagingSenderId: "402613185450",
  appId: "1:402613185450:web:252b2c98d1ef13bed859d3",
  measurementId: "G-091WQZN4SS",
};

const cloudDesktopFirebaseAppConfig: Record<DesktopCloudEnv, DesktopFirebaseAppConfig> = {
  staging: stagingDesktopFirebaseAppConfig,
  production: productionDesktopFirebaseAppConfig,
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
  const port = parsePort(rawPort);
  if (!port) return null;

  return {
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

function parsePort(rawPort: string | undefined): number | null {
  const normalized = normalizeEnvValue(rawPort);
  if (!normalized) return null;

  const port = Number(normalized);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseFunctionsEndpoint(
  runtimeEndpoint: string | undefined,
): string | null {
  const runtime = parseRuntimeFunctionsEndpoint(runtimeEndpoint);
  if (runtime) return runtime;

  return null;
}

function parseRuntimeFunctionsEndpoint(rawEndpoint: string | undefined): string | null {
  const normalized = normalizeEnvValue(rawEndpoint);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:" ? normalized : null;
  } catch (error) {
    console.debug("[firebase-config] invalid runtime functions endpoint:", error);
    return null;
  }
}

function parseHttpBaseUrl(rawUrl: string | undefined): string | null {
  const normalized = normalizeEnvValue(rawUrl);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalized.replace(/\/$/, "");
  } catch (error) {
    console.debug("[firebase-config] invalid portal base URL:", error);
    return null;
  }
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Read environment data straight from JSON. The Expo config loader transpiles
// only this file and then require()s its imports as plain JS, so it cannot
// resolve a sibling .ts module — JSON is resolvable by both the config loader
// and the typed runtime layer (src/mobileEnvironment.ts), keeping one data
// source. Do NOT import ./src/mobileEnvironment here.
import environments from "./src/mobileEnvironments.json";

type KannaAppEnvironmentName = "dev" | "staging" | "prod";

interface MobileFirebaseExtraConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

interface MobileAppEnvironment {
  name: KannaAppEnvironmentName;
  displayName: string;
  scheme: string;
  iosBundleId: string;
  iosGoogleServicesFile: string;
  firebase: MobileFirebaseExtraConfig;
  relayUrl: string;
}

const registry = environments as Record<
  KannaAppEnvironmentName,
  MobileAppEnvironment
>;

export function resolveMobileAppEnvironment(
  rawName: string | undefined
): MobileAppEnvironment {
  const name = rawName?.trim();
  if (name === "dev" || name === "staging" || name === "prod") {
    return registry[name];
  }

  return registry.prod;
}

interface ExpoConfig {
  name: string;
  slug: string;
  scheme: string;
  icon: string;
  plugins: string[];
  platforms: string[];
  ios: {
    bundleIdentifier: string;
    appleTeamId: string;
    googleServicesFile: string;
  };
  extra: {
    kanna: {
      appEnv: MobileAppEnvironment["name"];
      firebase: MobileAppEnvironment["firebase"];
      relayUrl: string;
    };
  };
}

export function createExpoConfig(
  env: { KANNA_APP_ENV?: string }
): ExpoConfig {
  const appEnvironment = resolveMobileAppEnvironment(env.KANNA_APP_ENV);

  return {
    name: appEnvironment.displayName,
    slug: "kanna-mobile",
    scheme: appEnvironment.scheme,
    icon: "./assets/icon.png",
    plugins: ["./plugins/withKannaBonjour"],
    platforms: ["ios", "android"],
    ios: {
      bundleIdentifier: appEnvironment.iosBundleId,
      appleTeamId: "GY3LFAA59P",
      googleServicesFile: appEnvironment.iosGoogleServicesFile
    },
    extra: {
      kanna: {
        appEnv: appEnvironment.name,
        firebase: appEnvironment.firebase,
        relayUrl: appEnvironment.relayUrl
      }
    }
  };
}

export default createExpoConfig(process.env);

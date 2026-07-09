// Read environment data straight from JSON. The Expo config loader transpiles
// only this file and then require()s its imports as plain JS, so it cannot
// resolve a sibling .ts module — JSON is resolvable by both the config loader
// and the typed runtime layer (src/mobileEnvironment.ts), keeping one data
// source. Do NOT import ./src/mobileEnvironment here.
import environments from "./src/mobileEnvironments.json";

type KannaAppEnvironmentName = "dev" | "staging" | "prod";
type OtaChannel = "staging" | "production";

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
  runtimeVersion: string;
  name: KannaAppEnvironmentName;
  displayName: string;
  scheme: string;
  iosBundleId: string;
  iosGoogleServicesFile: string;
  firebase: MobileFirebaseExtraConfig;
  relayUrl: string;
  otaChannel: OtaChannel | null;
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
  version?: string;
  scheme: string;
  icon: string;
  plugins: (string | [string, { displayName: string; iosBundleId: string }])[];
  platforms: string[];
  ios: {
    bundleIdentifier: string;
    appleTeamId: string;
    googleServicesFile: string;
    buildNumber?: string;
  };
  runtimeVersion: string;
  updates?: {
    url: string;
    requestHeaders: {
      "expo-channel-name": OtaChannel;
    };
    checkAutomatically: "NEVER";
    codeSigningCertificate: string;
    codeSigningMetadata: {
      keyid: string;
      alg: "rsa-v1_5-sha256";
    };
  };
  extra: {
    kanna: {
      appEnv: MobileAppEnvironment["name"];
      firebase: MobileAppEnvironment["firebase"];
      relayUrl: string;
      runtimeVersion: string;
      ota: {
        channel: OtaChannel | null;
        manifestUrl: string | null;
      };
    };
  };
}

const OTA_MANIFEST_PATH = "/ota/manifest";
const OTA_CODE_SIGNING_CERTIFICATE = "./certs/ota-codesign.pem";
const OTA_CODE_SIGNING_KEY_ID = "kanna-mobile-ota-v1";

export function createExpoConfig(
  env: {
    KANNA_APP_ENV?: string;
    KANNA_APP_VERSION?: string;
    KANNA_IOS_BUILD_NUMBER?: string;
  }
): ExpoConfig {
  const appEnvironment = resolveMobileAppEnvironment(env.KANNA_APP_ENV);
  const version = env.KANNA_APP_VERSION?.trim();
  const buildNumber = env.KANNA_IOS_BUILD_NUMBER?.trim();
  const otaManifestUrl = resolveOtaManifestUrl(appEnvironment);
  const updates =
    appEnvironment.otaChannel && otaManifestUrl
      ? {
          url: otaManifestUrl,
          requestHeaders: {
            "expo-channel-name": appEnvironment.otaChannel
          },
          checkAutomatically: "NEVER" as const,
          codeSigningCertificate: OTA_CODE_SIGNING_CERTIFICATE,
          codeSigningMetadata: {
            keyid: OTA_CODE_SIGNING_KEY_ID,
            alg: "rsa-v1_5-sha256" as const
          }
        }
      : undefined;

  return {
    name: appEnvironment.displayName,
    slug: "kanna-mobile",
    ...(version ? { version } : {}),
    scheme: appEnvironment.scheme,
    icon: "./assets/icon.png",
    plugins: [
      [
        "./plugins/withKannaNativeIdentity",
        {
          displayName: appEnvironment.displayName,
          iosBundleId: appEnvironment.iosBundleId
        }
      ],
      "./plugins/withKannaBonjour"
    ],
    platforms: ["ios", "android"],
    ios: {
      bundleIdentifier: appEnvironment.iosBundleId,
      appleTeamId: "GY3LFAA59P",
      googleServicesFile: appEnvironment.iosGoogleServicesFile,
      ...(buildNumber ? { buildNumber } : {})
    },
    runtimeVersion: appEnvironment.runtimeVersion,
    ...(updates ? { updates } : {}),
    extra: {
      kanna: {
        appEnv: appEnvironment.name,
        firebase: appEnvironment.firebase,
        relayUrl: appEnvironment.relayUrl,
        runtimeVersion: appEnvironment.runtimeVersion,
        ota: {
          channel: appEnvironment.otaChannel,
          manifestUrl: otaManifestUrl
        }
      }
    }
  };
}

export function deriveHttpsBaseFromRelayUrl(relayUrl: string): string | null {
  if (relayUrl.startsWith("wss://")) {
    return `https://${relayUrl.slice("wss://".length)}`;
  }

  if (relayUrl.startsWith("https://")) {
    return relayUrl;
  }

  return null;
}

function resolveOtaManifestUrl(
  appEnvironment: MobileAppEnvironment
): string | null {
  if (!appEnvironment.otaChannel) {
    return null;
  }

  const baseUrl = deriveHttpsBaseFromRelayUrl(appEnvironment.relayUrl);
  return baseUrl ? `${baseUrl}${OTA_MANIFEST_PATH}` : null;
}

export default createExpoConfig(process.env);

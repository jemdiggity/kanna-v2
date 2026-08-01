// Read environment data straight from JSON. The Expo config loader transpiles
// only this file and then require()s its imports as plain JS, so it cannot
// resolve a sibling .ts module — JSON is resolvable by both the config loader
// and the typed runtime layer (src/mobileEnvironment.ts), keeping one data
// source. Do NOT import ./src/mobileEnvironment here.
import environments from "./src/mobileEnvironments.json";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  version: string;
  scheme: string;
  icon: string;
  plugins: Array<string | [string, Record<string, unknown>]>;
  platforms: string[];
  ios: {
    bundleIdentifier: string;
    appleTeamId: string;
    googleServicesFile?: string;
    entitlements: {
      "aps-environment": "development" | "production";
    };
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

// The native CFBundleShortVersionString source of truth. An explicit
// KANNA_APP_VERSION (production archives and kd staging device builds) wins.
// Other local builds fall back to the repository VERSION file — the release
// version source mobile-archive also reads. Kd must supply the active staging
// marketing version because that series may be ahead of VERSION.
export function readRepoVersion(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "VERSION");
    if (existsSync(candidate)) {
      const version = readFileSync(candidate, "utf8").trim();
      if (!version) {
        throw new Error(
          `Repository VERSION file at ${candidate} is empty; fix it or set KANNA_APP_VERSION explicitly.`
        );
      }
      return version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find a repository VERSION file above ${startDir}; set KANNA_APP_VERSION explicitly.`
      );
    }
    dir = parent;
  }
}

export function createExpoConfig(
  env: {
    KANNA_APP_ENV?: string;
    KANNA_APP_VERSION?: string;
    KANNA_IOS_BUILD_NUMBER?: string;
  },
  readNativeVersionFallback: () => string = readRepoVersion
): ExpoConfig {
  const appEnvironment = resolveMobileAppEnvironment(env.KANNA_APP_ENV);
  const explicitVersion = env.KANNA_APP_VERSION?.trim();
  const version = explicitVersion || readNativeVersionFallback();
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
    version,
    scheme: appEnvironment.scheme,
    icon: "./assets/icon.png",
    plugins: [
      // React Native Firebase native packages autolink in every environment,
      // so their Swift pods always require static frameworks. This Podfile
      // configuration is separate from environment-specific initialization.
      "./plugins/withKannaFirebasePodfile",
      // Dev has no Firebase Apple app/plist matching build.kanna.app.dev.
      // Do not initialize it with the production native identity.
      ...(appEnvironment.name === "dev"
        ? []
        : ["./plugins/withKannaFirebaseMessaging"]),
      "expo-font",
      [
        "expo-camera",
        {
          cameraPermission: "Allow Kanna to scan machine pairing QR codes.",
          barcodeScannerEnabled: true,
          recordAudioAndroid: false
        }
      ],
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
      // Dev has no matching Firebase Apple app. Keep the production and
      // staging plist wiring intact without copying either plist into dev.
      ...(appEnvironment.name === "dev"
        ? {}
        : { googleServicesFile: appEnvironment.iosGoogleServicesFile }),
      entitlements: {
        "aps-environment":
          appEnvironment.name === "dev" ? "development" : "production"
      },
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

export default createExpoConfig(
  process.env as Parameters<typeof createExpoConfig>[0]
);

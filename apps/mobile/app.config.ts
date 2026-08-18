// Read environment data straight from JSON. The Expo config loader transpiles
// only this file and then require()s its imports as plain JS, so it cannot
// resolve a sibling .ts module — JSON is resolvable by both the config loader
// and the typed runtime layer (src/mobileEnvironment.ts), keeping one data
// source. Do NOT import ./src/mobileEnvironment here.
import environments from "./src/mobileEnvironments.json";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

// Build time refuses to guess. Mapping an unset or unrecognised KANNA_APP_ENV
// to production once produced a staging native shell wrapping production JS,
// and the only symptom was an authentication failure indistinguishable from a
// wrong password. Naming an environment explicitly is always honoured; only
// guessing is refused. The runtime resolver in src/mobileEnvironment.ts still
// falls back, because there it reads a value a build already baked in.
//
// "production" is an accepted alias for "prod" because kd emits exactly that:
// see resolveMobileAppEnv in tools/kd/src/runtime/mobile-device.ts, which
// carries the same alias, and productionMobileEnv in
// tools/kd/src/runtime/dev-plan.ts, which produces it.
export function resolveMobileAppEnvironment(
  rawName: string | undefined
): MobileAppEnvironment {
  const name = rawName?.trim();
  if (name === "dev" || name === "staging" || name === "prod") {
    return registry[name];
  }
  if (name === "production") {
    return registry.prod;
  }

  throw new Error(
    `KANNA_APP_ENV must be one of dev, staging, prod (or the alias production); got ${
      rawName === undefined ? "unset" : JSON.stringify(rawName)
    }. Build through kd (\`./kd dev up --mobile\`, \`./kd mobile run --device\`, ` +
      "`./kd mobile publish`), which always sets it."
  );
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
      /**
       * Provenance baked in at prebuild by `kd mobile archive`/`kd mobile
       * publish`. An IPA in Apple's hands cannot be queried the way the relay's
       * /health can, so the binary has to describe itself. Absent for builds
       * that did not name a source ref.
       */
      source?: {
        ref: string;
        commit: string;
      };
    };
  };
}

const OTA_MANIFEST_PATH = "/ota/manifest";
const OTA_CODE_SIGNING_CERTIFICATE = "./certs/ota-codesign.pem";
const OTA_CODE_SIGNING_KEY_ID = "kanna-mobile-ota-v1";

const NATIVE_MARKETING_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readVersionFile(candidate: string, mobile: boolean): string {
  const version = readFileSync(candidate, "utf8").trim();
  const source = mobile ? "Mobile" : "Repository";
  if (!version) {
    throw new Error(
      `${source} VERSION file at ${candidate} is empty; fix it or set KANNA_APP_VERSION explicitly.`
    );
  }
  if (mobile && !NATIVE_MARKETING_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Mobile VERSION file at ${candidate} is malformed; expected X.Y.Z, got ${JSON.stringify(version)}. Fix it or set KANNA_APP_VERSION explicitly.`
    );
  }
  return version;
}

// The native CFBundleShortVersionString source of truth. An explicit
// KANNA_APP_VERSION diagnostic/build override wins. Every canonical mobile
// build otherwise prefers apps/mobile/VERSION, independently of the desktop
// release series, with the repository VERSION retained as a compatibility
// fallback. Keep walking upward so config loading works from the repo root or
// a nested mobile directory.
export function readRepoVersion(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    const mobileCandidate = join(dir, "apps", "mobile", "VERSION");
    if (existsSync(mobileCandidate)) {
      return readVersionFile(mobileCandidate, true);
    }

    const candidate = join(dir, "VERSION");
    if (existsSync(candidate)) {
      const isMobileVersion =
        basename(dir) === "mobile" && basename(dirname(dir)) === "apps";
      return readVersionFile(candidate, isMobileVersion);
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
    KANNA_SOURCE_REF?: string;
    KANNA_SOURCE_COMMIT?: string;
  },
  readNativeVersionFallback: () => string = readRepoVersion
): ExpoConfig {
  const appEnvironment = resolveMobileAppEnvironment(env.KANNA_APP_ENV);
  const explicitVersion = env.KANNA_APP_VERSION?.trim();
  const version = explicitVersion || readNativeVersionFallback();
  const buildNumber = env.KANNA_IOS_BUILD_NUMBER?.trim();
  const sourceRef = env.KANNA_SOURCE_REF?.trim();
  const sourceCommit = env.KANNA_SOURCE_COMMIT?.trim();
  const source =
    sourceRef && sourceCommit ? { ref: sourceRef, commit: sourceCommit } : undefined;
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
      appleTeamId: "EA4J68749Z",
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
        },
        ...(source ? { source } : {})
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

// Exported as a function, not an object: resolution now throws on an unset or
// unrecognised KANNA_APP_ENV, and a module that throws at import time cannot be
// imported by tests or by the e2e helpers that read a named export from here.
// Expo calls this during config resolution, which is where the throw belongs.
export default (): ExpoConfig =>
  createExpoConfig(process.env as Parameters<typeof createExpoConfig>[0]);

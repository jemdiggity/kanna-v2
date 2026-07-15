import { describe, expect, it } from "vitest";
import {
  createExpoConfig,
  resolveMobileAppEnvironment
} from "../app.config";

describe("mobile app config", () => {
  it("uses production identity by default", () => {
    const config = createExpoConfig({});

    expect(config.name).toBe("Kanna");
    expect(config.scheme).toBe("kanna");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app");
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.production.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "prod",
      firebase: { projectId: "kanna-build" },
      relayUrl: "wss://relay.kanna.build",
      ota: {
        channel: "production",
        manifestUrl: "https://relay.kanna.build/ota/manifest"
      },
      runtimeVersion: "2.0.0"
    });
    expect(config.runtimeVersion).toBe("2.0.0");
    expect(config.updates).toMatchObject({
      url: "https://relay.kanna.build/ota/manifest",
      requestHeaders: { "expo-channel-name": "production" },
      checkAutomatically: "NEVER",
      codeSigningCertificate: "./certs/ota-codesign.pem",
      codeSigningMetadata: {
        keyid: "kanna-mobile-ota-v1",
        alg: "rsa-v1_5-sha256"
      }
    });
  });

  it("applies explicit App Store version and iOS build number when provided", () => {
    const config = createExpoConfig({
      KANNA_APP_ENV: "prod",
      KANNA_APP_VERSION: "1.2.3",
      KANNA_IOS_BUILD_NUMBER: "45"
    });

    expect(config.version).toBe("1.2.3");
    expect(config.ios?.buildNumber).toBe("45");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app");
    expect(config.ios?.appleTeamId).toBe("GY3LFAA59P");
  });

  it("produces the dev identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" });

    expect(config.name).toBe("Kanna Dev");
    expect(config.scheme).toBe("kanna-dev");
    expect(config.plugins).toContainEqual([
      "./plugins/withKannaNativeIdentity",
      {
        displayName: "Kanna Dev",
        iosBundleId: "build.kanna.app.dev"
      }
    ]);
    expect(config.plugins).toContain("expo-font");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app.dev");
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.production.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "dev",
      firebase: { projectId: "kanna-local" },
      relayUrl: "ws://127.0.0.1:9080",
      ota: {
        channel: null,
        manifestUrl: null
      },
      runtimeVersion: "2.0.0"
    });
    expect(config.runtimeVersion).toBe("2.0.0");
    expect(config.updates).toBeUndefined();
  });

  it("produces the staging identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "staging" });

    expect(config.name).toBe("Kanna Staging");
    expect(config.scheme).toBe("kanna-staging");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app.staging");
    expect(config.plugins).toContainEqual([
      "./plugins/withKannaNativeIdentity",
      {
        displayName: "Kanna Staging",
        iosBundleId: "build.kanna.app.staging"
      }
    ]);
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.staging.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "staging",
      firebase: { projectId: "kanna-staging" },
      relayUrl: "wss://relay-staging.kanna.build",
      ota: {
        channel: "staging",
        manifestUrl: "https://relay-staging.kanna.build/ota/manifest"
      },
      runtimeVersion: "2.0.0"
    });
    expect(config.runtimeVersion).toBe("2.0.0");
    expect(config.updates).toMatchObject({
      url: "https://relay-staging.kanna.build/ota/manifest",
      requestHeaders: { "expo-channel-name": "staging" }
    });
  });

  it("falls back to prod for unknown KANNA_APP_ENV values", () => {
    expect(resolveMobileAppEnvironment("qa").name).toBe("prod");
  });
});

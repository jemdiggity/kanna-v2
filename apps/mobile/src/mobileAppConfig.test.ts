import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExpoConfig,
  readRepoVersion,
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
    expect(config.plugins).toContain("./plugins/withKannaFirebasePodfile");
    expect(config.plugins).toContain("./plugins/withKannaFirebaseMessaging");
    expect(config.ios?.entitlements).toEqual({
      "aps-environment": "production"
    });
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "prod",
      firebase: { projectId: "kanna-build" },
      relayUrl: "wss://relay.kanna.build",
      ota: {
        channel: "production",
        manifestUrl: "https://relay.kanna.build/ota/manifest"
      },
      runtimeVersion: "2.1.4"
    });
    expect(config.runtimeVersion).toBe("2.1.4");
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
    expect(config.plugins).toContain("./plugins/withKannaFirebasePodfile");
    expect(config.plugins).not.toContain(
      "./plugins/withKannaFirebaseMessaging"
    );
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app.dev");
    expect(config.ios?.googleServicesFile).toBeUndefined();
    expect(config.ios?.entitlements).toEqual({
      "aps-environment": "development"
    });
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "dev",
      firebase: { projectId: "kanna-local" },
      relayUrl: "ws://127.0.0.1:9080",
      ota: {
        channel: null,
        manifestUrl: null
      },
      runtimeVersion: "2.1.4"
    });
    expect(config.runtimeVersion).toBe("2.1.4");
    expect(config.updates).toBeUndefined();
  });

  it("produces the staging identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({
      KANNA_APP_ENV: "staging",
      KANNA_APP_VERSION: "0.1.0"
    });

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
    expect(config.plugins).toContain("./plugins/withKannaFirebasePodfile");
    expect(config.plugins).toContain("./plugins/withKannaFirebaseMessaging");
    expect(config.ios?.entitlements).toEqual({
      "aps-environment": "production"
    });
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "staging",
      firebase: { projectId: "kanna-staging" },
      relayUrl: "wss://relay-staging.kanna.build",
      ota: {
        channel: "staging",
        manifestUrl: "https://relay-staging.kanna.build/ota/manifest"
      },
      runtimeVersion: "2.1.4"
    });
    expect(config.runtimeVersion).toBe("2.1.4");
    expect(config.updates).toMatchObject({
      url: "https://relay-staging.kanna.build/ota/manifest",
      requestHeaders: { "expo-channel-name": "staging" }
    });
  });

  it("falls back to prod for unknown KANNA_APP_ENV values", () => {
    expect(resolveMobileAppEnvironment("qa").name).toBe("prod");
  });

  it("defaults the dev native version from the repository VERSION source", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" }, () => "3.4.5");

    expect(config.version).toBe("3.4.5");
    expect(config.ios?.buildNumber).toBeUndefined();
  });

  it("prefers an explicit staging KANNA_APP_VERSION over the repository VERSION", () => {
    const config = createExpoConfig(
      {
        KANNA_APP_ENV: "staging",
        KANNA_APP_VERSION: "1.2.3"
      },
      () => {
        throw new Error("must not read the repository VERSION when overridden");
      }
    );

    expect(config.version).toBe("1.2.3");
  });

  it("treats a blank KANNA_APP_VERSION as unset", () => {
    const config = createExpoConfig({ KANNA_APP_VERSION: "   " }, () => "3.4.5");

    expect(config.version).toBe("3.4.5");
  });

  it("embeds the real repository VERSION for canonical builds", () => {
    const repoVersion = readRepoVersion();

    expect(repoVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(repoVersion).not.toBe("0.0.0");
    expect(createExpoConfig({}).version).toBe(repoVersion);
  });

  it("finds the VERSION file by walking up from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-"));
    await writeFile(join(root, "VERSION"), "7.8.9\n");
    const nested = join(root, "apps", "mobile");
    await mkdir(nested, { recursive: true });

    expect(readRepoVersion(nested)).toBe("7.8.9");
  });

  it("fails loudly when the VERSION file is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-empty-"));
    await writeFile(join(root, "VERSION"), "  \n");

    expect(() => readRepoVersion(root)).toThrow(/is empty/);
  });

  it("configures QR-only camera access and a new native runtime", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" });

    expect(config.plugins).toContainEqual([
      "expo-camera",
      {
        cameraPermission: "Allow Kanna to scan machine pairing QR codes.",
        barcodeScannerEnabled: true,
        recordAudioAndroid: false
      }
    ]);
    expect(config.runtimeVersion).toBe("2.1.4");
  });
});

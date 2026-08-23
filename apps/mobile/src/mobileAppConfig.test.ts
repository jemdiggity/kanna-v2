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
  it("produces the production identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "prod" });

    expect(config.version).toBe("1.0.0");
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
      runtimeVersion: "2.2.2"
    });
    expect(config.runtimeVersion).toBe("2.2.2");
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
    expect(config.ios?.appleTeamId).toBe("EA4J68749Z");
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
      runtimeVersion: "2.2.2"
    });
    expect(config.runtimeVersion).toBe("2.2.2");
    expect(config.updates).toBeUndefined();
  });

  it("produces the staging identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({
      KANNA_APP_ENV: "staging"
    });

    expect(config.version).toBe("1.0.0");
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
      runtimeVersion: "2.2.2"
    });
    expect(config.runtimeVersion).toBe("2.2.2");
    expect(config.updates).toMatchObject({
      url: "https://relay-staging.kanna.build/ota/manifest",
      requestHeaders: { "expo-channel-name": "staging" }
    });
  });

  it("accepts \"production\", the value kd itself emits for prod", () => {
    // productionMobileEnv in tools/kd/src/runtime/dev-plan.ts sets
    // KANNA_APP_ENV='production', and resolveMobileAppEnv in
    // tools/kd/src/runtime/mobile-device.ts carries the same alias. Rejecting
    // it would break `kd mobile up --production` and `kd mobile run --device
    // --production`.
    expect(resolveMobileAppEnvironment("production").name).toBe("prod");

    const config = createExpoConfig({ KANNA_APP_ENV: "production" });
    expect(config.name).toBe("Kanna");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app");
    expect(config.extra.kanna.appEnv).toBe("prod");
    expect(config.extra.kanna.ota.channel).toBe("production");
  });

  it("refuses to guess an environment rather than silently shipping production", () => {
    // A staging native shell wrapping production JS fails only at
    // authentication, with a message indistinguishable from a wrong password.
    expect(() => resolveMobileAppEnvironment("qa")).toThrow(
      /KANNA_APP_ENV must be one of dev, staging, prod/
    );
    expect(() => resolveMobileAppEnvironment("prd")).toThrow(/KANNA_APP_ENV/);
    expect(() => resolveMobileAppEnvironment("qa")).toThrow(/"qa"/);
    expect(() => resolveMobileAppEnvironment(undefined)).toThrow(/got unset/);
    expect(() => resolveMobileAppEnvironment("   ")).toThrow(/KANNA_APP_ENV/);
    expect(() => createExpoConfig({})).toThrow(/KANNA_APP_ENV must be one of/);
  });

  it("bakes the source ref and commit into extra.kanna for a named build", () => {
    const config = createExpoConfig({
      KANNA_APP_ENV: "prod",
      KANNA_SOURCE_REF: "release/0.2",
      KANNA_SOURCE_COMMIT: "9c8b7a6d5e4f30210123456789abcdef01234567"
    });

    expect(config.extra.kanna.source).toEqual({
      ref: "release/0.2",
      commit: "9c8b7a6d5e4f30210123456789abcdef01234567"
    });
  });

  it("omits the source record when the build did not name one", () => {
    expect(createExpoConfig({ KANNA_APP_ENV: "prod" }).extra.kanna.source).toBeUndefined();
    expect(
      createExpoConfig({ KANNA_APP_ENV: "prod", KANNA_SOURCE_REF: "release/0.2" }).extra.kanna
        .source
    ).toBeUndefined();
  });

  it("defaults the dev native version from the injected fallback source", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" }, () => "3.4.5");

    expect(config.version).toBe("3.4.5");
    expect(config.ios?.buildNumber).toBeUndefined();
  });

  it("treats KANNA_APP_VERSION as an explicit diagnostic/build override", () => {
    const config = createExpoConfig(
      {
        KANNA_APP_ENV: "staging",
        KANNA_APP_VERSION: "1.2.3"
      },
      () => {
        throw new Error("must not read a checked-in VERSION when overridden");
      }
    );

    expect(config.version).toBe("1.2.3");
  });

  it("treats a blank KANNA_APP_VERSION as unset", () => {
    const config = createExpoConfig(
      { KANNA_APP_ENV: "prod", KANNA_APP_VERSION: "   " },
      () => "3.4.5"
    );

    expect(config.version).toBe("3.4.5");
  });

  it("embeds the checked-in mobile VERSION for canonical builds", () => {
    const mobileVersion = readRepoVersion();

    expect(mobileVersion).toBe("1.0.0");
    expect(createExpoConfig({ KANNA_APP_ENV: "prod" }).version).toBe(mobileVersion);
  });

  it("prefers apps/mobile/VERSION while walking up from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-"));
    await writeFile(join(root, "VERSION"), "7.8.9\n");
    const nested = join(root, "apps", "mobile");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "VERSION"), "1.2.3\n");

    expect(readRepoVersion(nested)).toBe("1.2.3");
    expect(readRepoVersion(root)).toBe("1.2.3");
  });

  it("falls back to the repository VERSION while walking up", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-fallback-"));
    await writeFile(join(root, "VERSION"), "7.8.9\n");
    const nested = join(root, "apps", "mobile", "src");
    await mkdir(nested, { recursive: true });

    expect(readRepoVersion(nested)).toBe("7.8.9");
  });

  it("fails loudly with the path when apps/mobile/VERSION is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-empty-"));
    const mobileDir = join(root, "apps", "mobile");
    const mobileVersionPath = join(mobileDir, "VERSION");
    await mkdir(mobileDir, { recursive: true });
    await writeFile(join(root, "VERSION"), "7.8.9\n");
    await writeFile(mobileVersionPath, "  \n");

    expect(() => readRepoVersion(root)).toThrow(mobileVersionPath);
    expect(() => readRepoVersion(root)).toThrow(/is empty/);
  });

  it("fails loudly with the path when apps/mobile/VERSION is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-version-malformed-"));
    const mobileDir = join(root, "apps", "mobile");
    const mobileVersionPath = join(mobileDir, "VERSION");
    await mkdir(mobileDir, { recursive: true });
    await writeFile(join(root, "VERSION"), "7.8.9\n");
    await writeFile(mobileVersionPath, "not-a-version\n");

    expect(() => readRepoVersion(root)).toThrow(mobileVersionPath);
    expect(() => readRepoVersion(root)).toThrow(/is malformed/);
  });

  it("keeps the existing loud failure for an empty repository VERSION fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-repo-version-empty-"));
    await writeFile(join(root, "VERSION"), "  \n");

    expect(() => readRepoVersion(root)).toThrow(/is empty/);
  });

  const CAMERA_PERMISSION =
    "Allow Kanna to scan machine pairing QR codes and to take a photo to send to your agent.";

  it("configures audio-free camera access and a new native runtime", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" });

    expect(config.plugins).toContainEqual([
      "expo-camera",
      {
        cameraPermission: CAMERA_PERMISSION,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false
      }
    ]);
    expect(config.runtimeVersion).toBe("2.2.2");
  });

  it("declares the composer attachment permissions and captures no audio", () => {
    for (const appEnv of ["dev", "staging", "prod"] as const) {
      const config = createExpoConfig({ KANNA_APP_ENV: appEnv });

      // `microphonePermission: false` is load-bearing: unset, the image-picker
      // plugin adds RECORD_AUDIO and a microphone usage string to an app that
      // captures no audio.
      expect(config.plugins).toContainEqual([
        "expo-image-picker",
        {
          photosPermission:
            "Allow Kanna to attach a photo to a message for your agent.",
          cameraPermission: CAMERA_PERMISSION,
          microphonePermission: false
        }
      ]);
    }
  });

  it("declares one camera purpose across both plugins that write the key", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "prod" });

    const cameraPermissions = config.plugins
      .filter((plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin)
      )
      .map(([, options]) => options.cameraPermission)
      .filter((permission) => permission !== undefined);

    expect(cameraPermissions).toEqual([CAMERA_PERMISSION, CAMERA_PERMISSION]);
  });
});

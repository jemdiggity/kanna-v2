import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractIpaApp,
  formatMobileVerifyResult,
  hashFile,
  parseProvisioningProfile,
  parseSipsProperties,
  readEmbeddedSource,
  verifyExtractedApp,
  verifyMobileIpa,
  type MobileVerifyCheck
} from "./mobile-verify";
import type { CommandRunner } from "./process";

const BUNDLE_ID = "build.kanna.app";
const VERSION = "1.0.0";
const BUILD_NUMBER = "3";

interface AppFixtureOptions {
  authority?: string;
  provisionedDevices?: boolean;
  profileAppIdentifier?: string;
  infoPlist?: Record<string, unknown>;
  appConfig?: unknown;
  omitAppConfig?: boolean;
  omitIcon?: boolean;
  compiledIcon?: boolean;
  omitProfile?: boolean;
  hasAlpha?: string;
  iconSize?: string;
}

/**
 * Write a `.app` fixture on disk and a runner that answers the macOS tools the
 * checks shell out to. Everything the checks read from the filesystem is real;
 * only codesign/security/plutil/sips are stubbed.
 */
async function appFixture(options: AppFixtureOptions = {}): Promise<{
  appPath: string;
  runner: CommandRunner;
  calls: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "kanna-verify-"));
  const appPath = join(root, "Payload", "Kanna.app");
  await mkdir(join(appPath, "EXConstants.bundle"), { recursive: true });
  if (!options.omitProfile) {
    await writeFile(join(appPath, "embedded.mobileprovision"), "cms-envelope");
  }
  if (!options.omitIcon) {
    await writeFile(join(appPath, "AppIcon~ios-marketing.png"), "png");
  }
  if (options.compiledIcon) {
    await writeFile(join(appPath, "Assets.car"), "compiled-assets");
  }
  if (!options.omitAppConfig) {
    await writeFile(
      join(appPath, "EXConstants.bundle", "app.config"),
      JSON.stringify(
        options.appConfig ?? {
          extra: {
            kanna: {
              appEnv: "prod",
              ota: { channel: "production" },
              source: { ref: "release/0.2", commit: "9c8b7a6d5e4f30210123456789abcdef01234567" }
            }
          }
        }
      )
    );
  }
  const infoPlist = options.infoPlist ?? {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: BUILD_NUMBER,
    EXUpdatesRequestHeaders: { "expo-channel-name": "production" }
  };
  await writeFile(join(appPath, "Info.plist"), "<plist/>");

  const profile: Record<string, unknown> = {
    Name: "Kanna App Store",
    Entitlements: {
      "application-identifier": options.profileAppIdentifier ?? `EA4J68749Z.${BUNDLE_ID}`
    }
  };
  if (options.provisionedDevices) {
    profile.ProvisionedDevices = ["00008030-000123456789002E"];
  }

  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codesign") {
        return {
          exitCode: 0,
          stdout: "",
          // codesign reports to stderr.
          stderr: [
            `Identifier=${BUNDLE_ID}`,
            `Authority=${options.authority ?? "Apple Distribution: Kanna (EA4J68749Z)"}`,
            "Authority=Apple Worldwide Developer Relations Certification Authority",
            "Authority=Apple Root CA"
          ].join("\n")
        };
      }
      if (command === "security" && args[0] === "cms") {
        return { exitCode: 0, stdout: "<plist/>", stderr: "" };
      }
      if (command === "plutil") {
        if (args[0] === "-extract") {
          if (args[1] === "Name") {
            return { exitCode: 0, stdout: `${profile.Name}\n`, stderr: "" };
          }
          if (args[1] === "Entitlements.application-identifier") {
            return {
              exitCode: 0,
              stdout: `${(profile.Entitlements as Record<string, unknown>)["application-identifier"]}\n`,
              stderr: ""
            };
          }
          if (args[1] === "ProvisionedDevices") {
            return options.provisionedDevices
              ? { exitCode: 0, stdout: JSON.stringify(profile.ProvisionedDevices), stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing" };
          }
        }
        // stdin form is the provisioning profile; the file form is Info.plist.
        const isStdin = args.includes("-");
        const target = isStdin && args[args.length - 1] === "-" ? profile : infoPlist;
        return { exitCode: 0, stdout: JSON.stringify(target), stderr: "" };
      }
      if (command === "sips") {
        return {
          exitCode: 0,
          stdout: [
            args[args.length - 1],
            `  hasAlpha: ${options.hasAlpha ?? "no"}`,
            `  pixelWidth: ${options.iconSize ?? "1024"}`,
            `  pixelHeight: ${options.iconSize ?? "1024"}`
          ].join("\n"),
          stderr: ""
        };
      }
      if (command === "xcrun" && args[0] === "assetutil") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: "AppIcon",
              RenditionName: "App-Icon-1024x1024@1x.png",
              PixelWidth: Number(options.iconSize ?? "1024"),
              PixelHeight: Number(options.iconSize ?? "1024"),
              Opaque: options.hasAlpha !== "yes"
            }
          ]),
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
  return { appPath, runner, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function check(checks: MobileVerifyCheck[], name: string): MobileVerifyCheck {
  const match = checks.find((entry) => entry.name === name);
  if (!match) throw new Error(`no check named ${name}; got ${checks.map((c) => c.name).join(", ")}`);
  return match;
}

const EXPECTED = { bundleId: BUNDLE_ID, version: VERSION, buildNumber: BUILD_NUMBER };

describe("kd mobile verify", () => {
  it("passes every check for a correctly built production IPA", async () => {
    const fixture = await appFixture();
    try {
      const checks = await verifyExtractedApp({
        appPath: fixture.appPath,
        expected: EXPECTED,
        runner: fixture.runner
      });

      expect(checks.map((entry) => entry.name)).toEqual([
        "codesign authority",
        "provisioning profile",
        "plan/IPA agreement",
        "1024 marketing icon",
        "embedded environment"
      ]);
      expect(checks.every((entry) => entry.status === "PASS")).toBe(true);
      expect(check(checks, "embedded environment").detail).toContain("built from release/0.2");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the signing authority is not Apple Distribution", async () => {
    const fixture = await appFixture({
      authority: "Apple Development: Someone (ABC123)"
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "codesign authority"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("Apple Development");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the embedded profile lists provisioned devices", async () => {
    const fixture = await appFixture({ provisionedDevices: true });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "provisioning profile"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("ProvisionedDevices");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the embedded profile is for another app id", async () => {
    const fixture = await appFixture({
      profileAppIdentifier: "EA4J68749Z.build.kanna.app.staging"
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "provisioning profile"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("build.kanna.app.staging");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the profile is missing entirely", async () => {
    const fixture = await appFixture({ omitProfile: true });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "provisioning profile"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("no embedded.mobileprovision");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the IPA disagrees with the plan on version, build, or bundle id", async () => {
    const fixture = await appFixture({
      infoPlist: {
        CFBundleIdentifier: "build.kanna.app.staging",
        CFBundleShortVersionString: "0.9.9",
        CFBundleVersion: "2"
      }
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "plan/IPA agreement"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("bundle id build.kanna.app.staging != build.kanna.app");
      expect(result.detail).toContain("version 0.9.9 != 1.0.0");
      expect(result.detail).toContain("build number 2 != 3");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports the build number without asserting it when none was given", async () => {
    const fixture = await appFixture();
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: { bundleId: BUNDLE_ID, version: VERSION },
          runner: fixture.runner
        }),
        "plan/IPA agreement"
      );

      expect(result.status).toBe("PASS");
      expect(result.detail).toContain("not asserted");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the 1024 icon carries an alpha channel", async () => {
    const fixture = await appFixture({ hasAlpha: "yes" });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "1024 marketing icon"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("alpha channel");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the marketing icon is not 1024x1024 or is missing", async () => {
    const wrongSize = await appFixture({ iconSize: "512" });
    try {
      expect(
        check(
          await verifyExtractedApp({
            appPath: wrongSize.appPath,
            expected: EXPECTED,
            runner: wrongSize.runner
          }),
          "1024 marketing icon"
        ).detail
      ).toContain("512x512");
    } finally {
      await wrongSize.cleanup();
    }

    const missing = await appFixture({ omitIcon: true });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: missing.appPath,
          expected: EXPECTED,
          runner: missing.runner
        }),
        "1024 marketing icon"
      );
      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("no marketing icon");
    } finally {
      await missing.cleanup();
    }
  });

  it("accepts an opaque 1024 marketing icon compiled into Assets.car", async () => {
    const fixture = await appFixture({ omitIcon: true, compiledIcon: true });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "1024 marketing icon"
      );
      expect(result.status).toBe("PASS");
      expect(result.detail).toContain("App-Icon-1024x1024@1x.png");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the embedded JS is not the production environment", async () => {
    const staging = await appFixture({
      appConfig: { extra: { kanna: { appEnv: "staging", ota: { channel: "staging" } } } }
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: staging.appPath,
          expected: EXPECTED,
          runner: staging.runner
        }),
        "embedded environment"
      );
      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain('appEnv "staging"');
    } finally {
      await staging.cleanup();
    }
  });

  it("fails when the native shell and the JS bundle disagree on the OTA channel", async () => {
    // This is the pairing that produced an authentication failure
    // indistinguishable from a wrong password during the 1.0.0 release.
    const fixture = await appFixture({
      infoPlist: {
        CFBundleIdentifier: BUNDLE_ID,
        CFBundleShortVersionString: VERSION,
        CFBundleVersion: BUILD_NUMBER,
        EXUpdatesRequestHeaders: { "expo-channel-name": "staging" }
      }
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "embedded environment"
      );
      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("different environments");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the IPA was built from a different commit than the publish resolved", async () => {
    // Reuse keys on version and build number, which a rerun at another commit
    // keeps, so this is the only thing in the binary that catches it.
    const fixture = await appFixture();
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: { ...EXPECTED, sourceCommit: "1".repeat(40) },
          runner: fixture.runner
        }),
        "embedded environment"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("built from release/0.2 9c8b7a6d5e4f");
      expect(result.detail).toContain("this publish resolved 111111111111");
      expect(result.detail).toContain("--force-rebuild");
    } finally {
      await fixture.cleanup();
    }
  });

  it("passes when the IPA was built from the commit the publish resolved", async () => {
    const fixture = await appFixture();
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: {
            ...EXPECTED,
            sourceCommit: "9c8b7a6d5e4f30210123456789abcdef01234567"
          },
          runner: fixture.runner
        }),
        "embedded environment"
      );

      expect(result.status).toBe("PASS");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when a commit is expected but the IPA bakes none in", async () => {
    const fixture = await appFixture({
      appConfig: { extra: { kanna: { appEnv: "prod", ota: { channel: "production" } } } }
    });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: { ...EXPECTED, sourceCommit: "1".repeat(40) },
          runner: fixture.runner
        }),
        "embedded environment"
      );

      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("bakes in no source commit");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails when the embedded app config is missing rather than assuming production", async () => {
    const fixture = await appFixture({ omitAppConfig: true });
    try {
      const result = check(
        await verifyExtractedApp({
          appPath: fixture.appPath,
          expected: EXPECTED,
          runner: fixture.runner
        }),
        "embedded environment"
      );
      expect(result.status).toBe("FAIL");
      expect(result.detail).toContain("no embedded app.config");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("IPA extraction and hashing", () => {
  it("hashes the exact bytes that go to Apple", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-hash-"));
    const path = join(root, "Kanna.ipa");
    await writeFile(path, "kanna");
    try {
      expect(await hashFile(path)).toBe(
        "44e21fedfa17298ed6daba72bd5066075b49230e002e55e5bf4c025736e19682"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an IPA that is not an iOS app archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-extract-"));
    const ipaPath = join(root, "Kanna.ipa");
    await writeFile(ipaPath, "zip");
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    try {
      await expect(
        extractIpaApp({ ipaPath, runner, extractDir: join(root, "extract") })
      ).rejects.toThrow("no Payload directory");
      await expect(
        extractIpaApp({ ipaPath: join(root, "missing.ipa"), runner })
      ).rejects.toThrow("No IPA at");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a whole IPA and reports its sha256", async () => {
    const fixture = await appFixture();
    const root = await mkdtemp(join(tmpdir(), "kanna-ipa-"));
    const ipaPath = join(root, "Kanna.ipa");
    await writeFile(ipaPath, "ipa-bytes");
    // The fixture's .app already sits under <root>/Payload; point the
    // extraction at it and make unzip a no-op.
    const extractDir = fixture.appPath.replace(/\/Payload\/Kanna\.app$/, "");
    try {
      const result = await verifyMobileIpa({
        ipaPath,
        expected: EXPECTED,
        runner: fixture.runner,
        extractDir
      });

      expect(result.ok).toBe(true);
      expect(result.sha256).toBe(await hashFile(ipaPath));
      expect(result.appPath).toBe(fixture.appPath);
      expect(formatMobileVerifyResult(result)).toContain("All pre-upload checks passed.");
      expect(formatMobileVerifyResult(result)).toContain(result.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });
});

describe("embedded provenance", () => {
  it("reads the source the archive baked in", async () => {
    const fixture = await appFixture();
    try {
      expect(await readEmbeddedSource(fixture.appPath)).toEqual({
        ref: "release/0.2",
        commit: "9c8b7a6d5e4f30210123456789abcdef01234567"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns null when there is no embedded config to read", async () => {
    const fixture = await appFixture({ omitAppConfig: true });
    try {
      expect(await readEmbeddedSource(fixture.appPath)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("output parsers", () => {
  it("reads sips key/value output", () => {
    expect(
      parseSipsProperties("/a/AppIcon.png\n  hasAlpha: no\n  pixelWidth: 1024\n  pixelHeight: 1024")
    ).toMatchObject({ hasAlpha: "no", pixelWidth: "1024", pixelHeight: "1024" });
  });

  it("reads the provisioning profile shape", () => {
    expect(
      parseProvisioningProfile({
        Name: "Kanna App Store",
        Entitlements: { "application-identifier": "EA4J68749Z.build.kanna.app" }
      })
    ).toEqual({
      name: "Kanna App Store",
      hasProvisionedDevices: false,
      applicationIdentifier: "EA4J68749Z.build.kanna.app"
    });
    expect(parseProvisioningProfile({ ProvisionedDevices: ["a"] }).hasProvisionedDevices).toBe(true);
  });
});

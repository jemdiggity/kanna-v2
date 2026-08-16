import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli";
import {
  buildMobileIosArchivePlan,
  executeMobileIosArchiveWithContext,
  parseXcodeMajorVersion,
  type MobileIosArchivePlan
} from "./mobile-archive";
import type { CommandRunner } from "./process";

async function writeMinimalRepo(
  root: string,
  mobileVersion: string | null = "1.0.0"
): Promise<void> {
  await mkdir(join(root, "apps/mobile/src"), { recursive: true });
  await writeFile(join(root, "VERSION"), "0.0.67\n");
  if (mobileVersion !== null) {
    await writeFile(join(root, "apps/mobile/VERSION"), `${mobileVersion}\n`);
  }
  await writeFile(
    join(root, "apps/mobile/src/mobileEnvironments.json"),
    JSON.stringify({
      prod: {
        name: "prod",
        displayName: "Kanna",
        iosBundleId: "build.kanna.app",
        runtimeVersion: "1.0.0"
      }
    })
  );
}

describe("kd mobile archive", () => {
  it("parses the production archive command with build metadata", () => {
    expect(
      parseCliArgs([
        "mobile",
        "archive",
        "--production",
        "--build-number",
        "45",
        "--version",
        "1.2.3",
        "--out-dir",
        ".build/mobile-release",
        "--upload",
        "--dry-run"
      ])
    ).toEqual({
      taskId: "mobile.archive",
      input: {
        production: true,
        buildNumber: "45",
        version: "1.2.3",
        outDir: ".build/mobile-release",
        upload: true,
        dryRun: true
      }
    });
    expect(() => parseCliArgs(["mobile", "archive", "--production", "--rollback-to", "1"])).toThrow(
      "mobile archive only accepts"
    );
  });

  it("builds an archive and export plan that allows automatic provisioning updates", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-plan-"));
    await writeMinimalRepo(repoRoot);

    const plan = await buildMobileIosArchivePlan({
      repoRoot,
      buildNumber: "45",
      version: "1.2.3",
      outDir: ".build/mobile-release",
      upload: true
    });

    expect(plan).toMatchObject({
      appEnv: "prod",
      bundleId: "build.kanna.app",
      displayName: "Kanna",
      teamId: "EA4J68749Z",
      version: "1.2.3",
      buildNumber: "45",
      archivePath: join(repoRoot, ".build/mobile-release/Kanna.xcarchive"),
      exportPath: join(repoRoot, ".build/mobile-release/export"),
      ipaPath: join(repoRoot, ".build/mobile-release/export/Kanna.ipa")
    });
    expect(plan.commands.map((command) => `${command.command} ${command.args.join(" ")}`)).toEqual([
      `pnpm --dir ${repoRoot}/apps/mobile exec expo prebuild --platform ios --clean`,
      [
        "xcodebuild",
        `-workspace ${repoRoot}/apps/mobile/ios/Kanna.xcworkspace`,
        "-scheme Kanna",
        "-configuration Release",
        "-sdk iphoneos",
        "-destination generic/platform=iOS",
        `-archivePath ${repoRoot}/.build/mobile-release/Kanna.xcarchive`,
        "MARKETING_VERSION=1.2.3",
        "CURRENT_PROJECT_VERSION=45",
        "-allowProvisioningUpdates",
        "archive"
      ].join(" "),
      [
        "xcodebuild",
        "-exportArchive",
        `-archivePath ${repoRoot}/.build/mobile-release/Kanna.xcarchive`,
        `-exportPath ${repoRoot}/.build/mobile-release/export`,
        `-exportOptionsPlist ${repoRoot}/.build/mobile-release/ExportOptions.plist`,
        "-allowProvisioningUpdates"
      ].join(" "),
      `xcrun iTMSTransporter -m upload -assetFile ${repoRoot}/.build/mobile-release/export/Kanna.ipa -apiKey <APP_STORE_CONNECT_API_KEY_ID> -apiIssuer <APP_STORE_CONNECT_API_ISSUER_ID>`
    ]);
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_ENV: "prod",
      KANNA_APP_VERSION: "1.2.3",
      KANNA_IOS_BUILD_NUMBER: "45"
    });
  });

  it("requires Xcode 26 or later before executing archive commands", async () => {
    expect(parseXcodeMajorVersion("Xcode 26.0\nBuild version 17A123")).toBe(26);
    expect(parseXcodeMajorVersion("Xcode 25.4\nBuild version 16F6")).toBe(25);

    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-xcode-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 25.4\nBuild version 16F6\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, buildNumber: "45" },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("Xcode 26 or later is required");
    expect(calls).toEqual(["xcodebuild -version"]);
  });

  it("dry-runs without invoking archive or upload commands", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-dry-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
      }
    };

    const result = await executeMobileIosArchiveWithContext(
      { production: true, buildNumber: "45", dryRun: true },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Dry run: mobile production archive 1.0.0 (45)");
    const plan = result.data as MobileIosArchivePlan;
    expect(plan.version).toBe("1.0.0");
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_VERSION: "1.0.0",
      KANNA_IOS_BUILD_NUMBER: "45"
    });
    expect(calls).toEqual(["xcodebuild -version"]);
  });

  it("falls back to the repository VERSION when apps/mobile/VERSION is absent", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-fallback-"));
    await writeMinimalRepo(repoRoot, null);

    const plan = await buildMobileIosArchivePlan({
      repoRoot,
      buildNumber: "45"
    });

    expect(plan.version).toBe("0.0.67");
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_VERSION: "0.0.67"
    });
  });

  it("fails loudly when apps/mobile/VERSION is empty", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-empty-"));
    await writeMinimalRepo(repoRoot, "  ");
    const mobileVersionPath = join(repoRoot, "apps/mobile/VERSION");

    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(mobileVersionPath);
    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(/is empty/);
  });

  it("fails loudly when apps/mobile/VERSION is malformed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-malformed-"));
    await writeMinimalRepo(repoRoot, "not-a-version");
    const mobileVersionPath = join(repoRoot, "apps/mobile/VERSION");

    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(mobileVersionPath);
    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(/is malformed/);
  });
});

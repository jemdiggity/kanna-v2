import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli";
import {
  buildMobileIosArchivePlan,
  executeMobileIosArchiveWithContext,
  isUploaderUnavailable,
  parseArchiveIdentity,
  parseXcodeMajorVersion,
  type MobileIosArchivePlan
} from "./mobile-archive";
import type { CommandRunner } from "./process";

const HEAD_COMMIT = "9c8b7a6d5e4f30210123456789abcdef01234567";
const SHORT_COMMIT = HEAD_COMMIT.slice(0, 12);

/**
 * Mock runner that answers the git source-ref probes plus whatever the caller
 * stubs for the archive toolchain.
 */
function archiveRunner(options: {
  calls?: string[];
  status?: string;
  xcodeVersion?: string;
} = {}): CommandRunner {
  const calls = options.calls ?? [];
  return {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: options.status ?? "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
      }
      if (command === "xcodebuild" && args[0] === "-version") {
        return {
          exitCode: 0,
          stdout: options.xcodeVersion ?? "Xcode 26.0\nBuild version 17A123\n",
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

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
        "--ref",
        "release/0.2",
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
        ref: "release/0.2",
        buildNumber: "45",
        version: "1.2.3",
        outDir: ".build/mobile-release",
        upload: true,
        dryRun: true,
        forceRebuild: false
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
      `xcrun altool --upload-app -f ${repoRoot}/.build/mobile-release/export/Kanna.ipa -t ios --apiKey <APP_STORE_CONNECT_API_KEY_ID> --apiIssuer <APP_STORE_CONNECT_API_ISSUER_ID>`
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
    const runner = archiveRunner({ calls, xcodeVersion: "Xcode 25.4\nBuild version 16F6\n" });

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "45" },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("Xcode 26 or later is required");
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --verify --quiet HEAD^{commit}",
      "git rev-parse --verify --quiet release/0.2^{commit}",
      "xcodebuild -version"
    ]);
  });

  it("requires an explicit --ref and a clean worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-ref-"));
    await writeMinimalRepo(repoRoot);

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, buildNumber: "45", dryRun: true },
        { repoRoot, env: {}, runner: archiveRunner() }
      )
    ).rejects.toThrow("mobile archive --production requires --ref <branch|tag|sha>");

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "45", dryRun: true },
        { repoRoot, env: {}, runner: archiveRunner({ status: " M apps/mobile/app.json\n" }) }
      )
    ).rejects.toThrow("Refusing to run mobile archive from a dirty git worktree");
  });

  it("dry-runs without invoking archive or upload commands", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-dry-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner = archiveRunner({ calls });

    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "45", dryRun: true },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Dry run: mobile production archive 1.0.0 (45)");
    expect(result.message).toContain(`Source: release/0.2 (${SHORT_COMMIT})`);
    const plan = result.data as MobileIosArchivePlan;
    expect(plan.source).toEqual({ ref: "release/0.2", commit: HEAD_COMMIT, shortCommit: SHORT_COMMIT });
    expect(plan.version).toBe("1.0.0");
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_VERSION: "1.0.0",
      KANNA_IOS_BUILD_NUMBER: "45"
    });
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --verify --quiet HEAD^{commit}",
      "git rev-parse --verify --quiet release/0.2^{commit}",
      "xcodebuild -version"
    ]);
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

  // --- only build when required -------------------------------------------

  async function seedArtifacts(
    repoRoot: string,
    version: string,
    buildNumber: string
  ): Promise<void> {
    const outDir = join(repoRoot, ".build/mobile/ios-production");
    await mkdir(join(outDir, "Kanna.xcarchive"), { recursive: true });
    await mkdir(join(outDir, "export"), { recursive: true });
    await writeFile(join(outDir, "export/Kanna.ipa"), "not-a-real-ipa");
    await writeFile(
      join(outDir, "Kanna.xcarchive/Info.plist"),
      `<plist><dict><key>ApplicationProperties</key><dict>` +
        `<key>CFBundleShortVersionString</key><string>${version}</string>` +
        `<key>CFBundleVersion</key><string>${buildNumber}</string>` +
        `</dict></dict></plist>`
    );
  }

  function reuseArchiveRunner(calls: string[], identity: { version: string; buildNumber: string } | null): CommandRunner {
    return {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 0, stdout: "/Applications/Xcode.app/Contents/Developer/usr/bin/altool", stderr: "" };
        }
        if (command === "plutil") {
          if (!identity) return { exitCode: 1, stdout: "", stderr: "unreadable" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ApplicationProperties: {
                CFBundleShortVersionString: identity.version,
                CFBundleVersion: identity.buildNumber
              }
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
  }

  it("reuses a matching archive instead of rebuilding", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-reuse-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Reused existing mobile production archive 1.0.0 (7)");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(false);
    expect(calls.some((call) => call.startsWith("xcodebuild -workspace"))).toBe(false);
    expect(calls.some((call) => call.includes("-exportArchive"))).toBe(false);
  });

  it("rebuilds when the existing archive is a different build number", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-stale-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "6");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "6" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Built mobile production archive");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("rebuilds when no artifacts exist", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-fresh-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, null) }
    );
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("rebuilds a matching archive when --force-rebuild is passed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-force-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7", forceRebuild: true },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Built mobile production archive");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("fails before building when the uploader is unavailable for --upload", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-notransporter-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 1, stdout: "", stderr: "xcrun: error: unable to find utility \"altool\"" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "7", upload: true },
        {
          repoRoot,
          env: {
            APP_STORE_CONNECT_API_KEY_ID: "KEY",
            APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER"
          },
          runner
        }
      )
    ).rejects.toThrow("needs altool");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(false);
  });

  it("detects a missing uploader", () => {
    expect(isUploaderUnavailable("", 'xcrun: error: unable to find utility "altool"')).toBe(true);
    expect(isUploaderUnavailable("/Applications/Xcode.app/.../altool", "")).toBe(false);
  });

  it("uploads with altool rather than iTMSTransporter", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-uploader-"));
    await writeMinimalRepo(repoRoot);
    const plan = await buildMobileIosArchivePlan({ repoRoot, buildNumber: "3", upload: true });
    const upload = plan.commands.find((command) => command.kind === "upload");
    expect(upload?.args[0]).toBe("altool");
    expect(upload?.args).toContain("--upload-app");
    expect(plan.commands.some((command) => command.args.includes("iTMSTransporter"))).toBe(false);
  });

  it("parses archive identity from plist json", () => {
    expect(
      parseArchiveIdentity(
        JSON.stringify({
          ApplicationProperties: { CFBundleShortVersionString: "1.2.3", CFBundleVersion: "9" }
        })
      )
    ).toEqual({ version: "1.2.3", buildNumber: "9" });
    expect(parseArchiveIdentity("not json")).toBeNull();
    expect(parseArchiveIdentity(JSON.stringify({}))).toBeNull();
  });

});

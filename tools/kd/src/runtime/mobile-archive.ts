import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CommandRunner } from "./process";

export interface MobileIosArchiveInput {
  production: boolean;
  dryRun?: boolean;
  upload?: boolean;
  buildNumber?: string;
  version?: string;
  outDir?: string;
}

export interface MobileIosArchiveContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface MobileIosArchiveCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
}

export interface MobileIosArchivePlan {
  appEnv: "prod";
  bundleId: string;
  displayName: string;
  teamId: string;
  version: string;
  buildNumber: string;
  outDir: string;
  archivePath: string;
  exportOptionsPlistPath: string;
  exportPath: string;
  ipaPath: string;
  upload: boolean;
  exportOptionsPlist: string;
  commands: MobileIosArchiveCommand[];
}

interface MobileEnvironmentRecord {
  displayName?: string;
  iosBundleId?: string;
}

const APP_ENV = "prod";
const APPLE_TEAM_ID = "EA4J68749Z";
const XCODE_SCHEME = "Kanna";
const UPLOAD_API_KEY_PLACEHOLDER = "<APP_STORE_CONNECT_API_KEY_ID>";
const UPLOAD_API_ISSUER_PLACEHOLDER = "<APP_STORE_CONNECT_API_ISSUER_ID>";
const NATIVE_MARKETING_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseXcodeMajorVersion(stdout: string): number | null {
  const match = stdout.match(/^Xcode\s+(\d+)(?:\.|\s|$)/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function readMobileProductionIdentity(repoRoot: string): Promise<{ bundleId: string; displayName: string }> {
  const configPath = join(repoRoot, "apps/mobile/src/mobileEnvironments.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, MobileEnvironmentRecord | undefined>;
  const prod = parsed.prod;
  if (!prod?.iosBundleId?.trim()) {
    throw new Error("Missing prod.iosBundleId in apps/mobile/src/mobileEnvironments.json.");
  }
  return {
    bundleId: prod.iosBundleId.trim(),
    displayName: prod.displayName?.trim() || "Kanna"
  };
}

async function readCurrentVersion(repoRoot: string): Promise<string> {
  const mobileVersionPath = join(repoRoot, "apps/mobile/VERSION");
  if (existsSync(mobileVersionPath)) {
    const mobileVersion = (await readFile(mobileVersionPath, "utf8")).trim();
    if (!mobileVersion) {
      throw new Error(
        `Mobile VERSION file at ${mobileVersionPath} is empty; pass --version explicitly or fix the file.`
      );
    }
    if (!NATIVE_MARKETING_VERSION_PATTERN.test(mobileVersion)) {
      throw new Error(
        `Mobile VERSION file at ${mobileVersionPath} is malformed; expected X.Y.Z, got ${JSON.stringify(mobileVersion)}. Pass --version explicitly or fix the file.`
      );
    }
    return mobileVersion;
  }

  const repoVersionPath = join(repoRoot, "VERSION");
  const version = (await readFile(repoVersionPath, "utf8")).trim();
  if (!version) {
    throw new Error(
      `Repository VERSION file at ${repoVersionPath} is empty; pass --version explicitly or fix the file.`
    );
  }
  return version;
}

function requireBuildNumber(rawBuildNumber: string | undefined): string {
  const buildNumber = rawBuildNumber?.trim();
  if (!buildNumber) {
    throw new Error("mobile archive requires --build-number <number>.");
  }
  if (!/^[0-9]+$/.test(buildNumber)) {
    throw new Error(`mobile archive --build-number must be numeric, got: ${rawBuildNumber}`);
  }
  return buildNumber;
}

function resolveOutDir(repoRoot: string, outDir: string | undefined): string {
  const archiveOutDir = outDir?.trim() || ".build/mobile/ios-production";
  return isAbsolute(archiveOutDir) ? archiveOutDir : resolve(repoRoot, archiveOutDir);
}

function buildExportOptionsPlist(input: { bundleId: string; teamId: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>export</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${input.teamId}</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
`;
}

export async function buildMobileIosArchivePlan(input: {
  repoRoot: string;
  buildNumber?: string;
  version?: string;
  outDir?: string;
  upload?: boolean;
}): Promise<MobileIosArchivePlan> {
  const buildNumber = requireBuildNumber(input.buildNumber);
  const version = input.version?.trim() || await readCurrentVersion(input.repoRoot);
  const outDir = resolveOutDir(input.repoRoot, input.outDir);
  const archivePath = join(outDir, "Kanna.xcarchive");
  const exportOptionsPlistPath = join(outDir, "ExportOptions.plist");
  const exportPath = join(outDir, "export");
  const ipaPath = join(exportPath, "Kanna.ipa");
  const identity = await readMobileProductionIdentity(input.repoRoot);
  const appEnv = APP_ENV;
  const appBuildEnv = {
    KANNA_APP_ENV: appEnv,
    KANNA_APP_VERSION: version,
    KANNA_IOS_BUILD_NUMBER: buildNumber
  };
  const commands: MobileIosArchiveCommand[] = [
    {
      command: "pnpm",
      args: ["--dir", join(input.repoRoot, "apps/mobile"), "exec", "expo", "prebuild", "--platform", "ios", "--clean"],
      cwd: input.repoRoot,
      env: appBuildEnv,
      streamOutput: true
    },
    {
      command: "xcodebuild",
      args: [
        "-workspace",
        join(input.repoRoot, "apps/mobile/ios", `${XCODE_SCHEME}.xcworkspace`),
        "-scheme",
        XCODE_SCHEME,
        "-configuration",
        "Release",
        "-sdk",
        "iphoneos",
        "-destination",
        "generic/platform=iOS",
        "-archivePath",
        archivePath,
        `MARKETING_VERSION=${version}`,
        `CURRENT_PROJECT_VERSION=${buildNumber}`,
        "-allowProvisioningUpdates",
        "archive"
      ],
      cwd: input.repoRoot,
      env: appBuildEnv,
      streamOutput: true
    },
    {
      command: "xcodebuild",
      args: [
        "-exportArchive",
        "-archivePath",
        archivePath,
        "-exportPath",
        exportPath,
        "-exportOptionsPlist",
        exportOptionsPlistPath,
        "-allowProvisioningUpdates"
      ],
      cwd: input.repoRoot,
      streamOutput: true
    }
  ];
  if (input.upload === true) {
    commands.push({
      command: "xcrun",
      args: [
        "iTMSTransporter",
        "-m",
        "upload",
        "-assetFile",
        ipaPath,
        "-apiKey",
        UPLOAD_API_KEY_PLACEHOLDER,
        "-apiIssuer",
        UPLOAD_API_ISSUER_PLACEHOLDER
      ],
      cwd: input.repoRoot,
      streamOutput: true
    });
  }

  return {
    appEnv,
    bundleId: identity.bundleId,
    displayName: identity.displayName,
    teamId: APPLE_TEAM_ID,
    version,
    buildNumber,
    outDir,
    archivePath,
    exportOptionsPlistPath,
    exportPath,
    ipaPath,
    upload: input.upload === true,
    exportOptionsPlist: buildExportOptionsPlist({ bundleId: identity.bundleId, teamId: APPLE_TEAM_ID }),
    commands
  };
}

async function assertXcodeUploadRequirement(runner: CommandRunner): Promise<void> {
  const result = await runner.run("xcodebuild", ["-version"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "xcodebuild -version failed.");
  }
  const majorVersion = parseXcodeMajorVersion(result.stdout);
  if (majorVersion === null || majorVersion < 26) {
    throw new Error(
      `Xcode 26 or later is required for App Store Connect uploads; xcodebuild reported: ${result.stdout.trim()}`
    );
  }
}

function resolveUploadCredentials(env: NodeJS.ProcessEnv): { apiKey: string; apiIssuer: string } {
  const apiKey = env.APP_STORE_CONNECT_API_KEY_ID?.trim();
  const apiIssuer = env.APP_STORE_CONNECT_API_ISSUER_ID?.trim();
  if (!apiKey || !apiIssuer) {
    throw new Error(
      "mobile archive --upload requires APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID. " +
        "Place AuthKey_<key id>.p8 in ~/.appstoreconnect/private_keys/ for Transporter."
    );
  }
  return { apiKey, apiIssuer };
}

function commandWithUploadCredentials(
  command: MobileIosArchiveCommand,
  credentials: { apiKey: string; apiIssuer: string } | null
): MobileIosArchiveCommand {
  if (!credentials || command.command !== "xcrun") return command;
  return {
    ...command,
    args: command.args.map((arg) => {
      if (arg === UPLOAD_API_KEY_PLACEHOLDER) return credentials.apiKey;
      if (arg === UPLOAD_API_ISSUER_PLACEHOLDER) return credentials.apiIssuer;
      return arg;
    })
  };
}

function formatPlanCommands(plan: MobileIosArchivePlan): string {
  return plan.commands.map((command) => `${command.command} ${command.args.join(" ")}`).join("\n");
}

export async function executeMobileIosArchiveWithContext(
  input: MobileIosArchiveInput,
  context: MobileIosArchiveContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  if (!input.production) {
    throw new Error("mobile archive requires --production.");
  }

  await assertXcodeUploadRequirement(context.runner);
  const plan = await buildMobileIosArchivePlan({
    repoRoot: context.repoRoot,
    buildNumber: input.buildNumber,
    version: input.version,
    outDir: input.outDir,
    upload: input.upload
  });

  if (input.dryRun === true) {
    return {
      ok: true,
      message: [
        `Dry run: mobile production archive ${plan.version} (${plan.buildNumber})`,
        `Bundle ID: ${plan.bundleId}`,
        `Archive: ${plan.archivePath}`,
        `IPA: ${plan.ipaPath}`,
        formatPlanCommands(plan)
      ].join("\n"),
      data: plan
    };
  }

  const uploadCredentials = input.upload ? resolveUploadCredentials(context.env) : null;
  await mkdir(plan.outDir, { recursive: true });
  await writeFile(plan.exportOptionsPlistPath, plan.exportOptionsPlist);

  for (const plannedCommand of plan.commands) {
    const command = commandWithUploadCredentials(plannedCommand, uploadCredentials);
    const result = await context.runner.run(command.command, command.args, {
      cwd: command.cwd,
      env: { ...context.env, ...command.env },
      streamOutput: command.streamOutput
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        message: result.stderr || result.stdout || `${command.command} ${command.args.join(" ")} failed`,
        data: { plan, failedCommand: `${command.command} ${plannedCommand.args.join(" ")}` }
      };
    }
  }

  return {
    ok: true,
    message: [
      `Built mobile production archive ${plan.version} (${plan.buildNumber}).`,
      `Bundle ID: ${plan.bundleId}`,
      `Archive: ${plan.archivePath}`,
      `IPA: ${plan.ipaPath}`,
      input.upload ? "Uploaded to App Store Connect with Transporter." : "Upload skipped; rerun with --upload to submit."
    ].join("\n"),
    data: plan
  };
}

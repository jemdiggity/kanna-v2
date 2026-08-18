import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CommandRunner } from "./process";
import { formatSourceRef, resolveSourceRef, type ResolvedSourceRef } from "./source-ref";

export interface MobileIosArchiveInput {
  production: boolean;
  /** Branch, tag, or sha the archive is built from; required because it is a production build. */
  ref?: string;
  dryRun?: boolean;
  upload?: boolean;
  forceRebuild?: boolean;
  buildNumber?: string;
  version?: string;
  outDir?: string;
}

export interface MobileIosArchiveContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export type MobileIosArchiveCommandKind = "prebuild" | "archive" | "export" | "upload";

export interface MobileIosArchiveCommand {
  kind: MobileIosArchiveCommandKind;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
}

export interface MobileIosArchivePlan {
  appEnv: "prod";
  /** Resolved source the archive was built from; absent only for plans built outside a checkout. */
  source?: ResolvedSourceRef;
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

export async function readMobileProductionIdentity(repoRoot: string): Promise<{ bundleId: string; displayName: string }> {
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

export async function readCurrentVersion(repoRoot: string): Promise<string> {
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

export function resolveOutDir(repoRoot: string, outDir: string | undefined): string {
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
  source?: ResolvedSourceRef;
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
  // Provenance is baked into expoConfig.extra at prebuild so the shipped
  // binary is self-describing: an IPA in Apple's hands cannot be queried the
  // way the relay's /health can. This is JS config only, so it does not oblige
  // a runtimeVersion bump.
  const appBuildEnv = {
    KANNA_APP_ENV: appEnv,
    KANNA_APP_VERSION: version,
    KANNA_IOS_BUILD_NUMBER: buildNumber,
    ...(input.source
      ? { KANNA_SOURCE_REF: input.source.ref, KANNA_SOURCE_COMMIT: input.source.commit }
      : {})
  };
  const commands: MobileIosArchiveCommand[] = [
    {
      kind: "prebuild",
      command: "pnpm",
      args: ["--dir", join(input.repoRoot, "apps/mobile"), "exec", "expo", "prebuild", "--platform", "ios", "--clean"],
      cwd: input.repoRoot,
      env: appBuildEnv,
      streamOutput: true
    },
    {
      kind: "archive",
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
      kind: "export",
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
    commands.push(
      buildAltoolUploadCommand({
        repoRoot: input.repoRoot,
        ipaPath,
        apiKey: UPLOAD_API_KEY_PLACEHOLDER,
        apiIssuer: UPLOAD_API_ISSUER_PLACEHOLDER
      })
    );
  }

  return {
    appEnv,
    source: input.source,
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
        "Place AuthKey_<key id>.p8 in ~/.appstoreconnect/private_keys/ for altool."
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

export interface ArchiveIdentity {
  version: string;
  buildNumber: string;
}

/**
 * Read the marketing version and build number recorded inside an existing
 * .xcarchive. The archive is a plain directory, so this avoids unzipping the
 * IPA just to learn what it contains.
 */
export function parseArchiveIdentity(rawPlistJson: string): ArchiveIdentity | null {
  try {
    const parsed = JSON.parse(rawPlistJson) as {
      ApplicationProperties?: { CFBundleShortVersionString?: string; CFBundleVersion?: string };
    };
    const version = parsed.ApplicationProperties?.CFBundleShortVersionString?.trim();
    const buildNumber = parsed.ApplicationProperties?.CFBundleVersion?.trim();
    if (!version || !buildNumber) return null;
    return { version, buildNumber };
  } catch {
    return null;
  }
}

/**
 * Decide whether the artifacts already on disk are exactly the ones the plan
 * asks for. Reuse is safe here because App Store Connect rejects a repeated
 * build number for a version, so changed source obliges a new build number,
 * which misses this check and rebuilds.
 */
export async function resolveReusableArchive(input: {
  runner: CommandRunner;
  plan: MobileIosArchivePlan;
}): Promise<{ reusable: boolean; reason: string }> {
  const { plan, runner } = input;
  if (!existsSync(plan.ipaPath)) {
    return { reusable: false, reason: `no IPA at ${plan.ipaPath}` };
  }
  const archiveInfoPlist = join(plan.archivePath, "Info.plist");
  if (!existsSync(archiveInfoPlist)) {
    return { reusable: false, reason: `no archive Info.plist at ${archiveInfoPlist}` };
  }
  const result = await runner.run("plutil", ["-convert", "json", "-o", "-", archiveInfoPlist]);
  if (result.exitCode !== 0) {
    return { reusable: false, reason: "could not read the existing archive Info.plist" };
  }
  const identity = parseArchiveIdentity(result.stdout);
  if (!identity) {
    return { reusable: false, reason: "existing archive has no readable version/build number" };
  }
  if (identity.version !== plan.version || identity.buildNumber !== plan.buildNumber) {
    return {
      reusable: false,
      reason:
        `existing archive is ${identity.version} (${identity.buildNumber}), ` +
        `wanted ${plan.version} (${plan.buildNumber})`
    };
  }
  return { reusable: true, reason: `existing ${identity.version} (${identity.buildNumber}) matches` };
}

/**
 * Uploads go through `xcrun altool --upload-app`.
 *
 * The obvious alternative, `xcrun iTMSTransporter -m upload -assetFile`, does
 * not work here: it authenticates, reports "Creating reservations for build",
 * then fails with an undiagnosable `Could not upload file`. altool accepted the
 * identical IPA seconds later. Verified on 2026-08-18 against Kanna Mobile
 * 1.0.0 build 2 — same artifact, credentials, and machine.
 *
 * Watch item: Apple is moving Transporter toward `-assetFile` and away from
 * `-f` during 2026. If altool's `-f` is withdrawn, revisit the Transporter
 * invocation rather than assuming this one still holds.
 */
export function buildAltoolUploadCommand(input: {
  repoRoot: string;
  ipaPath: string;
  apiKey: string;
  apiIssuer: string;
}): MobileIosArchiveCommand {
  return {
    kind: "upload",
    command: "xcrun",
    args: [
      "altool",
      "--upload-app",
      "-f",
      input.ipaPath,
      "-t",
      "ios",
      "--apiKey",
      input.apiKey,
      "--apiIssuer",
      input.apiIssuer
    ],
    cwd: input.repoRoot,
    streamOutput: true
  };
}

/**
 * altool reports the delivery it created; the UUID is the only handle Apple's
 * support tooling accepts for a specific upload, so the publish record keeps
 * it. The label has moved between altool releases, so match either spelling
 * and treat its absence as unknown rather than as a failure.
 */
export function parseAltoolDeliveryUuid(output: string): string | null {
  const match = output.match(
    /delivery[ _]?uuid\s*[:=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match ? match[1].toLowerCase() : null;
}

export function isUploaderUnavailable(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /command not found|unable to find utility|no such file/i.test(combined);
}

export async function assertUploaderAvailable(runner: CommandRunner): Promise<void> {
  const result = await runner.run("xcrun", ["--find", "altool"]);
  if (result.exitCode !== 0 || isUploaderUnavailable(result.stdout, result.stderr)) {
    throw new Error(
      "mobile archive --upload needs altool, which ships with Xcode. `xcrun --find altool` " +
        "did not resolve it. Confirm Xcode is installed and selected " +
        "(`xcode-select -p`), then retry."
    );
  }
}

export async function executeMobileIosArchiveWithContext(
  input: MobileIosArchiveInput,
  context: MobileIosArchiveContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  if (!input.production) {
    throw new Error("mobile archive requires --production.");
  }

  const source = await resolveSourceRef({
    repoRoot: context.repoRoot,
    runner: context.runner,
    env: context.env,
    ref: input.ref,
    requireRef: true,
    command: "mobile archive"
  });
  await assertXcodeUploadRequirement(context.runner);
  const plan = await buildMobileIosArchivePlan({
    repoRoot: context.repoRoot,
    buildNumber: input.buildNumber,
    version: input.version,
    outDir: input.outDir,
    upload: input.upload,
    source
  });

  if (input.dryRun === true) {
    return {
      ok: true,
      message: [
        `Dry run: mobile production archive ${plan.version} (${plan.buildNumber})`,
        formatSourceRef(source),
        `Bundle ID: ${plan.bundleId}`,
        `Archive: ${plan.archivePath}`,
        `IPA: ${plan.ipaPath}`,
        formatPlanCommands(plan)
      ].join("\n"),
      data: plan
    };
  }

  const uploadCredentials = input.upload ? resolveUploadCredentials(context.env) : null;
  if (input.upload === true) {
    // Fail before the build rather than after 15 minutes of compiling.
    await assertUploaderAvailable(context.runner);
  }

  // Only build when the artifacts on disk are not already exactly this
  // version and build number.
  const reuse =
    input.forceRebuild === true
      ? { reusable: false, reason: "--force-rebuild requested" }
      : await resolveReusableArchive({ runner: context.runner, plan });
  const commands = reuse.reusable
    ? plan.commands.filter((command) => command.kind === "upload")
    : plan.commands;

  await mkdir(plan.outDir, { recursive: true });
  if (!reuse.reusable) {
    await writeFile(plan.exportOptionsPlistPath, plan.exportOptionsPlist);
  }

  for (const plannedCommand of commands) {
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
      reuse.reusable
        ? `Reused existing mobile production archive ${plan.version} (${plan.buildNumber}) — ${reuse.reason}. Pass --force-rebuild to rebuild.`
        : `Built mobile production archive ${plan.version} (${plan.buildNumber}).`,
      formatSourceRef(source),
      `Bundle ID: ${plan.bundleId}`,
      `Archive: ${plan.archivePath}`,
      `IPA: ${plan.ipaPath}`,
      input.upload ? "Uploaded to App Store Connect with altool." : "Upload skipped; rerun with --upload to submit."
    ].join("\n"),
    data: { ...plan, reused: reuse.reusable, reuseReason: reuse.reason }
  };
}

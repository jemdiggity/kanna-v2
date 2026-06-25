import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { cloudEnvironmentToKdEnvironment, resolveKdEnvironment, type CloudEnvironmentName } from "./environment";
import type { CommandRunner } from "./process";

export interface MobileOtaInput {
  staging: boolean;
  production: boolean;
  dryRun?: boolean;
  rollbackTo?: string;
}

export interface MobileOtaProvisionSecretInput {
  staging: boolean;
  production: boolean;
  keyPath: string;
}

export interface MobileOtaContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export interface MobileOtaCommandPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
}

export interface MobileOtaPublishPlan {
  environment: CloudEnvironmentName;
  bucket: string;
  channel: string;
  runtimeVersion: string;
  updateId: string;
  distDir: string;
  updateObjectPrefix: string;
  pointerObject: string;
  relayManifestUrl: string;
  commands: MobileOtaCommandPlan[];
  dryRun: boolean;
}

interface ExpoMetadataAsset {
  path: string;
  ext?: string;
  contentType?: string;
}

interface ExpoMetadata {
  fileMetadata?: Record<
    string,
    {
      bundle?: string;
      assets?: ExpoMetadataAsset[];
    }
  >;
}

interface StagedExpoFile {
  targetPath: string;
  bytes: Buffer;
}

interface StagedExpoMetadata {
  metadataBytes: Buffer;
  updateId: string;
  bundle: StagedExpoFile;
  assets: StagedExpoFile[];
}

interface MobileEnvironmentRecord {
  runtimeVersion?: string;
}

export function computeExpoUpdateId(metadataBytes: Buffer): string {
  const hash = createHash("sha256").update(metadataBytes).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export async function resolveMobileRuntimeVersion(
  repoRoot: string,
  kdEnvironmentName: "staging" | "prod"
): Promise<string> {
  const configPath = join(repoRoot, "apps/mobile/src/mobileEnvironments.json");
  const json = JSON.parse(await readFile(configPath, "utf8")) as Record<string, MobileEnvironmentRecord>;
  const runtimeVersion = json[kdEnvironmentName]?.runtimeVersion;
  if (typeof runtimeVersion !== "string" || runtimeVersion.trim().length === 0) {
    throw new Error(
      `Missing apps/mobile/src/mobileEnvironments.json ${kdEnvironmentName}.runtimeVersion for mobile OTA.`
    );
  }
  return runtimeVersion.trim();
}

export async function buildMobileOtaPublishPlan(input: {
  repoRoot: string;
  environment: CloudEnvironmentName;
  distDir?: string;
  dryRun?: boolean;
  updateId?: string;
}): Promise<MobileOtaPublishPlan> {
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(input.environment));
  if (!identity.otaBucket || !identity.otaChannel) {
    throw new Error(`Mobile OTA is not configured for ${input.environment}.`);
  }
  const kdEnvironmentName = cloudEnvironmentToKdEnvironment(input.environment);
  if (kdEnvironmentName !== "staging" && kdEnvironmentName !== "prod") {
    throw new Error("Mobile OTA applies only to staging and production.");
  }

  const distDir = input.distDir ?? join(input.repoRoot, "apps/mobile/dist");
  const runtimeVersion = await resolveMobileRuntimeVersion(input.repoRoot, kdEnvironmentName);
  const updateId = input.updateId ?? (await buildStagedExpoMetadata(distDir)).updateId;
  const updateObjectPrefix = `ota/ios/${runtimeVersion}/updates/${updateId}`;
  const pointerObject = `ota/ios/${runtimeVersion}/channels/${identity.otaChannel}.json`;
  const relayManifestUrl = `${identity.relayUrl.replace(/^ws/, "http")}/ota/manifest`;

  return {
    environment: input.environment,
    bucket: identity.otaBucket,
    channel: identity.otaChannel,
    runtimeVersion,
    updateId,
    distDir,
    updateObjectPrefix,
    pointerObject,
    relayManifestUrl,
    dryRun: input.dryRun === true,
    commands: [
      buildExpoExportCommand(input.repoRoot, input.environment, distDir),
      {
        command: "gcloud",
        args: [
          "storage",
          "rsync",
          "--recursive",
          "<staged-update-dir>",
          `gs://${identity.otaBucket}/${updateObjectPrefix}`,
        ],
        cwd: input.repoRoot,
        streamOutput: true,
      },
      {
        command: "gcloud",
        args: [
          "storage",
          "cp",
          "<channel-pointer-json>",
          `gs://${identity.otaBucket}/${pointerObject}`,
        ],
        cwd: input.repoRoot,
        streamOutput: true,
      },
    ],
  };
}

export async function executeMobileOtaPublishWithContext(
  input: MobileOtaInput,
  context: MobileOtaContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const environment = resolveMobileOtaEnvironment(input, "publish");
  await assertCleanGitWorktree(context.repoRoot, context.runner);
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
  if (!identity.otaBucket || !identity.otaChannel) {
    throw new Error(`Mobile OTA is not configured for ${environment}.`);
  }

  const kdEnvironmentName = cloudEnvironmentToKdEnvironment(environment);
  if (kdEnvironmentName !== "staging" && kdEnvironmentName !== "prod") {
    throw new Error("Mobile OTA applies only to staging and production.");
  }
  const runtimeVersion = await resolveMobileRuntimeVersion(context.repoRoot, kdEnvironmentName);

  if (input.rollbackTo) {
    const pointer = await writePointerFile(input.rollbackTo, runtimeVersion);
    const pointerObject = `ota/ios/${runtimeVersion}/channels/${identity.otaChannel}.json`;
    if (input.dryRun !== true) {
      await mustRun(context.runner, "gcloud", [
        "storage",
        "cp",
        pointer.path,
        `gs://${identity.otaBucket}/${pointerObject}`,
      ], context.repoRoot, context.env);
    }
    return {
      ok: true,
      message: formatRollbackMessage({
        dryRun: input.dryRun === true,
        bucket: identity.otaBucket,
        channel: identity.otaChannel,
        runtimeVersion,
        updateId: input.rollbackTo,
        pointerObject,
        relayManifestUrl: identity.relayUrl.replace(/^ws/, "http") + "/ota/manifest",
      }),
      data: { updateId: input.rollbackTo, runtimeVersion, channel: identity.otaChannel, pointerObject },
    };
  }

  const distDir = join(context.repoRoot, "apps/mobile/dist");
  await rm(distDir, { recursive: true, force: true });
  const exportCommand = buildExpoExportCommand(context.repoRoot, environment, distDir);
  await mustRun(
    context.runner,
    exportCommand.command,
    exportCommand.args,
    exportCommand.cwd ?? context.repoRoot,
    { ...context.env, ...exportCommand.env }
  );

  const staged = await stageOtaUpdate({ distDir });
  const plan = await buildMobileOtaPublishPlan({
    repoRoot: context.repoRoot,
    environment,
    distDir,
    updateId: staged.updateId,
    dryRun: input.dryRun === true,
  });
  const pointer = await writePointerFile(plan.updateId, plan.runtimeVersion);

  if (input.dryRun !== true) {
    const exists = await context.runner.run("gcloud", [
      "storage",
      "ls",
      `gs://${plan.bucket}/${plan.updateObjectPrefix}/metadata.json`,
    ], { cwd: context.repoRoot, env: context.env });
    if (exists.exitCode !== 0) {
      await mustRun(context.runner, "gcloud", [
        "storage",
        "rsync",
        "--recursive",
        staged.path,
        `gs://${plan.bucket}/${plan.updateObjectPrefix}`,
      ], context.repoRoot, context.env);
    }
    await mustRun(context.runner, "gcloud", [
      "storage",
      "cp",
      pointer.path,
      `gs://${plan.bucket}/${plan.pointerObject}`,
    ], context.repoRoot, context.env);
  }

  return {
    ok: true,
    message: formatPublishMessage(plan),
    data: {
      updateId: plan.updateId,
      runtimeVersion: plan.runtimeVersion,
      channel: plan.channel,
      bucket: plan.bucket,
      dryRun: plan.dryRun,
    },
  };
}

export async function executeMobileOtaStatusWithContext(
  input: Pick<MobileOtaInput, "staging" | "production">,
  context: MobileOtaContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const environment = resolveMobileOtaEnvironment(input, "status");
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
  if (!identity.otaBucket || !identity.otaChannel) {
    throw new Error(`Mobile OTA is not configured for ${environment}.`);
  }
  const kdEnvironmentName = cloudEnvironmentToKdEnvironment(environment);
  if (kdEnvironmentName !== "staging" && kdEnvironmentName !== "prod") {
    throw new Error("Mobile OTA applies only to staging and production.");
  }
  const runtimeVersion = await resolveMobileRuntimeVersion(context.repoRoot, kdEnvironmentName);
  const pointerObject = `ota/ios/${runtimeVersion}/channels/${identity.otaChannel}.json`;
  const pointer = await context.runner.run("gcloud", [
    "storage",
    "cat",
    `gs://${identity.otaBucket}/${pointerObject}`,
  ], { cwd: context.repoRoot, env: context.env });
  const updates = await context.runner.run("gcloud", [
    "storage",
    "ls",
    `gs://${identity.otaBucket}/ota/ios/${runtimeVersion}/updates/`,
  ], { cwd: context.repoRoot, env: context.env });

  return {
    ok: pointer.exitCode === 0,
    message: [
      `Mobile OTA ${environment}`,
      `bucket: ${identity.otaBucket}`,
      `channel: ${identity.otaChannel}`,
      `runtimeVersion: ${runtimeVersion}`,
      pointer.exitCode === 0 ? `pointer: ${pointer.stdout.trim()}` : `pointer: ${pointer.stderr.trim() || "missing"}`,
      updates.exitCode === 0 ? `recent updates:\n${updates.stdout.trim()}` : "recent updates: unavailable",
    ].join("\n"),
    data: {
      bucket: identity.otaBucket,
      channel: identity.otaChannel,
      runtimeVersion,
      pointerObject,
    },
  };
}

export async function executeMobileOtaProvisionSecretWithContext(
  input: MobileOtaProvisionSecretInput,
  context: MobileOtaContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const environment = resolveMobileOtaEnvironment(input, "provision-secret");
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
  if (!identity.gceVmName) {
    throw new Error(`Relay VM is not configured for ${environment}.`);
  }
  await readFile(input.keyPath);

  const secretName = "kanna-mobile-ota-private-key-pem";
  const projectId = identity.firebaseProjectId;
  const describe = await context.runner.run("gcloud", [
    "secrets",
    "describe",
    secretName,
    "--project",
    projectId,
  ], { cwd: context.repoRoot, env: context.env });
  if (describe.exitCode !== 0) {
    await mustRun(context.runner, "gcloud", [
      "secrets",
      "create",
      secretName,
      "--project",
      projectId,
      "--replication-policy",
      "automatic",
    ], context.repoRoot, context.env);
  }

  await mustRun(context.runner, "gcloud", [
    "secrets",
    "versions",
    "add",
    secretName,
    "--project",
    projectId,
    "--data-file",
    input.keyPath,
  ], context.repoRoot, context.env);

  const serviceAccount = await context.runner.run("gcloud", [
    "compute",
    "instances",
    "describe",
    identity.gceVmName,
    "--project",
    projectId,
    "--zone",
    "us-central1-a",
    "--format",
    "value(serviceAccounts[0].email)",
  ], { cwd: context.repoRoot, env: context.env });
  if (serviceAccount.exitCode !== 0 || serviceAccount.stdout.trim().length === 0) {
    throw new Error(serviceAccount.stderr || "Could not resolve the relay VM service account.");
  }

  await mustRun(context.runner, "gcloud", [
    "secrets",
    "add-iam-policy-binding",
    secretName,
    "--project",
    projectId,
    "--member",
    `serviceAccount:${serviceAccount.stdout.trim()}`,
    "--role",
    "roles/secretmanager.secretAccessor",
  ], context.repoRoot, context.env);

  return {
    ok: true,
    message: [
      `Provisioned mobile OTA private key secret for ${environment}.`,
      `secret: ${secretName}`,
      `keyid: kanna-mobile-ota-v1`,
      `relay VM: ${identity.gceVmName}`,
    ].join("\n"),
    data: { environment, projectId, secretName, keyId: "kanna-mobile-ota-v1" },
  };
}

function buildExpoExportCommand(repoRoot: string, environment: CloudEnvironmentName, distDir: string): MobileOtaCommandPlan {
  return {
    command: "pnpm",
    args: ["exec", "expo", "export", "--platform", "ios", "--output-dir", distDir],
    cwd: join(repoRoot, "apps/mobile"),
    env: {
      KANNA_APP_ENV: environment === "staging" ? "staging" : "prod",
    },
    streamOutput: true,
  };
}

async function stageOtaUpdate(input: { distDir: string }): Promise<{ path: string; updateId: string }> {
  const stagedMetadata = await buildStagedExpoMetadata(input.distDir);
  const stageRoot = await mkdtemp(join(tmpdir(), "kanna-ota-stage-"));
  const output = join(stageRoot, stagedMetadata.updateId);
  await mkdir(join(output, "bundles"), { recursive: true });
  await mkdir(join(output, "assets"), { recursive: true });

  await writeFile(join(output, stagedMetadata.bundle.targetPath), stagedMetadata.bundle.bytes);
  for (const asset of stagedMetadata.assets) {
    await writeFile(join(output, asset.targetPath), asset.bytes);
  }
  await writeFile(join(output, "metadata.json"), stagedMetadata.metadataBytes);
  await cp(join(input.distDir, "expoConfig.json"), join(output, "expoConfig.json"));
  return { path: output, updateId: stagedMetadata.updateId };
}

async function buildStagedExpoMetadata(distDir: string): Promise<StagedExpoMetadata> {
  const metadata = JSON.parse(await readFile(join(distDir, "metadata.json"), "utf8")) as ExpoMetadata;
  const ios = metadata.fileMetadata?.ios;
  if (!ios?.bundle) {
    throw new Error("Expo metadata.json does not include fileMetadata.ios.bundle.");
  }

  const bundlePath = ios.bundle;
  const bundleBytes = await readFile(join(distDir, bundlePath));
  const bundleKey = createHash("sha256").update(bundleBytes).digest("base64url");
  const bundleTarget = `bundles/${bundleKey}.hbc`;

  const assets: ExpoMetadataAsset[] = [];
  const stagedAssets: StagedExpoFile[] = [];
  for (const asset of ios.assets ?? []) {
    const assetBytes = await readFile(join(distDir, asset.path));
    const assetKey = createHash("sha256").update(assetBytes).digest("base64url");
    const target = `assets/${assetKey}`;
    assets.push({
      ...asset,
      path: target,
      ext: asset.ext ?? normalizeAssetExtension(asset.path),
    });
    stagedAssets.push({
      targetPath: target,
      bytes: assetBytes,
    });
  }

  const rewrittenMetadata: ExpoMetadata = {
    ...metadata,
    fileMetadata: {
      ...metadata.fileMetadata,
      ios: {
        ...ios,
        bundle: bundleTarget,
        assets,
      },
    },
  };
  const metadataBytes = Buffer.from(JSON.stringify(rewrittenMetadata));
  return {
    metadataBytes,
    updateId: computeExpoUpdateId(metadataBytes),
    bundle: {
      targetPath: bundleTarget,
      bytes: bundleBytes,
    },
    assets: stagedAssets,
  };
}

async function writePointerFile(updateId: string, runtimeVersion: string): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kanna-ota-pointer-"));
  const path = join(dir, "channel.json");
  await writeFile(path, JSON.stringify({
    currentUpdateId: updateId,
    createdAt: new Date().toISOString(),
    runtimeVersion,
  }));
  return { path };
}

function normalizeAssetExtension(path: string): string | undefined {
  const extension = extname(path);
  if (extension) return extension.slice(1);
  const name = basename(path);
  return name.includes(".") ? name.split(".").pop() : undefined;
}

async function assertCleanGitWorktree(repoRoot: string, runner: CommandRunner): Promise<void> {
  const status = await runner.run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || status.stdout || "Failed to inspect git worktree status.");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error("Refusing to publish mobile OTA from a dirty git worktree. Commit or stash changes first.");
  }
}

function resolveMobileOtaEnvironment(
  input: Pick<MobileOtaInput, "staging" | "production">,
  command: string
): CloudEnvironmentName {
  if (input.staging && input.production) {
    throw new Error(`mobile ota ${command} accepts only one of --staging or --production.`);
  }
  if (!input.staging && !input.production) {
    throw new Error(`mobile ota ${command} requires --staging or --production.`);
  }
  return input.staging ? "staging" : "production";
}

async function mustRun(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const result = await runner.run(command, args, { cwd, env, streamOutput: true });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} ${args.join(" ")} failed.`);
  }
}

function formatPublishMessage(plan: MobileOtaPublishPlan): string {
  return [
    `${plan.dryRun ? "Dry run: mobile OTA update" : "Published mobile OTA update"} ${plan.updateId}`,
    `runtimeVersion: ${plan.runtimeVersion}`,
    `channel: ${plan.channel}`,
    `bucket: gs://${plan.bucket}/${plan.updateObjectPrefix}`,
    `verify: ${manifestCurl(plan.relayManifestUrl, plan.runtimeVersion, plan.channel)}`,
  ].join("\n");
}

function formatRollbackMessage(input: {
  dryRun: boolean;
  bucket: string;
  channel: string;
  runtimeVersion: string;
  updateId: string;
  pointerObject: string;
  relayManifestUrl: string;
}): string {
  return [
    `${input.dryRun ? "Dry run: mobile OTA rollback" : "Rolled back mobile OTA channel"} ${input.channel}`,
    `updateId: ${input.updateId}`,
    `runtimeVersion: ${input.runtimeVersion}`,
    `pointer: gs://${input.bucket}/${input.pointerObject}`,
    `verify: ${manifestCurl(input.relayManifestUrl, input.runtimeVersion, input.channel)}`,
  ].join("\n");
}

function manifestCurl(url: string, runtimeVersion: string, channel: string): string {
  return [
    "curl",
    "-H 'expo-protocol-version: 1'",
    "-H 'expo-platform: ios'",
    `-H 'expo-runtime-version: ${runtimeVersion}'`,
    `-H 'expo-channel-name: ${channel}'`,
    `'${url}'`,
  ].join(" ");
}

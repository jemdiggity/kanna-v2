import { observeMobileDevices, observeRuntimePointers } from "./mobile-ota-observations";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { cloudEnvironmentToKdEnvironment, resolveKdEnvironment, type CloudEnvironmentName } from "./environment";
import {
  OTA_CERTIFICATE_RELATIVE_PATH,
  validateMobileOtaCertificate,
} from "./mobile-ota-certificate";
import type { CommandRunner } from "./process";
import { formatSourceRef, resolveSourceRef, type ResolvedSourceRef } from "./source-ref";

export interface MobileOtaInput {
  staging: boolean;
  production: boolean;
  dryRun?: boolean;
  rollbackTo?: string;
  /**
   * Branch, tag, or sha the update is exported from. Required for the
   * production channel: a publish ships the working tree's JS straight to
   * installed apps, so the source has to be named rather than inferred.
   */
  ref?: string;
}

export interface MobileOtaProvisionSecretInput {
  staging: boolean;
  production: boolean;
  keyPath: string;
}

export type MobileOtaProvisionInput = Pick<MobileOtaInput, "staging" | "production">;

export interface MobileOtaContext {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  request?: MobileOtaHttpRequest;
  validateOtaCertificate?: typeof validateMobileOtaCertificate;
}

export interface MobileOtaHttpRequestInput {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
}

export type MobileOtaHttpRequest = (
  input: MobileOtaHttpRequestInput
) => Promise<{ ok: boolean; status: number; body: string }>;

export interface MobileOtaCommandPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
}

export interface MobileOtaPublishPlan {
  environment: CloudEnvironmentName;
  /** Resolved source the update was exported from. */
  source?: ResolvedSourceRef;
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

interface OtaChannelPointer {
  currentUpdateId?: string;
  createdAt?: string;
  runtimeVersion?: string;
  /** Source ref the update the channel points at was published from. */
  sourceRef?: string;
  /** Full source commit, so `kd mobile ota status` traces the live update back to a commit. */
  sourceCommit?: string;
}

/**
 * Per-update source record, written alongside the update's Expo artifacts as
 * `kanna-source.json`. The channel pointer is overwritten by every publish and
 * rollback; this copy stays with the update it describes, so an update that a
 * rollback later re-points to can still be traced to its commit.
 */
interface OtaSourceRecord {
  updateId: string;
  ref: string;
  commit: string;
  shortCommit: string;
}

interface OtaDoctorCheck {
  status: "PASS" | "FAIL" | "WARN";
  name: string;
  detail: string;
}

interface IamPolicy {
  bindings?: Array<{
    role?: string;
    members?: string[];
  }>;
}

const OTA_SOURCE_OBJECT = "kanna-source.json";
const OTA_SECRET_NAME = "kanna-mobile-ota-private-key-pem";
const OTA_KEY_ID = "kanna-mobile-ota-v1";

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
  source?: ResolvedSourceRef;
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
    source: input.source,
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
      buildExpoPublicConfigCommand(input.repoRoot, input.environment),
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
  // A publish exports the working tree, so the source is a guard, not a
  // parameter: the tree must be clean and a named --ref must be the checked-out
  // commit. A rollback only re-points the channel at an already-published
  // update and exports nothing, so it keeps the clean-tree refusal but does not
  // demand a ref it would have no source to record.
  const source = await resolveSourceRef({
    repoRoot: context.repoRoot,
    runner: context.runner,
    env: context.env,
    ref: input.ref,
    requireRef: environment === "production" && !input.rollbackTo,
    command: "mobile ota publish"
  });
  const validateCertificate = context.validateOtaCertificate ?? validateMobileOtaCertificate;
  await validateCertificate({
    certificatePath: join(context.repoRoot, OTA_CERTIFICATE_RELATIVE_PATH),
  });
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
    const pointer = await writePointerFile({ updateId: input.rollbackTo, runtimeVersion });
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
      message: (await observeMobileDevices(context, identity.otaChannel, runtimeVersion, input.rollbackTo)).detail + "\n" + formatRollbackMessage({
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

  const expoConfigBytes = await readExpoPublicConfig(
    context.repoRoot,
    environment,
    context.runner,
    context.env
  );
  const staged = await stageOtaUpdate({ distDir, expoConfigBytes, source });
  const plan = await buildMobileOtaPublishPlan({
    repoRoot: context.repoRoot,
    environment,
    distDir,
    updateId: staged.updateId,
    dryRun: input.dryRun === true,
    source,
  });
  const pointer = await writePointerFile({
    updateId: plan.updateId,
    runtimeVersion: plan.runtimeVersion,
    source,
  });

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

  const devices = await observeMobileDevices(context, plan.channel, plan.runtimeVersion, plan.updateId);
  return {
    ok: true,
    message: `${formatPublishMessage(plan)}\n${devices.detail}`,
    data: {
      updateId: plan.updateId,
      runtimeVersion: plan.runtimeVersion,
      channel: plan.channel,
      bucket: plan.bucket,
      dryRun: plan.dryRun,
      devices,
      source,
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

  const pointers = await observeRuntimePointers(context, identity.otaBucket, identity.otaChannel, runtimeVersion);
  const devices = await observeMobileDevices(context, identity.otaChannel, runtimeVersion, parsePointer(pointer.stdout)?.currentUpdateId);
  return {
    ok: pointer.exitCode === 0,
    message: [
      `Mobile OTA ${environment}`,
      `bucket: ${identity.otaBucket}`,
      `channel: ${identity.otaChannel}`,
      `runtimeVersion: ${runtimeVersion}`,
      pointer.exitCode === 0 ? `pointer: ${pointer.stdout.trim()}` : `pointer: ${pointer.stderr.trim() || "missing"}`,
      updates.exitCode === 0 ? `recent updates:\n${updates.stdout.trim()}` : "recent updates: unavailable",
      pointers.detail,
      devices.detail,
    ].join("\n"),
    data: {
      bucket: identity.otaBucket,
      channel: identity.otaChannel,
      runtimeVersion,
      pointerObject,
      pointers,
      devices,
    },
  };
}

export async function executeMobileOtaProvisionWithContext(
  input: MobileOtaProvisionInput,
  context: MobileOtaContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const environment = resolveMobileOtaEnvironment(input, "provision");
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
  const projectId = identity.firebaseProjectId;
  const bucket = identity.otaBucket;
  if (!bucket || !identity.gceVmName) {
    throw new Error(`Mobile OTA provisioning is not configured for ${environment}.`);
  }

  await mustRun(context.runner, "gcloud", [
    "services",
    "enable",
    "storage.googleapis.com",
    "firebasestorage.googleapis.com",
    "--project",
    projectId,
  ], context.repoRoot, context.env);

  const bucketUrl = `gs://${bucket}`;
  const describe = await context.runner.run("gcloud", [
    "storage",
    "buckets",
    "describe",
    bucketUrl,
    "--project",
    projectId,
    "--format=json",
  ], { cwd: context.repoRoot, env: context.env });
  if (describe.exitCode !== 0) {
    if (!isNotFoundFailure(describe)) {
      throw new Error(summarizeCommandFailure(describe));
    }
    const accessTokenResult = await context.runner.run("gcloud", [
      "auth",
      "print-access-token",
    ], { cwd: context.repoRoot, env: context.env });
    const accessToken = accessTokenResult.stdout.trim();
    if (accessTokenResult.exitCode !== 0 || accessToken.length === 0) {
      throw new Error(summarizeCommandFailure(accessTokenResult));
    }

    const request = context.request ?? executeMobileOtaHttpRequest;
    const response = await request({
      url: `https://firebasestorage.googleapis.com/v1alpha/projects/${projectId}/defaultBucket`,
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: { location: "US-CENTRAL1" },
    });
    if (!response.ok) {
      const sanitizedBody = response.body.replaceAll(accessToken, "[redacted]").trim();
      throw new Error(
        `Firebase default-bucket provisioning failed (HTTP ${response.status}): ${sanitizedBody || "request failed"}`
      );
    }
  }

  const serviceAccountResult = await context.runner.run("gcloud", [
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
  const serviceAccount = serviceAccountResult.stdout.trim();
  if (serviceAccountResult.exitCode !== 0 || serviceAccount.length === 0) {
    throw new Error(summarizeCommandFailure(serviceAccountResult));
  }

  await mustRun(context.runner, "gcloud", [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    bucketUrl,
    "--project",
    projectId,
    "--member",
    `serviceAccount:${serviceAccount}`,
    "--role",
    "roles/storage.objectViewer",
  ], context.repoRoot, context.env);

  return {
    ok: true,
    message: [
      `Provisioned mobile OTA infrastructure for ${environment}.`,
      `project: ${projectId}`,
      `bucket: ${bucket}`,
      `relay service account: ${serviceAccount}`,
    ].join("\n"),
    data: { environment, projectId, bucket, serviceAccount },
  };
}

export async function executeMobileOtaDoctorWithContext(
  input: Pick<MobileOtaInput, "staging" | "production">,
  context: MobileOtaContext
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const environment = resolveMobileOtaEnvironment(input, "doctor");
  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
  if (!identity.otaBucket || !identity.otaChannel) {
    throw new Error(`Mobile OTA is not configured for ${environment}.`);
  }
  if (!identity.gceVmName) {
    throw new Error(`Relay VM is not configured for ${environment}.`);
  }
  const kdEnvironmentName = cloudEnvironmentToKdEnvironment(environment);
  if (kdEnvironmentName !== "staging" && kdEnvironmentName !== "prod") {
    throw new Error("Mobile OTA applies only to staging and production.");
  }

  const runtimeVersion = await resolveMobileRuntimeVersion(context.repoRoot, kdEnvironmentName);
  const projectId = identity.firebaseProjectId;
  const bucket = identity.otaBucket;
  const channel = identity.otaChannel;
  const pointerObject = `ota/ios/${runtimeVersion}/channels/${channel}.json`;
  const relayBaseUrl = identity.relayUrl.replace(/^ws/, "http");
  const relayHealthUrl = `${relayBaseUrl}/health`;
  const relayManifestUrl = `${relayBaseUrl}/ota/manifest`;
  const checks: OtaDoctorCheck[] = [
    {
      status: "PASS",
      name: "environment",
      detail: `${environment} project=${projectId} bucket=${bucket} channel=${channel} runtimeVersion=${runtimeVersion}`,
    },
  ];

  const validateCertificate = context.validateOtaCertificate ?? validateMobileOtaCertificate;
  try {
    const certificate = await validateCertificate({
      certificatePath: join(context.repoRoot, OTA_CERTIFICATE_RELATIVE_PATH),
    });
    checks.push({
      status: "PASS",
      name: "certificate",
      detail: `Code Signing EKU; valid ${certificate.validFrom} through ${certificate.validTo}`,
    });
  } catch (error: unknown) {
    checks.push({
      status: "FAIL",
      name: "certificate",
      detail: error instanceof Error ? error.message : "Mobile OTA certificate validation failed.",
    });
  }

  const pointerResult = await context.runner.run("gcloud", [
    "storage",
    "cat",
    `gs://${bucket}/${pointerObject}`,
  ], { cwd: context.repoRoot, env: context.env });
  const pointer = parsePointer(pointerResult.stdout);
  const updateId = pointer?.currentUpdateId?.trim();
  if (pointerResult.exitCode === 0 && pointer && updateId) {
    if (pointer.runtimeVersion && pointer.runtimeVersion !== runtimeVersion) {
      checks.push({
        status: "FAIL",
        name: "pointer",
        detail: `gs://${bucket}/${pointerObject} points at runtimeVersion ${pointer.runtimeVersion}, expected ${runtimeVersion}`,
      });
    } else {
      checks.push({
        status: "PASS",
        name: "pointer",
        detail: `gs://${bucket}/${pointerObject} -> ${updateId}`,
      });
    }
    await addGcsObjectCheck(checks, context, bucket, `ota/ios/${runtimeVersion}/updates/${updateId}/metadata.json`, "update metadata");
    await addGcsObjectCheck(checks, context, bucket, `ota/ios/${runtimeVersion}/updates/${updateId}/expoConfig.json`, "update expoConfig");
  } else {
    checks.push({
      status: "FAIL",
      name: "pointer",
      detail: `gs://${bucket}/${pointerObject} is not readable: ${summarizeCommandFailure(pointerResult)}`,
    });
  }

  await addCommandCheck(checks, context, {
    name: "relay health",
    command: "curl",
    args: ["--fail", "--silent", "--show-error", relayHealthUrl],
    passDetail: `${relayHealthUrl} responded successfully`,
    failDetail: `${relayHealthUrl} failed`,
  });

  const manifestResult = await context.runner.run("curl", manifestCurlArgs(relayManifestUrl, runtimeVersion, channel), {
    cwd: context.repoRoot,
    env: context.env,
  });
  if (manifestResult.exitCode === 0) {
    checks.push({
      status: "PASS",
      name: "manifest",
      detail: `${relayManifestUrl} returned an Expo manifest response`,
    });
  } else if (!updateId) {
    checks.push({
      status: "FAIL",
      name: "manifest",
      detail: "relay reports no update for the channel; publish an OTA before human device apply verification",
    });
  } else {
    checks.push({
      status: "FAIL",
      name: "manifest",
      detail: `${relayManifestUrl} failed for update ${updateId}: ${summarizeCommandFailure(manifestResult)}`,
    });
  }

  await addCommandCheck(checks, context, {
    name: "secret",
    command: "gcloud",
    args: ["secrets", "describe", OTA_SECRET_NAME, "--project", projectId],
    passDetail: `${OTA_SECRET_NAME} exists in ${projectId}`,
    failDetail: `${OTA_SECRET_NAME} is missing or inaccessible in ${projectId}`,
  });

  const serviceAccountResult = await context.runner.run("gcloud", [
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
  const serviceAccount = serviceAccountResult.stdout.trim();
  if (serviceAccountResult.exitCode === 0 && serviceAccount.length > 0) {
    checks.push({
      status: "PASS",
      name: "relay service account",
      detail: serviceAccount,
    });
  } else {
    checks.push({
      status: "FAIL",
      name: "relay service account",
      detail: summarizeCommandFailure(serviceAccountResult),
    });
  }

  if (serviceAccount.length > 0) {
    await addIamPolicyCheck(checks, context, {
      name: "secret IAM",
      command: "gcloud",
      args: [
        "secrets",
        "get-iam-policy",
        OTA_SECRET_NAME,
        "--project",
        projectId,
        "--format=json",
      ],
      expectedRole: "roles/secretmanager.secretAccessor",
      expectedMember: `serviceAccount:${serviceAccount}`,
      passDetail: `${serviceAccount} can read ${OTA_SECRET_NAME}`,
      failDetail: `${serviceAccount} is not listed as a Secret Manager accessor for ${OTA_SECRET_NAME}`,
    });
    await addIamPolicyCheck(checks, context, {
      name: "GCS IAM",
      command: "gcloud",
      args: [
        "storage",
        "buckets",
        "get-iam-policy",
        `gs://${bucket}`,
        "--project",
        projectId,
        "--format=json",
      ],
      expectedRole: "roles/storage.objectViewer",
      expectedMember: `serviceAccount:${serviceAccount}`,
      passDetail: `${serviceAccount} can read gs://${bucket}`,
      failDetail: `${serviceAccount} is not listed as a Storage Object Viewer for gs://${bucket}`,
    });
  } else {
    checks.push({
      status: "FAIL",
      name: "secret IAM",
      detail: "skipped because the relay service account could not be resolved",
    });
    checks.push({
      status: "FAIL",
      name: "GCS IAM",
      detail: "skipped because the relay service account could not be resolved",
    });
  }

  checks.push({ name: "runtime channel pointers", ...await observeRuntimePointers(context, bucket, channel, runtimeVersion) });
  checks.push({ name: "device compatibility", ...await observeMobileDevices(context, channel, runtimeVersion, updateId) });
  const ok = checks.every((check) => check.status === "PASS");
  return {
    ok,
    message: formatDoctorMessage({
      environment,
      bucket,
      channel,
      runtimeVersion,
      relayManifestUrl,
      checks,
    }),
    data: { environment, bucket, channel, runtimeVersion, pointerObject, checks },
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
  const validateCertificate = context.validateOtaCertificate ?? validateMobileOtaCertificate;
  await validateCertificate({
    certificatePath: join(context.repoRoot, OTA_CERTIFICATE_RELATIVE_PATH),
    privateKeyPath: input.keyPath,
  });

  const secretName = OTA_SECRET_NAME;
  const projectId = identity.firebaseProjectId;
  await mustRun(context.runner, "gcloud", [
    "services",
    "enable",
    "secretmanager.googleapis.com",
    "--project",
    projectId,
  ], context.repoRoot, context.env);

  const describe = await context.runner.run("gcloud", [
    "secrets",
    "describe",
    secretName,
    "--project",
    projectId,
  ], { cwd: context.repoRoot, env: context.env });
  if (describe.exitCode !== 0) {
    if (!isNotFoundFailure(describe)) {
      throw new Error(summarizeCommandFailure(describe));
    }
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
      `keyid: ${OTA_KEY_ID}`,
      `relay VM: ${identity.gceVmName}`,
    ].join("\n"),
    data: { environment, projectId, secretName, keyId: OTA_KEY_ID },
  };
}

async function addGcsObjectCheck(
  checks: OtaDoctorCheck[],
  context: MobileOtaContext,
  bucket: string,
  object: string,
  name: string
): Promise<void> {
  const result = await context.runner.run("gcloud", [
    "storage",
    "cat",
    `gs://${bucket}/${object}`,
  ], { cwd: context.repoRoot, env: context.env });
  checks.push({
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    name,
    detail: result.exitCode === 0 ? `gs://${bucket}/${object} is readable` : summarizeCommandFailure(result),
  });
}

async function addCommandCheck(
  checks: OtaDoctorCheck[],
  context: MobileOtaContext,
  input: {
    name: string;
    command: string;
    args: string[];
    passDetail: string;
    failDetail: string;
  }
): Promise<void> {
  const result = await context.runner.run(input.command, input.args, {
    cwd: context.repoRoot,
    env: context.env,
  });
  checks.push({
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    name: input.name,
    detail: result.exitCode === 0 ? input.passDetail : `${input.failDetail}: ${summarizeCommandFailure(result)}`,
  });
}

async function addIamPolicyCheck(
  checks: OtaDoctorCheck[],
  context: MobileOtaContext,
  input: {
    name: string;
    command: string;
    args: string[];
    expectedRole: string;
    expectedMember: string;
    passDetail: string;
    failDetail: string;
  }
): Promise<void> {
  const result = await context.runner.run(input.command, input.args, {
    cwd: context.repoRoot,
    env: context.env,
  });
  const policy = parseIamPolicy(result.stdout);
  const hasBinding = policy?.bindings?.some((binding) =>
    binding.role === input.expectedRole && binding.members?.includes(input.expectedMember)
  ) === true;
  checks.push({
    status: result.exitCode === 0 && hasBinding ? "PASS" : "FAIL",
    name: input.name,
    detail: result.exitCode === 0 && hasBinding ? input.passDetail : `${input.failDetail}: ${summarizeCommandFailure(result)}`,
  });
}

function parseIamPolicy(stdout: string): IamPolicy | null {
  try {
    const parsed = JSON.parse(stdout) as IamPolicy;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parsePointer(stdout: string): OtaChannelPointer | null {
  try {
    const parsed = JSON.parse(stdout) as OtaChannelPointer;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeCommandFailure(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout || "command failed").trim();
}

function isNotFoundFailure(result: { stdout: string; stderr: string }): boolean {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return message.includes("not found") || message.includes("not_found") || message.includes("404");
}

async function executeMobileOtaHttpRequest(
  input: MobileOtaHttpRequestInput
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: JSON.stringify(input.body),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
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

function buildExpoPublicConfigCommand(
  repoRoot: string,
  environment: CloudEnvironmentName
): MobileOtaCommandPlan {
  return {
    command: "pnpm",
    args: ["exec", "expo", "config", "--type", "public", "--json"],
    cwd: join(repoRoot, "apps/mobile"),
    env: {
      KANNA_APP_ENV: environment === "staging" ? "staging" : "prod",
    },
  };
}

async function readExpoPublicConfig(
  repoRoot: string,
  environment: CloudEnvironmentName,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): Promise<Buffer> {
  const command = buildExpoPublicConfigCommand(repoRoot, environment);
  const result = await runner.run(command.command, command.args, {
    cwd: command.cwd,
    env: { ...env, ...command.env },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${command.command} ${command.args.join(" ")} failed.`
    );
  }
  try {
    JSON.parse(result.stdout);
  } catch {
    throw new Error("Expo public config command did not return valid JSON.");
  }
  return Buffer.from(result.stdout);
}

async function stageOtaUpdate(input: {
  distDir: string;
  expoConfigBytes: Buffer;
  source: ResolvedSourceRef;
}): Promise<{ path: string; updateId: string }> {
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
  await writeFile(join(output, "expoConfig.json"), input.expoConfigBytes);
  // Deliberately not part of metadata.json: updateId is the SHA-256 of that
  // file, and Expo clients read it, so the source record rides beside it.
  const sourceRecord: OtaSourceRecord = {
    updateId: stagedMetadata.updateId,
    ref: input.source.ref,
    commit: input.source.commit,
    shortCommit: input.source.shortCommit,
  };
  await writeFile(join(output, OTA_SOURCE_OBJECT), JSON.stringify(sourceRecord));
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

async function writePointerFile(input: {
  updateId: string;
  runtimeVersion: string;
  source?: ResolvedSourceRef;
}): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kanna-ota-pointer-"));
  const path = join(dir, "channel.json");
  const pointer: OtaChannelPointer = {
    currentUpdateId: input.updateId,
    createdAt: new Date().toISOString(),
    runtimeVersion: input.runtimeVersion,
    ...(input.source
      ? { sourceRef: input.source.ref, sourceCommit: input.source.commit }
      : {}),
  };
  await writeFile(path, JSON.stringify(pointer));
  return { path };
}

function normalizeAssetExtension(path: string): string | undefined {
  const extension = extname(path);
  if (extension) return extension.slice(1);
  const name = basename(path);
  return name.includes(".") ? name.split(".").pop() : undefined;
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
    ...(plan.source ? [formatSourceRef(plan.source)] : []),
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

function formatDoctorMessage(input: {
  environment: CloudEnvironmentName;
  bucket: string;
  channel: string;
  runtimeVersion: string;
  relayManifestUrl: string;
  checks: OtaDoctorCheck[];
}): string {
  return [
    `Mobile OTA ${input.environment} preflight`,
    `bucket: ${input.bucket}`,
    `channel: ${input.channel}`,
    `runtimeVersion: ${input.runtimeVersion}`,
    `manifest: ${input.relayManifestUrl}`,
    ...input.checks.map((check) => `${check.status} ${check.name}: ${check.detail}`),
    "writes: none",
    "Device reports describe last observed state; compatibility alone does not confirm application.",
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

function manifestCurlArgs(url: string, runtimeVersion: string, channel: string): string[] {
  return [
    "--fail",
    "--silent",
    "--show-error",
    "-H",
    "expo-protocol-version: 1",
    "-H",
    "expo-platform: ios",
    "-H",
    `expo-runtime-version: ${runtimeVersion}`,
    "-H",
    `expo-channel-name: ${channel}`,
    url,
  ];
}

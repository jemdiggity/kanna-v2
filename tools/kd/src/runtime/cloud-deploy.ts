import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudEnvironmentToKdEnvironment, resolveKdEnvironment } from "./environment";
import type { CommandRunner } from "./process";

interface Firebaserc {
  projects?: {
    staging?: string;
    production?: string;
  };
}

export type CloudDeployEnvironment = "staging" | "production";

export interface CloudDeployInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  environment: CloudDeployEnvironment;
}

export interface CloudDeployResult {
  projectId: string;
  deployed: boolean;
  relay?: RelayDeployResult;
}

export interface RelayDeployResult {
  projectId: string;
  vmName: string;
  zone: string;
  relayUrl: string;
}

export interface RelayCommandPlanStep {
  command: string;
  args: string[];
  cwd?: string;
  streamOutput?: boolean;
}

export interface RelayProvisionPlan {
  projectId: string;
  domain: string;
  vmName: string;
  zone: string;
  region: string;
  staticIpName: string;
  commands: RelayCommandPlanStep[];
}

export interface RelayDeployPlan {
  projectId: string;
  vmName: string;
  zone: string;
  relayUrl: string;
  artifactRegistryImage: string;
  commands: RelayCommandPlanStep[];
}

function assertCloudDeployEnvironment(environment: unknown): asserts environment is CloudDeployEnvironment {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("cloud deploy requires staging or production");
  }
}

export function resolveFirebaseProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  environment: CloudDeployEnvironment
): string {
  assertCloudDeployEnvironment(environment);

  const envVarName = environment === "staging"
    ? "KANNA_FIREBASE_STAGING_PROJECT"
    : "KANNA_FIREBASE_PRODUCTION_PROJECT";
  const envProject = env[envVarName]?.trim();
  if (envProject) {
    return envProject;
  }

  try {
    const firebaserc = JSON.parse(readFileSync(join(repoRoot, ".firebaserc"), "utf8")) as Firebaserc;
    const configuredProject = firebaserc.projects?.[environment]?.trim();
    if (configuredProject) {
      return configuredProject;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  return resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment)).firebaseProjectId;
}

export function resolveProductionFirebaseProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): string {
  return resolveFirebaseProject(repoRoot, env, "production");
}

async function assertCleanGitWorktree(repoRoot: string, runner: CommandRunner): Promise<void> {
  const status = await runner.run("git", ["status", "--porcelain"], { cwd: repoRoot });
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || status.stdout || "Failed to inspect git worktree status.");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      "Refusing to deploy cloud services from a dirty git worktree. Commit or stash changes first."
    );
  }
}

export async function deployFirebaseCloud(input: CloudDeployInput & { relay?: boolean }): Promise<CloudDeployResult> {
  assertCloudDeployEnvironment(input.environment);

  const projectId = resolveFirebaseProject(input.repoRoot, input.env, input.environment);
  await assertCleanGitWorktree(input.repoRoot, input.runner);
  const build = await input.runner.run("pnpm", ["--dir", "services/firebase-functions", "build"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (build.exitCode !== 0) {
    throw new Error(build.stderr || build.stdout || "Firebase functions build failed.");
  }

  const deploy = await input.runner.run(
    "pnpm",
    [
      "exec",
      "firebase",
      "deploy",
      "--only",
      "functions,firestore:rules,firestore:indexes",
      "--project",
      projectId,
      "--force"
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (deploy.exitCode !== 0) {
    throw new Error(deploy.stderr || deploy.stdout || "Firebase deploy failed.");
  }

  const result: CloudDeployResult = { projectId, deployed: true };
  if (input.relay) {
    result.relay = await deployRelayCloud(input);
  }
  return result;
}

export async function deployRelayCloud(input: CloudDeployInput): Promise<RelayDeployResult> {
  assertCloudDeployEnvironment(input.environment);

  const plan = buildRelayDeployPlan({
    repoRoot: input.repoRoot,
    environment: input.environment
  });
  for (const step of plan.commands) {
    const result = await input.runner.run(step.command, step.args, {
      cwd: step.cwd,
      env: input.env,
      streamOutput: step.streamOutput
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Relay VM deploy step failed: ${step.command} ${step.args.join(" ")}`);
    }
  }
  return {
    projectId: plan.projectId,
    vmName: plan.vmName,
    zone: plan.zone,
    relayUrl: plan.relayUrl
  };
}

export function buildRelayProvisionPlan(input: { environment: CloudDeployEnvironment }): RelayProvisionPlan {
  assertCloudDeployEnvironment(input.environment);

  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(input.environment));
  if (!identity.relayDomain || !identity.gceVmName) {
    throw new Error(`Relay VM provisioning is not configured for ${input.environment}.`);
  }

  const projectId = identity.firebaseProjectId;
  const region = "us-central1";
  const zone = "us-central1-a";
  const vmName = identity.gceVmName;
  const staticIpName = identity.staticIpName ?? `${vmName}-ip`;
  const tag = vmName;
  const serviceAccountId = vmName;
  const serviceAccountEmail = `${serviceAccountId}@${projectId}.iam.gserviceaccount.com`;
  const startupScript = buildRelayStartupScript();

  return {
    projectId,
    domain: identity.relayDomain,
    vmName,
    zone,
    region,
    staticIpName,
    commands: [
      {
        command: "gcloud",
        args: [
          "services",
          "enable",
          "compute.googleapis.com",
          "--project",
          projectId
        ]
      },
      {
        command: "gcloud",
        args: [
          "iam",
          "service-accounts",
          "create",
          serviceAccountId,
          "--project",
          projectId,
          "--display-name",
          `Kanna relay VM (${input.environment})`
        ]
      },
      ...[
        "roles/datastore.user",
        "roles/artifactregistry.reader",
        "roles/storage.objectViewer",
        "roles/firebasecloudmessaging.admin"
      ].map((role): RelayCommandPlanStep => ({
        command: "gcloud",
        args: [
          "projects",
          "add-iam-policy-binding",
          projectId,
          "--member",
          `serviceAccount:${serviceAccountEmail}`,
          "--role",
          role,
          "--condition=None"
        ]
      })),
      {
        command: "gcloud",
        args: [
          "compute",
          "addresses",
          "create",
          staticIpName,
          "--project",
          projectId,
          "--region",
          region
        ]
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "instances",
          "create",
          vmName,
          "--project",
          projectId,
          "--zone",
          zone,
          "--machine-type",
          "e2-micro",
          "--service-account",
          serviceAccountEmail,
          "--scopes",
          "https://www.googleapis.com/auth/cloud-platform",
          "--address",
          staticIpName,
          "--tags",
          tag,
          "--metadata",
          [
            `kanna-relay-domain=${identity.relayDomain}`,
            `firebase-project-id=${projectId}`,
            `startup-script=${startupScript}`
          ].join(",")
        ]
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "firewall-rules",
          "create",
          `allow-${vmName}-web`,
          "--project",
          projectId,
          "--allow",
          "tcp:80,tcp:443",
          "--target-tags",
          tag,
          "--description",
          `Allow HTTP and HTTPS for Kanna ${input.environment} relay`
        ]
      }
    ]
  };
}

export function buildRelayDeployPlan(input: {
  repoRoot: string;
  environment: CloudDeployEnvironment;
}): RelayDeployPlan {
  assertCloudDeployEnvironment(input.environment);

  const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(input.environment));
  if (!identity.relayDomain || !identity.gceVmName || !identity.artifactRegistryImage) {
    throw new Error(`Relay VM deploy is not configured for ${input.environment}.`);
  }

  const projectId = identity.firebaseProjectId;
  const otaBucket = identity.otaBucket;
  if (!otaBucket) {
    throw new Error(`Relay VM deploy is missing an OTA bucket for ${input.environment}.`);
  }
  const zone = "us-central1-a";
  const deployDir = join(input.repoRoot, "services/relay/deploy");
  const registryHost = getArtifactRegistryHost(identity.artifactRegistryImage);

  return {
    projectId,
    vmName: identity.gceVmName,
    zone,
    relayUrl: identity.relayUrl,
    artifactRegistryImage: identity.artifactRegistryImage,
    commands: [
      {
        command: "gcloud",
        args: [
          "builds",
          "submit",
          "--project",
          projectId,
          "--config",
          "services/relay/cloudbuild.yaml",
          "--substitutions",
          `_IMAGE=${identity.artifactRegistryImage}`,
          "."
        ],
        cwd: input.repoRoot,
        streamOutput: true
      },
      {
        // The startup script creates /opt/kanna-relay as root; make it writable
        // by the scp user for deploy asset uploads.
        command: "gcloud",
        args: [
          "compute",
          "ssh",
          identity.gceVmName,
          "--project",
          projectId,
          "--zone",
          zone,
          "--command",
          'sudo mkdir -p /opt/kanna-relay && sudo chown -R "$(id -un):$(id -gn)" /opt/kanna-relay'
        ],
        cwd: input.repoRoot,
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "scp",
          "--project",
          projectId,
          "--zone",
          zone,
          join(deployDir, "docker-compose.yml"),
          join(deployDir, "Caddyfile"),
          `${identity.gceVmName}:/opt/kanna-relay/`
        ],
        cwd: input.repoRoot,
        streamOutput: true
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "ssh",
          identity.gceVmName,
          "--project",
          projectId,
          "--zone",
          zone,
          "--command",
          buildRemoteRelayDeployCommand({
            domain: identity.relayDomain,
            projectId,
            image: identity.artifactRegistryImage,
            registryHost,
            otaBucket
          })
        ],
        cwd: input.repoRoot,
        streamOutput: true
      }
    ]
  };
}

function getArtifactRegistryHost(image: string): string {
  const [host] = image.split("/");
  if (!host) {
    throw new Error(`Invalid Artifact Registry image ref: ${image}`);
  }
  return host;
}

function buildRemoteRelayDeployCommand(input: {
  domain: string;
  projectId: string;
  image: string;
  registryHost: string;
  otaBucket: string;
}): string {
  return [
    "cd /opt/kanna-relay",
    "TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')",
    "SECRET_NAME=kanna-mobile-ota-private-key-pem",
    "SECRET_DATA=$(curl -fsS -H \"Authorization: Bearer $TOKEN\" \"https://secretmanager.googleapis.com/v1/projects/" + input.projectId + "/secrets/$SECRET_NAME/versions/latest:access\" | sed -n 's/.*\"data\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')",
    "test -n \"$SECRET_DATA\"",
    "printf '%s' \"$SECRET_DATA\" | base64 -d > .ota-private-key.tmp",
    "sudo install -m 0444 .ota-private-key.tmp /opt/kanna-relay/ota-private-key.pem",
    "rm .ota-private-key.tmp",
    `printf '%s' "$TOKEN" | docker login -u oauth2accesstoken --password-stdin https://${input.registryHost}`,
    "cat > .env.tmp <<'KANNA_RELAY_ENV'",
    `KANNA_RELAY_DOMAIN=${input.domain}`,
    `FIREBASE_PROJECT_ID=${input.projectId}`,
    `KANNA_RELAY_IMAGE=${input.image}`,
    `KANNA_OTA_BUCKET=${input.otaBucket}`,
    "KANNA_OTA_KEY_ID=kanna-mobile-ota-v1",
    "KANNA_OTA_PRIVATE_KEY_PATH=/run/secrets/kanna_ota_private_key.pem",
    "KANNA_RELAY_ENV",
    "sudo install -m 0644 .env.tmp /opt/kanna-relay/.env",
    "rm .env.tmp",
    "docker compose pull",
    "docker compose up -d"
  ].join("\n");
}

function buildRelayStartupScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y ca-certificates curl gnupg",
    "install -m 0755 -d /etc/apt/keyrings",
    "if [ ! -f /etc/apt/keyrings/docker.gpg ]; then",
    "  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
    "  chmod a+r /etc/apt/keyrings/docker.gpg",
    "fi",
    ". /etc/os-release",
    "echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable\" > /etc/apt/sources.list.d/docker.list",
    "apt-get update",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    "systemctl enable --now docker",
    "mkdir -p /opt/kanna-relay",
    "docker pull caddy:2-alpine"
  ].join("\n");
}

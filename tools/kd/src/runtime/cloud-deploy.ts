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
      "functions,firestore:rules",
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
  const staticIpName = `${vmName}-ip`;
  const tag = vmName;
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
  if (!identity.relayDomain || !identity.gceVmName) {
    throw new Error(`Relay VM deploy is not configured for ${input.environment}.`);
  }

  const projectId = identity.firebaseProjectId;
  const zone = "us-central1-a";
  const deployDir = join(input.repoRoot, "services/relay/deploy");

  return {
    projectId,
    vmName: identity.gceVmName,
    zone,
    relayUrl: identity.relayUrl,
    commands: [
      {
        command: "pnpm",
        args: ["--dir", "services/relay", "build"],
        cwd: input.repoRoot
      },
      {
        command: "gcloud",
        args: [
          "compute",
          "scp",
          "--recurse",
          "--project",
          projectId,
          "--zone",
          zone,
          join(input.repoRoot, "package.json"),
          join(input.repoRoot, "pnpm-lock.yaml"),
          join(input.repoRoot, "pnpm-workspace.yaml"),
          join(input.repoRoot, "services/relay"),
          join(input.repoRoot, "tools/kd/package.json"),
          `${identity.gceVmName}:/opt/kanna-relay/source/`
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
          join(deployDir, "startup-script.sh"),
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
          buildRemoteRelayDeployCommand(identity.relayDomain, projectId)
        ],
        cwd: input.repoRoot,
        streamOutput: true
      }
    ]
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildRemoteRelayDeployCommand(domain: string, projectId: string): string {
  const script = [
    "touch .env",
    'grep -v -E "^(KANNA_RELAY_DOMAIN|FIREBASE_PROJECT_ID)=" .env > .env.tmp',
    `printf "%s\\n" ${shellQuote(`KANNA_RELAY_DOMAIN=${domain}`)} ${shellQuote(`FIREBASE_PROJECT_ID=${projectId}`)} >> .env.tmp`,
    "mv .env.tmp .env",
    "docker compose up --build -d"
  ].join(" && ");
  return `cd /opt/kanna-relay && sudo sh -c ${shellQuote(script)}`;
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
    "mkdir -p /opt/kanna-relay/source",
    "docker pull caddy:2-alpine"
  ].join("\n");
}

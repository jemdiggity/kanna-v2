import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  serviceName: string;
  region: string;
  image: string;
  serviceUrl: string;
  relayUrl: string;
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

  throw new Error(
    `No ${environment} Firebase project configured. Set ${envVarName} or add projects.${environment} to .firebaserc.`
  );
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

  const projectId = resolveFirebaseProject(input.repoRoot, input.env, input.environment);
  const region = input.env.KANNA_CLOUD_RUN_REGION?.trim() || "us-central1";
  const serviceName = input.env.KANNA_RELAY_SERVICE_NAME?.trim() || "kanna-relay";
  const image = `gcr.io/${projectId}/${serviceName}`;

  const build = await input.runner.run("pnpm", ["--dir", "services/relay", "build"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (build.exitCode !== 0) {
    throw new Error(build.stderr || build.stdout || "Relay build failed.");
  }

  const submit = await input.runner.run(
    "gcloud",
    [
      "builds",
      "submit",
      ".",
      "--project",
      projectId,
      "--config",
      "services/relay/cloudbuild.yaml",
      "--substitutions",
      `_IMAGE=${image}`
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (submit.exitCode !== 0) {
    throw new Error(submit.stderr || submit.stdout || "Relay Cloud Build submit failed.");
  }

  const deploy = await input.runner.run(
    "gcloud",
    [
      "run",
      "deploy",
      serviceName,
      "--project",
      projectId,
      "--image",
      image,
      "--region",
      region,
      "--platform",
      "managed",
      "--allow-unauthenticated",
      "--set-env-vars",
      `FIREBASE_PROJECT_ID=${projectId}`
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (deploy.exitCode !== 0) {
    throw new Error(deploy.stderr || deploy.stdout || "Relay Cloud Run deploy failed.");
  }

  const describe = await input.runner.run(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      serviceName,
      "--project",
      projectId,
      "--region",
      region,
      "--platform",
      "managed",
      "--format",
      "value(status.url)"
    ],
    { cwd: input.repoRoot, env: input.env }
  );
  if (describe.exitCode !== 0) {
    throw new Error(describe.stderr || describe.stdout || "Relay Cloud Run describe failed.");
  }

  const serviceUrl = describe.stdout.trim();
  if (!serviceUrl) {
    throw new Error("Relay Cloud Run deploy succeeded but no service URL was returned.");
  }

  return {
    projectId,
    serviceName,
    region,
    image,
    serviceUrl,
    relayUrl: serviceUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://")
  };
}

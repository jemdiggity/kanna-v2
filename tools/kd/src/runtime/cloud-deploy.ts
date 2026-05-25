import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./process";

interface Firebaserc {
  projects?: {
    production?: string;
  };
}

export interface CloudDeployInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  production: boolean;
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

export function resolveProductionFirebaseProject(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): string {
  const envProject = env.KANNA_FIREBASE_PRODUCTION_PROJECT?.trim();
  if (envProject) {
    return envProject;
  }

  try {
    const firebaserc = JSON.parse(readFileSync(join(repoRoot, ".firebaserc"), "utf8")) as Firebaserc;
    const productionProject = firebaserc.projects?.production?.trim();
    if (productionProject) {
      return productionProject;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(
    "No production Firebase project configured. Set KANNA_FIREBASE_PRODUCTION_PROJECT or add projects.production to .firebaserc."
  );
}

export async function deployFirebaseCloud(input: CloudDeployInput & { relay?: boolean }): Promise<CloudDeployResult> {
  if (!input.production) {
    throw new Error("Refusing to deploy cloud services without --production.");
  }

  const projectId = resolveProductionFirebaseProject(input.repoRoot, input.env);
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
    { cwd: input.repoRoot, env: input.env }
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
  if (!input.production) {
    throw new Error("Refusing to deploy relay without --production.");
  }

  const projectId = resolveProductionFirebaseProject(input.repoRoot, input.env);
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
    { cwd: input.repoRoot, env: input.env }
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
    { cwd: input.repoRoot, env: input.env }
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

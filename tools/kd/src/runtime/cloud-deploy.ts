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
  vmName: string;
  zone: string;
  image: string;
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
  // Reject staging relay requests before any git check, build, or deploy runs
  // so the Firebase staging deploy is never mutated as a partial outcome.
  if (input.relay && input.environment === "staging") {
    throw new Error(
      "staging relay is retired; use the local relay via emulators (ws://127.0.0.1:18080)."
    );
  }

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
  if (input.environment === "staging") {
    throw new Error(
      "staging relay is retired; use the local relay via emulators (ws://127.0.0.1:18080)."
    );
  }

  const projectId = resolveFirebaseProject(input.repoRoot, input.env, input.environment);
  const vmName = input.env.KANNA_RELAY_VM_NAME?.trim() || "kanna-relay-vm";
  const zone = input.env.KANNA_RELAY_VM_ZONE?.trim() || "us-central1-a";
  const hostname = input.env.KANNA_RELAY_HOSTNAME?.trim() || "relay.kanna.build";
  const image = `gcr.io/${projectId}/kanna-relay`;
  if (projectId !== "kanna-build") {
    throw new Error(
      `Relay VM compose stack pins gcr.io/kanna-build/kanna-relay; deploying for project ${projectId} would run a stale image. Update services/relay/deploy/compose.yaml first.`
    );
  }

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

  // Ship the deploy stack (compose.yaml, Caddyfile, vm-deploy.sh) so the repo
  // stays the source of truth for what runs on the VM. The destination is
  // recreated first: scp's directory semantics differ depending on whether
  // the destination already exists, so copy named files into a fresh dir.
  const prep = await input.runner.run(
    "gcloud",
    [
      "compute",
      "ssh",
      vmName,
      "--project",
      projectId,
      "--zone",
      zone,
      "--command",
      "rm -rf ~/kanna-relay && mkdir -p ~/kanna-relay"
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (prep.exitCode !== 0) {
    throw new Error(prep.stderr || prep.stdout || "Relay VM deploy-dir prep failed.");
  }

  const scp = await input.runner.run(
    "gcloud",
    [
      "compute",
      "scp",
      "services/relay/deploy/compose.yaml",
      "services/relay/deploy/Caddyfile",
      "services/relay/deploy/vm-deploy.sh",
      `${vmName}:~/kanna-relay/`,
      "--project",
      projectId,
      "--zone",
      zone
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (scp.exitCode !== 0) {
    throw new Error(scp.stderr || scp.stdout || "Relay deploy file transfer failed.");
  }

  const ssh = await input.runner.run(
    "gcloud",
    [
      "compute",
      "ssh",
      vmName,
      "--project",
      projectId,
      "--zone",
      zone,
      "--command",
      "sudo bash ~/kanna-relay/vm-deploy.sh"
    ],
    { cwd: input.repoRoot, env: input.env, streamOutput: true }
  );
  if (ssh.exitCode !== 0) {
    throw new Error(ssh.stderr || ssh.stdout || "Relay VM deploy failed.");
  }

  return { projectId, vmName, zone, image, relayUrl: `wss://${hostname}` };
}

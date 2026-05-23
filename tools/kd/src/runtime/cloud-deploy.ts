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

export async function deployFirebaseCloud(input: CloudDeployInput): Promise<CloudDeployResult> {
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

  return { projectId, deployed: true };
}

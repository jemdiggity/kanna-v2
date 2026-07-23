import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { CommandRunner } from "./process";

export const RELEASE_ENV_FILE = ".env.release.local";

export interface LoadReleaseEnvironmentInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

function validateDotenv(source: string, envPath: string): void {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) {
      throw new Error(`Invalid dotenv assignment at ${envPath}:${index + 1}`);
    }
    const value = assignment[1] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !value.slice(1).endsWith(quote)) {
      throw new Error(`Unterminated quoted value at ${envPath}:${index + 1}`);
    }
  }
}

async function resolvePrimaryRepoRoot(input: LoadReleaseEnvironmentInput): Promise<string> {
  const result = await input.runner.run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: input.repoRoot, env: input.env }
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to resolve the Git common directory.");
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new Error("Git returned an empty common directory.");
  }
  return dirname(commonDir);
}

export async function loadReleaseEnvironment(
  input: LoadReleaseEnvironmentInput
): Promise<NodeJS.ProcessEnv> {
  const primaryRoot = await resolvePrimaryRepoRoot(input);
  const envPath = join(primaryRoot, RELEASE_ENV_FILE);
  if (!existsSync(envPath)) {
    return { ...input.env };
  }

  try {
    const source = readFileSync(envPath, "utf8");
    validateDotenv(source, envPath);
    const fileEnv = parseEnv(source);
    const inherited = Object.fromEntries(
      Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return { ...fileEnv, ...inherited };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load release environment ${envPath}: ${message}`);
  }
}

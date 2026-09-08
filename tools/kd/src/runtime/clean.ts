import { lstatSync, rmSync } from "node:fs";
import { appCacheDir } from "../context";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { CommandResult, CommandRunner } from "./process";
import {
  EXTERNAL_WORKSPACE_BUILD_RECORD,
  resolveExternalWorkspaceBuild,
  WORKSPACE_BUILD_DIRECTORY
} from "./workspace-build";

export interface CleanInput {
  repoRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  runner: CommandRunner;
  all: boolean;
  dry: boolean;
  sharedRustBuild: boolean;
}

export interface CleanRemoval {
  path: string;
  removed: boolean;
  dryRun: boolean;
}

export interface CleanResult {
  removals: CleanRemoval[];
  bazelOutputBase: string;
}

export async function resolveBazelOutputBase(input: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<string> {
  let result: CommandResult;
  try {
    result = await input.runner.run("bazel", ["info", "output_base"], {
      cwd: input.repoRoot,
      env: input.env
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[kd] Cannot resolve Bazel output base: \`bazel info output_base\` could not run (${detail}).`);
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`[kd] Cannot resolve Bazel output base: \`bazel info output_base\` failed (${detail}).`);
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("[kd] Cannot resolve Bazel output base: `bazel info output_base` returned no path.");
  }
  if (lines.length !== 1 || !isAbsolute(lines[0] ?? "")) {
    throw new Error("[kd] Cannot resolve Bazel output base: `bazel info output_base` did not return one absolute path.");
  }

  const outputBase = resolve(lines[0] ?? "");
  if (outputBase === parse(outputBase).root || outputBase === resolve(input.repoRoot)) {
    throw new Error(`[kd] Refusing to clean unsafe Bazel output base ${outputBase}.`);
  }
  return outputBase;
}

function removePath(path: string, dry: boolean, requirePresent = false): CleanRemoval | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (requirePresent) {
      throw new Error(`[kd] Cannot clean external .build target ${path}: the resolved target became unavailable`);
    }
    return null;
  }
  if (!dry) {
    rmSync(path, { recursive: true, force: !requirePresent });
  }
  return { path, removed: !dry, dryRun: dry };
}

export async function cleanWorkspace(input: CleanInput): Promise<CleanResult> {
  const homeDir = input.homeDir ?? homedir();
  const bazelOutputBase = await resolveBazelOutputBase(input);
  const externalWorkspaceBuild = resolveExternalWorkspaceBuild(input.repoRoot);
  const candidates: Array<{ path: string; requirePresent?: boolean }> = [
    ...(externalWorkspaceBuild ? [{ path: externalWorkspaceBuild, requirePresent: true }] : []),
    { path: join(input.repoRoot, WORKSPACE_BUILD_DIRECTORY) },
    { path: join(input.repoRoot, EXTERNAL_WORKSPACE_BUILD_RECORD) },
    { path: join(input.repoRoot, "apps", "desktop", "src-tauri", "target") },
    { path: bazelOutputBase }
  ];

  if (input.sharedRustBuild) {
    // Same directory `resolveKdContext` treats as the legacy shared build
    // dir; if these two disagree, `kd clean` silently leaves it behind.
    candidates.push({
      path: join(appCacheDir(homeDir, process.env, process.platform), "kanna", "rust-build")
    });
  }

  if (input.all) {
    candidates.push(
      { path: join(input.repoRoot, "apps", "desktop", "dist") },
      { path: join(input.repoRoot, "node_modules") },
      { path: join(input.repoRoot, "apps", "desktop", "node_modules") },
      { path: join(input.repoRoot, "packages", "core", "node_modules") },
      { path: join(input.repoRoot, "packages", "db", "node_modules") },
      { path: join(input.repoRoot, ".turbo") }
    );
  }

  return {
    bazelOutputBase,
    removals: candidates
      .map(({ path, requirePresent }) => removePath(path, input.dry, requirePresent))
      .filter((removal): removal is CleanRemoval => removal !== null)
  };
}

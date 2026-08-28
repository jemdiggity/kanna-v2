import { lstatSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  EXTERNAL_WORKSPACE_BUILD_RECORD,
  resolveExternalWorkspaceBuild,
  WORKSPACE_BUILD_DIRECTORY
} from "./workspace-build";

export interface CleanInput {
  repoRoot: string;
  homeDir?: string;
  userName?: string;
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
}

export function bazelOutputBase(repoRoot: string, homeDir = homedir(), userName = userInfo().username): string {
  const hash = createHash("md5").update(repoRoot).digest("hex");
  return join(homeDir, "Library", "Caches", "bazel", `_bazel_${userName}`, hash);
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

export function cleanWorkspace(input: CleanInput): CleanResult {
  const homeDir = input.homeDir ?? homedir();
  const externalWorkspaceBuild = resolveExternalWorkspaceBuild(input.repoRoot);
  const candidates: Array<{ path: string; requirePresent?: boolean }> = [
    ...(externalWorkspaceBuild ? [{ path: externalWorkspaceBuild, requirePresent: true }] : []),
    { path: join(input.repoRoot, WORKSPACE_BUILD_DIRECTORY) },
    { path: join(input.repoRoot, EXTERNAL_WORKSPACE_BUILD_RECORD) },
    { path: join(input.repoRoot, "apps", "desktop", "src-tauri", "target") },
    { path: bazelOutputBase(input.repoRoot, homeDir, input.userName ?? userInfo().username) }
  ];

  if (input.sharedRustBuild) {
    candidates.push({ path: join(homeDir, "Library", "Caches", "kanna", "rust-build") });
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
    removals: candidates
      .map(({ path, requirePresent }) => removePath(path, input.dry, requirePresent))
      .filter((removal): removal is CleanRemoval => removal !== null)
  };
}

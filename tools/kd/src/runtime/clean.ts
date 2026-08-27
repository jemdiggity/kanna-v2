import { lstatSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
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

function removePath(path: string, dry: boolean): CleanRemoval | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  if (!dry) {
    rmSync(path, { recursive: true, force: true });
  }
  return { path, removed: !dry, dryRun: dry };
}

export function cleanWorkspace(input: CleanInput): CleanResult {
  const homeDir = input.homeDir ?? homedir();
  const externalWorkspaceBuild = resolveExternalWorkspaceBuild(input.repoRoot);
  const candidates = [
    ...(externalWorkspaceBuild ? [externalWorkspaceBuild] : []),
    join(input.repoRoot, WORKSPACE_BUILD_DIRECTORY),
    join(input.repoRoot, "apps", "desktop", "src-tauri", "target"),
    bazelOutputBase(input.repoRoot, homeDir, input.userName ?? userInfo().username)
  ];

  if (input.sharedRustBuild) {
    candidates.push(join(homeDir, "Library", "Caches", "kanna", "rust-build"));
  }

  if (input.all) {
    candidates.push(
      join(input.repoRoot, "apps", "desktop", "dist"),
      join(input.repoRoot, "node_modules"),
      join(input.repoRoot, "apps", "desktop", "node_modules"),
      join(input.repoRoot, "packages", "core", "node_modules"),
      join(input.repoRoot, "packages", "db", "node_modules"),
      join(input.repoRoot, ".turbo")
    );
  }

  return {
    removals: candidates
      .map((path) => removePath(path, input.dry))
      .filter((removal): removal is CleanRemoval => removal !== null)
  };
}

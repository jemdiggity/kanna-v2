import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export const WORKSPACE_BUILD_DIRECTORY = ".build";

function tryLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isOutside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ".." || pathFromParent.startsWith(`..${sep}`);
}

/**
 * Resolves the external Cargo build directory recorded by workspace setup.
 *
 * The `.build` symlink is the path Cargo actually consumes, so it is the
 * authoritative handoff between the machine-local setup hook and kd cleanup.
 * Cleanup deliberately does not reimplement the hook's machine-local root
 * calculation. Before returning an external target, it binds the last path
 * component to this exact workspace identity and refuses symlink chains.
 */
export function resolveExternalWorkspaceBuild(repoRoot: string): string | undefined {
  const workspaceRoot = resolve(repoRoot);
  const localBuild = resolve(workspaceRoot, WORKSPACE_BUILD_DIRECTORY);
  const localBuildStats = tryLstat(localBuild);
  if (!localBuildStats?.isSymbolicLink()) return undefined;

  const recordedTarget = readlinkSync(localBuild);
  const target = resolve(dirname(localBuild), recordedTarget);
  if (!isOutside(workspaceRoot, target)) return undefined;

  const workspaceName = basename(workspaceRoot);
  if (basename(target) !== workspaceName) {
    throw new Error(
      `[kd] Refusing to clean external .build target ${target}: expected an exact workspace target ending in ${workspaceName}`
    );
  }

  const targetStats = tryLstat(target);
  if (!targetStats) {
    throw new Error(
      `[kd] Cannot clean external .build target ${target}: the recorded target is unavailable; preserving ${localBuild}`
    );
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new Error(
      `[kd] Refusing to clean external .build target ${target}: target must be a real directory`
    );
  }

  const canonicalTarget = realpathSync(target);
  if (basename(canonicalTarget) !== workspaceName) {
    throw new Error(
      `[kd] Refusing to clean external .build target ${target}: resolved path does not match workspace ${workspaceName}`
    );
  }
  return canonicalTarget;
}

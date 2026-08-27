import { lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const WORKSPACE_BUILD_DIRECTORY = ".build";
export const EXTERNAL_WORKSPACE_BUILD_RECORD = ".kanna-external-build-target";

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
 * The machine-local setup hook records the target separately from `.build`, so
 * an unavailable volume can use a local `.build` fallback without losing the
 * cleanup contract. Legacy workspaces without that record still resolve their
 * symlink. Cleanup deliberately does not reimplement the hook's machine-local
 * root calculation. Before returning an external target, it binds the last
 * path component to this exact workspace identity and refuses symlink chains.
 */
export function resolveExternalWorkspaceBuild(repoRoot: string): string | undefined {
  const workspaceRoot = resolve(repoRoot);
  const localBuild = resolve(workspaceRoot, WORKSPACE_BUILD_DIRECTORY);
  const targetRecord = resolve(workspaceRoot, EXTERNAL_WORKSPACE_BUILD_RECORD);
  const localBuildStats = tryLstat(localBuild);
  const targetRecordStats = tryLstat(targetRecord);

  let recordedTarget: string;
  if (targetRecordStats) {
    if (!targetRecordStats.isFile() || targetRecordStats.isSymbolicLink()) {
      throw new Error(`[kd] Refusing external .build target record ${targetRecord}: expected a regular file`);
    }
    recordedTarget = readFileSync(targetRecord, "utf8").trim();
    if (!recordedTarget || recordedTarget.includes("\n") || !isAbsolute(recordedTarget)) {
      throw new Error(`[kd] Refusing external .build target record ${targetRecord}: expected one absolute path`);
    }

    if (localBuildStats?.isSymbolicLink()) {
      const linkedTarget = resolve(dirname(localBuild), readlinkSync(localBuild));
      if (linkedTarget !== resolve(recordedTarget)) {
        throw new Error(
          `[kd] Refusing to clean external .build target: ${targetRecord} and ${localBuild} disagree`
        );
      }
    }
  } else {
    if (!localBuildStats?.isSymbolicLink()) return undefined;
    recordedTarget = readlinkSync(localBuild);
  }

  const target = resolve(dirname(localBuild), recordedTarget);
  if (!isOutside(workspaceRoot, target)) {
    if (targetRecordStats) {
      throw new Error(`[kd] Refusing external .build target record ${targetRecord}: target must be outside the workspace`);
    }
    return undefined;
  }

  const workspaceName = basename(workspaceRoot);
  if (basename(target) !== workspaceName) {
    throw new Error(
      `[kd] Refusing to clean external .build target ${target}: expected an exact workspace target ending in ${workspaceName}`
    );
  }

  const targetStats = tryLstat(target);
  if (!targetStats) {
    throw new Error(
      `[kd] Cannot clean external .build target ${target}: the recorded target is unavailable; preserving ${targetRecordStats ? targetRecord : localBuild}`
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

import {
  linkSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { randomUUID } from "node:crypto";
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

function validateWorkspaceBuildTarget(
  workspaceRoot: string,
  recordedTarget: string,
  operation: "clean" | "migrate"
): string | undefined {
  const localBuild = resolve(workspaceRoot, WORKSPACE_BUILD_DIRECTORY);
  const target = resolve(dirname(localBuild), recordedTarget);
  if (!isOutside(workspaceRoot, target)) {
    return undefined;
  }

  const workspaceName = basename(workspaceRoot);
  if (basename(target) !== workspaceName) {
    const action = operation === "clean" ? "Refusing to clean" : "Refusing";
    throw new Error(
      `[kd] ${action} external .build target ${target}: expected an exact workspace target ending in ${workspaceName}`
    );
  }
  return target;
}

function validateAvailableWorkspaceBuildTarget(
  target: string,
  workspaceName: string,
  operation: "clean" | "migrate"
): string | undefined {
  const targetStats = tryLstat(target);
  if (!targetStats) return undefined;
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    const action = operation === "clean" ? "Refusing to clean" : "Refusing";
    throw new Error(`[kd] ${action} external .build target ${target}: target must be a real directory`);
  }

  const canonicalTarget = realpathSync(target);
  if (basename(canonicalTarget) !== workspaceName) {
    const action = operation === "clean" ? "Refusing to clean" : "Refusing";
    throw new Error(
      `[kd] ${action} external .build target ${target}: resolved path does not match workspace ${workspaceName}`
    );
  }
  return canonicalTarget;
}

export type LegacyWorkspaceBuildMigrationStatus = "absent" | "already-recorded" | "migrated";

export interface LegacyWorkspaceBuildMigration {
  status: LegacyWorkspaceBuildMigrationStatus;
  record: string;
  target?: string;
}

/**
 * Persists cleanup knowledge from a pre-record `.build` symlink before an
 * installed machine-local hook can replace a dangling link with local storage.
 * The target comes only from that link and uses cleanup's workspace-identity
 * contract; an unavailable target is safe to record and will fail visibly if
 * teardown reaches it before the volume returns.
 */
export function migrateLegacyExternalWorkspaceBuild(repoRoot: string): LegacyWorkspaceBuildMigration {
  const workspaceRoot = resolve(repoRoot);
  const localBuild = resolve(workspaceRoot, WORKSPACE_BUILD_DIRECTORY);
  const targetRecord = resolve(workspaceRoot, EXTERNAL_WORKSPACE_BUILD_RECORD);
  if (tryLstat(targetRecord)) {
    return { status: "already-recorded", record: targetRecord };
  }

  const localBuildStats = tryLstat(localBuild);
  if (!localBuildStats?.isSymbolicLink()) {
    return { status: "absent", record: targetRecord };
  }

  const target = validateWorkspaceBuildTarget(workspaceRoot, readlinkSync(localBuild), "migrate");
  if (!target) {
    return { status: "absent", record: targetRecord };
  }
  validateAvailableWorkspaceBuildTarget(target, basename(workspaceRoot), "migrate");

  const temporaryRecord = `${targetRecord}.${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryRecord, `${target}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporaryRecord, targetRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && tryLstat(targetRecord)) {
      throw new Error(`[kd] Refusing to replace external .build target record ${targetRecord}`);
    }
    throw error;
  } finally {
    rmSync(temporaryRecord, { force: true });
  }

  return { status: "migrated", record: targetRecord, target };
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

  const target = validateWorkspaceBuildTarget(workspaceRoot, recordedTarget, "clean");
  if (!target) {
    if (targetRecordStats) {
      throw new Error(`[kd] Refusing external .build target record ${targetRecord}: target must be outside the workspace`);
    }
    return undefined;
  }
  const workspaceName = basename(workspaceRoot);
  const canonicalTarget = validateAvailableWorkspaceBuildTarget(target, workspaceName, "clean");
  if (!canonicalTarget) {
    throw new Error(
      `[kd] Cannot clean external .build target ${target}: the recorded target is unavailable; preserving ${targetRecordStats ? targetRecord : localBuild}`
    );
  }
  return canonicalTarget;
}

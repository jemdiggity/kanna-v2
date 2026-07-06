export interface AppBuildInfo {
  version: string;
  branch: string;
  commitHash: string;
  taskId?: string;
  worktree: string;
}

function pushUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

export function formatAppWindowTitle(info: AppBuildInfo): string | null {
  const branch = info.branch.trim();
  const taskId = info.taskId?.trim() ?? "";
  const worktree = info.worktree.trim();
  const version = info.version.trim();
  const commitHash = info.commitHash.trim();

  if (!taskId && !worktree && (branch === "" || branch === "main" || branch === "master")) {
    return null;
  }

  const descriptorParts: string[] = [];
  if (taskId) {
    pushUnique(descriptorParts, `task ${taskId}`);
    if (worktree && worktree !== `task-${taskId}`) {
      pushUnique(descriptorParts, worktree);
    }
    if (branch !== worktree) {
      pushUnique(descriptorParts, branch);
    }
  } else {
    pushUnique(descriptorParts, worktree);
    pushUnique(descriptorParts, branch);
  }

  const descriptor = descriptorParts.join(" · ");
  return `Kanna — ${descriptor} (${version} @ ${commitHash})`;
}

import type { TaskSummary } from "../lib/api/types";

export interface TaskListItemModel {
  preview: string;
  repoLabel: string;
  scopeLabel: string;
  stageLabel: string;
}

export interface TaskWorkspaceHeaderModel {
  desktopLabel: string;
  repoLabel: string;
  snippetLabel: string;
  stageLabel: string;
}

export function buildTaskListItemModel(
  task: TaskSummary,
  repoName: string | null,
  isRecentView: boolean
): TaskListItemModel {
  return {
    preview: resolveTaskPreview(task),
    repoLabel: repoName ?? task.repoId,
    scopeLabel: isRecentView ? "Recent" : "Task",
    stageLabel: task.stage ?? "unknown"
  };
}

export function buildTaskWorkspaceHeaderModel(options: {
  desktopName: string | null;
  repoName: string | null;
  task: TaskSummary;
}): TaskWorkspaceHeaderModel {
  const { desktopName, repoName, task } = options;

  return {
    desktopLabel: desktopName ?? "Unknown desktop",
    repoLabel: repoName ?? task.repoId,
    snippetLabel:
      task.snippet?.trim() ||
      "Live terminal output will appear here as the desktop daemon streams data.",
    stageLabel: task.stage ?? "unknown"
  };
}

function resolveTaskPreview(task: TaskSummary): string {
  if (task.snippet?.trim()) {
    return task.snippet.trim();
  }

  if (task.stage === "pr") {
    return "Ready for review.";
  }

  return "Open the task for the latest output.";
}

import type { TaskSummary } from "../lib/api/types";
import type { RefreshStatus } from "../state/sessionStore";

export interface MoreCommandAction {
  id: "refresh" | "compose" | "advance-stage" | "merge-agent" | "close-task";
  title: string;
  copy: string;
  keywords?: string[];
}

export interface MoreCommandSection {
  title: string;
  headline: string;
  detail: string;
  actions?: MoreCommandAction[];
}

export interface MoreCommandPaletteEntry extends MoreCommandAction {
  sectionTitle: string;
  sectionHeadline: string;
}

interface BuildMoreCommandSectionsOptions {
  refreshStatus?: RefreshStatus;
  selectedTask: TaskSummary | null;
}

export function buildMoreCommandSections({
  refreshStatus = "idle",
  selectedTask
}: BuildMoreCommandSectionsOptions): MoreCommandSection[] {
  const sections: MoreCommandSection[] = [
    {
      title: "Workspace",
      headline: "Commands",
      detail: "Global workspace commands.",
      actions: [
        getRefreshAction(refreshStatus),
        {
          id: "compose",
          title: "Create Task",
          copy: "Open the new-task composer.",
          keywords: ["new", "task", "create"]
        }
      ]
    }
  ];

  if (selectedTask) {
    sections.push({
      title: "Task",
      headline: selectedTask.title,
      detail: selectedTask.stage ?? "unknown",
      actions: [
        {
          id: "advance-stage",
          title: "Advance Stage",
          copy: `Create the next-stage task after ${selectedTask.title}.`,
          keywords: ["next", "pipeline", "promote", "stage"]
        },
        {
          id: "merge-agent",
          title: "Run Merge Agent",
          copy: `Spawn the follow-up merge task for ${selectedTask.title}.`,
          keywords: ["merge", "agent", "follow-up"]
        },
        {
          id: "close-task",
          title: "Close Task",
          copy: `Stop the agent and hide ${selectedTask.title} from the open task list.`,
          keywords: ["close", "done", "stop", "hide"]
        }
      ]
    });
  }

  return sections;
}

function getRefreshAction(refreshStatus: RefreshStatus): MoreCommandAction {
  switch (refreshStatus) {
    case "refreshing":
      return {
        id: "refresh",
        title: "Refreshing...",
        copy: "Reloading machines, repos, and recent tasks.",
        keywords: ["reload", "sync", "update"]
      };
    case "updated":
      return {
        id: "refresh",
        title: "Refresh Data",
        copy: "Updated just now.",
        keywords: ["reload", "sync", "update"]
      };
    case "error":
      return {
        id: "refresh",
        title: "Retry Refresh",
        copy: "Refresh failed. Tap to try again.",
        keywords: ["reload", "sync", "update", "retry"]
      };
    case "idle":
    default:
      return {
        id: "refresh",
        title: "Refresh Data",
        copy: "Reload machines, repos, and recent tasks.",
        keywords: ["reload", "sync", "update"]
      };
  }
}

export function buildMoreCommandPalette(
  options: BuildMoreCommandSectionsOptions,
  query: string
): MoreCommandPaletteEntry[] {
  const normalizedQuery = query.trim().toLowerCase();

  return buildMoreCommandSections(options)
    .flatMap((section) =>
      (section.actions ?? []).map((action) => ({
        ...action,
        sectionTitle: section.title,
        sectionHeadline: section.headline
      }))
    )
    .filter((entry) => {
      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        entry.title,
        entry.copy,
        entry.sectionTitle,
        entry.sectionHeadline,
        ...(entry.keywords ?? [])
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
}

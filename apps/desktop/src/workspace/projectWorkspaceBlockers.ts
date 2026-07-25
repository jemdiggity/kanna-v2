import type {
  BlockerDisplayItem,
  BlockerTaskStates,
  TaskBlocker,
} from "../types/kanna";
import type { SidebarTaskItem } from "../types/taskUi";
import type { WorkspaceTask } from "./types";

export interface WorkspaceBlockerProjection {
  taskBlockers: TaskBlocker[];
  blockerTaskStates: BlockerTaskStates;
  blockerNames: Record<string, string>;
  blockersByLogicalTaskKey: Record<string, BlockerDisplayItem[]>;
}

interface ProjectWorkspaceBlockersInput {
  workspaceTasks: readonly WorkspaceTask[];
  sidebarItems: readonly SidebarTaskItem[];
  workspaceTasksByItemId: ReadonlyMap<string, WorkspaceTask>;
}

export function projectWorkspaceBlockers(
  input: ProjectWorkspaceBlockersInput,
): WorkspaceBlockerProjection {
  const sidebarItemByLogicalTaskKey = buildSidebarItemIndex(input);
  const tasksByOwnerIdentity = buildOwnerTaskIndex(input.workspaceTasks);
  const taskBlockers: TaskBlocker[] = [];
  const blockerTaskStates: BlockerTaskStates = {};
  const blockerNames: Record<string, string> = {};
  const blockersByLogicalTaskKey: Record<string, BlockerDisplayItem[]> = {};

  for (const blockedTask of input.workspaceTasks) {
    if (blockedTask.owner.kind === "local" || blockedTask.blockedByTaskIds.length === 0) {
      continue;
    }
    const blockedSidebarItem = sidebarItemByLogicalTaskKey.get(blockedTask.logicalTaskKey);
    const blockedPresentationId = blockedSidebarItem?.task_id;
    if (!blockedPresentationId) continue;

    const displays: BlockerDisplayItem[] = [];
    const names: string[] = [];
    const seenBlockerIds = new Set<string>();
    for (const ownerBlockerId of blockedTask.blockedByTaskIds) {
      const resolved = resolveBlockerTask(tasksByOwnerIdentity, blockedTask, ownerBlockerId);
      const blockerSidebarItem = resolved
        ? sidebarItemByLogicalTaskKey.get(resolved.logicalTaskKey)
        : undefined;
      const blockerPresentationId = blockerSidebarItem?.task_id
        ?? resolved?.item.id
        ?? ownerBlockerId;
      if (seenBlockerIds.has(blockerPresentationId)) continue;
      seenBlockerIds.add(blockerPresentationId);

      const display = blockerDisplayItem(resolved, blockerPresentationId, ownerBlockerId);
      taskBlockers.push({
        blocked_item_id: blockedPresentationId,
        blocker_item_id: blockerPresentationId,
      });
      blockerTaskStates[blockerPresentationId] = {
        closed_at: display.closed_at,
        stage: display.stage,
        pr_url: display.pr_url,
      };
      displays.push(display);
      names.push(blockerDisplayName(display));
    }

    if (displays.length > 0) {
      blockersByLogicalTaskKey[blockedTask.logicalTaskKey] = displays;
      blockerNames[blockedPresentationId] = names.join(", ");
    }
  }

  return {
    taskBlockers,
    blockerTaskStates,
    blockerNames,
    blockersByLogicalTaskKey,
  };
}

function buildSidebarItemIndex(
  input: ProjectWorkspaceBlockersInput,
): Map<string, SidebarTaskItem> {
  const result = new Map<string, SidebarTaskItem>();
  for (const sidebarItem of input.sidebarItems) {
    const workspaceTask = input.workspaceTasksByItemId.get(sidebarItem.slot_id)
      ?? (sidebarItem.task_id
        ? input.workspaceTasksByItemId.get(sidebarItem.task_id)
        : undefined);
    if (workspaceTask) {
      result.set(workspaceTask.logicalTaskKey, sidebarItem);
    }
  }
  return result;
}

interface OwnerTaskIndex {
  scoped: Map<string, WorkspaceTask>;
  unscoped: Map<string, WorkspaceTask>;
  ambiguousUnscoped: Set<string>;
}

function buildOwnerTaskIndex(tasks: readonly WorkspaceTask[]): OwnerTaskIndex {
  const index: OwnerTaskIndex = {
    scoped: new Map(),
    unscoped: new Map(),
    ambiguousUnscoped: new Set(),
  };
  for (const task of tasks) {
    const taskOwnerIds = ownerTaskIds(task);
    const desktopIds = ownerDesktopIds(task);
    for (const ownerTaskId of taskOwnerIds) {
      for (const desktopId of desktopIds) {
        index.scoped.set(ownerIdentityKey(desktopId, ownerTaskId), task);
      }
      if (index.ambiguousUnscoped.has(ownerTaskId)) continue;
      const existing = index.unscoped.get(ownerTaskId);
      if (existing && existing !== task) {
        index.unscoped.delete(ownerTaskId);
        index.ambiguousUnscoped.add(ownerTaskId);
      } else {
        index.unscoped.set(ownerTaskId, task);
      }
    }
  }
  return index;
}

function resolveBlockerTask(
  index: OwnerTaskIndex,
  blockedTask: WorkspaceTask,
  ownerBlockerId: string,
): WorkspaceTask | undefined {
  for (const desktopId of ownerDesktopIds(blockedTask)) {
    const scoped = index.scoped.get(ownerIdentityKey(desktopId, ownerBlockerId));
    if (scoped) return scoped;
  }
  return index.unscoped.get(ownerBlockerId);
}

function ownerDesktopIds(task: WorkspaceTask): Set<string> {
  const ids = new Set<string>();
  if (task.owner.kind === "remote" && task.owner.id !== "unknown") {
    ids.add(task.owner.id);
  }
  for (const source of task.sources) {
    if (source.terminalRef?.ownerDesktopId) {
      ids.add(source.terminalRef.ownerDesktopId);
    }
  }
  if (task.terminal.remoteRef?.ownerDesktopId) {
    ids.add(task.terminal.remoteRef.ownerDesktopId);
  }
  return ids;
}

function ownerTaskIds(task: WorkspaceTask): Set<string> {
  const ids = new Set<string>();
  for (const source of task.sources) {
    if (source.terminalRef?.ownerLocalTaskId) {
      ids.add(source.terminalRef.ownerLocalTaskId);
    }
  }
  if (task.terminal.remoteRef?.ownerLocalTaskId) {
    ids.add(task.terminal.remoteRef.ownerLocalTaskId);
  }
  const logicalId = logicalOwnerTaskId(task.logicalTaskKey);
  if (logicalId) ids.add(logicalId);
  return ids;
}

function logicalOwnerTaskId(logicalTaskKey: string): string | null {
  const marker = ":owner-local:";
  const markerIndex = logicalTaskKey.indexOf(marker);
  if (markerIndex < 0) return null;
  const ownerTaskId = logicalTaskKey.slice(markerIndex + marker.length);
  return ownerTaskId || null;
}

function ownerIdentityKey(desktopId: string, ownerTaskId: string): string {
  return `${encodeURIComponent(desktopId)}:${encodeURIComponent(ownerTaskId)}`;
}

function blockerDisplayItem(
  task: WorkspaceTask | undefined,
  presentationId: string,
  ownerBlockerId: string,
): BlockerDisplayItem {
  if (task) {
    return {
      id: presentationId,
      display_name: task.item.display_name,
      issue_title: task.item.issue_title,
      prompt: task.item.prompt,
      closed_at: task.item.closed_at,
      stage: task.item.stage,
      pr_url: task.item.pr_url,
    };
  }
  return {
    id: presentationId,
    display_name: `Task ${ownerBlockerId.slice(0, 8)}`,
    issue_title: null,
    prompt: null,
    closed_at: null,
    stage: "in progress",
    pr_url: null,
  };
}

function blockerDisplayName(blocker: BlockerDisplayItem): string {
  return blocker.display_name
    || blocker.issue_title
    || blocker.prompt?.slice(0, 30)
    || "Untitled";
}

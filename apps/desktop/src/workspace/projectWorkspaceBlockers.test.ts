import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import type { SidebarTaskItem } from "../types/taskUi";
import type { WorkspaceTask } from "./types";
import { projectWorkspaceBlockers } from "./projectWorkspaceBlockers";

function item(id: string, displayName: string | null): PipelineItem {
  return {
    id,
    repo_id: "cloud:repo-1",
    prompt: `Prompt for ${id}`,
    pipeline: "cloud",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${id}`,
    activity: "idle",
    activity_changed_at: "2026-07-25T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: displayName,
    issue_number: null,
    issue_title: null,
    closed_at: null,
    agent_session_id: null,
    base_ref: "origin/main",
    agent_provider: "codex",
    agent_type: "pty",
    teardown_started_at: null,
    parent_task_id: null,
    last_output_preview: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  };
}

function workspaceTask(
  ownerTaskId: string,
  displayName: string | null,
  blockedByTaskIds: string[] = [],
  ownerKind: "local" | "remote" = "remote",
): WorkspaceTask {
  const itemId = ownerKind === "local" ? ownerTaskId : `cloud:repo-1:${ownerTaskId}`;
  const taskItem = item(itemId, displayName);
  return {
    id: ownerKind === "local" ? `local:${ownerTaskId}` : itemId,
    logicalTaskKey: `repo-1:owner-local:${ownerTaskId}`,
    localTaskId: ownerKind === "local" ? ownerTaskId : null,
    remoteTaskIds: ownerKind === "local" ? [] : [itemId],
    repoKey: "repo-1",
    item: taskItem,
    owner: ownerKind === "local"
      ? { kind: "local", id: "local" }
      : { kind: "remote", id: "desktop-owner" },
    sources: [{
      kind: ownerKind === "local" ? "local" : "cloud",
      taskId: itemId,
      repoId: "cloud:repo-1",
      updatedAt: taskItem.updated_at,
      blockedByTaskIds,
      ...(ownerKind === "remote"
        ? {
            terminalRef: {
              ownerDesktopId: "desktop-owner",
              ownerLocalTaskId: ownerTaskId,
              transport: "cloud" as const,
            },
          }
        : {}),
    }],
    blockedByTaskIds,
    reachability: ownerKind === "local" ? "local" : "reachable",
    capabilities: {
      canOpenTerminal: true,
      canSendInput: true,
      canResizeTerminal: true,
      canClose: true,
      canCreateSiblingTask: true,
      canPushToMachine: ownerKind === "local",
      canPullFromMachine: ownerKind === "remote",
      canOpenDiff: ownerKind === "local",
      canOpenInIde: ownerKind === "local",
      canOpenShell: ownerKind === "local",
      canAdvanceStage: true,
      canEditMetadata: true,
    },
    terminal: ownerKind === "local"
      ? { kind: "local", localSessionId: ownerTaskId }
      : {
          kind: "cloud",
          remoteRef: {
            ownerDesktopId: "desktop-owner",
            ownerLocalTaskId: ownerTaskId,
            transport: "cloud",
          },
        },
  };
}

function sidebarItem(task: WorkspaceTask): SidebarTaskItem {
  const { id, ...presentation } = task.item;
  return {
    ...presentation,
    repo_id: task.repoKey,
    slot_id: `remote:${task.logicalTaskKey}`,
    task_id: id,
    state: "ready",
    remote_task: task.owner.kind === "remote",
  };
}

function project(tasks: WorkspaceTask[]) {
  const sidebarItems = tasks.map(sidebarItem);
  const workspaceTasksByItemId = new Map<string, WorkspaceTask>();
  tasks.forEach((task, index) => {
    workspaceTasksByItemId.set(sidebarItems[index].slot_id, task);
    const taskId = sidebarItems[index].task_id;
    if (taskId) workspaceTasksByItemId.set(taskId, task);
  });
  return projectWorkspaceBlockers({
    workspaceTasks: tasks,
    sidebarItems,
    workspaceTasksByItemId,
  });
}

describe("projectWorkspaceBlockers", () => {
  it("resolves owner blocker ids into sidebar identities and display details", () => {
    const blockedTask = workspaceTask("blocked-owner", "Blocked task", ["blocker-owner"]);
    const blockerTask = workspaceTask("blocker-owner", "Build dependency");

    const result = project([blockedTask, blockerTask]);

    expect(result.taskBlockers).toEqual([{
      blocked_item_id: blockedTask.item.id,
      blocker_item_id: blockerTask.item.id,
    }]);
    expect(result.blockersByLogicalTaskKey[blockedTask.logicalTaskKey]).toEqual([
      expect.objectContaining({
        id: blockerTask.item.id,
        display_name: "Build dependency",
      }),
    ]);
  });

  it("keeps an unresolved owner blocker visible as raw fallback metadata", () => {
    const blockedTask = workspaceTask("blocked-owner", "Blocked task", ["3c45beea"]);

    const result = project([blockedTask]);

    expect(result.taskBlockers).toEqual([{
      blocked_item_id: blockedTask.item.id,
      blocker_item_id: "3c45beea",
    }]);
    expect(result.blockersByLogicalTaskKey[blockedTask.logicalTaskKey]).toEqual([
      expect.objectContaining({
        id: "3c45beea",
        display_name: null,
        fallback_task_id: "3c45beea",
      }),
    ]);
  });

  it("does not project replicated blockers for a local-owned task", () => {
    const localTask = workspaceTask(
      "blocked-owner",
      "Local task",
      ["remote-blocker"],
      "local",
    );

    const result = project([localTask]);

    expect(result.taskBlockers).toEqual([]);
    expect(result.blockersByLogicalTaskKey).toEqual({});
  });
});

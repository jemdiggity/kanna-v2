import { computed, effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "../types/kanna";
import type { WorkspaceTask } from "../workspace/types";
import { useRemoteTaskReadDwell } from "./useRemoteTaskReadDwell";

function remoteWorkspaceTask(activityRevision: number | null = 7): WorkspaceTask {
  const item: PipelineItem = {
    id: "remote-task",
    repo_id: "remote-repo",
    issue_number: null,
    issue_title: null,
    prompt: "Remote task",
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: "task-remote",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "unread",
    activity_revision: activityRevision ?? undefined,
    activity_changed_at: "2026-07-24T00:00:00.000Z",
    unread_at: "2026-07-24T00:00:00.000Z",
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
  };

  return {
    id: "workspace-task",
    logicalTaskKey: "remote-task",
    localTaskId: null,
    remoteTaskIds: ["remote-task"],
    repoKey: "remote-repo",
    item,
    owner: { kind: "remote", id: "remote-desktop" },
    sources: [],
    reachability: "reachable",
    capabilities: {
      canOpenTerminal: true,
      canSendInput: true,
      canResizeTerminal: true,
      canClose: true,
      canCreateSiblingTask: false,
      canPushToMachine: false,
      canPullFromMachine: false,
      canOpenDiff: false,
      canOpenInIde: false,
      canOpenShell: false,
      canAdvanceStage: true,
      canEditMetadata: false,
    },
    terminal: {
      kind: "cloud",
      remoteRef: {
        ownerDesktopId: "remote-desktop",
        ownerLocalTaskId: "owner-task",
      },
    },
  };
}

describe("useRemoteTaskReadDwell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks an unread remote task read after one second", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask();
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).toHaveBeenCalledOnce();
    expect(markTaskRead).toHaveBeenCalledWith(task, 7);
    scope.stop();
  });

  it("cancels mark-read when selection changes before one second", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask();
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();
    await vi.advanceTimersByTimeAsync(999);
    selectedItemId.value = null;
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("does not overwrite activity with a revision newer than the selection", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask(7);
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();
    task.item.activity_revision = 8;
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("does not mark a replacement owner with the same revision read", async () => {
    const selectedItemId = ref<string | null>(null);
    const originalTask = remoteWorkspaceTask(7);
    const workspaceTasks = ref(new Map([["slot:remote", originalTask]]));
    const workspaceTasksByItemId = computed(() => workspaceTasks.value);
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();

    const replacementTask = remoteWorkspaceTask(7);
    replacementTask.owner = { kind: "remote", id: "replacement-desktop" };
    replacementTask.terminal.remoteRef = {
      ownerDesktopId: "replacement-desktop",
      ownerLocalTaskId: "replacement-task",
    };
    workspaceTasks.value = new Map([["slot:remote", replacementTask]]);
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("keeps the original activity revision when the dwell callback runs late", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask();
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();
    task.item.activity_revision = 8;
    vi.setSystemTime(new Date("2026-07-25T01:00:10.000Z"));
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("fails safe when the remote snapshot has no activity revision", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask(null);
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    selectedItemId.value = "slot:remote";
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("starts the dwell immediately for a restored remote selection", async () => {
    const selectedItemId = ref<string | null>("slot:remote");
    const task = remoteWorkspaceTask(11);
    const workspaceTasksByItemId = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();

    scope.run(() => {
      useRemoteTaskReadDwell({ selectedItemId, workspaceTasksByItemId, markTaskRead });
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(markTaskRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(markTaskRead).toHaveBeenCalledWith(task, 11);
    scope.stop();
  });
});

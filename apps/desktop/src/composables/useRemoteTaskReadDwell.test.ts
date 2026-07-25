import { computed, effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "../types/kanna";
import type { WorkspaceTask } from "../workspace/types";
import { useRemoteTaskReadDwell } from "./useRemoteTaskReadDwell";

function remoteWorkspaceTask(activityChangedAt = "2026-07-24T00:00:00.000Z"): WorkspaceTask {
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
    activity_changed_at: activityChangedAt,
    unread_at: activityChangedAt,
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
    expect(markTaskRead).toHaveBeenCalledWith(task);
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

  it("does not overwrite activity newer than the selection", async () => {
    const selectedItemId = ref<string | null>(null);
    const task = remoteWorkspaceTask("2026-07-25T01:00:00.500Z");
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
});

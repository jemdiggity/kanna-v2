import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "../types/kanna";
import type { WorkspaceTask } from "../workspace/types";
import { useAppKeyboardActions } from "./useAppKeyboardActions";

vi.mock("./useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));

function item(id: string): PipelineItem {
  return {
    id,
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Durable action",
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${id}`,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
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
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function remoteWorkspaceTask(presentationTaskId: string): WorkspaceTask {
  return {
    item: item(presentationTaskId),
    localTaskId: null,
  } as WorkspaceTask;
}

function createHarness(options: {
  selectedSlotId?: string | null;
  selectedTaskId?: string | null;
  currentItem?: PipelineItem | null;
  workspaceTask?: WorkspaceTask | null;
} = {}) {
  const openWindow = vi.fn(async () => {});
  const advanceStage = vi.fn(async () => {});
  const navigateBack = vi.fn(async () => {});
  const navigateForward = vi.fn(async () => {});
  const store = {
    selectedRepoId: "repo-1",
    selectedItemId: options.selectedSlotId ?? "create:stable",
    selectedTaskId: options.selectedTaskId ?? null,
    currentItem: options.currentItem ?? null,
    advanceStage,
  };
  const { keyboardActions } = useAppKeyboardActions({
    store,
    windowWorkspace: { openWindow },
    selectedWorkspaceTask: computed(() => options.workspaceTask ?? null),
    currentShortcutContext: computed(() => "main"),
    showShortcutsModal: ref(false),
    navigateBack,
    navigateForward,
  } as unknown as Parameters<typeof useAppKeyboardActions>[0]);
  return { keyboardActions, openWindow, advanceStage, navigateBack, navigateForward };
}

describe("useAppKeyboardActions durable selection", () => {
  it("opens a local task window with the durable task id, not its UI slot", async () => {
    const { keyboardActions, openWindow } = createHarness({
      selectedSlotId: "create:stable",
      selectedTaskId: "task-durable",
      currentItem: item("task-durable"),
    });

    await keyboardActions.newWindow();

    expect(openWindow).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-durable",
    });
  });

  it("opens a remote task window with its projected backend identity", async () => {
    const { keyboardActions, openWindow } = createHarness({
      selectedSlotId: "remote:logical-task",
      selectedTaskId: null,
      workspaceTask: remoteWorkspaceTask("cloud:repo:task-remote"),
    });

    await keyboardActions.newWindow();

    expect(openWindow).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "cloud:repo:task-remote",
    });
  });

  it("advances a selected durable task behind a noncanonical UI slot", () => {
    const durableItem = item("task-durable");
    const { keyboardActions, advanceStage } = createHarness({
      selectedSlotId: "create:stable",
      selectedTaskId: durableItem.id,
      currentItem: durableItem,
    });

    keyboardActions.advanceStage();

    expect(advanceStage).toHaveBeenCalledWith("task-durable");
  });

  it("routes history shortcuts through workspace-aware navigation", async () => {
    const { keyboardActions, navigateBack, navigateForward } = createHarness();

    await keyboardActions.goBack();
    await keyboardActions.goForward();

    expect(navigateBack).toHaveBeenCalledOnce();
    expect(navigateForward).toHaveBeenCalledOnce();
  });
});

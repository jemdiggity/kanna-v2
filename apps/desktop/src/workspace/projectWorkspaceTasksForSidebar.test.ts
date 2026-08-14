import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import type { TaskUiSlot } from "../types/taskUi";
import type {
  WorkspaceCapabilities,
  WorkspaceTask,
  WorkspaceTaskSource,
} from "./types";
import { createWorkspaceSidebarProjector } from "./projectWorkspaceTasksForSidebar";

const CAPABILITIES: WorkspaceCapabilities = {
  canOpenTerminal: true,
  canSendInput: true,
  canResizeTerminal: true,
  canClose: true,
  canCreateSiblingTask: true,
  canPushToMachine: true,
  canPullFromMachine: false,
  canOpenDiff: true,
  canOpenInIde: true,
  canOpenShell: true,
  canAdvanceStage: true,
  canEditMetadata: true,
};

function item(id: string, repoId = "repo-1", overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id,
    repo_id: repoId,
    issue_number: null,
    issue_title: null,
    prompt: `Task ${id}`,
    workflow: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${id}`,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-07-11T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function source(
  kind: WorkspaceTaskSource["kind"],
  taskId: string,
  ownerLocalTaskId?: string,
  ownerDesktopId = `${kind}-desktop`,
): WorkspaceTaskSource {
  return {
    kind,
    taskId,
    repoId: "repo-1",
    updatedAt: "2026-07-11T00:00:00.000Z",
    blockedByTaskIds: [],
    ...(ownerLocalTaskId
      ? {
          terminalRef: {
            ownerDesktopId,
            ownerLocalTaskId,
            transport: kind === "local" ? "cloud" : kind,
          },
        }
      : {}),
  };
}

interface WorkspaceTaskOptions {
  repoKey?: string;
  logicalOwnerId?: string;
  itemId?: string;
  localTaskId?: string | null;
  remoteTaskIds?: string[];
  sources?: WorkspaceTaskSource[];
  ownerKind?: "local" | "remote";
  ownerDesktopId?: string;
  createdAt?: string;
}

function workspaceTask(options: WorkspaceTaskOptions = {}): WorkspaceTask {
  const repoKey = options.repoKey ?? "repo-1";
  const logicalOwnerId = options.logicalOwnerId ?? "task-1";
  const localTaskId = options.localTaskId === undefined ? logicalOwnerId : options.localTaskId;
  const itemId = options.itemId ?? (localTaskId ?? `cloud:${repoKey}:${logicalOwnerId}`);
  const ownerKind = options.ownerKind ?? (localTaskId ? "local" : "remote");
  return {
    id: localTaskId ? `local:${localTaskId}` : itemId,
    logicalTaskKey: `${repoKey}:owner-local:${logicalOwnerId}`,
    localTaskId,
    remoteTaskIds: options.remoteTaskIds ?? [],
    repoKey,
    item: item(itemId, repoKey, {
      created_at: options.createdAt ?? "2026-07-11T00:00:00.000Z",
    }),
    owner: ownerKind === "local"
      ? { kind: "local", id: "local" }
      : { kind: "remote", id: options.ownerDesktopId ?? "remote-desktop" },
    sources: options.sources ?? [source(localTaskId ? "local" : "cloud", itemId, logicalOwnerId)],
    blockedByTaskIds: [],
    reachability: ownerKind === "local" ? "local" : "reachable",
    capabilities: CAPABILITIES,
    terminal: ownerKind === "local"
      ? { kind: "local", localSessionId: localTaskId ?? itemId }
      : {
          kind: "cloud",
          remoteRef: {
            ownerDesktopId: options.ownerDesktopId ?? "remote-desktop",
            ownerLocalTaskId: logicalOwnerId,
            transport: "cloud",
          },
        },
  };
}

function draft(repoId: string, prompt: string) {
  return {
    repo_id: repoId,
    prompt,
    display_name: null,
    workflow: "default",
    stage: "in progress",
    agent_type: "pty" as const,
    agent_provider: "claude" as const,
    created_at: "2026-07-11T00:00:00.000Z",
  };
}

function creatingSlot(
  slotId: string,
  repoId = "repo-1",
  taskId: string | null = null,
): TaskUiSlot {
  return {
    slot_id: slotId,
    task_id: taskId,
    state: "creating",
    task: null,
    authoritative_miss_grace_remaining: taskId === null ? 0 : 1,
    draft: draft(repoId, `Draft ${slotId}`),
  };
}

function readySlot(slotId: string, taskId: string, repoId = "repo-1"): TaskUiSlot {
  return {
    slot_id: slotId,
    task_id: taskId,
    state: "ready",
    task: item(taskId, repoId),
    draft: draft(repoId, `Draft ${slotId}`),
  };
}

describe("workspace sidebar projection", () => {
  it("keeps repo-scoped owner aliases and rejects globally ambiguous raw aliases", () => {
    const first = workspaceTask({
      repoKey: "repo-1",
      logicalOwnerId: "shared-owner-task",
      localTaskId: null,
      itemId: "cloud:repo-1:shared-owner-task",
      remoteTaskIds: ["cloud:repo-1:shared-owner-task"],
      ownerKind: "remote",
      ownerDesktopId: "desktop-1",
      sources: [source(
        "cloud",
        "cloud:repo-1:shared-owner-task",
        "shared-owner-task",
        "desktop-1",
      )],
    });
    const second = workspaceTask({
      repoKey: "repo-2",
      logicalOwnerId: "shared-owner-task",
      localTaskId: null,
      itemId: "cloud:repo-2:shared-owner-task",
      remoteTaskIds: ["cloud:repo-2:shared-owner-task"],
      ownerKind: "remote",
      ownerDesktopId: "desktop-2",
      sources: [source(
        "cloud",
        "cloud:repo-2:shared-owner-task",
        "shared-owner-task",
        "desktop-2",
      )],
    });
    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [],
      workspaceTasks: [first, second],
    });

    expect(projection.workspaceTasksByItemId.has("shared-owner-task")).toBe(false);
    expect(projection.workspaceTasksByItemId.get(first.logicalTaskKey)).toBe(first);
    expect(projection.workspaceTasksByItemId.get(second.logicalTaskKey)).toBe(second);
    expect(projection.workspaceTasksByItemId.get(first.item.id)).toBe(first);
    expect(projection.workspaceTasksByItemId.get(second.item.id)).toBe(second);
    expect(projection.workspaceTasksByItemId.get(`remote:${first.logicalTaskKey}`)).toBe(first);
    expect(projection.workspaceTasksByItemId.get(`remote:${second.logicalTaskKey}`)).toBe(second);
  });

  it("projects local, cloud, and LAN sources as one stable noncanonical slot", () => {
    const task = workspaceTask({
      localTaskId: "task-1",
      itemId: "task-1",
      remoteTaskIds: ["cloud:repo-1:task-1", "lan:peer:repo-1:task-1"],
      sources: [
        source("local", "task-1"),
        source("cloud", "cloud:repo-1:task-1", "task-1"),
        source("lan", "lan:peer:repo-1:task-1", "task-1"),
      ],
    });
    const projector = createWorkspaceSidebarProjector();
    const projection = projector.project({
      taskUiSlots: [
        readySlot("task-1", "task-1"),
        readySlot("create:stable", "task-1"),
      ],
      workspaceTasks: [task],
    });

    expect(projection.sidebarItems).toHaveLength(1);
    expect(projection.sidebarItems[0]).toMatchObject({
      slot_id: "create:stable",
      task_id: "task-1",
      state: "ready",
      repo_id: "repo-1",
      remote_task: false,
    });

    const aliases = [
      "create:stable",
      "task-1",
      "cloud:repo-1:task-1",
      "lan:peer:repo-1:task-1",
    ];
    for (const alias of aliases) {
      expect(projection.workspaceTasksByItemId.get(alias)).toBe(task);
    }
  });

  it("keeps a deterministic remote slot when the preferred source item changes", () => {
    const logicalTaskKey = "remote-repo:owner-local:task-remote";
    const cloud = workspaceTask({
      repoKey: "remote-repo",
      logicalOwnerId: "task-remote",
      localTaskId: null,
      itemId: "cloud:remote-repo:task-remote",
      remoteTaskIds: ["cloud:remote-repo:task-remote"],
      ownerKind: "remote",
    });
    const lan = workspaceTask({
      repoKey: "remote-repo",
      logicalOwnerId: "task-remote",
      localTaskId: null,
      itemId: "lan:peer:remote-repo:task-remote",
      remoteTaskIds: [
        "cloud:remote-repo:task-remote",
        "lan:peer:remote-repo:task-remote",
      ],
      ownerKind: "remote",
      sources: [source("lan", "lan:peer:remote-repo:task-remote", "task-remote")],
    });
    const projector = createWorkspaceSidebarProjector();

    const first = projector.project({ taskUiSlots: [], workspaceTasks: [cloud] });
    const second = projector.project({ taskUiSlots: [], workspaceTasks: [lan] });

    expect(first.sidebarItems[0]).toMatchObject({
      slot_id: `remote:${logicalTaskKey}`,
      task_id: "cloud:remote-repo:task-remote",
      remote_task: true,
    });
    expect(second.sidebarItems[0]).toMatchObject({
      slot_id: `remote:${logicalTaskKey}`,
      task_id: "lan:peer:remote-repo:task-remote",
      remote_task: true,
    });
  });

  it("carries the running-post flag of a remote task into its sidebar item", () => {
    const remote = workspaceTask({
      repoKey: "cloud:remote-repo",
      logicalOwnerId: "task-post",
      localTaskId: null,
      itemId: "cloud:remote-repo:task-post",
      remoteTaskIds: ["cloud:remote-repo:task-post"],
      ownerKind: "remote",
      sources: [source("cloud", "cloud:remote-repo:task-post", "task-post")],
    });
    remote.item.has_running_post = 1;

    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [],
      workspaceTasks: [remote],
    });

    expect(projection.sidebarItems).toEqual([
      expect.objectContaining({
        remote_task: true,
        has_running_post: 1,
      }),
    ]);
  });

  it("retains remote presentation identity and aliases when local matching rekeys the repo", () => {
    const remote = workspaceTask({
      repoKey: "cloud:remote-repo",
      logicalOwnerId: "task-transition",
      localTaskId: null,
      itemId: "cloud:remote-repo:task-transition",
      remoteTaskIds: ["cloud:remote-repo:task-transition"],
      ownerKind: "remote",
      sources: [source("cloud", "cloud:remote-repo:task-transition", "task-transition")],
    });
    const local = workspaceTask({
      repoKey: "repo-local",
      logicalOwnerId: "task-transition",
      localTaskId: "task-transition",
      itemId: "task-transition",
      remoteTaskIds: ["cloud:remote-repo:task-transition"],
      ownerKind: "local",
      sources: [
        source("local", "task-transition"),
        source("cloud", "cloud:remote-repo:task-transition", "task-transition"),
      ],
    });
    const projector = createWorkspaceSidebarProjector();

    const remoteProjection = projector.project({
      taskUiSlots: [],
      workspaceTasks: [remote],
    });
    const remoteSlotId = remoteProjection.sidebarItems[0].slot_id;
    const localProjection = projector.project({
      taskUiSlots: [readySlot("task-transition", "task-transition", "repo-local")],
      workspaceTasks: [local],
    });

    expect(remoteSlotId).toBe(`remote:${remote.logicalTaskKey}`);
    expect(localProjection.sidebarItems).toEqual([
      expect.objectContaining({
        slot_id: remoteSlotId,
        task_id: "task-transition",
        remote_task: false,
      }),
    ]);
    expect(localProjection.workspaceTasksByItemId.get(remoteSlotId)).toBe(local);
    expect(localProjection.workspaceTasksByItemId.get("task-transition")).toBe(local);
    expect(localProjection.workspaceTasksByItemId.get(remote.item.id)).toBe(local);
  });

  it("keeps an acknowledged matched slot in its draft state until hydration", () => {
    const task = workspaceTask({ localTaskId: "task-1", itemId: "task-1" });
    const slot = creatingSlot("create:stable", "repo-1", "task-1");
    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [slot],
      workspaceTasks: [task],
    });

    expect(projection.sidebarItems).toEqual([
      expect.objectContaining({
        slot_id: "create:stable",
        task_id: "task-1",
        state: "creating",
        prompt: "Draft create:stable",
      }),
    ]);
    expect(projection.workspaceTasksByItemId.get("create:stable")).toBe(task);
    expect(projection.workspaceTasksByItemId.get("task-1")).toBe(task);
  });

  it("matches a slot by owner-local identity only within the workspace repo", () => {
    const task = workspaceTask({
      logicalOwnerId: "task-owner",
      localTaskId: null,
      itemId: "cloud:repo-1:task-owner",
      remoteTaskIds: ["cloud:repo-1:task-owner"],
      ownerKind: "remote",
      sources: [source("cloud", "cloud:repo-1:task-owner", "task-owner")],
    });
    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [
        readySlot("create:wrong-repo", "task-owner", "repo-2"),
        readySlot("create:owner", "task-owner", "repo-1"),
      ],
      workspaceTasks: [task],
    });

    expect(projection.sidebarItems).toEqual([
      expect.objectContaining({
        slot_id: "create:owner",
        task_id: "task-owner",
        remote_task: true,
      }),
    ]);
    expect(projection.workspaceTasksByItemId.get("task-owner")).toBe(task);
  });

  it("withholds a pre-response durable task until its slot acknowledges it", () => {
    const projector = createWorkspaceSidebarProjector();
    const task = workspaceTask({ localTaskId: "task-1", itemId: "task-1" });
    const unacknowledged = creatingSlot("create:stable");

    projector.project({ taskUiSlots: [], workspaceTasks: [] });
    const beforeResponse = projector.project({
      taskUiSlots: [unacknowledged],
      workspaceTasks: [task],
    });
    const acknowledged = projector.project({
      taskUiSlots: [creatingSlot("create:stable", "repo-1", "task-1")],
      workspaceTasks: [task],
    });
    const hydrated = projector.project({
      taskUiSlots: [readySlot("create:stable", "task-1")],
      workspaceTasks: [task],
    });

    expect(beforeResponse.sidebarItems.map((entry) => entry.slot_id)).toEqual(["create:stable"]);
    expect(beforeResponse.sidebarItems[0]).toMatchObject({ task_id: null, state: "creating" });
    expect(beforeResponse.workspaceTasksByItemId.has("task-1")).toBe(false);
    expect(acknowledged.sidebarItems).toHaveLength(1);
    expect(acknowledged.sidebarItems[0]).toMatchObject({
      slot_id: "create:stable",
      task_id: "task-1",
      state: "creating",
    });
    expect(hydrated.sidebarItems).toHaveLength(1);
    expect(hydrated.sidebarItems[0]).toMatchObject({
      slot_id: "create:stable",
      task_id: "task-1",
      state: "ready",
    });
  });

  it("withholds unmatched local and remote rows on a pathological first call during a create", () => {
    const existingLocal = workspaceTask({
      logicalOwnerId: "task-existing-local",
      localTaskId: "task-existing-local",
      itemId: "task-existing-local",
    });
    const existingRemote = workspaceTask({
      logicalOwnerId: "task-existing-remote",
      localTaskId: null,
      itemId: "cloud:repo-1:task-existing-remote",
      remoteTaskIds: ["cloud:repo-1:task-existing-remote"],
      ownerKind: "remote",
    });
    const newRawLocal = workspaceTask({
      logicalOwnerId: "task-new",
      localTaskId: "task-new",
      itemId: "task-new",
    });

    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [
        readySlot("slot:existing-local", "task-existing-local"),
        creatingSlot("create:new"),
      ],
      workspaceTasks: [existingLocal, existingRemote, newRawLocal],
    });

    expect(projection.sidebarItems.map((entry) => entry.slot_id)).toEqual([
      "slot:existing-local",
      "create:new",
    ]);
    expect(projection.workspaceTasksByItemId.get("slot:existing-local")).toBe(existingLocal);
    expect(projection.workspaceTasksByItemId.has(existingRemote.item.id)).toBe(false);
    expect(projection.workspaceTasksByItemId.has("task-new")).toBe(false);
  });

  it("keeps eagerly admitted baseline rows, withholds new same-repo keys, and updates other repos", () => {
    const projector = createWorkspaceSidebarProjector();
    const baseline = workspaceTask({
      logicalOwnerId: "baseline",
      localTaskId: null,
      itemId: "cloud:repo-1:baseline",
      remoteTaskIds: ["cloud:repo-1:baseline"],
      ownerKind: "remote",
    });
    const sameRepoNew = workspaceTask({
      logicalOwnerId: "task-new",
      localTaskId: "task-new",
      itemId: "task-new",
    });
    const otherRepoNew = workspaceTask({
      repoKey: "repo-2",
      logicalOwnerId: "other-new",
      localTaskId: null,
      itemId: "cloud:repo-2:other-new",
      remoteTaskIds: ["cloud:repo-2:other-new"],
      ownerKind: "remote",
    });

    projector.project({ taskUiSlots: [], workspaceTasks: [baseline] });
    const activeBarrier = projector.project({
      taskUiSlots: [creatingSlot("create:new")],
      workspaceTasks: [baseline, sameRepoNew, otherRepoNew],
    });

    expect(activeBarrier.sidebarItems.map((entry) => entry.slot_id)).toEqual([
      "remote:repo-1:owner-local:baseline",
      "remote:repo-2:owner-local:other-new",
      "create:new",
    ]);
    expect(activeBarrier.workspaceTasksByItemId.get("cloud:repo-1:baseline")).toBe(baseline);
    expect(activeBarrier.workspaceTasksByItemId.has("task-new")).toBe(false);
    expect(activeBarrier.workspaceTasksByItemId.get("cloud:repo-2:other-new")).toBe(otherRepoNew);
  });

  it("supports concurrent creates that acknowledge in reverse order without extra rows", () => {
    const projector = createWorkspaceSidebarProjector();
    const firstTask = workspaceTask({
      logicalOwnerId: "task-first",
      localTaskId: "task-first",
      itemId: "task-first",
    });
    const secondTask = workspaceTask({
      logicalOwnerId: "task-second",
      localTaskId: "task-second",
      itemId: "task-second",
    });
    const firstSlot = creatingSlot("create:first");
    const secondSlot = creatingSlot("create:second");

    projector.project({ taskUiSlots: [], workspaceTasks: [] });
    const bothPending = projector.project({
      taskUiSlots: [firstSlot, secondSlot],
      workspaceTasks: [firstTask, secondTask],
    });
    const secondAcknowledgedFirst = projector.project({
      taskUiSlots: [firstSlot, creatingSlot("create:second", "repo-1", "task-second")],
      workspaceTasks: [firstTask, secondTask],
    });
    const bothAcknowledged = projector.project({
      taskUiSlots: [
        creatingSlot("create:first", "repo-1", "task-first"),
        creatingSlot("create:second", "repo-1", "task-second"),
      ],
      workspaceTasks: [firstTask, secondTask],
    });

    expect(bothPending.sidebarItems.map((entry) => entry.slot_id)).toEqual([
      "create:first",
      "create:second",
    ]);
    expect(secondAcknowledgedFirst.sidebarItems.map((entry) => entry.slot_id).sort()).toEqual([
      "create:first",
      "create:second",
    ]);
    expect(secondAcknowledgedFirst.workspaceTasksByItemId.has("task-first")).toBe(false);
    expect(secondAcknowledgedFirst.workspaceTasksByItemId.get("task-second")).toBe(secondTask);
    expect(bothAcknowledged.sidebarItems.map((entry) => entry.slot_id).sort()).toEqual([
      "create:first",
      "create:second",
    ]);
    expect(bothAcknowledged.sidebarItems.every((entry) => entry.state === "creating")).toBe(true);
  });

  it("appends unmatched creating slots without resurrecting unmatched ready slots", () => {
    const projection = createWorkspaceSidebarProjector().project({
      taskUiSlots: [
        readySlot("ready:stale", "task-stale"),
        creatingSlot("create:visible"),
      ],
      workspaceTasks: [],
    });

    expect(projection.sidebarItems.map((entry) => entry.slot_id)).toEqual(["create:visible"]);
    expect(projection.workspaceTasksByItemId.size).toBe(0);
  });
});

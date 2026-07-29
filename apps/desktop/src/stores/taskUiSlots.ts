import type { AgentProvider, PipelineItem } from "../types/kanna";
import type {
  CreatingTaskUiSlot,
  ReadyTaskUiSlot,
  SidebarTaskItem,
  TaskUiSlot,
} from "../types/taskUi";
import { normalizeAgentProviderCandidates } from "./agent-provider";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";

interface BuildCreatingTaskUiSlotOptions {
  slotId: string;
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
  stage?: string;
  agentType: AgentExecutionType;
  requestedAgentProviders?: AgentProvider | AgentProvider[];
  nowIso?: string;
}

export function buildCreatingTaskUiSlot(
  options: BuildCreatingTaskUiSlotOptions,
): CreatingTaskUiSlot {
  const providers = normalizeAgentProviderCandidates(options.requestedAgentProviders);

  return {
    slot_id: options.slotId,
    task_id: null,
    state: "creating",
    task: null,
    authoritative_miss_grace_remaining: 0,
    draft: {
      repo_id: options.repoId,
      prompt: options.prompt,
      display_name: options.displayName ?? null,
      pipeline: options.pipelineName ?? "no-review",
      stage: options.stage ?? "in progress",
      agent_type: options.agentType,
      agent_provider: providers[0] ?? "claude",
      created_at: options.nowIso ?? new Date().toISOString(),
    },
  };
}

export function acknowledgeTaskUiSlot(
  slots: readonly TaskUiSlot[],
  slotId: string,
  taskId: string,
): TaskUiSlot[] {
  const target = slots.find((slot) => slot.slot_id === slotId);
  if (!target) return [...slots];

  if (target.state === "ready") {
    if (target.task_id !== taskId) return [...slots];
    return slots.filter((slot) => slot.slot_id === slotId || slot.task_id !== taskId);
  }

  const task = slots.find(
    (slot): slot is ReadyTaskUiSlot => slot.state === "ready" && slot.task_id === taskId,
  )?.task;
  const acknowledged: TaskUiSlot = task
    ? {
        slot_id: target.slot_id,
        task_id: taskId,
        state: "ready",
        task,
        draft: target.draft,
      }
    : {
        ...target,
        task_id: taskId,
        authoritative_miss_grace_remaining: 1,
      };

  return slots.flatMap((slot) => {
    if (slot.slot_id === slotId) return [acknowledged];
    return slot.task_id === taskId ? [] : [slot];
  });
}

export function removeTaskUiSlot(slots: readonly TaskUiSlot[], slotId: string): TaskUiSlot[] {
  return slots.filter((slot) => slot.slot_id !== slotId);
}

export function taskUiSlotForSelection(
  slots: readonly TaskUiSlot[],
  selectionId: string | null | undefined,
): TaskUiSlot | null {
  if (!selectionId) return null;
  return slots.find((slot) => slot.slot_id === selectionId || slot.task_id === selectionId) ?? null;
}

export function reconcileTaskUiSlots(
  slots: readonly TaskUiSlot[],
  tasks: readonly PipelineItem[],
  options: { authoritative?: boolean } = {},
): TaskUiSlot[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const reposWithUnacknowledgedCreatingSlots = new Set(
    slots
      .filter((slot) => slot.state === "creating" && slot.task_id === null)
      .map((slot) => slot.draft.repo_id),
  );
  const claimedTaskIds = new Set<string>();
  const reconciled: TaskUiSlot[] = [];

  for (const slot of slots) {
    const task = slot.task_id ? tasksById.get(slot.task_id) : undefined;
    if (task) {
      claimedTaskIds.add(task.id);
      const readySlot: ReadyTaskUiSlot = {
        slot_id: slot.slot_id,
        task_id: task.id,
        state: "ready",
        task,
        draft: slot.draft,
      };
      reconciled.push(readySlot);
    } else if (slot.state === "creating") {
      if (slot.task_id === null || options.authoritative !== true) {
        reconciled.push(slot);
      } else if (slot.authoritative_miss_grace_remaining === 1) {
        reconciled.push({
          ...slot,
          authoritative_miss_grace_remaining: 0,
        });
      }
    }
  }

  for (const task of tasksById.values()) {
    if (claimedTaskIds.has(task.id)) continue;
    if (reposWithUnacknowledgedCreatingSlots.has(task.repo_id)) continue;
    reconciled.push({
      slot_id: task.id,
      task_id: task.id,
      state: "ready",
      task,
      draft: {
        repo_id: task.repo_id,
        prompt: task.prompt ?? "",
        display_name: task.display_name,
        pipeline: task.pipeline,
        stage: task.stage,
        agent_type: normalizeAgentExecutionType(task.agent_type),
        agent_provider: task.agent_provider,
        created_at: task.created_at,
      },
    });
  }

  return reconciled;
}

export function taskUiSlotToSidebarItem(slot: TaskUiSlot): SidebarTaskItem {
  if (slot.state === "ready") {
    const { id: task_id, ...task } = slot.task;
    return { ...task, slot_id: slot.slot_id, task_id, state: "ready" };
  }

  const now = slot.draft.created_at;
  return {
    slot_id: slot.slot_id,
    task_id: slot.task_id,
    state: "creating",
    repo_id: slot.draft.repo_id,
    issue_number: null,
    issue_title: null,
    prompt: slot.draft.prompt,
    pipeline: slot.draft.pipeline,
    pipeline_def: null,
    stage: slot.draft.stage,
    pr_number: null,
    pr_url: null,
    branch: null,
    closed_at: null,
    agent_type: slot.draft.agent_type,
    agent_provider: slot.draft.agent_provider,
    activity: "working",
    activity_changed_at: now,
    unread_at: null,
    port_offset: null,
    display_name: slot.draft.display_name,
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
    created_at: now,
    updated_at: now,
  };
}

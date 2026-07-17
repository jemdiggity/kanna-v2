import type { AgentProvider } from "@kanna/agent-protocol";
import type { TaskSummary } from "../lib/api/types";

export interface TaskUiSlotDraft {
  repoId: string;
  prompt: string;
  desktopId: string | null;
  agentProvider: AgentProvider;
  agentType: "pty" | "agent";
  stage: string;
}

export interface CreatingTaskUiSlot {
  slotId: string;
  taskId: null;
  state: "creating";
  task: null;
  draft: TaskUiSlotDraft;
}

export interface ReadyTaskUiSlot {
  slotId: string;
  taskId: string;
  state: "ready";
  task: TaskSummary;
  draft: TaskUiSlotDraft;
  authoritativeMissGraceRemaining?: 0 | 1;
}

export type TaskUiSlot = CreatingTaskUiSlot | ReadyTaskUiSlot;

export interface BuildCreatingTaskUiSlotInput {
  slotId: string;
  repoId: string;
  prompt: string;
  desktopId: string;
  agentProvider: AgentProvider;
}

export function buildCreatingTaskUiSlot({
  slotId,
  repoId,
  prompt,
  desktopId,
  agentProvider
}: BuildCreatingTaskUiSlotInput): CreatingTaskUiSlot {
  return {
    slotId,
    taskId: null,
    state: "creating",
    task: null,
    draft: {
      repoId,
      prompt,
      desktopId,
      agentProvider,
      agentType: "pty",
      stage: "in progress"
    }
  };
}

export function acknowledgeTaskUiSlot(
  slots: readonly TaskUiSlot[],
  slotId: string,
  task: TaskSummary
): TaskUiSlot[] {
  const target = slots.find((slot) => slot.slotId === slotId);
  if (!target) {
    return [...slots];
  }

  const acknowledged: ReadyTaskUiSlot = {
    slotId: target.slotId,
    taskId: task.id,
    state: "ready",
    task,
    draft: target.draft,
    authoritativeMissGraceRemaining:
      target.state === "creating"
        ? 1
        : target.authoritativeMissGraceRemaining ?? 0
  };

  return slots.flatMap((slot) => {
    if (slot.slotId === slotId) {
      return [acknowledged];
    }
    return slot.taskId === task.id ? [] : [slot];
  });
}

export function removeTaskUiSlot(
  slots: readonly TaskUiSlot[],
  slotId: string
): TaskUiSlot[] {
  return slots.filter((slot) => slot.slotId !== slotId);
}

export function taskUiSlotForSelection(
  slots: readonly TaskUiSlot[],
  selectionId: string | null | undefined
): TaskUiSlot | null {
  if (!selectionId) {
    return null;
  }
  return slots.find(
    (slot) => slot.slotId === selectionId || slot.taskId === selectionId
  ) ?? null;
}

export function taskUiSlotToTaskSummary(slot: TaskUiSlot): TaskSummary {
  if (slot.state === "ready") {
    return slot.task;
  }
  return {
    id: slot.slotId,
    repoId: slot.draft.repoId,
    title: slot.draft.prompt,
    prompt: slot.draft.prompt,
    stage: slot.draft.stage,
    agentProvider: slot.draft.agentProvider,
    agentType: slot.draft.agentType,
    ownerDesktopId: slot.draft.desktopId ?? undefined,
    activity: "working"
  };
}

export function reconcileTaskUiSlots(
  localSlots: readonly TaskUiSlot[],
  tasks: readonly TaskSummary[],
  options: { authoritative?: boolean } = {}
): TaskUiSlot[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  return localSlots.flatMap((slot): TaskUiSlot[] => {
    const task = slot.taskId ? tasksById.get(slot.taskId) : undefined;
    if (task) {
      return [{
        ...slot,
        state: "ready",
        taskId: task.id,
        task,
        authoritativeMissGraceRemaining: 0
      }];
    }

    if (slot.state === "creating" || options.authoritative !== true) {
      return [slot];
    }
    if (slot.authoritativeMissGraceRemaining === 1) {
      return [{ ...slot, authoritativeMissGraceRemaining: 0 }];
    }
    return [];
  });
}

export function projectTaskUiSlots(
  tasks: readonly TaskSummary[],
  localSlots: readonly TaskUiSlot[]
): TaskUiSlot[] {
  const projected: TaskUiSlot[] = [...localSlots];
  const localSlotIndexesByTaskId = new Map(
    localSlots.flatMap((slot, index) =>
      slot.taskId ? [[slot.taskId, index] as const] : []
    )
  );

  for (const task of tasks) {
    const existingIndex = localSlotIndexesByTaskId.get(task.id);
    if (existingIndex !== undefined) {
      const existing = projected[existingIndex]!;
      projected[existingIndex] = {
        ...existing,
        state: "ready",
        taskId: task.id,
        task
      };
      continue;
    }

    projected.push({
      slotId: task.id,
      taskId: task.id,
      state: "ready",
      task,
      draft: {
        repoId: task.repoId,
        prompt: task.prompt ?? task.title,
        desktopId: task.ownerDesktopId ?? null,
        agentProvider: normalizeAgentProvider(task.agentProvider),
        agentType: task.agentType === "agent" ? "agent" : "pty",
        stage: task.stage ?? "in progress"
      }
    });
  }

  return projected;
}

function normalizeAgentProvider(provider: string | null | undefined): AgentProvider {
  switch (provider) {
    case "claude":
    case "copilot":
    case "codex":
    case "opencode":
    case "antigravity":
      return provider;
    default:
      return "claude";
  }
}

import type { AgentExecutionType } from "../stores/agentExecutionType";
import type { AgentProvider, PipelineItem } from "./kanna";

export interface TaskUiDraft {
  repo_id: string;
  prompt: string;
  display_name: string | null;
  workflow: string;
  stage: string;
  agent_type: AgentExecutionType;
  agent_provider: AgentProvider;
  created_at: string;
}

interface TaskUiSlotBase {
  slot_id: string;
  draft: TaskUiDraft;
}

export interface CreatingTaskUiSlot extends TaskUiSlotBase {
  task_id: string | null;
  state: "creating";
  task: null;
  authoritative_miss_grace_remaining: 0 | 1;
}

export interface ReadyTaskUiSlot extends TaskUiSlotBase {
  task_id: string;
  state: "ready";
  task: PipelineItem;
}

export type TaskUiSlot = CreatingTaskUiSlot | ReadyTaskUiSlot;

interface SidebarTaskItemBase extends Omit<PipelineItem, "id"> {
  slot_id: string;
  remote_task?: boolean;
}

export interface CreatingSidebarTaskItem extends SidebarTaskItemBase {
  task_id: string | null;
  state: "creating";
}

export interface ReadySidebarTaskItem extends SidebarTaskItemBase {
  task_id: string;
  state: "ready";
}

export type SidebarTaskItem = CreatingSidebarTaskItem | ReadySidebarTaskItem;

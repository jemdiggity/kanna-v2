import type { AgentProvider, PipelineItem } from "../types/kanna";
import { normalizeAgentProviderCandidates } from "./agent-provider";
import type { AgentExecutionType } from "./agentExecutionType";

export interface InitializingTaskItem {
  id: string;
  state: "initializing";
  taskId: string | null;
  repo_id: string;
  prompt: string;
  display_name: string | null;
  pipeline: string;
  stage: string;
  agent_type: AgentExecutionType;
  agent_provider: AgentProvider;
  created_at: string;
}

export interface ReadyTaskUiItem {
  id: string;
  state: "ready";
  taskId: string;
  task: PipelineItem;
}

export type TaskUiItem = InitializingTaskItem | ReadyTaskUiItem;

interface BuildInitializingTaskItemOptions {
  id: string;
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
  stage?: string;
  agentType: AgentExecutionType;
  requestedAgentProviders?: AgentProvider | AgentProvider[];
  nowIso?: string;
}

export function buildInitializingTaskItem(
  options: BuildInitializingTaskItemOptions,
): InitializingTaskItem {
  const providers = normalizeAgentProviderCandidates(options.requestedAgentProviders);
  return {
    id: options.id,
    state: "initializing",
    taskId: null,
    repo_id: options.repoId,
    prompt: options.prompt,
    display_name: options.displayName ?? null,
    pipeline: options.pipelineName ?? "default",
    stage: options.stage ?? "in progress",
    agent_type: options.agentType,
    agent_provider: providers[0] ?? "claude",
    created_at: options.nowIso ?? new Date().toISOString(),
  };
}

export function toReadyTaskUiItem(task: PipelineItem): ReadyTaskUiItem {
  return {
    id: task.id,
    state: "ready",
    taskId: task.id,
    task,
  };
}

export function initializeTaskItem(
  items: readonly InitializingTaskItem[],
  itemId: string,
  taskId: string,
): InitializingTaskItem[] {
  return items.map((item) => item.id === itemId ? { ...item, taskId } : item);
}

export function removeInitializingTaskItem(
  items: readonly InitializingTaskItem[],
  itemId: string,
): InitializingTaskItem[] {
  return items.filter((item) => item.id !== itemId);
}

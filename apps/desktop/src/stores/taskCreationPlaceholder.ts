import type { AgentProvider, PipelineItem } from "@kanna/db";
import { normalizeAgentProviderCandidates } from "./agent-provider";
import type { AgentExecutionType } from "./agentExecutionType";

interface BuildPendingTaskPlaceholderOptions {
  id: string;
  repoId: string;
  prompt: string;
  branch: string;
  agentType: AgentExecutionType;
  requestedAgentProviders?: AgentProvider | AgentProvider[];
  pipelineName?: string;
  stage?: string;
  displayName?: string | null;
  nowIso?: string;
}

export function buildPendingTaskPlaceholder(
  options: BuildPendingTaskPlaceholderOptions,
): PipelineItem {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const stage = options.stage ?? "in progress";
  const requestedProviders = normalizeAgentProviderCandidates(options.requestedAgentProviders);

  return {
    id: options.id,
    repo_id: options.repoId,
    issue_number: null,
    issue_title: null,
    prompt: options.prompt,
    pipeline: options.pipelineName ?? "default",
    pipeline_def: null,
    stage,
    pr_number: null,
    pr_url: null,
    branch: options.branch,
    closed_at: null,
    agent_type: options.agentType,
    agent_provider: requestedProviders[0] ?? "claude",
    activity: "working",
    activity_changed_at: nowIso,
    unread_at: null,
    port_offset: null,
    display_name: options.displayName ?? null,
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
    created_at: nowIso,
    updated_at: nowIso,
  };
}

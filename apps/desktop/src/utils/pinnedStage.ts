import { parseWorkflowJson } from "../../../../packages/core/src/workflow/workflow-loader";
import type { WorkflowDefinition, WorkflowStage } from "../../../../packages/core/src/workflow/workflow-types";
import type { PipelineItem } from "../types/kanna";

type PinnedStageTask = Pick<PipelineItem, "pipeline_def" | "stage">;

/**
 * The task's pinned `pipeline_def` snapshot is the durable source of truth
 * for what advancing the task does: the repo's live workflow file may have
 * changed since the task was created, but the engine executes the snapshot.
 */
export function pinnedWorkflowDefinition(item: PinnedStageTask): WorkflowDefinition | null {
  if (!item.pipeline_def?.trim()) return null;
  try {
    return parseWorkflowJson(item.pipeline_def);
  } catch {
    return null;
  }
}

export function pinnedCurrentStage(item: PinnedStageTask): WorkflowStage | null {
  const workflow = pinnedWorkflowDefinition(item);
  return workflow?.stages.find((stage) => stage.name === item.stage) ?? null;
}

/**
 * True when the task's pinned current stage declares the merge-signaling
 * `approve` post — the built-in post that marks the PR ready and signals the
 * merge master. Pre-change snapshots and custom workflows whose final stage
 * has no such post advance without any merge side effect, so approval UI
 * must not promise one.
 */
export function pinnedApproveMergePost(item: PinnedStageTask): boolean {
  const post = pinnedCurrentStage(item)?.post;
  if (!post) return false;
  return post.name === "approve" || post.agent === "approve";
}

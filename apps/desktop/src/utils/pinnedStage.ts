import { parsePipelineJson } from "../../../../packages/core/src/pipeline/pipeline-loader";
import type { PipelineDefinition, PipelineStage } from "../../../../packages/core/src/pipeline/pipeline-types";
import type { PipelineItem } from "../types/kanna";

type PinnedStageTask = Pick<PipelineItem, "pipeline_def" | "stage">;

/**
 * The task's pinned `pipeline_def` snapshot is the durable source of truth
 * for what advancing the task does: the repo's live pipeline file may have
 * changed since the task was created, but the engine executes the snapshot.
 */
export function pinnedPipelineDefinition(item: PinnedStageTask): PipelineDefinition | null {
  if (!item.pipeline_def?.trim()) return null;
  try {
    return parsePipelineJson(item.pipeline_def);
  } catch {
    return null;
  }
}

export function pinnedCurrentStage(item: PinnedStageTask): PipelineStage | null {
  const pipeline = pinnedPipelineDefinition(item);
  return pipeline?.stages.find((stage) => stage.name === item.stage) ?? null;
}

/**
 * True when the task's pinned current stage declares the merge-signaling
 * `approve` post — the built-in post that marks the PR ready and signals the
 * merge master. Pre-change snapshots and custom pipelines whose final stage
 * has no such post advance without any merge side effect, so approval UI
 * must not promise one.
 */
export function pinnedApproveMergePost(item: PinnedStageTask): boolean {
  const post = pinnedCurrentStage(item)?.post;
  if (!post) return false;
  return post.name === "approve" || post.agent === "approve";
}

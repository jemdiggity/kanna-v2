import { parsePipelineJson } from "../../../../packages/core/src/pipeline/pipeline-loader";
import type { PipelineItem } from "../types/kanna";

type ReviewInboxTask = Pick<
  PipelineItem,
  "activity" | "closed_at" | "has_running_post" | "pipeline_def" | "stage"
>;

export function reviewAwaitingVerdictStage(item: ReviewInboxTask): string | null {
  if (item.closed_at != null) return null;
  if (item.activity === "working") return null;
  if (item.has_running_post) return null;
  if (!item.pipeline_def?.trim()) return null;

  try {
    const pipeline = parsePipelineJson(item.pipeline_def);
    const stage = pipeline.stages.find((candidate) => candidate.name === item.stage);
    return stage?.policy.transition === "manual" ? stage.name : null;
  } catch {
    return null;
  }
}

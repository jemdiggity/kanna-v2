import type { PipelineDefinition, PipelineStage } from "./pipeline-types";

export function getStageIndex(pipeline: PipelineDefinition, stageName: string): number {
  return pipeline.stages.findIndex(s => s.name === stageName);
}

export function getNextStage(pipeline: PipelineDefinition, currentStage: string): PipelineStage | null {
  const idx = getStageIndex(pipeline, currentStage);
  if (idx === -1 || idx >= pipeline.stages.length - 1) return null;
  return pipeline.stages[idx + 1];
}

export function isLastStage(pipeline: PipelineDefinition, stageName: string): boolean {
  return getStageIndex(pipeline, stageName) === pipeline.stages.length - 1;
}

export const SYSTEM_TAGS = ["in progress", "done", "pr", "merge", "blocked", "teardown", "archived"] as const;
export type SystemTag = (typeof SYSTEM_TAGS)[number];

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch { return []; }
}

export function hasTag(item: { tags: string }, tag: string): boolean {
  return parseTags(item.tags).includes(tag);
}

export function isHidden(item: { tags: string }): boolean {
  return hasTag(item, "done") || hasTag(item, "archived");
}

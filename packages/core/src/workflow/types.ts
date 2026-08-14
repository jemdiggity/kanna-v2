import type { WorkflowDefinition, WorkflowStage } from "./workflow-types";

export function getStageIndex(workflow: WorkflowDefinition, stageName: string): number {
  return workflow.stages.findIndex(s => s.name === stageName);
}

export function getNextStage(workflow: WorkflowDefinition, currentStage: string): WorkflowStage | null {
  const idx = getStageIndex(workflow, currentStage);
  if (idx === -1 || idx >= workflow.stages.length - 1) return null;
  return workflow.stages[idx + 1];
}

export function isLastStage(workflow: WorkflowDefinition, stageName: string): boolean {
  return getStageIndex(workflow, stageName) === workflow.stages.length - 1;
}

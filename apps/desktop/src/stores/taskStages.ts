export const TEARDOWN_STAGE = "teardown";
export const LEGACY_TORNDOWN_STAGE = "torndown";

export function isTeardownStage(stage: string): boolean {
  return stage === TEARDOWN_STAGE || stage === LEGACY_TORNDOWN_STAGE;
}

export function normalizeWorkflowStage(stage: string): string {
  return isTeardownStage(stage) ? TEARDOWN_STAGE : stage;
}

export interface TaskTeardownState {
  stage: string;
  teardown_started_at?: string | null;
}

export function isTaskTearingDown(item: TaskTeardownState): boolean {
  return item.teardown_started_at != null || isTeardownStage(item.stage);
}

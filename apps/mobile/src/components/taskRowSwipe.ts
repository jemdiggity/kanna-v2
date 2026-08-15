export const TASK_ROW_ACTION_WIDTH = 92;
export const TASK_ROW_SWIPE_ACTIVATION = 14;
export const TASK_ROW_SWIPE_REVEAL_THRESHOLD = 48;

export interface TaskRowSwipeDisplacement {
  dx: number;
  dy: number;
}

export function shouldBeginTaskRowSwipe({
  dx,
  dy
}: TaskRowSwipeDisplacement): boolean {
  return (
    dx < -TASK_ROW_SWIPE_ACTIVATION &&
    Math.abs(dx) > Math.abs(dy) * 1.5
  );
}

export function clampTaskRowSwipe(dx: number): number {
  return Math.max(-TASK_ROW_ACTION_WIDTH, Math.min(0, dx));
}

export function shouldRevealTaskRowAction(dx: number): boolean {
  return dx <= -TASK_ROW_SWIPE_REVEAL_THRESHOLD;
}

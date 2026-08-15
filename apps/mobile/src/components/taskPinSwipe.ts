export const TASK_PIN_ACTION_WIDTH = 92;
export const TASK_PIN_SWIPE_ACTIVATION = 14;
export const TASK_PIN_SWIPE_REVEAL_THRESHOLD = 48;

export interface TaskPinSwipeDisplacement {
  dx: number;
  dy: number;
}

export function shouldBeginTaskPinSwipe({
  dx,
  dy
}: TaskPinSwipeDisplacement): boolean {
  return (
    dx < -TASK_PIN_SWIPE_ACTIVATION &&
    Math.abs(dx) > Math.abs(dy) * 1.5
  );
}

export function clampTaskPinSwipe(dx: number): number {
  return Math.max(-TASK_PIN_ACTION_WIDTH, Math.min(0, dx));
}

export function shouldRevealTaskPinAction(dx: number): boolean {
  return dx <= -TASK_PIN_SWIPE_REVEAL_THRESHOLD;
}

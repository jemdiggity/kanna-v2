export const TASK_ROW_ACTION_WIDTH = 92;
export const TASK_ROW_SWIPE_ACTIVATION = 14;
export const TASK_ROW_SWIPE_COMMIT_THRESHOLD = 48;
export const TASK_ROW_REDUCED_MOTION_TIMING_MS = 140;

export type TaskRowCompletionMotion = "spring" | "timing";

/**
 * Reduced motion keeps the row and action spatially separate, but replaces
 * physical springs and overshoot with a short timing animation.
 */
export function taskRowCompletionMotion(
  reduceMotionEnabled: boolean
): TaskRowCompletionMotion {
  return reduceMotionEnabled ? "timing" : "spring";
}

/**
 * How the action under the row is drawn while the finger is down. The row
 * commits on release, so the only thing that tells the user what letting go
 * will do is the action itself: it sits back at full opacity while a release
 * would cancel, and changes scale and colour once a release would commit.
 */
export interface TaskRowActionEmphasis {
  opacity: number;
  transform: { scale: number }[];
}

export const TASK_ROW_ACTION_IDLE_EMPHASIS: TaskRowActionEmphasis = {
  opacity: 1,
  transform: [{ scale: 0.88 }]
};

export const TASK_ROW_ACTION_ARMED_EMPHASIS: TaskRowActionEmphasis = {
  opacity: 1,
  transform: [{ scale: 1.04 }]
};

export interface TaskRowSwipeDisplacement {
  dx: number;
  dy: number;
}

/**
 * The row has one resting position — closed — so only a leftward drag is ever
 * its own to take. A rightward one has nothing to reveal and belongs to
 * whatever encloses the row.
 */
export function shouldBeginTaskRowSwipe({
  dx,
  dy
}: TaskRowSwipeDisplacement): boolean {
  if (Math.abs(dx) <= Math.abs(dy) * 1.5) {
    return false;
  }
  return dx < -TASK_ROW_SWIPE_ACTIVATION;
}

/**
 * The translation a drag of `dx` produces, bounded by the action's width.
 * Dragging back past the closed position does not push the row the other way.
 */
export function clampTaskRowSwipe(dx: number): number {
  return Math.max(-TASK_ROW_ACTION_WIDTH, Math.min(0, dx));
}

/**
 * Whether releasing at this translation performs the row's action. The same
 * distance arms and disarms: dragging past it arms the release, dragging back
 * inside it disarms again, so a swipe can always be taken back without
 * lifting the finger.
 */
export function shouldCommitTaskRowAction(offset: number): boolean {
  return offset <= -TASK_ROW_SWIPE_COMMIT_THRESHOLD;
}

export function taskRowActionEmphasis(offset: number): TaskRowActionEmphasis {
  return shouldCommitTaskRowAction(offset)
    ? TASK_ROW_ACTION_ARMED_EMPHASIS
    : TASK_ROW_ACTION_IDLE_EMPHASIS;
}

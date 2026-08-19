export const TASK_ROW_ACTION_WIDTH = 92;
export const TASK_ROW_SWIPE_ACTIVATION = 14;
export const TASK_ROW_SWIPE_REVEAL_THRESHOLD = 48;

export interface TaskRowSwipeDisplacement {
  dx: number;
  dy: number;
  /**
   * Where the row already rests when the gesture starts: `0` closed, negative
   * with the action revealed. A revealed row is a resting state the next
   * gesture has to be able to act on, so the direction that closes it is a
   * gesture the row must claim too.
   */
  offset?: number;
}

export function shouldBeginTaskRowSwipe({
  dx,
  dy,
  offset = 0
}: TaskRowSwipeDisplacement): boolean {
  if (Math.abs(dx) <= Math.abs(dy) * 1.5) {
    return false;
  }
  // Closed, only a leftward drag is the row's to take — a rightward one has
  // nothing to reveal and belongs to whatever encloses the row. Revealed,
  // either direction moves the row it is already displaced from.
  return offset < 0
    ? Math.abs(dx) > TASK_ROW_SWIPE_ACTIVATION
    : dx < -TASK_ROW_SWIPE_ACTIVATION;
}

/**
 * The translation a drag of `dx` produces from a row resting at `startOffset`,
 * bounded by the action's width. Displacement is measured from where the row
 * rests, not from the closed position, so a drag that begins on a revealed row
 * moves it from there.
 */
export function clampTaskRowSwipe(dx: number, startOffset = 0): number {
  return Math.max(-TASK_ROW_ACTION_WIDTH, Math.min(0, startOffset + dx));
}

/**
 * Which resting position a released drag settles into, given the translation
 * it ended on. The same distance decides both directions: a closed row opens
 * once dragged past the threshold, and a revealed one closes once dragged back
 * inside it.
 */
export function shouldRevealTaskRowAction(offset: number): boolean {
  return offset <= -TASK_ROW_SWIPE_REVEAL_THRESHOLD;
}

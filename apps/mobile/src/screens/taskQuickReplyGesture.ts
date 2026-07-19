export const TASK_QUICK_REPLY_LONG_PRESS_MS = 400;
export const TASK_QUICK_REPLY_TAP_SLOP = 10;
export const TASK_QUICK_REPLY_CARD_HEIGHT = 48;
export const TASK_QUICK_REPLY_CARD_GAP = 8;
export const TASK_QUICK_REPLY_CARD_WIDTH = 260;
export const TASK_QUICK_REPLY_FIRST_CENTER_Y = 52;

const TASK_QUICK_REPLY_MAX_COUNT = 5;
const TASK_QUICK_REPLY_HIT_EXTENSION = 8;
const TASK_QUICK_REPLY_VERTICAL_HALF_BAND =
  TASK_QUICK_REPLY_CARD_HEIGHT / 2 + TASK_QUICK_REPLY_HIT_EXTENSION;
const TASK_QUICK_REPLY_HORIZONTAL_MIN = -239;
const TASK_QUICK_REPLY_HORIZONTAL_MAX = 37;

interface GestureDisplacement {
  dx: number;
  dy: number;
}

export function exceedsTaskQuickReplyTapSlop({
  dx,
  dy
}: GestureDisplacement): boolean {
  return Math.hypot(dx, dy) > TASK_QUICK_REPLY_TAP_SLOP;
}

export function selectTaskQuickReplyIndex(
  { dx, dy }: GestureDisplacement,
  replyCount: number
): number | null {
  const count = Math.min(
    TASK_QUICK_REPLY_MAX_COUNT,
    Math.max(0, Math.floor(replyCount))
  );
  if (
    count === 0 ||
    dx < TASK_QUICK_REPLY_HORIZONTAL_MIN ||
    dx > TASK_QUICK_REPLY_HORIZONTAL_MAX
  ) {
    return null;
  }

  const upwardDistance = -dy;
  const cardStride = TASK_QUICK_REPLY_CARD_HEIGHT + TASK_QUICK_REPLY_CARD_GAP;
  let closestIndex: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < count; index += 1) {
    const center = TASK_QUICK_REPLY_FIRST_CENTER_Y + index * cardStride;
    const distance = Math.abs(upwardDistance - center);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }

  return closestDistance <= TASK_QUICK_REPLY_VERTICAL_HALF_BAND
    ? closestIndex
    : null;
}

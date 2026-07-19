import { describe, expect, it } from "vitest";
import {
  exceedsTaskQuickReplyTapSlop,
  selectTaskQuickReplyIndex,
  TASK_QUICK_REPLY_CARD_GAP,
  TASK_QUICK_REPLY_CARD_HEIGHT,
  TASK_QUICK_REPLY_CARD_WIDTH,
  TASK_QUICK_REPLY_LONG_PRESS_MS,
  TASK_QUICK_REPLY_TAP_SLOP
} from "./taskQuickReplyGesture";

describe("task quick reply gesture", () => {
  it("defines the approved gesture and rail dimensions", () => {
    expect(TASK_QUICK_REPLY_LONG_PRESS_MS).toBe(400);
    expect(TASK_QUICK_REPLY_TAP_SLOP).toBe(10);
    expect(TASK_QUICK_REPLY_CARD_HEIGHT).toBe(48);
    expect(TASK_QUICK_REPLY_CARD_GAP).toBe(8);
    expect(TASK_QUICK_REPLY_CARD_WIDTH).toBe(260);
  });

  it("maps upward displacement to the nearest reply", () => {
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: 0 }, 5)).toBeNull();
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -52 }, 5)).toBe(0);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -108 }, 5)).toBe(1);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -164 }, 5)).toBe(2);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -220 }, 5)).toBe(3);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -276 }, 5)).toBe(4);
  });

  it("chooses the nearest card where expanded hit regions overlap", () => {
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -79 }, 2)).toBe(0);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -81 }, 2)).toBe(1);
  });

  it("includes the eight-point vertical hit extension", () => {
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -20 }, 1)).toBe(0);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -19 }, 1)).toBeNull();
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -84 }, 1)).toBe(0);
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -85 }, 1)).toBeNull();
  });

  it("cancels outside the horizontal or vertical card band", () => {
    expect(selectTaskQuickReplyIndex({ dx: -240, dy: -52 }, 5)).toBeNull();
    expect(selectTaskQuickReplyIndex({ dx: 38, dy: -52 }, 5)).toBeNull();
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -350 }, 5)).toBeNull();
  });

  it("returns no selection for an empty list and ignores entries after five", () => {
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -52 }, 0)).toBeNull();
    expect(selectTaskQuickReplyIndex({ dx: 0, dy: -332 }, 6)).toBeNull();
  });

  it("uses Euclidean distance for the ten-point tap slop", () => {
    expect(exceedsTaskQuickReplyTapSlop({ dx: 6, dy: 8 })).toBe(false);
    expect(exceedsTaskQuickReplyTapSlop({ dx: 8, dy: 8 })).toBe(true);
  });
});

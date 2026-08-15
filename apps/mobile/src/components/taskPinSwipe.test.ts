import { describe, expect, it } from "vitest";
import {
  TASK_PIN_ACTION_WIDTH,
  clampTaskPinSwipe,
  shouldBeginTaskPinSwipe,
  shouldRevealTaskPinAction
} from "./taskPinSwipe";

describe("task pin swipe gesture", () => {
  it("claims only deliberate leftward horizontal movement", () => {
    expect(shouldBeginTaskPinSwipe({ dx: -20, dy: 4 })).toBe(true);
    expect(shouldBeginTaskPinSwipe({ dx: -10, dy: 1 })).toBe(false);
    expect(shouldBeginTaskPinSwipe({ dx: 24, dy: 2 })).toBe(false);
    expect(shouldBeginTaskPinSwipe({ dx: -24, dy: 20 })).toBe(false);
  });

  it("bounds translation and requires a meaningful reveal distance", () => {
    expect(clampTaskPinSwipe(20)).toBe(0);
    expect(clampTaskPinSwipe(-32)).toBe(-32);
    expect(clampTaskPinSwipe(-200)).toBe(-TASK_PIN_ACTION_WIDTH);
    expect(shouldRevealTaskPinAction(-47)).toBe(false);
    expect(shouldRevealTaskPinAction(-48)).toBe(true);
  });
});

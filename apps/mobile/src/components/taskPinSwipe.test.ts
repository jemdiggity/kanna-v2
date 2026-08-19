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

  it("claims either direction once the action is revealed", () => {
    const revealed = -TASK_PIN_ACTION_WIDTH;
    expect(
      shouldBeginTaskPinSwipe({ dx: 20, dy: 4, offset: revealed })
    ).toBe(true);
    expect(
      shouldBeginTaskPinSwipe({ dx: -20, dy: 4, offset: revealed })
    ).toBe(true);
    // Still not a scroll, and still not an idle touch.
    expect(
      shouldBeginTaskPinSwipe({ dx: 10, dy: 1, offset: revealed })
    ).toBe(false);
    expect(
      shouldBeginTaskPinSwipe({ dx: 24, dy: 20, offset: revealed })
    ).toBe(false);
  });

  it("bounds translation and requires a meaningful reveal distance", () => {
    expect(clampTaskPinSwipe(20)).toBe(0);
    expect(clampTaskPinSwipe(-32)).toBe(-32);
    expect(clampTaskPinSwipe(-200)).toBe(-TASK_PIN_ACTION_WIDTH);
    expect(shouldRevealTaskPinAction(-47)).toBe(false);
    expect(shouldRevealTaskPinAction(-48)).toBe(true);
  });

  it("measures a drag from where the row already rests", () => {
    const revealed = -TASK_PIN_ACTION_WIDTH;
    expect(clampTaskPinSwipe(30, revealed)).toBe(revealed + 30);
    expect(clampTaskPinSwipe(200, revealed)).toBe(0);
    expect(clampTaskPinSwipe(-30, revealed)).toBe(revealed);
    // The same threshold decides both directions: dragging a revealed row
    // back inside it closes, stopping short of it stays open.
    expect(shouldRevealTaskPinAction(clampTaskPinSwipe(50, revealed))).toBe(
      false
    );
    expect(shouldRevealTaskPinAction(clampTaskPinSwipe(20, revealed))).toBe(
      true
    );
  });
});

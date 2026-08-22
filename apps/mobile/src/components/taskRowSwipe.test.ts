import { describe, expect, it } from "vitest";
import {
  TASK_ROW_ACTION_ARMED_EMPHASIS,
  TASK_ROW_ACTION_IDLE_EMPHASIS,
  TASK_ROW_ACTION_WIDTH,
  TASK_ROW_REDUCED_MOTION_FADE_MS,
  clampTaskRowSwipe,
  shouldBeginTaskRowSwipe,
  shouldCommitTaskRowAction,
  taskRowActionEmphasis,
  taskRowCompletionMotion
} from "./taskRowSwipe";

describe("task row swipe gesture", () => {
  it("claims only deliberate leftward horizontal movement", () => {
    expect(shouldBeginTaskRowSwipe({ dx: -20, dy: 4 })).toBe(true);
    expect(shouldBeginTaskRowSwipe({ dx: -10, dy: 1 })).toBe(false);
    expect(shouldBeginTaskRowSwipe({ dx: 24, dy: 2 })).toBe(false);
    expect(shouldBeginTaskRowSwipe({ dx: -24, dy: 20 })).toBe(false);
  });

  it("bounds the translation to the action it uncovers", () => {
    expect(clampTaskRowSwipe(20)).toBe(0);
    expect(clampTaskRowSwipe(-32)).toBe(-32);
    expect(clampTaskRowSwipe(-200)).toBe(-TASK_ROW_ACTION_WIDTH);
  });

  it("commits a release only past the threshold, in both directions", () => {
    expect(shouldCommitTaskRowAction(-47)).toBe(false);
    expect(shouldCommitTaskRowAction(-48)).toBe(true);
    // The same distance disarms: a swipe dragged back inside the threshold
    // releases without acting.
    expect(shouldCommitTaskRowAction(clampTaskRowSwipe(-92 + 50))).toBe(false);
    expect(shouldCommitTaskRowAction(clampTaskRowSwipe(-92 + 20))).toBe(true);
  });

  it("emphasizes the action exactly where the release would commit", () => {
    expect(taskRowActionEmphasis(-20)).toBe(TASK_ROW_ACTION_IDLE_EMPHASIS);
    expect(taskRowActionEmphasis(-47)).toBe(TASK_ROW_ACTION_IDLE_EMPHASIS);
    expect(taskRowActionEmphasis(-48)).toBe(TASK_ROW_ACTION_ARMED_EMPHASIS);
    expect(TASK_ROW_ACTION_ARMED_EMPHASIS.opacity).toBeGreaterThan(
      TASK_ROW_ACTION_IDLE_EMPHASIS.opacity
    );
    expect(TASK_ROW_ACTION_ARMED_EMPHASIS.transform[0].scale).toBeGreaterThan(
      TASK_ROW_ACTION_IDLE_EMPHASIS.transform[0].scale
    );
  });

  it("replaces physical completion motion with a short fade for reduced motion", () => {
    expect(taskRowCompletionMotion(false)).toBe("spring");
    expect(taskRowCompletionMotion(true)).toBe("fade");
    expect(TASK_ROW_REDUCED_MOTION_FADE_MS).toBeLessThanOrEqual(200);
  });
});

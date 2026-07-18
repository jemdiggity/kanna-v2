import { describe, expect, it } from "vitest";
import {
  clampTaskComposerHeight,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS
} from "./taskComposerInput";

describe("TASK_COMPOSER_TEXT_INPUT_PROPS", () => {
  it("keeps the soft keyboard return key as a newline instead of submit", () => {
    expect(TASK_COMPOSER_TEXT_INPUT_PROPS).toMatchObject({
      blurOnSubmit: false,
      multiline: true,
      returnKeyType: "default"
    });
  });

  it.each([
    [24, 40],
    [72, 72],
    [160, 120],
    [Number.POSITIVE_INFINITY, 40]
  ])("clamps native content height %s to %s", (contentHeight, expected) => {
    expect(clampTaskComposerHeight(contentHeight)).toBe(expected);
  });

  it("exports the input's existing layout bounds", () => {
    expect(TASK_COMPOSER_MIN_HEIGHT).toBe(40);
    expect(TASK_COMPOSER_MAX_HEIGHT).toBe(120);
  });
});

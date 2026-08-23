import { describe, expect, it } from "vitest";
import {
  clampTaskComposerHeight,
  getTaskComposerExplicitLineHeight,
  TASK_COMPOSER_LINE_HEIGHT,
  TASK_COMPOSER_MAX_LINES,
  TASK_COMPOSER_MAX_HEIGHT,
  TASK_COMPOSER_MIN_HEIGHT,
  TASK_COMPOSER_TEXT_INPUT_PROPS,
  TASK_COMPOSER_VERTICAL_PADDING
} from "./taskComposerInput";

describe("TASK_COMPOSER_TEXT_INPUT_PROPS", () => {
  it("keeps the soft keyboard return key as a newline instead of submit", () => {
    expect(TASK_COMPOSER_TEXT_INPUT_PROPS).toMatchObject({
      blurOnSubmit: false,
      multiline: true,
      returnKeyType: "default",
      scrollEnabled: true
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

  it("derives a clamped fallback height from explicit lines", () => {
    expect(getTaskComposerExplicitLineHeight("")).toBe(40);
    expect(getTaskComposerExplicitLineHeight("one\ntwo\nthree")).toBe(80);
    expect(getTaskComposerExplicitLineHeight("1\n2\n3\n4\n5")).toBe(120);
    expect(getTaskComposerExplicitLineHeight("1\n2\n3\n4\n5\n6\n7\n8")).toBe(
      120
    );
  });

  it("derives the input bounds from one baseline line through five lines", () => {
    expect(TASK_COMPOSER_LINE_HEIGHT).toBe(20);
    expect(TASK_COMPOSER_VERTICAL_PADDING).toBe(20);
    expect(TASK_COMPOSER_MAX_LINES).toBe(5);
    expect(TASK_COMPOSER_MIN_HEIGHT).toBe(40);
    expect(TASK_COMPOSER_MAX_HEIGHT).toBe(120);
  });
});

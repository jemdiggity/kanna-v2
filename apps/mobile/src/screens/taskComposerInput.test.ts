import { describe, expect, it } from "vitest";
import {
  shouldTaskComposerScroll,
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
      returnKeyType: "default"
    });
  });

  it("enables native scrolling only above the five-line cap", () => {
    expect(shouldTaskComposerScroll(120)).toBe(false);
    expect(shouldTaskComposerScroll(121)).toBe(true);
    expect(shouldTaskComposerScroll(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("derives the input bounds from one baseline line through five lines", () => {
    expect(TASK_COMPOSER_LINE_HEIGHT).toBe(20);
    expect(TASK_COMPOSER_VERTICAL_PADDING).toBe(20);
    expect(TASK_COMPOSER_MAX_LINES).toBe(5);
    expect(TASK_COMPOSER_MIN_HEIGHT).toBe(40);
    expect(TASK_COMPOSER_MAX_HEIGHT).toBe(120);
  });
});

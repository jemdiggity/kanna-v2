import { describe, expect, it } from "vitest";
import { TASK_COMPOSER_TEXT_INPUT_PROPS } from "./taskComposerInput";

describe("TASK_COMPOSER_TEXT_INPUT_PROPS", () => {
  it("keeps the soft keyboard return key as a newline instead of submit", () => {
    expect(TASK_COMPOSER_TEXT_INPUT_PROPS).toMatchObject({
      blurOnSubmit: false,
      multiline: true,
      returnKeyType: "default"
    });
  });
});

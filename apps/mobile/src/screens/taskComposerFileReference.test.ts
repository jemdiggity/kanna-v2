import { describe, expect, it } from "vitest";
import { appendComposerFileReference } from "./taskComposerInput";

describe("file browser composer hand-off", () => {
  it("inserts a line range without discarding an existing draft", () => {
    expect(appendComposerFileReference("Please inspect", "src/main.ts:12-18"))
      .toBe("Please inspect\nsrc/main.ts:12-18");
  });

  it("accepts a quoted selected-text payload", () => {
    expect(appendComposerFileReference("", "src/main.ts:12\n> const ready = true;"))
      .toBe("src/main.ts:12\n> const ready = true;");
  });
});

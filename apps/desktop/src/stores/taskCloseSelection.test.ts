import { describe, expect, it } from "vitest";
import { shouldSelectNextOnCloseTransition } from "./taskCloseSelection";

describe("shouldSelectNextOnCloseTransition", () => {
  it("selects immediately when a normal task enters teardown", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: true,
        wasBlocked: false,
        previousStage: "in progress",
        nextStage: "tearing_down",
      }),
    ).toBe(true);
  });

  it("also selects immediately when a normal task closes directly", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: true,
        wasBlocked: false,
        previousStage: "in progress",
        nextStage: "closed",
      }),
    ).toBe(true);
  });

  it("does not require a teardown stage write before selecting the next item", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: true,
        wasBlocked: false,
        previousStage: "pr",
        nextStage: "closed",
      }),
    ).toBe(true);
  });

  it("does not select when selection handoff is disabled", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: false,
        wasBlocked: false,
        previousStage: "in progress",
        nextStage: "closed",
      }),
    ).toBe(false);
  });

  it("does not treat blocked-task close as an immediate selection handoff", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: true,
        wasBlocked: true,
        previousStage: "in progress",
        nextStage: "closed",
      }),
    ).toBe(false);
  });

  it("does not reselect on final close after teardown", () => {
    expect(
      shouldSelectNextOnCloseTransition({
        selectNext: true,
        wasBlocked: false,
        previousStage: "teardown",
        nextStage: "closed",
      }),
    ).toBe(false);
  });
});

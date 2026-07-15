import { describe, expect, it } from "vitest";
import {
  buildTaskQuickReply,
  TASK_QUICK_REPLIES
} from "./taskQuickReplies";

describe("task quick replies", () => {
  it("defines the initial SGTM reply with a stable id", () => {
    expect(TASK_QUICK_REPLIES).toEqual([
      {
        id: "sgtm-proceed",
        label: "SGTM. Proceed.",
        messagePrefix: "SGTM. Proceed."
      }
    ]);
  });

  it.each(["", "   ", "\n\t"])(
    "builds only the shortcut for an empty draft %#",
    (draft) => {
      expect(buildTaskQuickReply(TASK_QUICK_REPLIES[0]!, draft)).toBe(
        "SGTM. Proceed."
      );
    }
  );

  it("appends a trimmed draft after one blank line", () => {
    expect(
      buildTaskQuickReply(
        TASK_QUICK_REPLIES[0]!,
        "  Also add regression tests.  "
      )
    ).toBe("SGTM. Proceed.\n\nAlso add regression tests.");
  });
});

import { describe, expect, it } from "vitest";
import {
  addTaskQuickReply,
  buildTaskQuickReply,
  DEFAULT_TASK_QUICK_REPLIES,
  deleteTaskQuickReply,
  MAX_TASK_QUICK_REPLIES,
  MAX_TASK_QUICK_REPLY_LENGTH,
  moveTaskQuickReply,
  normalizeTaskQuickReplies,
  updateTaskQuickReply,
  validateTaskQuickReplies
} from "./taskQuickReplies";

describe("task quick replies", () => {
  it("starts with the existing SGTM reply", () => {
    expect(DEFAULT_TASK_QUICK_REPLIES).toEqual([
      { id: "sgtm-proceed", text: "SGTM. Proceed." }
    ]);
  });

  it("trims entries, removes case-insensitive duplicates, and caps at five", () => {
    expect(
      normalizeTaskQuickReplies([
        { id: "a", text: "  One  " },
        { id: "b", text: "one" },
        { id: "c", text: "Two" },
        { id: "d", text: "Three" },
        { id: "e", text: "Four" },
        { id: "f", text: "Five" },
        { id: "g", text: "Six" }
      ])
    ).toEqual([
      { id: "a", text: "One" },
      { id: "c", text: "Two" },
      { id: "d", text: "Three" },
      { id: "e", text: "Four" },
      { id: "f", text: "Five" }
    ]);
  });

  it("rejects malformed entries while preserving internal whitespace", () => {
    expect(
      normalizeTaskQuickReplies([
        null,
        { id: "", text: "Missing ID" },
        { id: "valid", text: "  First line\n  second line  " },
        { id: "missing-text" }
      ])
    ).toEqual([{ id: "valid", text: "First line\n  second line" }]);
  });

  it("validates one to five unique replies of at most 200 characters", () => {
    expect(MAX_TASK_QUICK_REPLIES).toBe(5);
    expect(MAX_TASK_QUICK_REPLY_LENGTH).toBe(200);
    expect(validateTaskQuickReplies([])).toMatchObject({
      valid: false,
      listError: expect.stringMatching(/at least one/i)
    });
    expect(
      validateTaskQuickReplies([
        { id: "a", text: "Same" },
        { id: "b", text: " same " }
      ]).errors[1]
    ).toMatch(/unique/i);
    expect(
      validateTaskQuickReplies([{ id: "long", text: "x".repeat(201) }])
        .errors[0]
    ).toMatch(/200 characters/i);
  });

  it("reports blank entries without normalizing them away", () => {
    expect(
      validateTaskQuickReplies([{ id: "blank", text: "  \n " }]).errors[0]
    ).toMatch(/cannot be blank/i);
  });

  it("adds, updates, deletes, and moves replies without mutation", () => {
    const original = [
      { id: "a", text: "One" },
      { id: "b", text: "Two" }
    ];

    expect(
      addTaskQuickReply(original, { id: "c", text: "Three" })
    ).toEqual([
      { id: "a", text: "One" },
      { id: "b", text: "Two" },
      { id: "c", text: "Three" }
    ]);
    expect(updateTaskQuickReply(original, "a", "Updated")[0]?.text).toBe(
      "Updated"
    );
    expect(deleteTaskQuickReply(original, "a")).toEqual([
      { id: "b", text: "Two" }
    ]);
    expect(
      moveTaskQuickReply(original, "b", -1).map((reply) => reply.id)
    ).toEqual(["b", "a"]);
    expect(original).toEqual([
      { id: "a", text: "One" },
      { id: "b", text: "Two" }
    ]);
  });

  it("keeps list operations within one to five entries", () => {
    const onlyReply = [{ id: "a", text: "One" }];
    const fiveReplies = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      text: `Reply ${index}`
    }));

    expect(deleteTaskQuickReply(onlyReply, "a")).toBe(onlyReply);
    expect(
      addTaskQuickReply(fiveReplies, { id: "extra", text: "Extra" })
    ).toBe(fiveReplies);
    expect(moveTaskQuickReply(onlyReply, "a", -1)).toBe(onlyReply);
    expect(moveTaskQuickReply(onlyReply, "missing", 1)).toBe(onlyReply);
  });

  it.each(["", "   ", "\n\t"])(
    "builds only the shortcut for an empty draft %#",
    (draft) => {
      expect(buildTaskQuickReply(DEFAULT_TASK_QUICK_REPLIES[0]!, draft)).toBe(
        "SGTM. Proceed."
      );
    }
  );

  it("appends a trimmed draft after one blank line", () => {
    expect(
      buildTaskQuickReply(
        DEFAULT_TASK_QUICK_REPLIES[0]!,
        "  Also add regression tests.  "
      )
    ).toBe("SGTM. Proceed.\n\nAlso add regression tests.");
  });
});

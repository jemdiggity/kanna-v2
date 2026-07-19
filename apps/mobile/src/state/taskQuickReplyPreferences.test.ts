import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";
import {
  createTaskQuickReplyPreferences,
  TASK_QUICK_REPLY_STORAGE_KEY
} from "./taskQuickReplyPreferences";

const storage = {
  getItem: vi.fn<() => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>()
};

describe("task quick reply preferences", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    null,
    "not json",
    JSON.stringify({ version: 2, replies: [] }),
    JSON.stringify({ version: 1, replies: [] })
  ])("falls back to the default for unsupported data %#", async (raw) => {
    storage.getItem.mockResolvedValue(raw);
    const repository = createTaskQuickReplyPreferences(storage);

    const loaded = await repository.load();

    expect(loaded).toEqual(DEFAULT_TASK_QUICK_REPLIES);
    expect(loaded).not.toBe(DEFAULT_TASK_QUICK_REPLIES);
    expect(storage.getItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY
    );
  });

  it("falls back when storage cannot be read", async () => {
    storage.getItem.mockRejectedValue(new Error("storage unavailable"));

    await expect(
      createTaskQuickReplyPreferences(storage).load()
    ).resolves.toEqual(DEFAULT_TASK_QUICK_REPLIES);
  });

  it("keeps the valid ordered subset of a version-one envelope", async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({
        version: 1,
        replies: [
          { id: "custom", text: "  Ship it  " },
          { id: "duplicate", text: "ship it" },
          { id: "missing-text" },
          { id: "second", text: "Add tests" }
        ]
      })
    );

    await expect(
      createTaskQuickReplyPreferences(storage).load()
    ).resolves.toEqual([
      { id: "custom", text: "Ship it" },
      { id: "second", text: "Add tests" }
    ]);
  });

  it("finds valid replies after more than five overlong stored entries", async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({
        version: 1,
        replies: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `overlong-${index}`,
            text: `${index}${"x".repeat(200)}`
          })),
          { id: "valid", text: "Ship it" }
        ]
      })
    );

    await expect(
      createTaskQuickReplyPreferences(storage).load()
    ).resolves.toEqual([{ id: "valid", text: "Ship it" }]);
  });

  it("normalizes and round-trips valid replies", async () => {
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(
      repository.save([{ id: "custom", text: "  Ship it  " }])
    ).resolves.toEqual([{ id: "custom", text: "Ship it" }]);
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        replies: [{ id: "custom", text: "Ship it" }]
      })
    );
  });

  it.each([
    [] as const,
    [
      { id: "first", text: "Same" },
      { id: "second", text: " same " }
    ] as const,
    [{ id: "blank", text: "   " }] as const
  ])("rejects an invalid list without writing %#", async (replies) => {
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(repository.save(replies)).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("propagates a storage write failure", async () => {
    storage.setItem.mockRejectedValue(new Error("disk full"));
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(
      repository.save([{ id: "custom", text: "Ship it" }])
    ).rejects.toThrow("disk full");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";
import {
  createTaskQuickReplyPreferences,
  TASK_QUICK_REPLY_BACKUP_STORAGE_KEY,
  TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
  TaskQuickReplySaveBlockedError,
  TASK_QUICK_REPLY_STORAGE_KEY
} from "./taskQuickReplyPreferences";

const storage = {
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>()
};

describe("task quick reply preferences", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
  });

  it("treats a missing key as a resolved default baseline", async () => {
    storage.getItem.mockResolvedValue(null);
    const repository = createTaskQuickReplyPreferences(storage);

    const loaded = await repository.load();

    expect(loaded).toEqual({
      status: "loaded",
      replies: DEFAULT_TASK_QUICK_REPLIES
    });
    expect(loaded.replies).not.toBe(DEFAULT_TASK_QUICK_REPLIES);
    expect(storage.getItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("preserves malformed data and refuses a save until replacement is confirmed", async () => {
    const raw = "not json";
    storage.getItem.mockResolvedValue(raw);
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(repository.load()).resolves.toEqual({
      status: "failed",
      replies: DEFAULT_TASK_QUICK_REPLIES
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
      raw
    );

    await expect(
      repository.save([{ id: "custom", text: "Ship it" }])
    ).rejects.toMatchObject<TaskQuickReplySaveBlockedError>({
      reason: "load-failed"
    });
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      expect.any(String)
    );

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).resolves.toEqual([{ id: "custom", text: "Ship it" }]);
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      envelope([{ id: "custom", text: "Ship it" }])
    );
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_BACKUP_STORAGE_KEY,
      raw
    );
  });

  it("preserves a non-empty envelope that normalizes to no replies", async () => {
    const raw = JSON.stringify({
      version: 1,
      replies: [{ id: "blank", text: "   " }]
    });
    storage.getItem.mockResolvedValue(raw);
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(repository.load()).resolves.toMatchObject({ status: "failed" });
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
      raw
    );
    await expect(
      repository.save(DEFAULT_TASK_QUICK_REPLIES)
    ).rejects.toMatchObject({ reason: "load-failed" });
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      expect.any(String)
    );
  });

  it("preserves an unknown-version envelope instead of discarding it", async () => {
    const raw = JSON.stringify({
      version: 2,
      replies: [{ id: "future", text: "Future reply" }]
    });
    storage.getItem.mockResolvedValue(raw);

    await expect(
      createTaskQuickReplyPreferences(storage).load()
    ).resolves.toMatchObject({ status: "failed" });
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
      raw
    );
  });

  it("recovers the active payload before a confirmed replacement after an adapter read failure", async () => {
    const raw = "existing raw payload";
    storage.getItem
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(raw);
    const repository = createTaskQuickReplyPreferences(storage);

    await expect(repository.load()).resolves.toEqual({
      status: "failed",
      replies: DEFAULT_TASK_QUICK_REPLIES
    });
    expect(storage.setItem).not.toHaveBeenCalled();

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).resolves.toEqual([{ id: "custom", text: "Ship it" }]);
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).toHaveBeenNthCalledWith(
      1,
      TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
      raw
    );
    expect(storage.setItem).toHaveBeenNthCalledWith(
      2,
      TASK_QUICK_REPLY_STORAGE_KEY,
      envelope([{ id: "custom", text: "Ship it" }])
    );
    expect(storage.getItem.mock.invocationCallOrder[1]).toBeLessThan(
      storage.setItem.mock.invocationCallOrder[0]
    );
    expect(storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      storage.setItem.mock.invocationCallOrder[1]
    );
  });

  it("allows a confirmed replacement only after a retry proves the active key is absent", async () => {
    storage.getItem
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(null);
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).resolves.toEqual([{ id: "custom", text: "Ship it" }]);
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      envelope([{ id: "custom", text: "Ship it" }])
    );
  });

  it("does not write the active key when the recovery retry also fails", async () => {
    storage.getItem.mockRejectedValue(new Error("storage unavailable"));
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).rejects.toMatchObject({ reason: "recovery-not-preserved" });
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not write the active key when recovery after a read failure cannot be preserved", async () => {
    storage.getItem
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce("existing raw payload");
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).rejects.toMatchObject({ reason: "recovery-not-preserved" });
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY,
      "existing raw payload"
    );
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      expect.any(String)
    );
  });

  it("refuses a save before an unresolved load has read the baseline", async () => {
    let resolveRead: ((value: string | null) => void) | undefined;
    storage.getItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const repository = createTaskQuickReplyPreferences(storage);
    const loading = repository.load();

    await expect(
      repository.save([{ id: "custom", text: "Ship it" }])
    ).rejects.toMatchObject({ reason: "baseline-unresolved" });
    expect(storage.setItem).not.toHaveBeenCalled();

    resolveRead?.(envelope([{ id: "stored", text: "Stored" }]));
    await expect(loading).resolves.toEqual({
      status: "loaded",
      replies: [{ id: "stored", text: "Stored" }]
    });
  });

  it("does not replace malformed data when its recovery copy cannot be written", async () => {
    storage.getItem.mockResolvedValue("not json");
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();

    await expect(
      repository.save(
        [{ id: "custom", text: "Ship it" }],
        { confirmReplacement: true }
      )
    ).rejects.toMatchObject({ reason: "recovery-not-preserved" });
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      expect.any(String)
    );
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
    ).resolves.toEqual({
      status: "loaded",
      replies: [
        { id: "custom", text: "Ship it" },
        { id: "second", text: "Add tests" }
      ]
    });
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
    ).resolves.toEqual({
      status: "loaded",
      replies: [{ id: "valid", text: "Ship it" }]
    });
  });

  it("rotates the previous good envelope before every successful save", async () => {
    const first = [{ id: "first", text: "First" }];
    const second = [{ id: "second", text: "Second" }];
    const third = [{ id: "third", text: "Third" }];
    storage.getItem.mockResolvedValue(envelope(first));
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();

    await expect(repository.save(second)).resolves.toEqual(second);
    expect(storage.setItem).toHaveBeenNthCalledWith(
      1,
      TASK_QUICK_REPLY_BACKUP_STORAGE_KEY,
      envelope(first)
    );
    expect(storage.setItem).toHaveBeenNthCalledWith(
      2,
      TASK_QUICK_REPLY_STORAGE_KEY,
      envelope(second)
    );

    await expect(repository.save(third)).resolves.toEqual(third);
    expect(storage.setItem).toHaveBeenNthCalledWith(
      3,
      TASK_QUICK_REPLY_BACKUP_STORAGE_KEY,
      envelope(second)
    );
    expect(storage.setItem).toHaveBeenNthCalledWith(
      4,
      TASK_QUICK_REPLY_STORAGE_KEY,
      envelope(third)
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
    storage.getItem.mockResolvedValue(null);
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();
    storage.setItem.mockClear();

    await expect(repository.save(replies)).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("propagates a backup write failure without overwriting the active value", async () => {
    storage.getItem.mockResolvedValue(
      envelope([{ id: "stored", text: "Stored" }])
    );
    const repository = createTaskQuickReplyPreferences(storage);
    await repository.load();
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      repository.save([{ id: "custom", text: "Ship it" }])
    ).rejects.toThrow("disk full");
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_QUICK_REPLY_STORAGE_KEY,
      expect.any(String)
    );
  });
});

function envelope(replies: readonly { id: string; text: string }[]): string {
  return JSON.stringify({ version: 1, replies });
}

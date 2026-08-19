import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLocalTaskListPreferences } from "./taskListPreferences";
import {
  createTaskListPreferencesStore,
  TASK_LIST_PREFERENCES_BACKUP_STORAGE_KEY,
  TASK_LIST_PREFERENCES_RECOVERY_STORAGE_KEY,
  TASK_LIST_PREFERENCES_STORAGE_KEY,
  TaskListPreferencesSaveBlockedError
} from "./taskListPreferencesStorage";

const storage = {
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>()
};

const pinned = {
  pins: [{ taskId: "task-1", repoId: "repo-1" }],
  dismissedActivity: [
    { taskId: "task-2", repoId: "repo-1", activityRevision: 7 }
  ],
  pinsSeededFromServer: true
};

describe("task list preferences storage", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
  });

  it("treats a missing key as an empty record with the seed still owed", async () => {
    storage.getItem.mockResolvedValue(null);
    const store = createTaskListPreferencesStore(storage);

    await expect(store.load()).resolves.toEqual({
      status: "loaded",
      preferences: emptyLocalTaskListPreferences()
    });
    expect(storage.getItem).toHaveBeenCalledWith(
      TASK_LIST_PREFERENCES_STORAGE_KEY
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("round-trips a saved record and backs the previous one up", async () => {
    storage.getItem.mockResolvedValue(null);
    const store = createTaskListPreferencesStore(storage);
    await store.load();

    await expect(store.save(pinned)).resolves.toEqual(pinned);
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_LIST_PREFERENCES_BACKUP_STORAGE_KEY,
      JSON.stringify({ version: 1, preferences: emptyLocalTaskListPreferences() })
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      TASK_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, preferences: pinned })
    );

    const reread = createTaskListPreferencesStore({
      getItem: async () => JSON.stringify({ version: 1, preferences: pinned }),
      setItem: storage.setItem
    });
    await expect(reread.load()).resolves.toEqual({
      status: "loaded",
      preferences: pinned
    });
  });

  it("refuses to save before the record has been read", async () => {
    const store = createTaskListPreferencesStore(storage);

    await expect(store.save(pinned)).rejects.toMatchObject({
      reason: "baseline-unresolved"
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    { label: "malformed", raw: "not json" },
    {
      label: "unknown-version",
      raw: JSON.stringify({ version: 2, preferences: pinned })
    },
    {
      label: "unreadable-shape",
      raw: JSON.stringify({ version: 1, preferences: { pins: "all" } })
    }
  ])(
    "preserves a $label payload before it can be replaced",
    async ({ raw }) => {
      storage.getItem.mockResolvedValue(raw);
      const store = createTaskListPreferencesStore(storage);

      await expect(store.load()).resolves.toEqual({
        status: "failed",
        preferences: emptyLocalTaskListPreferences()
      });
      // The bytes are copied aside first — a read this module cannot
      // understand never becomes "this phone has no pins".
      expect(storage.setItem).toHaveBeenCalledWith(
        TASK_LIST_PREFERENCES_RECOVERY_STORAGE_KEY,
        raw
      );
      expect(storage.setItem).not.toHaveBeenCalledWith(
        TASK_LIST_PREFERENCES_STORAGE_KEY,
        expect.any(String)
      );

      // Pinning is not dead for good: once preserved, the phone may write.
      await expect(store.save(pinned)).resolves.toEqual(pinned);
      expect(storage.setItem).toHaveBeenCalledWith(
        TASK_LIST_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ version: 1, preferences: pinned })
      );
    }
  );

  it("blocks a save while the stored payload could not be preserved", async () => {
    storage.getItem.mockResolvedValue("not json");
    storage.setItem.mockRejectedValue(new Error("storage full"));
    const store = createTaskListPreferencesStore(storage);

    await expect(store.load()).resolves.toMatchObject({ status: "failed" });
    await expect(store.save(pinned)).rejects.toBeInstanceOf(
      TaskListPreferencesSaveBlockedError
    );
    expect(storage.setItem).not.toHaveBeenCalledWith(
      TASK_LIST_PREFERENCES_STORAGE_KEY,
      expect.any(String)
    );
  });

  it("retries preservation before replacing a payload it never managed to read", async () => {
    const raw = JSON.stringify({ version: 2, preferences: pinned });
    storage.getItem.mockRejectedValueOnce(new Error("storage offline"));
    const store = createTaskListPreferencesStore(storage);

    await expect(store.load()).resolves.toMatchObject({ status: "failed" });
    expect(storage.setItem).not.toHaveBeenCalled();

    storage.getItem.mockResolvedValueOnce(raw);
    await expect(store.save(pinned)).resolves.toEqual(pinned);
    expect(storage.setItem).toHaveBeenNthCalledWith(
      1,
      TASK_LIST_PREFERENCES_RECOVERY_STORAGE_KEY,
      raw
    );
    expect(storage.setItem).toHaveBeenLastCalledWith(
      TASK_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, preferences: pinned })
    );
  });

  it("shares one read across concurrent loads", async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({ version: 1, preferences: pinned })
    );
    const store = createTaskListPreferencesStore(storage);

    const [first, second] = await Promise.all([store.load(), store.load()]);

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    // Later reads answer from the resolved baseline with their own copy.
    const third = await store.load();
    expect(third).toEqual(first);
    expect(third.preferences).not.toBe(first.preferences);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });
});

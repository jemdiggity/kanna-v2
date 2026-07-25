import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDesktopServerClientHandlersForTests } from "./desktopServerClient";
import {
  REMOTE_TASK_PINS_SETTING,
  parseRemoteTaskPins,
  pinRemoteTask,
  reorderRemoteTaskPins,
  unpinRemoteTask,
} from "./remoteTaskPins";

describe("parseRemoteTaskPins", () => {
  it("returns an empty map when the setting is absent", () => {
    expect(parseRemoteTaskPins({})).toEqual(new Map());
    expect(parseRemoteTaskPins(undefined)).toEqual(new Map());
    expect(parseRemoteTaskPins(null)).toEqual(new Map());
  });

  it("parses owner task ids mapped to pin orders", () => {
    const pins = parseRemoteTaskPins({
      [REMOTE_TASK_PINS_SETTING]: JSON.stringify({ "task-a": 0, "task-b": 2 }),
    });
    expect(pins).toEqual(new Map([["task-a", 0], ["task-b", 2]]));
  });

  it("ignores malformed JSON without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseRemoteTaskPins({ [REMOTE_TASK_PINS_SETTING]: "{oops" })).toEqual(new Map());
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("drops entries whose order is not a finite number", () => {
    const pins = parseRemoteTaskPins({
      [REMOTE_TASK_PINS_SETTING]: JSON.stringify({ "task-a": 1, "task-b": "top", "task-c": null }),
    });
    expect(pins).toEqual(new Map([["task-a", 1]]));
  });

  it("ignores non-object payloads", () => {
    expect(parseRemoteTaskPins({ [REMOTE_TASK_PINS_SETTING]: "[1,2]" })).toEqual(new Map());
    expect(parseRemoteTaskPins({ [REMOTE_TASK_PINS_SETTING]: "7" })).toEqual(new Map());
  });
});

describe("remote task pin mutations", () => {
  let settings: Map<string, string>;
  let deletedKeys: string[];

  beforeEach(() => {
    settings = new Map();
    deletedKeys = [];
    setDesktopServerClientHandlersForTests({
      getSetting: (key) => settings.get(key) ?? null,
      putSetting: (key, value) => {
        settings.set(key, value);
      },
      deleteSetting: (key) => {
        settings.delete(key);
        deletedKeys.push(key);
      },
    });
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  function storedPins(): Map<string, number> {
    return parseRemoteTaskPins(Object.fromEntries(settings));
  }

  it("pins and unpins a remote task", async () => {
    await pinRemoteTask("task-a", 1);
    expect(storedPins()).toEqual(new Map([["task-a", 1]]));

    await pinRemoteTask("task-b", 0);
    expect(storedPins()).toEqual(new Map([["task-a", 1], ["task-b", 0]]));

    await unpinRemoteTask("task-a");
    expect(storedPins()).toEqual(new Map([["task-b", 0]]));
  });

  it("deletes the setting when the last pin is removed", async () => {
    await pinRemoteTask("task-a", 0);
    await unpinRemoteTask("task-a");
    expect(settings.has(REMOTE_TASK_PINS_SETTING)).toBe(false);
    expect(deletedKeys).toContain(REMOTE_TASK_PINS_SETTING);
  });

  it("upserts orders for reordered pins", async () => {
    await pinRemoteTask("task-a", 0);
    await reorderRemoteTaskPins(new Map([["task-a", 2], ["task-b", 0]]));
    expect(storedPins()).toEqual(new Map([["task-a", 2], ["task-b", 0]]));
  });

  it("does nothing for an empty reorder", async () => {
    await reorderRemoteTaskPins(new Map());
    expect(settings.size).toBe(0);
    expect(deletedKeys).toEqual([]);
  });

  it("serializes concurrent mutations so a pin and its reorder both land", async () => {
    await Promise.all([
      pinRemoteTask("task-new", 1),
      reorderRemoteTaskPins(new Map([["task-old", 0], ["task-new", 1]])),
    ]);
    expect(storedPins()).toEqual(new Map([["task-old", 0], ["task-new", 1]]));
  });

  it("keeps later mutations working after a failed write", async () => {
    setDesktopServerClientHandlersForTests({
      getSetting: (key) => settings.get(key) ?? null,
      putSetting: () => {
        throw new Error("write failed");
      },
      deleteSetting: (key) => {
        settings.delete(key);
      },
    });
    await expect(pinRemoteTask("task-a", 0)).rejects.toThrow("write failed");

    setDesktopServerClientHandlersForTests({
      getSetting: (key) => settings.get(key) ?? null,
      putSetting: (key, value) => {
        settings.set(key, value);
      },
      deleteSetting: (key) => {
        settings.delete(key);
      },
    });
    await pinRemoteTask("task-b", 0);
    expect(storedPins()).toEqual(new Map([["task-b", 0]]));
  });
});

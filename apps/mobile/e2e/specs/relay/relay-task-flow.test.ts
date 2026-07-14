import { describe, expect, it, vi } from "vitest";
import {
  verifyRelayTaskActivityTransitions,
  verifyRelayTaskMarkedRead,
} from "./relay-task-flow.e2e";

describe("verifyRelayTaskActivityTransitions", () => {
  it("observes working, unread, and idle through the rendered row value", async () => {
    let activity = "working";
    const observed: string[] = [];
    const row = {
      getAttribute: vi.fn(async (name: string) => {
        expect(name).toBe("value");
        observed.push(activity);
        return activity;
      }),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      getTaskRows: vi.fn(async () => []),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await condition()) return;
        }
        throw new Error(options.timeoutMsg);
      }),
    };
    const setTaskActivity = vi.fn(async (next: "unread" | "idle") => {
      activity = next;
    });

    await verifyRelayTaskActivityTransitions(
      ui as never,
      "cloud-task-1",
      setTaskActivity,
    );

    expect(observed).toEqual(["working", "unread", "idle"]);
    expect(setTaskActivity.mock.calls).toEqual([["unread"], ["idle"]]);
  });

  it("opens an unread task and waits for the real owner action before asserting idle", async () => {
    let activity = "working";
    let taskOpen = false;
    let ownerIdle = false;
    const row = {
      getAttribute: vi.fn(async () => activity),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };
    const actions = {
      prepareUnread: vi.fn(async () => {
        activity = "unread";
      }),
      openTask: vi.fn(async () => {
        taskOpen = true;
      }),
      waitForOwnerIdle: vi.fn(async () => {
        expect(taskOpen).toBe(true);
        ownerIdle = true;
      }),
      waitForSelectedDetailIdle: vi.fn(async () => {
        expect(ownerIdle).toBe(true);
        activity = "idle";
      }),
      closeTask: vi.fn(async () => {
        taskOpen = false;
      }),
    };

    await verifyRelayTaskMarkedRead(ui as never, "cloud-task-1", actions);

    expect(actions.prepareUnread).toHaveBeenCalledTimes(1);
    expect(actions.openTask).toHaveBeenCalledTimes(1);
    expect(actions.waitForOwnerIdle).toHaveBeenCalledTimes(1);
    expect(actions.waitForSelectedDetailIdle).toHaveBeenCalledTimes(1);
    expect(actions.closeTask).toHaveBeenCalledTimes(1);
    expect(activity).toBe("idle");
  });

  it("reports the last native activity value when a transition times out", async () => {
    const row = { getAttribute: vi.fn(async () => "unread") };
    const otherRow = {
      getAttribute: vi.fn(async (name: string) =>
        name === "name" ? "mobile.task-row.cloud-task-2" : null
      ),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      getTaskRows: vi.fn(async () => [otherRow]),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>) => {
        await condition();
        throw new Error("timeout");
      }),
    };

    await expect(
      verifyRelayTaskActivityTransitions(ui as never, "cloud-task-1", vi.fn()),
    ).rejects.toThrow(
      'last native accessibility value was unread; rendered task row ids were ["cloud-task-2"]',
    );
  });
});

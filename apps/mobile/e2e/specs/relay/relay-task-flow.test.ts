import { describe, expect, it, vi } from "vitest";
import {
  assertRelayTaskRowPresentation,
  openRelayFixtureTask,
  verifyRelayTaskActivityTransitions,
  verifyRelayTaskMarkedRead,
  type RelayTaskRowExpectation,
} from "./relay-task-flow.e2e";

const taskRowExpectation: RelayTaskRowExpectation = {
  title: "Relay card current title",
  stage: "in progress",
  waitingPromptSnippet: "Relay card current title",
  originalPromptSnippet: "Original relay request must stay hidden",
  repoLabel: "Relay fixture repository",
};

function expectedTaskRowLabel(): string {
  return `${taskRowExpectation.title}. ${taskRowExpectation.stage}`;
}

function createTaskRow(label: string, calls: string[] = []) {
  return {
    click: vi.fn(async () => {
      calls.push("click");
    }),
    getAttribute: vi.fn(async (name: string) => {
      calls.push(`getAttribute:${name}`);
      return label;
    }),
    getText: vi.fn(async () => label),
    waitForDisplayed: vi.fn(async () => {
      calls.push("waitForDisplayed");
    }),
  };
}

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

describe("relay task row presentation", () => {
  it("inspects the exact row before opening it", async () => {
    const calls: string[] = [];
    const row = createTaskRow(expectedTaskRowLabel(), calls);
    const ui = { getTaskRowById: vi.fn(async () => row) };

    await openRelayFixtureTask(
      ui,
      "cloud:desktop:repo:task",
      taskRowExpectation,
    );

    expect(ui.getTaskRowById).toHaveBeenCalledWith("cloud:desktop:repo:task");
    expect(calls).toEqual(["waitForDisplayed", "getAttribute:label", "click"]);
  });

  it("accepts a duplicated waiting preview rendered only once", async () => {
    await expect(
      assertRelayTaskRowPresentation(
        createTaskRow(expectedTaskRowLabel()),
        taskRowExpectation,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a duplicated waiting preview rendered twice", async () => {
    const duplicatedLabel =
      `${expectedTaskRowLabel()}. ${taskRowExpectation.waitingPromptSnippet}`;

    await expect(
      assertRelayTaskRowPresentation(
        createTaskRow(duplicatedLabel),
        taskRowExpectation,
      ),
    ).rejects.toThrow("unexpected content");
  });

  it.each([
    ["original prompt", taskRowExpectation.originalPromptSnippet],
    ["repository label", taskRowExpectation.repoLabel],
    ["TASK marker", "TASK"],
    ["RECENT marker", "RECENT"],
  ])("rejects a row containing the %s", async (_label, forbidden) => {
    const row = createTaskRow(`${expectedTaskRowLabel()}. ${forbidden}`);

    await expect(
      assertRelayTaskRowPresentation(row, taskRowExpectation),
    ).rejects.toThrow("unexpected content");
    expect(row.click).not.toHaveBeenCalled();
  });
});

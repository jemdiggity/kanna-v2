import { describe, expect, it, vi } from "vitest";
import {
  ensureTaskListVisible,
  waitForTaskTerminalLive
} from "./list-detail-back.e2e";

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  isExisting: ReturnType<typeof vi.fn>;
  waitForDisplayed: ReturnType<typeof vi.fn>;
}

function createElement(exists: () => boolean, onClick?: () => void): FakeElement {
  return {
    click: vi.fn(async () => {
      onClick?.();
    }),
    isExisting: vi.fn(async () => exists()),
    waitForDisplayed: vi.fn(async () => undefined)
  };
}

describe("ensureTaskListVisible", () => {
  it("backs out of persisted task detail before waiting for task rows", async () => {
    let taskDetailVisible = true;
    const backButton = createElement(
      () => taskDetailVisible,
      () => {
        taskDetailVisible = false;
      }
    );
    const ui = {
      getBackButton: vi.fn(async () => backButton),
      getTaskRows: vi.fn(async () => (taskDetailVisible ? [] : [createElement(() => true)])),
      pause: vi.fn(async () => undefined),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        for (let index = 0; index < 3; index += 1) {
          if (await condition()) {
            return;
          }
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await ensureTaskListVisible(ui);

    expect(backButton.click).toHaveBeenCalledTimes(1);
    expect(ui.pause).toHaveBeenCalledWith(500);
  });

  it("waits for task rows without navigating when already on the task list", async () => {
    const backButton = createElement(() => false);
    const ui = {
      getBackButton: vi.fn(async () => backButton),
      getTaskRows: vi.fn(async () => [createElement(() => true)]),
      pause: vi.fn(async () => undefined),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await ensureTaskListVisible(ui);

    expect(backButton.click).not.toHaveBeenCalled();
    expect(ui.pause).not.toHaveBeenCalled();
  });
});

describe("waitForTaskTerminalLive", () => {
  it("waits for the terminal overlay to disappear after opening a task", async () => {
    let overlayVisible = true;
    const agentMessageView = createElement(() => false);
    const overlay = createElement(() => overlayVisible);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      getTerminalOverlay: vi.fn(async () => overlay),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (!(await condition())) {
          overlayVisible = false;
        }

        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await waitForTaskTerminalLive(ui);

    expect(ui.getTerminalOverlay).toHaveBeenCalled();
  });

  it("accepts an agent message view after opening a task", async () => {
    const agentMessageView = createElement(() => true);
    const overlay = createElement(() => true);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      getTerminalOverlay: vi.fn(async () => overlay),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await waitForTaskTerminalLive(ui);

    expect(ui.getAgentMessageView).toHaveBeenCalled();
    expect(ui.getTerminalOverlay).not.toHaveBeenCalled();
  });
});

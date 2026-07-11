import { describe, expect, it, vi } from "vitest";
import {
  assertPtyTerminalFixtureAvailable,
  ensureTaskListVisible,
  inspectTerminalWebView,
  openPtyFixtureTask,
  PTY_SNAPSHOT_MIN_DECODED_BYTES,
  resolveRequiredPtyTerminalFixture,
  waitForRenderedPtyTerminal,
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

describe("PTY fixture selection", () => {
  it("requires a known live PTY fixture instead of opening an arbitrary task row", () => {
    expect(() => resolveRequiredPtyTerminalFixture({})).toThrow(
      "KANNA_E2E_PTY_TASK_ID is required"
    );
  });

  it("rejects a fixture task that is not a PTY task", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "task-agent",
        agentType: "agent",
        closedAt: null
      })
    }));

    await expect(
      assertPtyTerminalFixtureAvailable(
        "http://127.0.0.1:48120",
        {
          taskId: "task-agent",
          sentinel: "Kanna PTY sentinel",
          expectedCols: 80,
          expectedRows: 24,
          minDecodedBytes: PTY_SNAPSHOT_MIN_DECODED_BYTES
        },
        fetchImpl
      )
    ).rejects.toThrow("expected a live PTY task");
  });

  it("opens the exact fixture task row by id and never clicks the first arbitrary row", async () => {
    const firstRow = createElement(() => true);
    const fixtureRow = createElement(() => true);
    const ui = {
      getTaskRowById: vi.fn(async (taskId: string) =>
        taskId === "task-fixture" ? fixtureRow : firstRow
      ),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await openPtyFixtureTask(ui, "task-fixture");

    expect(ui.getTaskRowById).toHaveBeenCalledWith("task-fixture");
    expect(fixtureRow.click).toHaveBeenCalledTimes(1);
    expect(firstRow.click).not.toHaveBeenCalled();
  });
});

describe("waitForTaskTerminalLive", () => {
  it("does not treat an absent overlay as live before task detail mounts", async () => {
    const taskDetail = createElement(() => false);
    const agentMessageView = createElement(() => false);
    const overlay = createElement(() => false);
    const ui = {
      getTaskDetailScreen: vi.fn(async () => taskDetail),
      getAgentMessageView: vi.fn(async () => agentMessageView),
      getTerminalOverlay: vi.fn(async () => overlay),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForTaskTerminalLive(ui)).rejects.toThrow(
      "Expected the mobile task terminal"
    );
  });

  it("waits for the terminal overlay to disappear after opening a task", async () => {
    let overlayVisible = true;
    const taskDetail = createElement(() => true);
    const agentMessageView = createElement(() => false);
    const overlay = createElement(() => overlayVisible);
    const ui = {
      getTaskDetailScreen: vi.fn(async () => taskDetail),
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

  it("does not accept an agent message view until its stream is ready", async () => {
    const taskDetail = createElement(() => true);
    const agentMessageView = createElement(() => true);
    const agentMessageReady = createElement(() => false);
    const overlay = createElement(() => false);
    const ui = {
      getTaskDetailScreen: vi.fn(async () => taskDetail),
      getAgentMessageView: vi.fn(async () => agentMessageView),
      getAgentMessageReady: vi.fn(async () => agentMessageReady),
      getTerminalOverlay: vi.fn(async () => overlay),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        await condition();
        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForTaskTerminalLive(ui)).rejects.toThrow(
      "Expected the mobile task terminal"
    );

    expect(ui.getAgentMessageReady).toHaveBeenCalled();
    expect(ui.getTerminalOverlay).not.toHaveBeenCalled();
  });

  it("accepts an agent message view after its stream is ready", async () => {
    const taskDetail = createElement(() => true);
    const agentMessageView = createElement(() => true);
    const agentMessageReady = createElement(() => true);
    const overlay = createElement(() => true);
    const ui = {
      getTaskDetailScreen: vi.fn(async () => taskDetail),
      getAgentMessageView: vi.fn(async () => agentMessageView),
      getAgentMessageReady: vi.fn(async () => agentMessageReady),
      getTerminalOverlay: vi.fn(async () => overlay),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await waitForTaskTerminalLive(ui);

    expect(ui.getAgentMessageReady).toHaveBeenCalled();
    expect(ui.getTerminalOverlay).not.toHaveBeenCalled();
  });
});

describe("inspectTerminalWebView", () => {
  it("reports why WebView terminal inspection is unavailable", async () => {
    await expect(
      inspectTerminalWebView({
        execute: vi.fn()
      })
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Appium driver does not expose WebView context APIs"
    });
  });

  it("switches into the WebView context and restores the previous native context", async () => {
    const switchContext = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      kind: "rendered" as const,
      byteCount: 1024,
      cols: 132,
      frameCount: 1,
      rows: 43,
      text: "large snapshot"
    }));

    const result = await inspectTerminalWebView({
      execute,
      getContext: vi.fn(async () => "NATIVE_APP"),
      getContexts: vi.fn(async () => ["NATIVE_APP", "WEBVIEW_build.kanna.app.dev"]),
      switchContext
    });

    expect(result).toEqual({
      kind: "rendered",
      byteCount: 1024,
      cols: 132,
      frameCount: 1,
      rows: 43,
      text: "large snapshot"
    });
    expect(switchContext).toHaveBeenNthCalledWith(1, "WEBVIEW_build.kanna.app.dev");
    expect(switchContext).toHaveBeenNthCalledWith(2, "NATIVE_APP");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("waitForRenderedPtyTerminal", () => {
  const expectation = {
    sentinel: "Kanna PTY sentinel",
    expectedCols: 80,
    expectedRows: 24,
    minDecodedBytes: PTY_SNAPSHOT_MIN_DECODED_BYTES
  };

  it("waits until WebView terminal output and desktop dimensions are rendered", async () => {
    const agentMessageView = createElement(() => false);
    const inspections = [
      { kind: "unavailable" as const, reason: "No WEBVIEW context was available" },
      {
        kind: "rendered" as const,
        byteCount: PTY_SNAPSHOT_MIN_DECODED_BYTES,
        cols: 80,
        frameCount: 1,
        rows: 24,
        text: "large snapshot\nKanna PTY sentinel"
      }
    ];
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      inspectTerminalWebView: vi.fn(async () => inspections.shift() ?? inspections[0]),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        for (let index = 0; index < 3; index += 1) {
          if (await condition()) {
            return;
          }
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await waitForRenderedPtyTerminal(ui, expectation);

    expect(ui.inspectTerminalWebView).toHaveBeenCalledTimes(2);
  });

  it("fails on tiny decoded byte counts that would not catch the old mid-base64 slice", async () => {
    const agentMessageView = createElement(() => false);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        byteCount: 9_000,
        cols: 80,
        frameCount: 1,
        rows: 24,
        text: "Kanna PTY sentinel"
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        await condition();
        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForRenderedPtyTerminal(ui, expectation)).rejects.toThrow(
      "byteCount"
    );
  });

  it("fails when the rendered terminal text is blank", async () => {
    const agentMessageView = createElement(() => false);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        byteCount: PTY_SNAPSHOT_MIN_DECODED_BYTES,
        cols: 80,
        frameCount: 1,
        rows: 24,
        text: "   "
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        await condition();
        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForRenderedPtyTerminal(ui, expectation)).rejects.toThrow(
      "terminal text"
    );
  });

  it("fails when the expected terminal sentinel is missing", async () => {
    const agentMessageView = createElement(() => false);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        byteCount: PTY_SNAPSHOT_MIN_DECODED_BYTES,
        cols: 80,
        frameCount: 1,
        rows: 24,
        text: "large snapshot without the expected marker"
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        await condition();
        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForRenderedPtyTerminal(ui, expectation)).rejects.toThrow(
      "sentinel"
    );
  });

  it("fails with the last WebView inspection reason when Appium cannot inspect the terminal", async () => {
    const agentMessageView = createElement(() => false);
    const ui = {
      getAgentMessageView: vi.fn(async () => agentMessageView),
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "unavailable" as const,
        reason: "No WEBVIEW context was available"
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        await condition();
        throw new Error(options.timeoutMsg);
      })
    };

    await expect(waitForRenderedPtyTerminal(ui, expectation)).rejects.toThrow(
      "No WEBVIEW context was available"
    );
  });
});

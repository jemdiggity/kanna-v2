import { describe, expect, it, vi } from "vitest";
import * as smokeModule from "./list-detail-back.e2e";
import {
  assertPtyTerminalFixtureAvailable,
  ensureTaskListVisible,
  exerciseTaskPinSwipe,
  exerciseListDetailBackFromOrigin,
  inspectTerminalWebView,
  openPtyFixtureTask,
  performTaskDetailEdgeSwipeBack,
  PTY_SNAPSHOT_MIN_DECODED_BYTES,
  resolveRequiredPtyTerminalFixture,
  waitForRenderedPtyTerminal,
  waitForTaskTerminalLive
} from "./list-detail-back.e2e";
import { selectors } from "../../helpers/selectors";

describe("origin-preserving list/detail/back", () => {
  it("returns to Activity after opening a task from Activity", async () => {
    const calls: string[] = [];
    const ui = {
      selectOrigin: vi.fn(async (origin: string) => {
        calls.push(`select:${origin}`);
      }),
      openTask: vi.fn(async (taskId: string) => {
        calls.push(`open:${taskId}`);
      }),
      goBack: vi.fn(async () => {
        calls.push("back");
      }),
      assertOrigin: vi.fn(async (origin: string) => {
        calls.push(`assert:${origin}`);
      })
    };

    await exerciseListDetailBackFromOrigin(ui, "recent", "task-1");

    expect(calls).toEqual([
      "select:recent",
      "open:task-1",
      "back",
      "assert:recent"
    ]);
  });
});

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

describe("performTaskDetailEdgeSwipeBack", () => {
  it("drags from the native iOS left edge and waits for Tasks to replace TaskDetail", async () => {
    let taskDetailVisible = true;
    let tasksVisible = false;
    const taskDetail = createElement(() => taskDetailVisible);
    const tasksScreen = {
      ...createElement(() => tasksVisible),
      isDisplayed: vi.fn(async () => tasksVisible)
    };
    const driver = {
      $: vi.fn(async (selector: string) =>
        selector === selectors.taskDetailScreen ? taskDetail : tasksScreen
      ),
      execute: vi.fn(async () => {
        taskDetailVisible = false;
        tasksVisible = true;
      }),
      getWindowSize: vi.fn(async () => ({ width: 390, height: 844 })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }
        throw new Error(options.timeoutMsg);
      })
    };

    await performTaskDetailEdgeSwipeBack(driver as never);

    expect(driver.execute).toHaveBeenCalledWith(
      "mobile: dragFromToForDuration",
      {
        duration: 0.5,
        fromX: 1,
        fromY: 422,
        toX: 293,
        toY: 422
      }
    );
    expect(driver.$).toHaveBeenCalledWith(selectors.taskDetailScreen);
    expect(driver.$).toHaveBeenCalledWith(selectors.tasksScreen);
    expect(taskDetail.isExisting).toHaveBeenCalled();
    expect(tasksScreen.isExisting).toHaveBeenCalled();
    expect(tasksScreen.isDisplayed).toHaveBeenCalled();
  });
});

describe("exerciseTaskPinSwipe", () => {
  it("reveals the row action, observes canonical state, and restores the fixture", async () => {
    let pinned = false;
    const row = {
      getLocation: vi.fn(async () => ({ x: 10, y: 100 })),
      getSize: vi.fn(async () => ({ width: 360, height: 90 })),
      waitForDisplayed: vi.fn(async () => undefined)
    };
    const action = {
      click: vi.fn(async () => {
        pinned = true;
      }),
      waitForDisplayed: vi.fn(async () => undefined)
    };
    const repo = {
      click: vi.fn(async () => undefined),
      waitForDisplayed: vi.fn(async () => undefined)
    };
    const driver = {
      $: vi.fn(async (selector: string) => {
        if (selector === "~mobile.tasks.repo.repo-1") return repo;
        return selector === "~mobile.task-row.task-1" ? row : action;
      }),
      execute: vi.fn(async () => undefined),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (!(await condition())) throw new Error(options.timeoutMsg);
      })
    };
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/v1/tasks/task-1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ repoId: "repo-1" })
        };
      }
      if (url.endsWith("/actions/unpin") && init?.method === "POST") {
        pinned = false;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "task-1", repoId: "repo-1", pinned }]
      };
    });

    await exerciseTaskPinSwipe(
      driver as never,
      "http://127.0.0.1:48120",
      "task-1",
      fetchImpl
    );

    expect(driver.execute).toHaveBeenCalledWith(
      "mobile: dragFromToForDuration",
      {
        duration: 0.35,
        fromX: 298,
        fromY: 145,
        toX: 136,
        toY: 145
      }
    );
    expect(repo.click).toHaveBeenCalledOnce();
    expect(action.click).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/unpin",
      { method: "POST" }
    );
    expect(pinned).toBe(false);
  });
});

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
          expectedRows: 48,
          minDecodedBytes: PTY_SNAPSHOT_MIN_DECODED_BYTES
        },
        fetchImpl
      )
    ).rejects.toThrow("expected a live PTY task");
  });

  it("loads the distinct renamed title and multiline prompt end from the real task API fixture", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "task-pty",
        title: "Short renamed task",
        prompt:
          "First canonical prompt line\nSecond detailed line\nMOBILE_PROMPT_END_SENTINEL",
        agentType: "pty",
        closedAt: null
      })
    }));

    await expect(
      assertPtyTerminalFixtureAvailable(
        "http://127.0.0.1:48120",
        {
          taskId: "task-pty",
          sentinel: "Kanna PTY sentinel",
          expectedCols: 80,
          expectedRows: 48,
          minDecodedBytes: PTY_SNAPSHOT_MIN_DECODED_BYTES
        },
        fetchImpl
      )
    ).resolves.toEqual({
      expectedTitle: "Short renamed task",
      promptEndSentinel: "MOBILE_PROMPT_END_SENTINEL",
      taskId: "task-pty"
    });
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

describe("task prompt expansion journey", () => {
  it("copies the complete task ID without collapsing, then preserves both collapse paths", async () => {
    const exerciseTaskPromptExpansion = (
      smokeModule as typeof smokeModule & {
        exerciseTaskPromptExpansion?: (
          ui: Record<string, unknown>,
          fixture: {
            expectedTitle: string;
            promptEndSentinel: string;
            taskId: string;
          }
        ) => Promise<void>;
      }
    ).exerciseTaskPromptExpansion;
    expect(exerciseTaskPromptExpansion).toBeTypeOf("function");
    if (!exerciseTaskPromptExpansion) return;

    const taskId = "019f6c9d6ed40000000120e4307b4591";
    let expanded = false;
    let copyMenuVisible = false;
    let clipboard = "preexisting clipboard";
    const titleButton = {
      ...createElement(() => true, () => {
        expanded = !expanded;
      }),
      getText: vi.fn(async () => "Short renamed task")
    };
    const expandedPrompt = {
      ...createElement(() => expanded),
      getText: vi.fn(async () =>
        expanded
          ? "First prompt line\nSecond detailed line\nPROMPT_END_SENTINEL"
          : ""
      )
    };
    const expandedTaskId = {
      ...createElement(() => expanded),
      getText: vi.fn(async () => (expanded ? taskId : "")),
      longPress: vi.fn(async ({ duration }: { duration: number }) => {
        if (duration === 1_500) {
          copyMenuVisible = true;
        }
      })
    };
    const copyMenuItem = {
      ...createElement(
        () => copyMenuVisible,
        () => {
          clipboard = taskId;
          copyMenuVisible = false;
        }
      ),
      isDisplayed: vi.fn(async () => copyMenuVisible)
    };
    const dismissLayer = createElement(
      () => expanded,
      () => {
        expanded = false;
      }
    );
    const backButton = createElement(() => true);
    const backDisplayed = vi.fn(async () => true);
    const backEnabled = vi.fn(async () => true);
    Object.assign(backButton, {
      isDisplayed: backDisplayed,
      isEnabled: backEnabled,
      getSize: vi.fn(async () => ({ height: 48, width: 48 }))
    });
    const ui = {
      getBackButton: vi.fn(async () => backButton),
      getClipboard: vi.fn(async () =>
        Buffer.from(clipboard, "utf8").toString("base64")
      ),
      setClipboard: vi.fn(async (encodedClipboard: string) => {
        clipboard = Buffer.from(encodedClipboard, "base64").toString("utf8");
      }),
      getCollapsedTitle: vi.fn(async () => titleButton),
      getCopyMenuItem: vi.fn(async () => copyMenuItem),
      getExpandedPrompt: vi.fn(async () => expandedPrompt),
      getExpandedTaskId: vi.fn(async () => expandedTaskId),
      getTitleButton: vi.fn(async () => titleButton),
      getTitleDismissLayer: vi.fn(async () => dismissLayer),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        for (let index = 0; index < 3; index += 1) {
          if (await condition()) return;
        }
        throw new Error(options.timeoutMsg);
      })
    };

    await exerciseTaskPromptExpansion(ui, {
      expectedTitle: "Short renamed task",
      promptEndSentinel: "PROMPT_END_SENTINEL",
      taskId
    });

    expect(titleButton.click).toHaveBeenCalledTimes(3);
    expect(expandedPrompt.getText).toHaveBeenCalled();
    expect(expandedTaskId.getText).toHaveBeenCalled();
    expect(expandedTaskId.longPress).toHaveBeenCalledWith({ duration: 1_500 });
    expect(copyMenuItem.click).toHaveBeenCalledTimes(1);
    expect(ui.getClipboard).toHaveBeenCalled();
    expect(ui.setClipboard).toHaveBeenCalledTimes(2);
    expect(clipboard).toBe("preexisting clipboard");
    expect(dismissLayer.click).toHaveBeenCalledTimes(1);
    expect(await backButton.isExisting()).toBe(true);
    expect(backDisplayed).toHaveBeenCalledTimes(1);
    expect(backEnabled).toHaveBeenCalledTimes(1);
    expect(await expandedPrompt.isExisting()).toBe(false);
    expect(await expandedTaskId.isExisting()).toBe(false);
    expect(expanded).toBe(false);
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
  it("uses the native terminal diagnostic bridge without switching WebView context", async () => {
    const switchContext = vi.fn(async () => undefined);
    const inspection = {
      byteCount: 1024,
      cols: 80,
      frameCount: 3,
      rows: 24,
      text: "SCRIPT_READY"
    };

    await expect(inspectTerminalWebView({
      execute: vi.fn(),
      getContexts: vi.fn(async () => ["NATIVE_APP", "WEBVIEW_build.kanna.app.dev"]),
      getNativeInspection: vi.fn(async () => JSON.stringify(inspection)),
      switchContext
    })).resolves.toEqual({ kind: "rendered", ...inspection });
    expect(switchContext).not.toHaveBeenCalled();
  });

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

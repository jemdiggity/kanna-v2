import { describe, expect, it, vi } from "vitest";
import * as profileConnectionSmoke from "./profile-connection.e2e";

const {
  assertOtaDiagnosticsHidden,
  assertProfileConnectionControlsReachable,
  assertProfileConnectionDisconnected,
  assertProfilePasswordCanRevealAndHide,
  openProfileConnectionSheet
} = profileConnectionSmoke;

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  isExisting: ReturnType<typeof vi.fn>;
  waitForDisplayed: ReturnType<typeof vi.fn>;
}

interface FakeWaitUntilOptions {
  timeoutMsg: string;
}

function createElement(exists = true): FakeElement {
  return {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null),
    getText: vi.fn(async () => ""),
    isExisting: vi.fn(async () => exists),
    waitForDisplayed: vi.fn(async () => undefined)
  };
}

function createReachableControlsUi(
  overrides: Partial<{
    getConnectionTitle: ReturnType<typeof vi.fn>;
    getConnectionStatus: ReturnType<typeof vi.fn>;
    getConnectLocalButton: ReturnType<typeof vi.fn>;
    getEmailInput: ReturnType<typeof vi.fn>;
    getPasswordInput: ReturnType<typeof vi.fn>;
    getPasswordToggle: ReturnType<typeof vi.fn>;
    getSignInButton: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    getConnectionTitle: vi.fn(async () => createElement()),
    getConnectionStatus: vi.fn(async () => createElement()),
    getConnectLocalButton: vi.fn(async () => createElement()),
    getEmailInput: vi.fn(async () => createElement()),
    getPasswordInput: vi.fn(async () => createElement()),
    getPasswordToggle: vi.fn(async () => createElement()),
    getSignInButton: vi.fn(async () => createElement()),
    waitUntil: vi.fn(
      async (condition: () => Promise<boolean>, options: FakeWaitUntilOptions) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      }
    ),
    ...overrides
  };
}

describe("openProfileConnectionSheet", () => {
  it("opens the account sheet from the app top bar", async () => {
    const accountButton = createElement();
    const accountSheet = createElement();
    const ui = {
      getAccountButton: vi.fn(async () => accountButton),
      getAccountSheet: vi.fn(async () => accountSheet)
    };

    await openProfileConnectionSheet(ui);

    expect(accountButton.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(accountButton.click).toHaveBeenCalledTimes(1);
    expect(accountSheet.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });
});

describe("assertToolbarActionPathsReachable", () => {
  it("opens the task composer from both Add task and the More command", async () => {
    const events: string[] = [];
    const addTaskButton = {
      ...createElement(),
      click: vi.fn(async () => {
        composerOpen = true;
        events.push("click Add task");
      })
    };
    const moreTab = {
      ...createElement(),
      click: vi.fn(async () => events.push("click More"))
    };
    const moreScreen = {
      ...createElement(),
      waitForDisplayed: vi.fn(async () => events.push("More displayed"))
    };
    const createTaskCommand = {
      ...createElement(),
      scrollIntoView: vi.fn(async () => events.push("scroll Create Task")),
      click: vi.fn(async () => {
        composerOpen = true;
        events.push("click Create Task");
      })
    };
    let composerOpen = false;
    const promptInput = {
      ...createElement(),
      isExisting: vi.fn(async () => composerOpen),
      waitForDisplayed: vi.fn(async () => events.push("composer displayed"))
    };
    const cancelButton = {
      ...createElement(),
      click: vi.fn(async () => {
        composerOpen = false;
        events.push("cancel composer");
      })
    };
    const ui = {
      getAddTaskButton: vi.fn(async () => addTaskButton),
      getCreateTaskCancelButton: vi.fn(async () => cancelButton),
      getCreateTaskCommand: vi.fn(async () => createTaskCommand),
      getCreateTaskPromptInput: vi.fn(async () => promptInput),
      getMoreScreen: vi.fn(async () => moreScreen),
      getMoreTab: vi.fn(async () => moreTab),
      waitUntil: vi.fn(
        async (condition: () => Promise<boolean>, options: FakeWaitUntilOptions) => {
          if (await condition()) return;
          throw new Error(options.timeoutMsg);
        }
      )
    };
    const assertToolbarActionPathsReachable = (
      profileConnectionSmoke as typeof profileConnectionSmoke & {
        assertToolbarActionPathsReachable: (value: typeof ui) => Promise<void>;
      }
    ).assertToolbarActionPathsReachable;

    expect(assertToolbarActionPathsReachable).toBeTypeOf("function");
    await assertToolbarActionPathsReachable(ui);

    expect(events).toEqual([
      "click Add task",
      "composer displayed",
      "cancel composer",
      "click More",
      "More displayed",
      "scroll Create Task",
      "click Create Task",
      "composer displayed",
      "cancel composer"
    ]);
    expect(createTaskCommand.scrollIntoView).toHaveBeenCalledWith({
      direction: "down",
      maxScrolls: 5
    });
  });
});

describe("assertOtaDiagnosticsHidden", () => {
  it("waits for More navigation before checking that the legacy OTA element is absent", async () => {
    const events: string[] = [];
    const moreTab = {
      ...createElement(),
      click: vi.fn(async () => {
        events.push("click More");
      })
    };
    const moreScreen = {
      ...createElement(),
      waitForDisplayed: vi.fn(async () => {
        events.push("More displayed");
      })
    };
    const otaStatus = {
      ...createElement(false),
      isExisting: vi.fn(async () => {
        events.push("check OTA absent");
        return false;
      })
    };
    const ui = {
      getMoreTab: vi.fn(async () => moreTab),
      getMoreScreen: vi.fn(async () => moreScreen),
      getOtaStatusValue: vi.fn(async () => otaStatus)
    };

    await assertOtaDiagnosticsHidden(ui);

    expect(moreTab.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(events).toEqual([
      "click More",
      "More displayed",
      "check OTA absent"
    ]);
  });

  it("fails when the legacy OTA element still exists on More", async () => {
    const ui = {
      getMoreTab: vi.fn(async () => createElement()),
      getMoreScreen: vi.fn(async () => createElement()),
      getOtaStatusValue: vi.fn(async () => createElement())
    };

    await expect(assertOtaDiagnosticsHidden(ui)).rejects.toThrow(
      "Expected OTA diagnostics to be absent from More"
    );
  });
});

describe("assertProfileConnectionControlsReachable", () => {
  it("waits for connection status, local connect, and email sign-in controls", async () => {
    const ui = createReachableControlsUi();

    await assertProfileConnectionControlsReachable(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg:
          "Expected profile drawer connection controls and sign-in form to be reachable"
      })
    );
    expect(ui.getPasswordToggle).toHaveBeenCalled();
  });
});

describe("assertProfilePasswordCanRevealAndHide", () => {
  it("clicks the profile password toggle through native accessibility label states", async () => {
    let toggleLabel = "Show password";
    const passwordToggle = {
      ...createElement(),
      click: vi.fn(async () => {
        toggleLabel = toggleLabel === "Show password" ? "Hide password" : "Show password";
      }),
      getAttribute: vi.fn(async (attributeName: string) =>
        attributeName === "label" ? toggleLabel : null
      ),
      getText: vi.fn(async () => toggleLabel)
    };
    const ui = createReachableControlsUi({
      getPasswordToggle: vi.fn(async () => passwordToggle)
    });

    await assertProfilePasswordCanRevealAndHide(ui);

    expect(passwordToggle.click).toHaveBeenCalledTimes(2);
    expect(passwordToggle.getAttribute).toHaveBeenCalledWith("label");
    expect(passwordToggle.getText).not.toHaveBeenCalled();
    expect(ui.getPasswordToggle).toHaveBeenCalledTimes(5);
    expect(toggleLabel).toBe("Show password");
  });
});

describe("assertProfileConnectionDisconnected", () => {
  it("waits for the profile drawer to report the disconnected state", async () => {
    const ui = createReachableControlsUi({
      getConnectionTitle: vi.fn(async () => ({
        ...createElement(),
        getText: vi.fn(async () => "Not connected")
      }))
    });

    await assertProfileConnectionDisconnected(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg: "Expected profile drawer connection status to be disconnected"
      })
    );
  });
});

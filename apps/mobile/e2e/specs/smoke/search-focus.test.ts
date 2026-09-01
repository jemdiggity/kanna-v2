import { describe, expect, it, vi } from "vitest";
import { runSearchFocusJourney } from "./search-focus.e2e";

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  isExisting: ReturnType<typeof vi.fn>;
  waitForDisplayed: ReturnType<typeof vi.fn>;
}

interface FakeWaitUntilOptions {
  timeoutMsg: string;
}

function createSearchFocusUi({
  blurOnHide = true
}: {
  blurOnHide?: boolean;
} = {}) {
  let inputFocused = false;
  let keyboardShown = false;
  let searchVisible = false;
  let tasksVisible = true;

  const searchButton: FakeElement = {
    click: vi.fn(async () => {
      searchVisible = true;
      tasksVisible = false;
      inputFocused = true;
      keyboardShown = true;
    }),
    getAttribute: vi.fn(async () => null),
    isExisting: vi.fn(async () => true),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const searchScreen: FakeElement = {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null),
    isExisting: vi.fn(async () => searchVisible),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const searchInput: FakeElement = {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async (attributeName: string) =>
      attributeName === "focused" ? String(inputFocused) : null
    ),
    isExisting: vi.fn(async () => searchVisible),
    setValue: vi.fn(async () => undefined),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const taskResult: FakeElement = {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async (name: string) =>
      name === "label" ? "Unrelated title. Task ID eef65d54. in progress" : null
    ),
    isExisting: vi.fn(async () => searchVisible),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const searchKeyboardDismissTarget: FakeElement = {
    click: vi.fn(async () => {
      keyboardShown = false;
      if (blurOnHide) inputFocused = false;
    }),
    getAttribute: vi.fn(async () => null),
    isExisting: vi.fn(async () => searchVisible),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const tasksTab: FakeElement = {
    click: vi.fn(async () => {
      searchVisible = false;
      tasksVisible = true;
    }),
    getAttribute: vi.fn(async () => null),
    isExisting: vi.fn(async () => true),
    waitForDisplayed: vi.fn(async () => undefined)
  };
  const tasksScreen: FakeElement = {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null),
    isExisting: vi.fn(async () => tasksVisible),
    waitForDisplayed: vi.fn(async () => undefined)
  };

  const ui = {
    captureTaskIdSearch: vi.fn(async () => undefined),
    getSearchInput: vi.fn(async () => searchInput),
    getSearchKeyboardDismissTarget: vi.fn(
      async () => searchKeyboardDismissTarget
    ),
    getSearchScreen: vi.fn(async () => searchScreen),
    getSearchToolbarButton: vi.fn(async () => searchButton),
    getTaskResult: vi.fn(async () => taskResult),
    getTasksScreen: vi.fn(async () => tasksScreen),
    getTasksTab: vi.fn(async () => tasksTab),
    isKeyboardShown: vi.fn(async () => keyboardShown),
    isSearchInputFocused: vi.fn(async () => inputFocused),
    waitUntil: vi.fn(
      async (
        condition: () => Promise<boolean>,
        options: FakeWaitUntilOptions
      ) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }
    )
  };

  return {
    searchButton,
    searchInput,
    searchKeyboardDismissTarget,
    searchScreen,
    tasksScreen,
    tasksTab,
    taskResult,
    ui
  };
}

describe("runSearchFocusJourney", () => {
  it("focuses Search, dismisses it, and refocuses it from a second toolbar tap", async () => {
    const harness = createSearchFocusUi();

    await runSearchFocusJourney(harness.ui);

    expect(harness.searchButton.click).toHaveBeenCalledTimes(2);
    expect(harness.searchScreen.waitForDisplayed).toHaveBeenCalledTimes(2);
    expect(harness.searchScreen.waitForDisplayed).toHaveBeenCalledWith({
      timeout: 30_000
    });
    expect(harness.ui.isSearchInputFocused).toHaveBeenCalled();
    expect(harness.searchInput.getAttribute).not.toHaveBeenCalled();
    expect(harness.searchKeyboardDismissTarget.click).toHaveBeenCalledTimes(2);
    expect(harness.tasksTab.click).toHaveBeenCalledOnce();
    expect(harness.tasksScreen.waitForDisplayed).toHaveBeenCalledWith({
      timeout: 30_000
    });
  });

  it("requires keyboard dismissal to clear focus before the second Search tap", async () => {
    const harness = createSearchFocusUi({ blurOnHide: false });

    await expect(runSearchFocusJourney(harness.ui)).rejects.toThrow(
      "Expected Search tasks input to lose native focus after keyboard dismissal"
    );

    expect(harness.searchButton.click).toHaveBeenCalledOnce();
  });

  it("searches by a task ID prefix and verifies the full ID in the result row", async () => {
    const harness = createSearchFocusUi();

    await runSearchFocusJourney(harness.ui, "eef65d54");

    expect(harness.searchInput.setValue).toHaveBeenCalledWith("eef65");
    expect(harness.ui.getTaskResult).toHaveBeenCalledWith("eef65d54");
    expect(harness.taskResult.waitForDisplayed).toHaveBeenCalledWith({
      timeout: 30_000
    });
    expect(harness.taskResult.getAttribute).toHaveBeenCalledWith("label");
    expect(harness.ui.captureTaskIdSearch).toHaveBeenCalledOnce();
  });
});

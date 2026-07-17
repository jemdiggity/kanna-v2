import { describe, expect, it, vi } from "vitest";
import type { Browser } from "webdriverio";
import { waitForExpoAppReady } from "../../run";
import {
  assertOtaDiagnosticsHidden,
  assertMachineOrigins,
  assertPairingFailure,
  assertPairingSheetFresh,
  assertProfilePasswordCanRevealAndHide,
  assertProfileSignInControlsReachable,
  assertSignedOutMachineEntryPoints,
  assertToolbarActionPathsReachable,
  openMachinesFromProfile,
  openProfileSheet,
  relaunchApp,
  removeManualMachine,
  submitPairingCode
} from "./profile-connection.e2e";

interface FakeWaitUntilOptions {
  timeoutMsg: string;
}

function createElement(exists = true) {
  return {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null as string | null),
    getText: vi.fn(async () => ""),
    isExisting: vi.fn(async () => exists),
    setValue: vi.fn(async () => undefined),
    waitForDisplayed: vi.fn(async () => undefined)
  };
}

function createWaitUntil() {
  return vi.fn(async (
    condition: () => Promise<boolean>,
    options: FakeWaitUntilOptions
  ) => {
    if (!(await condition())) throw new Error(options.timeoutMsg);
  });
}

describe("Profile to Machines smoke helpers", () => {
  it("requires a successfully consumed pairing sheet to reopen fresh", async () => {
    const scanMode = {
      ...createElement(),
      getAttribute: vi.fn(async (name: string) => name === "selected" ? "true" : null)
    };
    const codeInput = {
      ...createElement(),
      getAttribute: vi.fn(async (name: string) => name === "value" ? "" : null),
      getText: vi.fn(async () => "")
    };
    const error = createElement(false);
    const submit = {
      ...createElement(),
      getAttribute: vi.fn(async (name: string) => name === "enabled" ? "false" : null)
    };

    await expect(assertPairingSheetFresh({
      getPairingScanMode: async () => scanMode,
      getPairingCodeInput: async () => codeInput,
      getPairingError: async () => error,
      getPairingSubmit: async () => submit
    }, "ABC123")).resolves.toBeUndefined();

    expect(scanMode.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(scanMode.getAttribute).toHaveBeenCalledWith("selected");
    expect(error.isExisting).toHaveBeenCalledOnce();
    expect(submit.getAttribute).toHaveBeenCalledWith("enabled");
  });

  it("rejects a pairing sheet that retains its consumed code", async () => {
    const staleInput = {
      ...createElement(),
      getAttribute: vi.fn(async (name: string) => name === "value" ? "abc-123" : null)
    };
    const submit = {
      ...createElement(),
      getAttribute: vi.fn(async (name: string) => name === "enabled" ? "false" : null)
    };

    await expect(assertPairingSheetFresh({
      getPairingScanMode: async () => ({
        ...createElement(),
        getAttribute: vi.fn(async (name: string) => name === "selected" ? "true" : null)
      }),
      getPairingCodeInput: async () => staleInput,
      getPairingError: async () => createElement(false),
      getPairingSubmit: async () => submit
    }, "ABC123")).rejects.toThrow("consumed pairing code");
  });

  it("dismisses a late Expo dev menu after relaunch before profile interaction", async () => {
    let expoPoll = 0;
    let devMenuDismissed = false;
    const accountButton = createElement();
    accountButton.click.mockImplementation(async () => {
      if (!devMenuDismissed) throw new Error("profile interaction raced the Expo dev menu");
    });

    const driver = {
      $: async (selector: string) => ({
        click: async () => {
          if (selector === "~xmark") devMenuDismissed = true;
        },
        isDisplayed: async () => {
          if (selector === "~xmark") {
            return expoPoll >= 2 && !devMenuDismissed;
          }
          if (selector === "~mobile.app-shell") return devMenuDismissed;
          if (selector === "~mobile.account-button") return devMenuDismissed;
          return false;
        },
        isExisting: async () => false,
        waitForDisplayed: async () => {
          if (selector === "~mobile.app-shell" && !devMenuDismissed) {
            throw new Error("app shell is blocked by the late Expo dev menu");
          }
        }
      }),
      acceptAlert: vi.fn(async () => undefined),
      activateApp: vi.fn(async () => undefined),
      execute: vi.fn(async () => undefined),
      getAlertText: async () => {
        throw new Error("no alert open");
      },
      getWindowSize: async () => ({ width: 393, height: 852 }),
      queryAppState: async () => 1,
      terminateApp: vi.fn(async () => true),
      waitUntil: async (
        condition: () => Promise<boolean>,
        options: { timeoutMsg: string }
      ) => {
        if (options.timeoutMsg.includes("terminate")) {
          if (await condition()) return true;
        } else {
          while (expoPoll < 6) {
            expoPoll += 1;
            if (await condition()) return true;
          }
        }
        throw new Error(options.timeoutMsg);
      }
    } as unknown as Browser;

    await relaunchApp(
      driver,
      "build.kanna.app.dev",
      async () => undefined,
      "~mobile.account-button",
      (readySelector) => waitForExpoAppReady(driver, readySelector)
    );
    await accountButton.click();

    expect(expoPoll).toBe(4);
    expect(devMenuDismissed).toBe(true);
    expect(accountButton.click).toHaveBeenCalledOnce();
  });

  it("opens Profile from the top bar", async () => {
    const accountButton = createElement();
    const accountSheet = createElement();
    await openProfileSheet({
      getAccountButton: async () => accountButton,
      getAccountSheet: async () => accountSheet
    });

    expect(accountButton.click).toHaveBeenCalledOnce();
    expect(accountSheet.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("opens the dedicated Machines screen from Profile", async () => {
    const machinesButton = createElement();
    const machinesScreen = createElement();
    await openMachinesFromProfile({
      getAccountButton: async () => createElement(),
      getAccountSheet: async () => createElement(),
      getMachinesButton: async () => machinesButton,
      getMachinesScreen: async () => machinesScreen
    });

    expect(machinesButton.click).toHaveBeenCalledOnce();
    expect(machinesScreen.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("keeps manual pairing reachable while signed out", async () => {
    const addButton = createElement();
    const codeInput = createElement();
    await assertSignedOutMachineEntryPoints({
      getAccountButton: async () => createElement(),
      getAccountSheet: async () => createElement(),
      getMachinesButton: async () => createElement(),
      getMachinesScreen: async () => createElement(),
      getMachinesAddButton: async () => addButton,
      getPairingCodeInput: async () => codeInput
    });

    expect(addButton.click).toHaveBeenCalledOnce();
    expect(codeInput.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("requires Profile identity controls plus the Machines entry point", async () => {
    const waitUntil = createWaitUntil();
    await assertProfileSignInControlsReachable({
      getMachinesButton: async () => createElement(),
      getEmailInput: async () => createElement(),
      getPasswordInput: async () => createElement(),
      getPasswordToggle: async () => createElement(),
      getSignInButton: async () => createElement(),
      waitUntil
    });

    expect(waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg: "Expected Profile identity controls and Machines entry point to be reachable"
      })
    );
  });

  it("submits a pairing code and waits for the claimed machine row", async () => {
    const codeInput = createElement();
    const submit = createElement();
    const machineRow = createElement();

    await submitPairingCode({
      getPairingCodeInput: async () => codeInput,
      getPairingSubmit: async () => submit,
      getMachineRow: async () => machineRow
    }, "ABC123", "desktop-e2e");

    expect(codeInput.setValue).toHaveBeenCalledWith("ABC123");
    expect(submit.click).toHaveBeenCalledOnce();
    expect(machineRow.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("requires invalid and expired pairing copy while keeping recovery controls", async () => {
    const error = {
      ...createElement(),
      getText: vi.fn(async () => "That pairing session expired. Start a new one on the desktop.")
    };
    const codeInput = createElement();

    await assertPairingFailure({
      getPairingCodeInput: async () => codeInput,
      getPairingError: async () => error
    }, "expired");

    expect(codeInput.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("asserts a single deduplicated dual-origin machine", async () => {
    const row = {
      ...createElement(),
      getText: vi.fn(async () => "Remote E2E Desktop Account Paired")
    };

    await assertMachineOrigins({
      getMachineOrigin: async (_desktopId, origin) => createElement(origin === "account" || origin === "manual"),
      getMachineRow: async () => row,
      getMachineRows: async () => [row],
      waitUntil: createWaitUntil()
    }, "desktop-e2e", { account: true, manual: true });

    expect(row.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("removes only the manual origin while retaining a dual-origin row", async () => {
    const remove = createElement();
    const row = {
      ...createElement(),
      getText: vi.fn(async () => "Remote E2E Desktop Account")
    };

    await removeManualMachine({
      getMachineOrigin: async (_desktopId, origin) => createElement(origin === "account"),
      getMachineRemoveButton: async () => remove,
      getMachineRow: async () => row,
      getMachineRows: async () => [row],
      waitUntil: createWaitUntil()
    }, "desktop-e2e", true);

    expect(remove.click).toHaveBeenCalledOnce();
    expect(await row.getText()).not.toContain("Paired");
  });
});

describe("Toolbar action paths", () => {
  it("opens the task composer from both Add task and the More command", async () => {
    const events: string[] = [];
    let composerOpen = false;
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
      waitUntil: createWaitUntil()
    };

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

describe("OTA diagnostics", () => {
  it("waits for More navigation before checking that the legacy OTA element is absent", async () => {
    const events: string[] = [];
    const moreTab = {
      ...createElement(),
      click: vi.fn(async () => events.push("click More"))
    };
    const moreScreen = {
      ...createElement(),
      waitForDisplayed: vi.fn(async () => events.push("More displayed"))
    };
    const otaStatus = {
      ...createElement(false),
      isExisting: vi.fn(async () => {
        events.push("check OTA absent");
        return false;
      })
    };

    await assertOtaDiagnosticsHidden({
      getMoreTab: async () => moreTab,
      getMoreScreen: async () => moreScreen,
      getOtaStatusValue: async () => otaStatus
    });

    expect(moreTab.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(events).toEqual(["click More", "More displayed", "check OTA absent"]);
  });

  it("fails when the legacy OTA element still exists on More", async () => {
    await expect(assertOtaDiagnosticsHidden({
      getMoreTab: async () => createElement(),
      getMoreScreen: async () => createElement(),
      getOtaStatusValue: async () => createElement()
    })).rejects.toThrow("Expected OTA diagnostics to be absent from More");
  });
});

describe("Profile password visibility", () => {
  it("reveals and hides the password through accessibility labels", async () => {
    let label = "Show password";
    const toggle = {
      ...createElement(),
      click: vi.fn(async () => {
        label = label === "Show password" ? "Hide password" : "Show password";
      }),
      getAttribute: vi.fn(async (name: string) => name === "label" ? label : null)
    };
    await assertProfilePasswordCanRevealAndHide({
      getPasswordToggle: async () => toggle,
      waitUntil: createWaitUntil()
    });

    expect(toggle.click).toHaveBeenCalledTimes(2);
    expect(label).toBe("Show password");
  });
});

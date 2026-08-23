import { describe, expect, it, vi } from "vitest";
import type { Browser } from "webdriverio";
import { waitForExpoAppReady } from "../../run";
import {
  assertBuildInfoJourney,
  assertMachineDisplayName,
  assertMachineOrigins,
  assertPairingFailure,
  assertPairedMachineTasksLoad,
  assertPairingSheetFresh,
  assertProfilePasswordCanRevealAndHide,
  assertProfileSignInControlsReachable,
  assertRepositoryCommandJourney,
  assertSignedOutMachineEntryPoints,
  assertToolbarActionPathsReachable,
  openMachinesFromProfile,
  openProfileSheet,
  relaunchApp,
  removeManualMachine,
  resolveBuildInfoSmokeExpectations,
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

  it("requires pairing itself to surface the machine's tasks", async () => {
    const rows = new Map<string, ReturnType<typeof createElement>>();
    let taskRowText = "";
    const machinesScreen = createElement();
    const driver = {
      $: async (selector: string) => {
        if (selector === "~mobile.task-row.task-1") {
          return {
            ...(rows.get(selector) ?? createElement()),
            isExisting: async () => taskRowText !== "",
            getText: async () => taskRowText
          };
        }
        return rows.get(selector) ?? (() => {
          const element = createElement();
          rows.set(selector, element);
          return element;
        })();
      },
      getPageSource: async () => "<XCUIElementTypeOther/>",
      waitUntil: async (
        condition: () => Promise<boolean>,
        options: { timeout: number; timeoutMsg: string }
      ) => {
        // A pairing-driven load: the row appears on the second poll, well
        // inside the tighter budget this assertion holds pairing to.
        if (await condition()) return true;
        taskRowText = "Paired machine task";
        if (await condition()) return true;
        throw new Error(options.timeoutMsg);
      }
    } as unknown as Browser;

    await assertPairedMachineTasksLoad(
      driver,
      {
        getAccountButton: async () => createElement(),
        getAccountSheet: async () => createElement(),
        getMachinesButton: async () => createElement(),
        getMachinesScreen: async () => machinesScreen
      },
      "task-1",
      "Paired machine task"
    );

    expect(rows.get("~mobile.machines-back")?.click).toHaveBeenCalledOnce();
    expect(rows.get("~mobile.toolbar.tab.recent")?.click).toHaveBeenCalledOnce();
    expect(machinesScreen.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("fails when the paired machine's tasks never arrive", async () => {
    const driver = {
      $: async () => ({
        ...createElement(),
        isExisting: async () => false,
        getText: async () => ""
      }),
      getPageSource: async () => "",
      waitUntil: async (
        condition: () => Promise<boolean>,
        options: { timeout: number; timeoutMsg: string }
      ) => {
        if (await condition()) return true;
        throw new Error(`${options.timeoutMsg} (${options.timeout}ms)`);
      }
    } as unknown as Browser;

    await expect(assertPairedMachineTasksLoad(
      driver,
      {
        getAccountButton: async () => createElement(),
        getAccountSheet: async () => createElement(),
        getMachinesButton: async () => createElement(),
        getMachinesScreen: async () => createElement()
      },
      "task-1",
      "Paired machine task"
    )).rejects.toThrow("without a relaunch (15000ms)");
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

  it("waits for a stable-ID machine row to render its friendly desktop name", async () => {
    const names = ["desktop-lan", "Gu’s MacBook Pro"];
    const machineName = {
      ...createElement(),
      getText: vi.fn(async () => names.shift() ?? "Gu’s MacBook Pro")
    };
    const waitUntil = vi.fn(async (
      condition: () => Promise<boolean>,
      options: FakeWaitUntilOptions
    ) => {
      if (!(await condition()) && !(await condition())) {
        throw new Error(options.timeoutMsg);
      }
    });

    await assertMachineDisplayName({
      getMachineName: async () => machineName,
      waitUntil
    }, "desktop-lan", "Gu’s MacBook Pro");

    expect(machineName.waitForDisplayed).toHaveBeenCalledWith({
      timeout: 30_000
    });
    expect(machineName.getText).toHaveBeenCalledTimes(2);
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
  it("opens the task composer from Add task", async () => {
    const events: string[] = [];
    let composerOpen = false;
    const addTaskButton = {
      ...createElement(),
      click: vi.fn(async () => {
        composerOpen = true;
        events.push("click Add task");
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
      getCreateTaskPromptInput: vi.fn(async () => promptInput),
      waitUntil: createWaitUntil()
    };

    await assertToolbarActionPathsReachable(ui);

    expect(events).toEqual([
      "click Add task",
      "composer displayed",
      "cancel composer"
    ]);
  });
});

describe("Repository command journey", () => {
  it("selects a repository, launches a grouped command, and opens its canonical task", async () => {
    const events: string[] = [];
    const element = (event?: string) => ({
      ...createElement(),
      click: vi.fn(async () => {
        if (event) events.push(event);
      })
    });
    const command = {
      ...element("click command"),
      scrollIntoView: vi.fn(async () => events.push("scroll command"))
    };
    const ui = {
      getMoreTab: vi.fn(async () => element("click More")),
      getMoreScreen: vi.fn(async () => ({
        ...element(),
        waitForDisplayed: vi.fn(async () => events.push("More displayed"))
      })),
      getRepoOption: vi.fn(async () => element("click repository")),
      getConfigureCommandGroup: vi.fn(async () => ({
        ...element(),
        waitForDisplayed: vi.fn(async () => events.push("Configure displayed"))
      })),
      getCreateAgentCommand: vi.fn(async () => command),
      getTaskDetailScreen: vi.fn(async () => ({
        ...element(),
        waitForDisplayed: vi.fn(async () => events.push("task detail displayed"))
      })),
      getTaskTitleButton: vi.fn(async () => element("expand task identity")),
      getExpandedTaskId: vi.fn(async () => ({
        ...element(),
        waitForDisplayed: vi.fn(async () => events.push("task id displayed")),
        getText: vi.fn(async () => {
          events.push("read task id");
          return "task-command";
        })
      })),
      getTaskSnapshotMarker: vi.fn(async () => ({
        ...element(),
        getAttribute: vi.fn(async () => {
          events.push("read snapshot marker");
          return "task-command:Canonical server title";
        })
      })),
      getTaskBackButton: vi.fn(async () => element("back to tasks"))
    };

    await assertRepositoryCommandJourney(ui);

    expect(events).toEqual([
      "click More",
      "More displayed",
      "click repository",
      "Configure displayed",
      "scroll command",
      "click command",
      "task detail displayed",
      "expand task identity",
      "task id displayed",
      "read task id",
      "read snapshot marker",
      "back to tasks"
    ]);
  });
});

describe("About this build journey", () => {
  it("resolves exact bundled staging expectations for physical-device E2E", () => {
    expect(
      resolveBuildInfoSmokeExpectations({
        KANNA_APP_ENV: "staging",
        KANNA_E2E_EXPECTED_NATIVE_VERSION: " 1.0.0 (1) ",
        KANNA_E2E_EXPECTED_RUNNING_SOURCE: " Embedded bundle "
      })
    ).toEqual({
      channel: "staging",
      environment: "staging",
      nativeVersion: "1.0.0 (1)",
      runningSource: "Embedded bundle",
      runtimeVersion: "2.2.2"
    });
  });

  it("expands build information and validates the real dev-client identity fields", async () => {
    const events: string[] = [];
    const moreTab = {
      ...createElement(),
      click: vi.fn(async () => events.push("click More"))
    };
    const moreScreen = {
      ...createElement(),
      waitForDisplayed: vi.fn(async () => events.push("More displayed"))
    };
    const buildElement = (value: string, name: string) => ({
      ...createElement(),
      getText: vi.fn(async () => {
        events.push(`read ${name}`);
        return value;
      })
    });
    const buildToggle = {
      ...createElement(),
      click: vi.fn(async () => events.push("expand build info")),
      scrollIntoView: vi.fn(async () => events.push("scroll build toggle"))
    };
    const buildDetails = {
      ...createElement(),
      scrollIntoView: vi.fn(async () => events.push("scroll build details")),
      waitForDisplayed: vi.fn(async () => events.push("build details displayed"))
    };

    await assertBuildInfoJourney({
      getMoreTab: async () => moreTab,
      getMoreScreen: async () => moreScreen,
      getBuildInfoToggle: async () => buildToggle,
      getBuildInfoDetails: async () => buildDetails,
      getBuildInfoNative: async () => buildElement("1.8.0 (214)", "native"),
      getBuildInfoRuntime: async () => buildElement("2.1.2", "runtime"),
      getBuildInfoEnvironment: async () => buildElement("dev", "environment"),
      getBuildInfoChannel: async () => buildElement("None", "channel"),
      getBuildInfoRunningSource: async () =>
        buildElement("Development bundle (Metro)", "running source"),
      getBuildInfoUpdateId: async () => createElement(false),
      getBuildInfoCopyHint: async () => createElement(false),
      waitUntil: createWaitUntil()
    }, {
      runtimeVersion: "2.1.2",
      environment: "dev",
      channel: "None",
      nativeVersion: "1.8.0 (214)",
      runningSource: "Development bundle (Metro)"
    });

    expect(moreTab.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(events).toEqual([
      "click More",
      "More displayed",
      "scroll build toggle",
      "expand build info",
      "scroll build details",
      "build details displayed",
      "read native",
      "read runtime",
      "read environment",
      "read channel",
      "read running source"
    ]);
  });

  it("rejects a placeholder 0.0.0 native version", async () => {
    const value = (text: string) => ({
      ...createElement(),
      getText: vi.fn(async () => text)
    });
    const scrollable = {
      ...createElement(),
      scrollIntoView: vi.fn(async () => undefined)
    };

    await expect(
      assertBuildInfoJourney({
        getMoreTab: async () => createElement(),
        getMoreScreen: async () => createElement(),
        getBuildInfoToggle: async () => scrollable,
        getBuildInfoDetails: async () => scrollable,
        getBuildInfoNative: async () => value("0.0.0 (1)"),
        getBuildInfoRuntime: async () => value("2.1.2"),
        getBuildInfoEnvironment: async () => value("staging"),
        getBuildInfoChannel: async () => value("staging"),
        getBuildInfoRunningSource: async () => value("Embedded bundle"),
        getBuildInfoUpdateId: async () => createElement(false),
        getBuildInfoCopyHint: async () => createElement(false),
        waitUntil: createWaitUntil()
      }, {
        runtimeVersion: "2.1.2",
        environment: "staging",
        channel: "staging",
        runningSource: "Embedded bundle"
      })
    ).rejects.toThrow(/real native version/);
  });

  it("rejects a valid native version that differs from the exact expected build", async () => {
    const value = (text: string) => ({
      ...createElement(),
      getText: vi.fn(async () => text)
    });
    const scrollable = {
      ...createElement(),
      scrollIntoView: vi.fn(async () => undefined)
    };

    await expect(
      assertBuildInfoJourney({
        getMoreTab: async () => createElement(),
        getMoreScreen: async () => createElement(),
        getBuildInfoToggle: async () => scrollable,
        getBuildInfoDetails: async () => scrollable,
        getBuildInfoNative: async () => value("0.1.1 (1)"),
        getBuildInfoRuntime: async () => value("2.1.4"),
        getBuildInfoEnvironment: async () => value("staging"),
        getBuildInfoChannel: async () => value("staging"),
        getBuildInfoRunningSource: async () => value("Embedded bundle"),
        getBuildInfoUpdateId: async () => createElement(false),
        getBuildInfoCopyHint: async () => createElement(false),
        waitUntil: createWaitUntil()
      }, {
        runtimeVersion: "2.1.4",
        environment: "staging",
        channel: "staging",
        nativeVersion: "0.1.0 (1)",
        runningSource: "Embedded bundle"
      })
    ).rejects.toThrow(/Expected Native to be 0.1.0 \(1\), got 0.1.1 \(1\)/);
  });

  it("exercises copy feedback when the running source is an OTA update", async () => {
    const updateId = "84667f93-5c7b-45fb-9f78-7045160cb842";
    let copied = false;
    const value = (text: string) => ({
      ...createElement(),
      getText: vi.fn(async () => text)
    });
    const scrollable = {
      ...createElement(),
      scrollIntoView: vi.fn(async () => undefined)
    };
    const updateIdControl = {
      ...createElement(),
      click: vi.fn(async () => {
        copied = true;
      })
    };

    await assertBuildInfoJourney({
      getMoreTab: async () => createElement(),
      getMoreScreen: async () => createElement(),
      getBuildInfoToggle: async () => scrollable,
      getBuildInfoDetails: async () => scrollable,
      getBuildInfoNative: async () => value("1.8.0 (214)"),
      getBuildInfoRuntime: async () => value("2.1.2"),
      getBuildInfoEnvironment: async () => value("staging"),
      getBuildInfoChannel: async () => value("staging"),
      getBuildInfoRunningSource: async () => value(updateId),
      getBuildInfoUpdateId: async () => updateIdControl,
      getBuildInfoCopyHint: async () => value(copied ? "Copied" : "Tap to copy"),
      waitUntil: createWaitUntil()
    }, {
      runtimeVersion: "2.1.2",
      environment: "staging",
      channel: "staging",
      runningSource: updateId
    });

    expect(updateIdControl.click).toHaveBeenCalledOnce();
    expect(copied).toBe(true);
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

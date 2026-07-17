import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface ProfileMachinesElement {
  click(): Promise<unknown>;
  getAttribute(name: string): Promise<string | null>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface ScrollableProfileMachinesElement extends ProfileMachinesElement {
  scrollIntoView(options: {
    direction: "down";
    maxScrolls: number;
  }): Promise<unknown>;
}

interface ProfileMachinesUi {
  getAccountButton(): Promise<ProfileMachinesElement>;
  getAccountSheet(): Promise<ProfileMachinesElement>;
  getMachinesButton(): Promise<ProfileMachinesElement>;
  getMachinesScreen(): Promise<ProfileMachinesElement>;
  getMachinesAddButton(): Promise<ProfileMachinesElement>;
  getPairingCodeInput(): Promise<ProfileMachinesElement>;
  getEmailInput(): Promise<ProfileMachinesElement>;
  getPasswordInput(): Promise<ProfileMachinesElement>;
  getPasswordToggle(): Promise<ProfileMachinesElement>;
  getSignInButton(): Promise<ProfileMachinesElement>;
  getMoreTab(): Promise<ProfileMachinesElement>;
  getMoreScreen(): Promise<ProfileMachinesElement>;
  getOtaStatusValue(): Promise<ProfileMachinesElement>;
  getAddTaskButton(): Promise<ProfileMachinesElement>;
  getCreateTaskCancelButton(): Promise<ProfileMachinesElement>;
  getCreateTaskCommand(): Promise<ScrollableProfileMachinesElement>;
  getCreateTaskPromptInput(): Promise<ProfileMachinesElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: { interval: number; timeout: number; timeoutMsg: string }
  ): Promise<unknown>;
}

function createProfileMachinesUi(driver: Browser): ProfileMachinesUi {
  return {
    getAccountButton: async () => driver.$(selectors.accountButton),
    getAccountSheet: async () => driver.$(selectors.accountSheet),
    getMachinesButton: async () => driver.$(selectors.accountMachinesButton),
    getMachinesScreen: async () => driver.$(selectors.machinesScreen),
    getMachinesAddButton: async () => driver.$(selectors.machinesAddButton),
    getPairingCodeInput: async () => driver.$(selectors.machinePairingCodeInput),
    getEmailInput: async () => driver.$(selectors.accountEmailInput),
    getPasswordInput: async () => driver.$(selectors.accountPasswordInput),
    getPasswordToggle: async () => driver.$(selectors.accountPasswordToggle),
    getSignInButton: async () => driver.$(selectors.accountSignInButton),
    getMoreTab: async () => driver.$(selectors.moreTab),
    getMoreScreen: async () => driver.$(selectors.moreScreen),
    getOtaStatusValue: async () => driver.$(selectors.legacyUpdateInfoOtaValue),
    getAddTaskButton: async () => driver.$(selectors.addTaskButton),
    getCreateTaskCancelButton: async () => driver.$(selectors.createTaskCancelButton),
    getCreateTaskCommand: async () => driver.$(selectors.createTaskCommand),
    getCreateTaskPromptInput: async () => driver.$(selectors.createTaskPromptInput),
    waitUntil: async (condition, options) => driver.waitUntil(condition, options)
  };
}

// XCUITest's native accessibility snapshot exposes control names, roles, and
// states, but not React Native's resolved backgroundColor, opacity, or transform.
// A WebDriver click also releases the pointer before the next command can capture
// a screenshot. Reliable end-to-end visual checking would require a harness API
// that holds pointer-down while atomically capturing and comparing the control's
// pixel region (or a test-only native resolved-style probe). Until then, this
// smoke covers the real Add task and More action paths; FloatingToolbar.test.tsx
// and MoreScreen.test.tsx assert the transient pressed styles themselves.
export async function assertToolbarActionPathsReachable(
  ui: Pick<
    ProfileMachinesUi,
    | "getAddTaskButton"
    | "getCreateTaskCancelButton"
    | "getCreateTaskCommand"
    | "getCreateTaskPromptInput"
    | "getMoreTab"
    | "getMoreScreen"
    | "waitUntil"
  >
): Promise<void> {
  const openAndCloseComposer = async (
    opener: ProfileMachinesElement
  ): Promise<void> => {
    await opener.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await opener.click();

    const promptInput = await ui.getCreateTaskPromptInput();
    await promptInput.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

    const cancelButton = await ui.getCreateTaskCancelButton();
    await cancelButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await cancelButton.click();
    await ui.waitUntil(
      async () => !(await (await ui.getCreateTaskPromptInput()).isExisting()),
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: "Expected task composer to close after Cancel"
      }
    );
  };

  await openAndCloseComposer(await ui.getAddTaskButton());

  const moreTab = await ui.getMoreTab();
  await moreTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await moreTab.click();

  const moreScreen = await ui.getMoreScreen();
  await moreScreen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const createTaskCommand = await ui.getCreateTaskCommand();
  await createTaskCommand.scrollIntoView({ direction: "down", maxScrolls: 5 });
  await openAndCloseComposer(createTaskCommand);
}

export async function assertOtaDiagnosticsHidden(
  ui: Pick<ProfileMachinesUi, "getMoreTab" | "getMoreScreen" | "getOtaStatusValue">
): Promise<void> {
  const moreTab = await ui.getMoreTab();
  await moreTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await moreTab.click();

  const moreScreen = await ui.getMoreScreen();
  await moreScreen.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  const otaStatus = await ui.getOtaStatusValue();
  if (await otaStatus.isExisting()) {
    throw new Error("Expected OTA diagnostics to be absent from More");
  }
}

export async function openProfileSheet(
  ui: Pick<ProfileMachinesUi, "getAccountButton" | "getAccountSheet">
): Promise<void> {
  const accountButton = await ui.getAccountButton();
  await accountButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await accountButton.click();
  await (await ui.getAccountSheet()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function openMachinesFromProfile(
  ui: Pick<
    ProfileMachinesUi,
    "getAccountButton" | "getAccountSheet" | "getMachinesButton" | "getMachinesScreen"
  >
): Promise<void> {
  await openProfileSheet(ui);
  const machinesButton = await ui.getMachinesButton();
  await machinesButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await machinesButton.click();
  await (await ui.getMachinesScreen()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function assertSignedOutMachineEntryPoints(
  ui: Pick<
    ProfileMachinesUi,
    | "getAccountButton"
    | "getAccountSheet"
    | "getMachinesButton"
    | "getMachinesScreen"
    | "getMachinesAddButton"
    | "getPairingCodeInput"
  >
): Promise<void> {
  await openMachinesFromProfile(ui);
  const add = await ui.getMachinesAddButton();
  await add.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await add.click();
  await (await ui.getPairingCodeInput()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function assertProfileSignInControlsReachable(
  ui: Pick<
    ProfileMachinesUi,
    | "getMachinesButton"
    | "getEmailInput"
    | "getPasswordInput"
    | "getPasswordToggle"
    | "getSignInButton"
    | "waitUntil"
  >
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const controls = await Promise.all([
        ui.getMachinesButton(),
        ui.getEmailInput(),
        ui.getPasswordInput(),
        ui.getPasswordToggle(),
        ui.getSignInButton()
      ]);
      return (await Promise.all(controls.map((control) => control.isExisting()))).every(Boolean);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected Profile identity controls and Machines entry point to be reachable"
    }
  );
}

export async function assertProfilePasswordCanRevealAndHide(
  ui: Pick<ProfileMachinesUi, "getPasswordToggle" | "waitUntil">
): Promise<void> {
  await ui.waitUntil(async () => (await ui.getPasswordToggle()).isExisting(), {
    interval: POLL_INTERVAL_MS,
    timeout: SCREEN_TIMEOUT_MS,
    timeoutMsg: "Expected profile drawer password visibility control to exist"
  });

  const showToggle = await ui.getPasswordToggle();
  const initialToggleLabel = await getAccessibilityLabel(showToggle);
  if (initialToggleLabel !== "Show password") {
    throw new Error(
      `Expected password visibility control to start as Show password, got ${initialToggleLabel}`
    );
  }
  await showToggle.click();

  await ui.waitUntil(
    async () =>
      getAccessibilityLabel(await ui.getPasswordToggle()).then(
        (label) => label === "Hide password"
      ),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch to Hide password"
    }
  );
  await (await ui.getPasswordToggle()).click();
  await ui.waitUntil(
    async () =>
      getAccessibilityLabel(await ui.getPasswordToggle()).then(
        (label) => label === "Show password"
      ),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch back to Show password"
    }
  );
}

async function getAccessibilityLabel(
  element: ProfileMachinesElement
): Promise<string | null> {
  for (const name of ["label", "content-desc", "name"]) {
    try {
      const value = await element.getAttribute(name);
      if (value) return value;
    } catch {
      // Native drivers differ in which accessibility attributes they expose.
    }
  }
  return null;
}

export async function runProfileConnectionSmoke(driver: Browser): Promise<void> {
  const ui = createProfileMachinesUi(driver);
  await (await driver.$(selectors.appShell)).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
  await assertToolbarActionPathsReachable(ui);
  await assertOtaDiagnosticsHidden(ui);
  await openProfileSheet(ui);
  await assertProfileSignInControlsReachable(ui);
  await assertProfilePasswordCanRevealAndHide(ui);
  const machinesButton = await ui.getMachinesButton();
  await machinesButton.click();
  await (await ui.getMachinesScreen()).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function runProfileDisconnectedConnectionSmoke(
  driver: Browser
): Promise<void> {
  const ui = createProfileMachinesUi(driver);
  await (await driver.$(selectors.appShell)).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
  await assertSignedOutMachineEntryPoints(ui);
}

import type { Browser } from "webdriverio";
import { selectors } from "../../helpers/selectors";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface ProfileConnectionElement {
  click(): Promise<unknown>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
}

interface ProfilePasswordToggleElement extends ProfileConnectionElement {
  getAttribute(name: string): Promise<string | null>;
}

interface ScrollableProfileConnectionElement extends ProfileConnectionElement {
  scrollIntoView(options: {
    direction: "down";
    maxScrolls: number;
  }): Promise<unknown>;
}

interface ProfileSheetOpener {
  getAccountButton(): Promise<ProfileConnectionElement>;
  getAccountSheet(): Promise<ProfileConnectionElement>;
}

interface MoreDiagnosticsUi {
  getMoreTab(): Promise<ProfileConnectionElement>;
  getMoreScreen(): Promise<ProfileConnectionElement>;
  getOtaStatusValue(): Promise<ProfileConnectionElement>;
}

interface ToolbarActionPathsUi {
  getAddTaskButton(): Promise<ProfileConnectionElement>;
  getCreateTaskCancelButton(): Promise<ProfileConnectionElement>;
  getCreateTaskCommand(): Promise<ScrollableProfileConnectionElement>;
  getCreateTaskPromptInput(): Promise<ProfileConnectionElement>;
  getMoreTab(): Promise<ProfileConnectionElement>;
  getMoreScreen(): Promise<ProfileConnectionElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

interface ProfileConnectionControlsUi {
  getConnectionTitle(): Promise<ProfileConnectionElement>;
  getConnectionStatus(): Promise<ProfileConnectionElement>;
  getConnectLocalButton(): Promise<ProfileConnectionElement>;
  getEmailInput(): Promise<ProfileConnectionElement>;
  getPasswordInput(): Promise<ProfileConnectionElement>;
  getPasswordToggle(): Promise<ProfilePasswordToggleElement>;
  getSignInButton(): Promise<ProfileConnectionElement>;
  waitUntil(
    condition: () => Promise<boolean>,
    options: {
      interval: number;
      timeout: number;
      timeoutMsg: string;
    }
  ): Promise<unknown>;
}

interface ProfileConnectionUi
  extends ProfileSheetOpener,
    MoreDiagnosticsUi,
    ToolbarActionPathsUi,
    ProfileConnectionControlsUi {}

function createProfileConnectionUi(driver: Browser): ProfileConnectionUi {
  return {
    async getAccountButton() {
      return driver.$(selectors.accountButton);
    },
    async getAccountSheet() {
      return driver.$(selectors.accountSheet);
    },
    async getAddTaskButton() {
      return driver.$(selectors.addTaskButton);
    },
    async getConnectionStatus() {
      return driver.$(selectors.accountConnectionStatus);
    },
    async getConnectionTitle() {
      return driver.$(selectors.accountConnectionTitle);
    },
    async getConnectLocalButton() {
      return driver.$(selectors.accountConnectLocalButton);
    },
    async getCreateTaskCancelButton() {
      return driver.$(selectors.createTaskCancelButton);
    },
    async getCreateTaskCommand() {
      return driver.$(selectors.createTaskCommand);
    },
    async getCreateTaskPromptInput() {
      return driver.$(selectors.createTaskPromptInput);
    },
    async getEmailInput() {
      return driver.$(selectors.accountEmailInput);
    },
    async getPasswordInput() {
      return driver.$(selectors.accountPasswordInput);
    },
    async getPasswordToggle() {
      return driver.$(selectors.accountPasswordToggle);
    },
    async getMoreTab() {
      return driver.$(selectors.moreTab);
    },
    async getMoreScreen() {
      return driver.$(selectors.moreScreen);
    },
    async getOtaStatusValue() {
      return driver.$(selectors.legacyUpdateInfoOtaValue);
    },
    async getSignInButton() {
      return driver.$(selectors.accountSignInButton);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
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
  ui: ToolbarActionPathsUi
): Promise<void> {
  const openAndCloseComposer = async (
    opener: ProfileConnectionElement
  ): Promise<void> => {
    await opener.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await opener.click();

    const promptInput = await ui.getCreateTaskPromptInput();
    await promptInput.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

    const cancelButton = await ui.getCreateTaskCancelButton();
    await cancelButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
    await cancelButton.click();
    await ui.waitUntil(
      async () =>
        !(await (await ui.getCreateTaskPromptInput()).isExisting()),
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
  ui: MoreDiagnosticsUi
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

export async function openProfileConnectionSheet(
  ui: ProfileSheetOpener
): Promise<void> {
  const accountButton = await ui.getAccountButton();
  await accountButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await accountButton.click();

  const accountSheet = await ui.getAccountSheet();
  await accountSheet.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
}

export async function assertProfileConnectionControlsReachable(
  ui: ProfileConnectionControlsUi
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const status = await ui.getConnectionStatus();
      const localConnect = await ui.getConnectLocalButton();
      const emailInput = await ui.getEmailInput();
      const passwordInput = await ui.getPasswordInput();
      const passwordToggle = await ui.getPasswordToggle();
      const signInButton = await ui.getSignInButton();

      return (
        (await status.isExisting()) &&
        (await localConnect.isExisting()) &&
        (await emailInput.isExisting()) &&
        (await passwordInput.isExisting()) &&
        (await passwordToggle.isExisting()) &&
        (await signInButton.isExisting())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected profile drawer connection controls and sign-in form to be reachable"
    }
  );
}

export async function assertProfilePasswordCanRevealAndHide(
  ui: ProfileConnectionControlsUi
): Promise<void> {
  await ui.waitUntil(
    async () => (await ui.getPasswordToggle()).isExisting(),
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected profile drawer password visibility control to exist"
    }
  );

  const showToggle = await ui.getPasswordToggle();
  const initialToggleLabel = await getPasswordToggleAccessibilityLabel(showToggle);
  if (initialToggleLabel !== "Show password") {
    throw new Error(
      `Expected password visibility control to start as Show password, got ${initialToggleLabel}`
    );
  }
  await showToggle.click();

  await ui.waitUntil(
    async () =>
      (await getPasswordToggleAccessibilityLabel(await ui.getPasswordToggle())) ===
      "Hide password",
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch to Hide password"
    }
  );

  const hideToggle = await ui.getPasswordToggle();
  await hideToggle.click();

  await ui.waitUntil(
    async () =>
      (await getPasswordToggleAccessibilityLabel(await ui.getPasswordToggle())) ===
      "Show password",
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch back to Show password"
    }
  );
}

async function getPasswordToggleAccessibilityLabel(
  toggle: ProfilePasswordToggleElement
): Promise<string | null> {
  for (const attributeName of ["label", "content-desc", "name"]) {
    try {
      const value = await toggle.getAttribute(attributeName);
      if (value) {
        return value;
      }
    } catch {
      // Appium attribute support varies by native driver.
    }
  }

  return null;
}

export async function assertProfileConnectionDisconnected(
  ui: ProfileConnectionControlsUi
): Promise<void> {
  await ui.waitUntil(
    async () => {
      const title = await ui.getConnectionTitle();
      return (await title.getText()).includes("Not connected");
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected profile drawer connection status to be disconnected"
    }
  );
}

export async function runProfileConnectionSmoke(driver: Browser): Promise<void> {
  const ui = createProfileConnectionUi(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await assertToolbarActionPathsReachable(ui);
  await assertOtaDiagnosticsHidden(ui);
  await openProfileConnectionSheet(ui);
  await assertProfileConnectionControlsReachable(ui);
  await assertProfilePasswordCanRevealAndHide(ui);
}

export async function runProfileDisconnectedConnectionSmoke(
  driver: Browser
): Promise<void> {
  const ui = createProfileConnectionUi(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });

  await openProfileConnectionSheet(ui);
  await assertProfileConnectionDisconnected(ui);
  await assertProfileConnectionControlsReachable(ui);
  await assertProfilePasswordCanRevealAndHide(ui);
}

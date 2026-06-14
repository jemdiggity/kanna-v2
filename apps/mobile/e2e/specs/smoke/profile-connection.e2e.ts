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

interface ProfileSheetOpener {
  getAccountButton(): Promise<ProfileConnectionElement>;
  getAccountSheet(): Promise<ProfileConnectionElement>;
}

interface ProfileConnectionControlsUi {
  getConnectionTitle(): Promise<ProfileConnectionElement>;
  getConnectionStatus(): Promise<ProfileConnectionElement>;
  getConnectLocalButton(): Promise<ProfileConnectionElement>;
  getEmailInput(): Promise<ProfileConnectionElement>;
  getPasswordInput(): Promise<ProfileConnectionElement>;
  getPasswordToggle(): Promise<ProfileConnectionElement>;
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
    ProfileConnectionControlsUi {}

function createProfileConnectionUi(driver: Browser): ProfileConnectionUi {
  return {
    async getAccountButton() {
      return driver.$(selectors.accountButton);
    },
    async getAccountSheet() {
      return driver.$(selectors.accountSheet);
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
    async getEmailInput() {
      return driver.$(selectors.accountEmailInput);
    },
    async getPasswordInput() {
      return driver.$(selectors.accountPasswordInput);
    },
    async getPasswordToggle() {
      return driver.$(selectors.accountPasswordToggle);
    },
    async getSignInButton() {
      return driver.$(selectors.accountSignInButton);
    },
    async waitUntil(condition, options) {
      return driver.waitUntil(condition, options);
    }
  };
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
  const initialToggleText = await showToggle.getText();
  if (initialToggleText !== "Show") {
    throw new Error(
      `Expected password visibility control to start as Show, got ${initialToggleText}`
    );
  }
  await showToggle.click();

  await ui.waitUntil(
    async () => (await (await ui.getPasswordToggle()).getText()) === "Hide",
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch to Hide"
    }
  );

  const hideToggle = await ui.getPasswordToggle();
  await hideToggle.click();

  await ui.waitUntil(
    async () => (await (await ui.getPasswordToggle()).getText()) === "Show",
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected password visibility control to switch back to Show"
    }
  );
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

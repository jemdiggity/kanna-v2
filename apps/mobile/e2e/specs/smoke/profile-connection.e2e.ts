import type { Browser } from "webdriverio";
import type {
  HarnessPairingSession,
  MobileHybridFixture
} from "../../helpers/relay-harness";
import { claimPairingPayloadThroughDeepLink } from "../../helpers/trust-seed";
import {
  machineRemoveButtonSelector,
  machineOriginSelector,
  machineRowSelector,
  machineRowsXPath,
  selectors
} from "../../helpers/selectors";
import {
  openPtyFixtureTask,
  waitForTaskTerminalLive
} from "./list-detail-back.e2e";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const IOS_APP_STATE_NOT_RUNNING = 1;

interface ProfileMachinesElement {
  click(): Promise<unknown>;
  getAttribute(name: string): Promise<string | null>;
  getText(): Promise<string>;
  isExisting(): Promise<boolean>;
  setValue(value: string): Promise<unknown>;
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
  getPairingScanMode(): Promise<ProfileMachinesElement>;
  getPairingCodeInput(): Promise<ProfileMachinesElement>;
  getPairingError(): Promise<ProfileMachinesElement>;
  getPairingSubmit(): Promise<ProfileMachinesElement>;
  getMachineRow(desktopId: string): Promise<ProfileMachinesElement>;
  getMachineRows(desktopId: string): Promise<ProfileMachinesElement[]>;
  getMachineOrigin(
    desktopId: string,
    origin: "account" | "manual"
  ): Promise<ProfileMachinesElement>;
  getMachineRemoveButton(desktopId: string): Promise<ProfileMachinesElement>;
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
    getPairingScanMode: async () => driver.$(selectors.machinePairingScanMode),
    getPairingCodeInput: async () => driver.$(selectors.machinePairingCodeInput),
    getPairingError: async () => driver.$(selectors.machinePairingError),
    getPairingSubmit: async () => driver.$(selectors.machinePairingSubmit),
    getMachineRow: async (desktopId) => driver.$(machineRowSelector(desktopId)),
    getMachineRows: async (desktopId) =>
      Array.from(await driver.$$(machineRowsXPath(desktopId))),
    getMachineOrigin: async (desktopId, origin) =>
      driver.$(machineOriginSelector(desktopId, origin)),
    getMachineRemoveButton: async (desktopId) =>
      driver.$(machineRemoveButtonSelector(desktopId)),
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

export async function submitPairingCode(
  ui: Pick<
    ProfileMachinesUi,
    "getPairingCodeInput" | "getPairingSubmit" | "getMachineRow"
  >,
  code: string,
  desktopId: string
): Promise<void> {
  const input = await ui.getPairingCodeInput();
  await input.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await input.setValue(code);
  await (await ui.getPairingSubmit()).click();
  await (await ui.getMachineRow(desktopId)).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
}

export async function assertPairingFailure(
  ui: Pick<ProfileMachinesUi, "getPairingCodeInput" | "getPairingError">,
  failure: "invalid" | "expired"
): Promise<void> {
  const error = await ui.getPairingError();
  await error.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const message = await error.getText();
  const expected = failure === "expired"
    ? "pairing session expired"
    : "No matching machine was found";
  if (!message.includes(expected)) {
    throw new Error(`Expected ${failure} pairing recovery copy, got ${message}`);
  }
  await (await ui.getPairingCodeInput()).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
}

export async function assertPairingSheetFresh(
  ui: Pick<
    ProfileMachinesUi,
    | "getPairingScanMode"
    | "getPairingCodeInput"
    | "getPairingError"
    | "getPairingSubmit"
  >,
  consumedCode: string
): Promise<void> {
  const scanMode = await ui.getPairingScanMode();
  await scanMode.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  if (await scanMode.getAttribute("selected") !== "true") {
    throw new Error("Expected the pairing sheet to reopen in Scan QR mode");
  }

  const input = await ui.getPairingCodeInput();
  const inputValue = await input.getAttribute("value");
  if (normalizeNativeInputValue(inputValue) === normalizeNativeInputValue(consumedCode)) {
    throw new Error("Expected the consumed pairing code to be cleared before reopening");
  }

  if (await (await ui.getPairingError()).isExisting()) {
    throw new Error("Expected the pairing error to be cleared before reopening");
  }
  const submitEnabled = await (await ui.getPairingSubmit()).getAttribute("enabled");
  if (submitEnabled !== "false") {
    throw new Error("Expected pairing submission to be reset and disabled before reopening");
  }
}

function normalizeNativeInputValue(value: string | null): string {
  return (value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export async function assertMachineOrigins(
  ui: Pick<
    ProfileMachinesUi,
    "getMachineOrigin" | "getMachineRow" | "getMachineRows" | "waitUntil"
  >,
  desktopId: string,
  origins: { account: boolean; manual: boolean }
): Promise<void> {
  const row = await ui.getMachineRow(desktopId);
  await row.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  let observedOrigins = { account: false, manual: false };
  let observedRows = 0;
  await ui.waitUntil(
    async () => {
      const rows = await ui.getMachineRows(desktopId);
      observedRows = rows.length;
      observedOrigins = {
        account: await (await ui.getMachineOrigin(desktopId, "account")).isExisting(),
        manual: await (await ui.getMachineOrigin(desktopId, "manual")).isExisting()
      };
      return rows.length === 1 &&
        observedOrigins.account === origins.account &&
        observedOrigins.manual === origins.manual;
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        `Expected one ${desktopId} row with origins ${JSON.stringify(origins)}; ` +
        `last observed ${observedRows} rows and ${JSON.stringify(observedOrigins)}`
    }
  );
}

export async function removeManualMachine(
  ui: Pick<
    ProfileMachinesUi,
    | "getMachineRemoveButton"
    | "getMachineOrigin"
    | "getMachineRow"
    | "getMachineRows"
    | "waitUntil"
  >,
  desktopId: string,
  retainAccountRow: boolean,
  confirmRemoval?: () => Promise<void>
): Promise<void> {
  await (await ui.getMachineRemoveButton(desktopId)).click();
  await confirmRemoval?.();
  await ui.waitUntil(
    async () => {
      const row = await ui.getMachineRow(desktopId);
      if (!retainAccountRow) return !(await row.isExisting());
      if (!(await row.isExisting())) return false;
      const rows = await ui.getMachineRows(desktopId);
      const account = await (await ui.getMachineOrigin(desktopId, "account")).isExisting();
      const manual = await (await ui.getMachineOrigin(desktopId, "manual")).isExisting();
      return rows.length === 1 && account && !manual;
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: retainAccountRow
        ? `Expected ${desktopId} to remain account-only after manual removal`
        : `Expected manual-only machine ${desktopId} to be removed`
    }
  );
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
  driver: Browser,
  options: {
    bundleId: string;
    createPairingSession(): Promise<HarnessPairingSession>;
    credentials: { email: string; password: string };
    desktopId: string;
    expirePairingSession(): Promise<void>;
    hybridFixture: MobileHybridFixture;
    reopenDevelopmentClient(): Promise<void>;
    setLanHttpEnabled(enabled: boolean): Promise<void>;
    waitForAppReady(readySelector: string): Promise<void>;
  }
): Promise<void> {
  const ui = createProfileMachinesUi(driver);
  await (await driver.$(selectors.appShell)).waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await openMachinesFromProfile(ui);

  const codePairing = await options.createPairingSession();
  await openPairingSheet(ui);
  await submitPairingCode(ui, codePairing.code, options.desktopId);
  await assertMachineOrigins(ui, options.desktopId, {
    account: false,
    manual: true
  });
  await openPairingSheet(ui);
  await assertPairingSheetFresh(ui, codePairing.code);
  await (await driver.$(selectors.machinePairingClose)).click();
  await removeManualMachine(
    ui,
    options.desktopId,
    false,
    () => acceptRemovalAlert(driver)
  );

  const invalidPairing = await options.createPairingSession();
  await openPairingSheet(ui);
  const invalidCode = invalidPairing.code === "FFFFFF" ? "000000" : "FFFFFF";
  await submitPairingFailure(ui, invalidCode, "invalid");

  const expiredPairing = await options.createPairingSession();
  await options.expirePairingSession();
  await submitPairingFailure(ui, expiredPairing.code, "expired");

  const qrPairing = await options.createPairingSession();
  await claimPairingPayloadThroughDeepLink({
    bundleId: options.bundleId,
    driver,
    payload: qrPairing.pairingPayload
  });
  await (await driver.$(selectors.machinePairingClose)).click();
  await assertMachineOrigins(ui, options.desktopId, {
    account: false,
    manual: true
  });

  await relaunchApp(
    driver,
    options.bundleId,
    options.reopenDevelopmentClient,
    selectors.machinesScreen,
    options.waitForAppReady
  );
  await (await driver.$(selectors.machinesScreen)).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
  await assertMachineOrigins(ui, options.desktopId, {
    account: false,
    manual: true
  });

  await (await driver.$(selectors.machinesBackButton)).click();
  await options.waitForAppReady(selectors.accountButton);
  await signInFromProfile(driver, ui, options.credentials);
  await openMachinesFromProfile(ui);
  await assertMachineOrigins(ui, options.desktopId, {
    account: true,
    manual: true
  });

  await (await driver.$(selectors.machinesBackButton)).click();
  const recentTab = await driver.$(selectors.recentTab);
  await recentTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await recentTab.click();
  await waitForTaskRowText(
    driver,
    options.hybridFixture.duplicate.displayTaskId,
    options.hybridFixture.duplicate.lanTitle,
    "Expected the account machine to prefer its reachable LAN task source"
  );

  await options.setLanHttpEnabled(false);
  await relaunchApp(
    driver,
    options.bundleId,
    options.reopenDevelopmentClient,
    selectors.recentTab,
    options.waitForAppReady
  );
  const relaunchedRecentTab = await driver.$(selectors.recentTab);
  await relaunchedRecentTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await relaunchedRecentTab.click();
  await waitForTaskRowText(
    driver,
    options.hybridFixture.duplicate.displayTaskId,
    options.hybridFixture.duplicate.cloudTitle,
    "Expected the account machine to fall back to relay after LAN became unavailable"
  );
  await openPtyFixtureTask(
    {
      getTaskRowById: async (taskId) =>
        driver.$(`~mobile.task-row.${taskId}`),
      waitUntil: (condition, waitOptions) => driver.waitUntil(condition, waitOptions)
    },
    options.hybridFixture.duplicate.displayTaskId
  );
  await waitForTaskTerminalLive({
    getAgentMessageView: async () => driver.$(selectors.agentMessageView),
    getAgentMessageReady: async () => driver.$(selectors.agentMessageReady),
    getTaskDetailScreen: async () => driver.$(selectors.taskDetailScreen),
    getTerminalOverlay: async () => driver.$(selectors.terminalOverlay),
    waitUntil: (condition, waitOptions) => driver.waitUntil(condition, waitOptions)
  });

  await (await driver.$(selectors.taskBackButton)).click();
  await openMachinesFromProfile(ui);
  await removeManualMachine(
    ui,
    options.desktopId,
    true,
    () => acceptRemovalAlert(driver)
  );
}

async function openPairingSheet(
  ui: Pick<ProfileMachinesUi, "getMachinesAddButton" | "getPairingCodeInput">
): Promise<void> {
  await (await ui.getMachinesAddButton()).click();
  await (await ui.getPairingCodeInput()).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
}

async function submitPairingFailure(
  ui: Pick<
    ProfileMachinesUi,
    "getPairingCodeInput" | "getPairingError" | "getPairingSubmit"
  >,
  code: string,
  failure: "invalid" | "expired"
): Promise<void> {
  await (await ui.getPairingCodeInput()).setValue(code);
  await (await ui.getPairingSubmit()).click();
  await assertPairingFailure(ui, failure);
}

async function acceptRemovalAlert(driver: Browser): Promise<void> {
  const alertAppeared = await driver
    .waitUntil(
      async () => driver.getAlertText().then(() => true).catch(() => false),
      {
        interval: 100,
        timeout: 5_000,
        timeoutMsg: "Expected remove-machine confirmation alert"
      }
    )
    .then(() => true)
    .catch(() => false);
  if (alertAppeared) await driver.acceptAlert();
}

export async function relaunchApp(
  driver: Browser,
  bundleId: string,
  reopenDevelopmentClient: () => Promise<void>,
  readySelector: string,
  waitForAppReady: (readySelector: string) => Promise<void>
): Promise<void> {
  await driver.terminateApp(undefined, bundleId);
  await driver.waitUntil(
    async () =>
      await driver.queryAppState(undefined, bundleId) === IOS_APP_STATE_NOT_RUNNING,
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected ${bundleId} to terminate before relaunch`
    }
  );
  await driver.activateApp(undefined, bundleId);
  await reopenDevelopmentClient();
  await waitForAppReady(readySelector);
}

async function signInFromProfile(
  driver: Browser,
  ui: ProfileMachinesUi,
  credentials: { email: string; password: string }
): Promise<void> {
  await openProfileSheet(ui);
  await (await ui.getEmailInput()).setValue(credentials.email);
  await (await ui.getPasswordInput()).setValue(credentials.password);
  await (await ui.getSignInButton()).click();
  await driver.waitUntil(
    async () => {
      await dismissSavePasswordPrompt(driver);
      return (await driver.$(selectors.accountSignOutButton)).isExisting();
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: "Expected profile machine E2E sign-in to complete"
    }
  );
  await (await driver.$(selectors.accountCloseButton)).click();
}

async function dismissSavePasswordPrompt(driver: Browser): Promise<void> {
  for (const selector of [
    "~Not Now",
    '-ios predicate string:name == "Not Now" OR label == "Not Now"'
  ]) {
    const notNow = await driver.$(selector);
    if (await notNow.isExisting()) {
      await notNow.click();
      return;
    }
  }
}

async function waitForTaskRowText(
  driver: Browser,
  taskId: string,
  expectedText: string,
  timeoutMsg: string
): Promise<void> {
  await driver.waitUntil(
    async () => {
      const row = await driver.$(`~mobile.task-row.${taskId}`);
      if (!(await row.isExisting())) return false;
      const rowText = await row.getText().catch(() => "");
      const pageSource = await driver.getPageSource();
      return `${rowText}\n${pageSource}`.includes(expectedText);
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg
    }
  );
}

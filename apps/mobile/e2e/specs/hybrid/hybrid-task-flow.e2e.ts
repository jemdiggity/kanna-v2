import type { Browser } from "webdriverio";
import type { MobileHybridFixture } from "../../helpers/relay-harness";
import { extractTaskRowId, selectors } from "../../helpers/selectors";
import {
  openPtyFixtureTask,
  waitForTaskTerminalLive
} from "../smoke/list-detail-back.e2e";
import { openProfileConnectionSheet } from "../smoke/profile-connection.e2e";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const STABILITY_SETTLE_MS = 1_000;

interface HybridCredentials {
  email: string;
  password: string;
}

interface HybridTaskFlowOptions {
  credentials: HybridCredentials;
  fixture: MobileHybridFixture;
  stopRelay(): Promise<void>;
}

async function dismissSavePasswordPrompt(driver: Browser): Promise<void> {
  for (const selector of [
    "~Not Now",
    '-ios predicate string:name == "Not Now" OR label == "Not Now"'
  ]) {
    const notNow = await driver.$(selector);
    const isVisible = await notNow
      .waitForDisplayed({ timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (isVisible) {
      await notNow.click();
      return;
    }
  }
}

async function assertPersistedUnresolvedSelectionKeepsShellVisible(
  driver: Browser
): Promise<void> {
  await driver.waitUntil(
    async () => {
      const [tasksScreen, accountButton, tasksTab, detailScreen] =
        await Promise.all([
          driver.$(selectors.tasksScreen),
          driver.$(selectors.accountButton),
          driver.$(selectors.tasksTab),
          driver.$(selectors.taskDetailScreen)
        ]);
      return (
        (await tasksScreen.isExisting()) &&
        (await accountButton.isExisting()) &&
        (await tasksTab.isExisting()) &&
        !(await detailScreen.isExisting())
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected an unresolved persisted task selection to keep the task list, account badge, and toolbar visible"
    }
  );
}

async function signInToHybridCloud(
  driver: Browser,
  credentials: HybridCredentials
): Promise<void> {
  await openProfileConnectionSheet({
    getAccountButton: async () => await driver.$(selectors.accountButton),
    getAccountSheet: async () => await driver.$(selectors.accountSheet)
  });

  const emailInput = await driver.$(selectors.accountEmailInput);
  await emailInput.setValue(credentials.email);
  const passwordInput = await driver.$(selectors.accountPasswordInput);
  await passwordInput.setValue(credentials.password);
  const signInButton = await driver.$(selectors.accountSignInButton);
  await signInButton.click();
  await dismissSavePasswordPrompt(driver);

  await driver.waitUntil(
    async () => {
      await dismissSavePasswordPrompt(driver);
      const signOutButton = await driver.$(selectors.accountSignOutButton);
      return signOutButton.isExisting();
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected the hybrid mobile fixture to sign into the Auth emulator"
    }
  );

  const closeButton = await driver.$(selectors.accountCloseButton);
  await closeButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await closeButton.click();
}

async function readTaskRowIds(driver: Browser): Promise<string[]> {
  const rows = Array.from(await driver.$$(selectors.taskRowsXPath));
  const taskIds: string[] = [];
  for (const row of rows) {
    let accessibilityName = await row.getAttribute("name").catch(() => null);
    if (!accessibilityName) {
      accessibilityName = await row.getAttribute("label").catch(() => null);
    }
    const taskId = extractTaskRowId(accessibilityName);
    if (taskId) taskIds.push(taskId);
  }
  return taskIds.sort();
}

function sameTaskIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((taskId, index) => taskId === right[index])
  );
}

async function waitForStableExactTaskRows(
  driver: Browser,
  expectedTaskIds: string[]
): Promise<void> {
  const expected = [...expectedTaskIds].sort();
  let observed: string[] = [];
  try {
    await driver.waitUntil(
      async () => {
        observed = await readTaskRowIds(driver);
        return sameTaskIds(observed, expected);
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg: `Expected exact hybrid task rows ${JSON.stringify(expected)}`
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; last observed task row ids were ${JSON.stringify(observed)}`
    );
  }

  await driver.pause(STABILITY_SETTLE_MS);
  const stableIds = await readTaskRowIds(driver);
  if (!sameTaskIds(stableIds, expected)) {
    throw new Error(
      "Hybrid task rows changed after settling: " +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(stableIds)}`
    );
  }
}

async function assertHybridTaskPresentation(
  driver: Browser,
  fixture: MobileHybridFixture
): Promise<void> {
  const duplicate = await driver.$(
    `~mobile.task-row.${fixture.duplicate.displayTaskId}`
  );
  const rowText = await duplicate.getText().catch(() => "");
  const pageSource = await driver.getPageSource();
  const renderedText = `${rowText}\n${pageSource}`;
  for (const title of [
    fixture.cloudOnly.title,
    fixture.duplicate.lanTitle,
    fixture.lanOnly.title
  ]) {
    if (!renderedText.includes(title)) {
      throw new Error(`Expected hybrid task list to render title ${title}`);
    }
  }
  if (renderedText.includes(fixture.duplicate.cloudTitle)) {
    throw new Error(
      "Expected duplicate task presentation to use LAN metadata, but the cloud title was rendered"
    );
  }

  const duplicateLocalRow = await driver.$(
    `~mobile.task-row.${fixture.duplicate.localTaskId}`
  );
  if (await duplicateLocalRow.isExisting()) {
    throw new Error(
      `Expected local duplicate row ${fixture.duplicate.localTaskId} to be deduplicated under ${fixture.duplicate.displayTaskId}`
    );
  }
}

export async function runHybridTaskFlow(
  driver: Browser,
  options: HybridTaskFlowOptions
): Promise<void> {
  await dismissSavePasswordPrompt(driver);
  const appShell = await driver.$(selectors.appShell);
  await appShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await assertPersistedUnresolvedSelectionKeepsShellVisible(driver);
  await signInToHybridCloud(driver, options.credentials);

  const recentTab = await driver.$(selectors.recentTab);
  await recentTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await recentTab.click();

  await waitForStableExactTaskRows(
    driver,
    options.fixture.expectedDisplayTaskIds
  );
  await assertHybridTaskPresentation(driver, options.fixture);

  // If the duplicate were accidentally routed through the relay, opening it
  // below would fail after this point. A healthy trusted-LAN route keeps the
  // exact cloud display id while streaming the local task's PTY.
  await options.stopRelay();
  await openPtyFixtureTask(
    {
      getTaskRowById: async (taskId) =>
        await driver.$(`~mobile.task-row.${taskId}`),
      waitUntil: (condition, waitOptions) =>
        driver.waitUntil(condition, waitOptions)
    },
    options.fixture.duplicate.displayTaskId
  );
  await waitForTaskTerminalLive({
    getAgentMessageView: async () =>
      await driver.$(selectors.agentMessageView),
    getTerminalOverlay: async () =>
      await driver.$(selectors.terminalOverlay),
    waitUntil: (condition, waitOptions) =>
      driver.waitUntil(condition, waitOptions)
  });
}

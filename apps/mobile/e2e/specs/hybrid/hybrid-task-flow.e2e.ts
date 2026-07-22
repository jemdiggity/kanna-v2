import type { Browser } from "webdriverio";
import type { MobileHybridFixture } from "../../helpers/relay-harness";
import { extractTaskRowId, selectors } from "../../helpers/selectors";
import {
  openPtyFixtureTask,
  smokeElementText,
  waitForTaskTerminalLive
} from "../smoke/list-detail-back.e2e";
import { openProfileSheet } from "../smoke/profile-connection.e2e";

const SCREEN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const STABILITY_SETTLE_MS = 1_000;
const IOS_APP_STATE_NOT_RUNNING = 1;

interface HybridCredentials {
  email: string;
  password: string;
}

interface HybridTaskFlowOptions {
  bundleId: string;
  credentials: HybridCredentials;
  fixture: MobileHybridFixture;
  publishCloudRefresh(): Promise<void>;
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
  await openProfileSheet({
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

async function assertRestoredHybridSignIn(driver: Browser): Promise<void> {
  await openProfileSheet({
    getAccountButton: async () => await driver.$(selectors.accountButton),
    getAccountSheet: async () => await driver.$(selectors.accountSheet)
  });

  const signOutButton = await driver.$(selectors.accountSignOutButton);
  await signOutButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const signInButton = await driver.$(selectors.accountSignInButton);
  if (await signInButton.isExisting()) {
    throw new Error(
      "Expected Firebase auth to restore after relaunch without interactive sign-in"
    );
  }

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

function expectedRefreshedSnapshotMarker(
  fixture: MobileHybridFixture
): string[] {
  return [
    `${fixture.cloudOnly.taskId}:${fixture.cloudOnly.refreshedTitle}`,
    `${fixture.duplicate.displayTaskId}:${fixture.duplicate.lanTitle}`,
    `${fixture.lanOnly.taskId}:${fixture.lanOnly.title}`
  ].sort();
}

function markerEntries(marker: string | null): string[] {
  return (marker ?? "")
    .split("\n")
    .filter((entry) => entry.length > 0)
    .sort();
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
  fixture: MobileHybridFixture,
  cloudOnlyTitle = fixture.cloudOnly.title
): Promise<void> {
  const duplicate = await driver.$(
    `~mobile.task-row.${fixture.duplicate.displayTaskId}`
  );
  const rowText = await duplicate.getText().catch(() => "");
  const pageSource = await driver.getPageSource();
  const renderedText = `${rowText}\n${pageSource}`;
  for (const title of [
    cloudOnlyTitle,
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

  // Relaunch the same installed app without resetting its sandbox. This keeps
  // both Firebase Auth persistence and the trusted-LAN record, exercising the
  // restored-auth startup path instead of another interactive sign-in.
  await driver.terminateApp(undefined, options.bundleId);
  await driver.waitUntil(
    async () =>
      await driver.queryAppState(undefined, options.bundleId) ===
        IOS_APP_STATE_NOT_RUNNING,
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg: `Expected ${options.bundleId} to terminate before relaunch`
    }
  );
  await driver.activateApp(undefined, options.bundleId);
  await dismissSavePasswordPrompt(driver);

  const relaunchedShell = await driver.$(selectors.appShell);
  await relaunchedShell.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  const relaunchedRecentTab = await driver.$(selectors.recentTab);
  await relaunchedRecentTab.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await relaunchedRecentTab.click();
  await waitForStableExactTaskRows(
    driver,
    options.fixture.expectedDisplayTaskIds
  );
  await assertHybridTaskPresentation(driver, options.fixture);
  await assertRestoredHybridSignIn(driver);

  await openPtyFixtureTask(
    {
      getTaskRowById: async (taskId) =>
        await driver.$(`~mobile.task-row.${taskId}`),
      waitUntil: (condition, waitOptions) =>
        driver.waitUntil(condition, waitOptions)
    },
    options.fixture.lanOnly.taskId
  );
  await waitForTaskTerminalLive({
    getAgentMessageView: async () =>
      await driver.$(selectors.agentMessageView),
    getAgentMessageReady: async () =>
      await driver.$(selectors.agentMessageReady),
    getTaskDetailScreen: async () =>
      await driver.$(selectors.taskDetailScreen),
    getTerminalOverlay: async () =>
      await driver.$(selectors.terminalOverlay),
    waitUntil: (condition, waitOptions) =>
      driver.waitUntil(condition, waitOptions)
  });

  await options.publishCloudRefresh();
  await driver.waitUntil(
    async () => {
      const [taskDetail, snapshotMarker] = await Promise.all([
        driver.$(selectors.taskDetailScreen),
        driver.$(selectors.taskSnapshotMarker)
      ]);
      if (!(await taskDetail.isExisting()) || !(await snapshotMarker.isExisting())) {
        return false;
      }
      const marker = await snapshotMarker.getAttribute("label").catch(() => null);
      return sameTaskIds(
        markerEntries(marker),
        expectedRefreshedSnapshotMarker(options.fixture)
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected the selected LAN-only detail to acknowledge the refreshed cloud snapshot"
    }
  );
  const selectedLanOnlyDetail = await driver.$(selectors.taskDetailScreen);
  if (!(await selectedLanOnlyDetail.isExisting())) {
    throw new Error(
      "Expected a second cloud snapshot to preserve the selected LAN-only task detail and stream"
    );
  }
  const selectedLanOnlyTitle = await driver.$(selectors.taskDetailTitle);
  const selectedTitleText = await selectedLanOnlyTitle.getText().catch(() => "");
  if (selectedTitleText !== options.fixture.lanOnly.title) {
    throw new Error(
      `Expected selected LAN-only detail title to remain ${options.fixture.lanOnly.title}, received ${selectedTitleText}`
    );
  }
  await waitForTaskTerminalLive({
    getAgentMessageView: async () =>
      await driver.$(selectors.agentMessageView),
    getAgentMessageReady: async () =>
      await driver.$(selectors.agentMessageReady),
    getTaskDetailScreen: async () =>
      await driver.$(selectors.taskDetailScreen),
    getTerminalOverlay: async () =>
      await driver.$(selectors.terminalOverlay),
    waitUntil: (condition, waitOptions) =>
      driver.waitUntil(condition, waitOptions)
  });

  const backButton = await driver.$(selectors.taskBackButton);
  await backButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await backButton.click();
  const recentAfterRefresh = await driver.$(selectors.recentTab);
  await recentAfterRefresh.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await recentAfterRefresh.click();
  await waitForStableExactTaskRows(
    driver,
    options.fixture.expectedDisplayTaskIds
  );
  await assertHybridTaskPresentation(
    driver,
    options.fixture,
    options.fixture.cloudOnly.refreshedTitle
  );

  // The expanded identity panel must show the desktop-local task id — matching
  // the desktop app — even though the cloud snapshot task's canonical mobile id
  // is the synthetic "cloud:<desktop>:<repo>:<task>" id.
  const cloudOnlyRow = await driver.$(
    `~mobile.task-row.${options.fixture.cloudOnly.taskId}`
  );
  await cloudOnlyRow.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await cloudOnlyRow.click();
  await (await driver.$(selectors.taskDetailScreen)).waitForDisplayed({
    timeout: SCREEN_TIMEOUT_MS
  });
  // The freshly opened detail can briefly render the previously selected task,
  // and title expansion is keyed by task id — clicking early expands the wrong
  // task. Settle on the cloud-only collapsed title before expanding.
  await driver.waitUntil(
    async () => {
      const collapsedTitle = await driver.$(selectors.taskDetailTitle);
      return (
        (await collapsedTitle.isExisting()) &&
        (await smokeElementText(collapsedTitle)).includes(
          options.fixture.cloudOnly.refreshedTitle
        )
      );
    },
    {
      interval: POLL_INTERVAL_MS,
      timeout: SCREEN_TIMEOUT_MS,
      timeoutMsg:
        "Expected the collapsed cloud-only detail title " +
        `${JSON.stringify(options.fixture.cloudOnly.refreshedTitle)} before expanding`
    }
  );
  // While expanded, iOS consolidates the accessible title chip into a single
  // XCUITest element without exposing the child prompt/task-id text nodes, so
  // assert the expanded identity through the chip's accessibility label
  // ("<stage>: <prompt>. Task ID: <id>"). The suffix check also proves the
  // synthetic canonical cloud id is not the displayed identity — a canonical
  // display would end with "Task ID: cloud:…". The loop taps the chip whenever
  // it observes it collapsed, which also recovers the expansion that TaskScreen
  // intentionally resets if the rendered task id changes mid-flight.
  const expandedIdentitySuffix =
    `. Task ID: ${options.fixture.cloudOnly.localTaskId}`;
  let lastTitleChipLabel: string | null = null;
  try {
    await driver.waitUntil(
      async () => {
        const titleButton = await driver.$(selectors.taskTitleButton);
        if (!(await titleButton.isExisting())) {
          lastTitleChipLabel = null;
          // The detail popped back to the list; reopen the cloud-only task.
          const row = await driver.$(
            `~mobile.task-row.${options.fixture.cloudOnly.taskId}`
          );
          if (await row.isExisting()) {
            await row.click();
          }
          return false;
        }
        const label =
          (await titleButton.getAttribute("label").catch(() => null)) ?? "";
        lastTitleChipLabel = label;
        if (!label.includes(". Task ID: ")) {
          await titleButton.click();
          return false;
        }
        return label.endsWith(expandedIdentitySuffix);
      },
      {
        interval: POLL_INTERVAL_MS,
        timeout: SCREEN_TIMEOUT_MS,
        timeoutMsg:
          "Expected the expanded cloud task identity to show the desktop-local id " +
          `${JSON.stringify(options.fixture.cloudOnly.localTaskId)} instead of the ` +
          `canonical ${JSON.stringify(options.fixture.cloudOnly.taskId)}`
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; last observed title chip label ` +
      JSON.stringify(lastTitleChipLabel)
    );
  }
  const cloudOnlyBackButton = await driver.$(selectors.taskBackButton);
  await cloudOnlyBackButton.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await cloudOnlyBackButton.click();
  const recentAfterCloudDetail = await driver.$(selectors.recentTab);
  await recentAfterCloudDetail.waitForDisplayed({ timeout: SCREEN_TIMEOUT_MS });
  await recentAfterCloudDetail.click();
  await waitForStableExactTaskRows(
    driver,
    options.fixture.expectedDisplayTaskIds
  );

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
    getAgentMessageReady: async () =>
      await driver.$(selectors.agentMessageReady),
    getTaskDetailScreen: async () =>
      await driver.$(selectors.taskDetailScreen),
    getTerminalOverlay: async () =>
      await driver.$(selectors.terminalOverlay),
    waitUntil: (condition, waitOptions) =>
      driver.waitUntil(condition, waitOptions)
  });
}

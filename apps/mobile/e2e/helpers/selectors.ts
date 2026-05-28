import { MOBILE_E2E_IDS } from "../../src/e2eTestIds";

export const selectors = {
  appShell: `~${MOBILE_E2E_IDS.appShell}`,
  tasksScreen: `~${MOBILE_E2E_IDS.tasksScreen}`,
  taskDetailScreen: `~${MOBILE_E2E_IDS.taskDetailScreen}`,
  taskBackButton: `~${MOBILE_E2E_IDS.taskBackButton}`,
  terminalOverlay: `~${MOBILE_E2E_IDS.terminalOverlay}`,
  accountButton: `~${MOBILE_E2E_IDS.accountButton}`,
  accountSheet: `~${MOBILE_E2E_IDS.accountSheet}`,
  accountConnectionStatus: `~${MOBILE_E2E_IDS.accountConnectionStatus}`,
  accountConnectionTitle: `~${MOBILE_E2E_IDS.accountConnectionTitle}`,
  accountConnectLocalButton: `~${MOBILE_E2E_IDS.accountConnectLocalButton}`,
  accountEmailInput: `~${MOBILE_E2E_IDS.accountEmailInput}`,
  accountPasswordInput: `~${MOBILE_E2E_IDS.accountPasswordInput}`,
  accountSignInButton: `~${MOBILE_E2E_IDS.accountSignInButton}`,
  taskRowsXPath: '//*[starts-with(@name, "mobile.task-row.")]'
} as const;

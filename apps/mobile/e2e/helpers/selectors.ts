import { MOBILE_E2E_IDS } from "../../src/e2eTestIds";

export const selectors = {
  appShell: `~${MOBILE_E2E_IDS.appShell}`,
  tasksScreen: `~${MOBILE_E2E_IDS.tasksScreen}`,
  recentScreen: `~${MOBILE_E2E_IDS.recentScreen}`,
  searchScreen: `~${MOBILE_E2E_IDS.searchScreen}`,
  toolbarNavigation: `~${MOBILE_E2E_IDS.toolbarNavigation}`,
  toolbarSearch: `~${MOBILE_E2E_IDS.toolbarSearch}`,
  taskDetailScreen: `~${MOBILE_E2E_IDS.taskDetailScreen}`,
  taskDetailTitle: `~${MOBILE_E2E_IDS.taskDetailTitle}`,
  taskTitleButton: `~${MOBILE_E2E_IDS.taskTitleButton}`,
  taskExpandedPrompt: `~${MOBILE_E2E_IDS.taskExpandedPrompt}`,
  taskExpandedTaskId: `~${MOBILE_E2E_IDS.taskExpandedTaskId}`,
  taskTitleDismissLayer: `~${MOBILE_E2E_IDS.taskTitleDismissLayer}`,
  taskSnapshotMarker: `~${MOBILE_E2E_IDS.taskSnapshotMarker}`,
  taskBackButton: `~${MOBILE_E2E_IDS.taskBackButton}`,
  taskInput: `~${MOBILE_E2E_IDS.taskInput}`,
  taskSendButton: `~${MOBILE_E2E_IDS.taskSendButton}`,
  agentMessageView: `~${MOBILE_E2E_IDS.agentMessageView}`,
  agentMessageReady: `~${MOBILE_E2E_IDS.agentMessageReady}`,
  terminalOverlay: `~${MOBILE_E2E_IDS.terminalOverlay}`,
  terminalInspection: `~${MOBILE_E2E_IDS.terminalInspection}`,
  taskFilePreviewPath: `~${MOBILE_E2E_IDS.taskFilePreviewPath}`,
  taskFilePreviewMode: `~${MOBILE_E2E_IDS.taskFilePreviewMode}`,
  taskFilePreviewClose: `~${MOBILE_E2E_IDS.taskFilePreviewClose}`,
  taskFilePreviewError: `~${MOBILE_E2E_IDS.taskFilePreviewError}`,
  taskFilePreviewErrorMessage: `~${MOBILE_E2E_IDS.taskFilePreviewErrorMessage}`,
  taskFilePreviewInspection: `~${MOBILE_E2E_IDS.taskFilePreviewInspection}`,
  accountButton: `~${MOBILE_E2E_IDS.accountButton}`,
  accountSheet: `~${MOBILE_E2E_IDS.accountSheet}`,
  accountCloseButton: `~${MOBILE_E2E_IDS.accountCloseButton}`,
  accountConnectionStatus: `~${MOBILE_E2E_IDS.accountConnectionStatus}`,
  accountConnectionTitle: `~${MOBILE_E2E_IDS.accountConnectionTitle}`,
  accountConnectLocalButton: `~${MOBILE_E2E_IDS.accountConnectLocalButton}`,
  accountEmailInput: `~${MOBILE_E2E_IDS.accountEmailInput}`,
  accountPasswordInput: `~${MOBILE_E2E_IDS.accountPasswordInput}`,
  accountPasswordToggle: `~${MOBILE_E2E_IDS.accountPasswordToggle}`,
  accountSignInButton: `~${MOBILE_E2E_IDS.accountSignInButton}`,
  accountSignOutButton: `~${MOBILE_E2E_IDS.accountSignOutButton}`,
  moreScreen: `~${MOBILE_E2E_IDS.moreScreen}`,
  taskCreationRecoverButton:
    `~${MOBILE_E2E_IDS.taskCreationRecoverButton}`,
  addTaskButton: `~${MOBILE_E2E_IDS.toolbarUtilityAction("create")}`,
  createTaskCancelButton: `~${MOBILE_E2E_IDS.createTaskCancelButton}`,
  createTaskPromptInput: `~${MOBILE_E2E_IDS.createTaskPromptInput}`,
  createTaskCommand: `~${MOBILE_E2E_IDS.moreCommand("compose")}`,
  tasksTab: `~${MOBILE_E2E_IDS.toolbarTab("tasks")}`,
  recentTab: `~${MOBILE_E2E_IDS.toolbarTab("recent")}`,
  moreTab: `~${MOBILE_E2E_IDS.toolbarTab("more")}`,
  legacyUpdateInfoOtaValue: "~mobile.update-info.ota",
  taskRowsXPath: '//*[starts-with(@name, "mobile.task-row.")]'
} as const;

const TASK_ROW_PREFIX = "mobile.task-row.";

export function extractTaskRowId(
  accessibilityName: string | null
): string | null {
  if (!accessibilityName?.startsWith(TASK_ROW_PREFIX)) {
    return null;
  }
  const taskId = accessibilityName.slice(TASK_ROW_PREFIX.length);
  return taskId || null;
}

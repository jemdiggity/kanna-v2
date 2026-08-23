import { MOBILE_E2E_IDS } from "../../src/e2eTestIds";

export const selectors = {
  appShell: `~${MOBILE_E2E_IDS.appShell}`,
  tasksScreen: `~${MOBILE_E2E_IDS.tasksScreen}`,
  recentScreen: `~${MOBILE_E2E_IDS.recentScreen}`,
  searchScreen: `~${MOBILE_E2E_IDS.searchScreen}`,
  searchInput: `~${MOBILE_E2E_IDS.searchInput}`,
  searchKeyboardDismissTarget:
    `~${MOBILE_E2E_IDS.searchKeyboardDismissTarget}`,
  searchToolbarButton: `~${MOBILE_E2E_IDS.toolbarSearch}`,
  toolbarNavigation: `~${MOBILE_E2E_IDS.toolbarNavigation}`,
  toolbarSearch: `~${MOBILE_E2E_IDS.toolbarSearch}`,
  taskDetailScreen: `~${MOBILE_E2E_IDS.taskDetailScreen}`,
  taskDetailTitle: `~${MOBILE_E2E_IDS.taskDetailTitle}`,
  taskDetailTaskId: `~${MOBILE_E2E_IDS.taskDetailTaskId}`,
  taskTitleButton: `~${MOBILE_E2E_IDS.taskTitleButton}`,
  taskExpandedPrompt: `~${MOBILE_E2E_IDS.taskExpandedPrompt}`,
  taskExpandedTaskId: `~${MOBILE_E2E_IDS.taskExpandedTaskId}`,
  taskTitleDismissLayer: `~${MOBILE_E2E_IDS.taskTitleDismissLayer}`,
  taskSnapshotMarker: `~${MOBILE_E2E_IDS.taskSnapshotMarker}`,
  taskBackButton: `~${MOBILE_E2E_IDS.taskBackButton}`,
  taskMoreButton: `~${MOBILE_E2E_IDS.taskMoreButton}`,
  taskInput: `~${MOBILE_E2E_IDS.taskInput}`,
  taskSendButton: `~${MOBILE_E2E_IDS.taskSendButton}`,
  agentMessageView: `~${MOBILE_E2E_IDS.agentMessageView}`,
  agentMessageReady: `~${MOBILE_E2E_IDS.agentMessageReady}`,
  terminalOverlay: `~${MOBILE_E2E_IDS.terminalOverlay}`,
  terminalInspection: `~${MOBILE_E2E_IDS.terminalInspection}`,
  visualCompanionButton: `~${MOBILE_E2E_IDS.visualCompanionButton}`,
  visualCompanionClose: `~${MOBILE_E2E_IDS.visualCompanionClose}`,
  visualCompanionModal: `~${MOBILE_E2E_IDS.visualCompanionModal}`,
  visualCompanionStatus: `~${MOBILE_E2E_IDS.visualCompanionStatus}`,
  visualCompanionWebView: `~${MOBILE_E2E_IDS.visualCompanionWebView}`,
  taskFilePreviewPath: `~${MOBILE_E2E_IDS.taskFilePreviewPath}`,
  taskFilePreviewMode: `~${MOBILE_E2E_IDS.taskFilePreviewMode}`,
  taskFilePreviewClose: `~${MOBILE_E2E_IDS.taskFilePreviewClose}`,
  taskFilePreviewError: `~${MOBILE_E2E_IDS.taskFilePreviewError}`,
  taskFilePreviewErrorMessage: `~${MOBILE_E2E_IDS.taskFilePreviewErrorMessage}`,
  taskFilePreviewInspection: `~${MOBILE_E2E_IDS.taskFilePreviewInspection}`,
  taskMentionedFilesModal: `~${MOBILE_E2E_IDS.taskMentionedFilesModal}`,
  taskMentionedFilesClose: `~${MOBILE_E2E_IDS.taskMentionedFilesClose}`,
  taskMentionedFilesError: `~${MOBILE_E2E_IDS.taskMentionedFilesError}`,
  taskMentionedFilesRetry: `~${MOBILE_E2E_IDS.taskMentionedFilesRetry}`,
  accountButton: `~${MOBILE_E2E_IDS.accountButton}`,
  accountSheet: `~${MOBILE_E2E_IDS.accountSheet}`,
  accountCloseButton: `~${MOBILE_E2E_IDS.accountCloseButton}`,
  accountMachinesButton: `~${MOBILE_E2E_IDS.accountMachinesButton}`,
  accountQuickRepliesButton: `~${MOBILE_E2E_IDS.accountQuickRepliesButton}`,
  quickReplyEditor: `~${MOBILE_E2E_IDS.quickReplyEditor}`,
  quickReplyEditorDone: `~${MOBILE_E2E_IDS.quickReplyEditorDone}`,
  quickReplyEditorCancel: `~${MOBILE_E2E_IDS.quickReplyEditorCancel}`,
  quickReplyEditorInputsXPath:
    '//*[starts-with(@name, "mobile.quick-replies.") and contains(@name, ".input")]',
  machinesScreen: `~${MOBILE_E2E_IDS.machinesScreen}`,
  machinesBackButton: `~${MOBILE_E2E_IDS.machinesBackButton}`,
  machinesAddButton: `~${MOBILE_E2E_IDS.machinesAddButton}`,
  machinePairingSheet: `~${MOBILE_E2E_IDS.machinePairingSheet}`,
  machinePairingCodeInput: `~${MOBILE_E2E_IDS.machinePairingCodeInput}`,
  machinePairingSubmit: `~${MOBILE_E2E_IDS.machinePairingSubmitButton}`,
  machinePairingProgress: `~${MOBILE_E2E_IDS.machinePairingProgress}`,
  machinePairingError: `~${MOBILE_E2E_IDS.machinePairingError}`,
  machinePairingClose: `~${MOBILE_E2E_IDS.machinePairingCloseButton}`,
  machinePairingCamera: `~${MOBILE_E2E_IDS.machinePairingCamera}`,
  machinePairingScanMode: `~${MOBILE_E2E_IDS.machinePairingScanModeButton}`,
  machinePairingOpenSettings:
    `~${MOBILE_E2E_IDS.machinePairingOpenSettingsButton}`,
  accountEmailInput: `~${MOBILE_E2E_IDS.accountEmailInput}`,
  accountPasswordInput: `~${MOBILE_E2E_IDS.accountPasswordInput}`,
  accountPasswordToggle: `~${MOBILE_E2E_IDS.accountPasswordToggle}`,
  accountSignInButton: `~${MOBILE_E2E_IDS.accountSignInButton}`,
  accountCreateButton: `~${MOBILE_E2E_IDS.accountCreateButton}`,
  accountSubscribeLink: `~${MOBILE_E2E_IDS.accountSubscribeLink}`,
  accountSignOutButton: `~${MOBILE_E2E_IDS.accountSignOutButton}`,
  moreScreen: `~${MOBILE_E2E_IDS.moreScreen}`,
  moreHeading: `~${MOBILE_E2E_IDS.moreHeading}`,
  moreSearchInput: `~${MOBILE_E2E_IDS.moreSearchInput}`,
  buildInfoToggle: `~${MOBILE_E2E_IDS.buildInfoToggle}`,
  buildInfoDetails: `~${MOBILE_E2E_IDS.buildInfoDetails}`,
  buildInfoNative: `~${MOBILE_E2E_IDS.buildInfoNative}`,
  buildInfoRuntime: `~${MOBILE_E2E_IDS.buildInfoRuntime}`,
  buildInfoEnvironment: `~${MOBILE_E2E_IDS.buildInfoEnvironment}`,
  buildInfoChannel: `~${MOBILE_E2E_IDS.buildInfoChannel}`,
  buildInfoRunningSource: `~${MOBILE_E2E_IDS.buildInfoRunningSource}`,
  buildInfoUpdateId: `~${MOBILE_E2E_IDS.buildInfoUpdateId}`,
  buildInfoCopyHint: `~${MOBILE_E2E_IDS.buildInfoCopyHint}`,
  taskCreationRecoverButton:
    `~${MOBILE_E2E_IDS.taskCreationRecoverButton}`,
  addTaskButton: `~${MOBILE_E2E_IDS.toolbarUtilityAction("create")}`,
  createTaskCancelButton: `~${MOBILE_E2E_IDS.createTaskCancelButton}`,
  createTaskPromptInput: `~${MOBILE_E2E_IDS.createTaskPromptInput}`,
  moreRepoOptionsXPath: '//*[starts-with(@name, "mobile.more.repo.")]',
  moreCommand(commandId: string): string {
    return `~${MOBILE_E2E_IDS.moreCommand(commandId)}`;
  },
  moreCommandGroup(group: string): string {
    return `~${MOBILE_E2E_IDS.moreCommandGroup(group)}`;
  },
  tasksTab: `~${MOBILE_E2E_IDS.toolbarTab("tasks")}`,
  recentTab: `~${MOBILE_E2E_IDS.toolbarTab("recent")}`,
  moreTab: `~${MOBILE_E2E_IDS.toolbarTab("more")}`,
  developerForceCloudToggle: `~${MOBILE_E2E_IDS.developerForceCloudToggle}`,
  taskRowsXPath: '//*[starts-with(@name, "mobile.task-row.")]',
  taskQuickReply(replyId: string): string {
    return `~${MOBILE_E2E_IDS.taskQuickReply(replyId)}`;
  }
} as const;

export function taskMentionedFilesRowSelector(path: string): string {
  return `~${MOBILE_E2E_IDS.taskMentionedFilesRow(path)}`;
}

export function tasksRepoSelector(repoId: string): string {
  return `~${MOBILE_E2E_IDS.tasksRepo(repoId)}`;
}

export function machineRowSelector(desktopId: string): string {
  return `~${MOBILE_E2E_IDS.machineRow(desktopId)}`;
}

export function machineNameSelector(desktopId: string): string {
  return `~${MOBILE_E2E_IDS.machineName(desktopId)}`;
}

export function machineRowsXPath(desktopId: string): string {
  return `//*[@name="${MOBILE_E2E_IDS.machineName(desktopId)}"]`;
}

export function machineOriginSelector(
  desktopId: string,
  origin: "account" | "manual"
): string {
  return `~${MOBILE_E2E_IDS.machineOrigin(desktopId, origin)}`;
}

export function machineRemoveButtonSelector(desktopId: string): string {
  return `~${MOBILE_E2E_IDS.machineRemoveButton(desktopId)}`;
}

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

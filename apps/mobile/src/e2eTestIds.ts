export const MOBILE_E2E_IDS = {
  appShell: "mobile.app-shell",
  tasksScreen: "mobile.tasks-screen",
  taskDetailScreen: "mobile.task-detail-screen",
  taskDetailTitle: "mobile.task-detail-title",
  taskSnapshotMarker: "mobile.task-snapshot-marker",
  taskBackButton: "mobile.task-back-button",
  taskMoreButton: "mobile.task-more-button",
  taskInput: "mobile.task-input",
  taskSendButton: "mobile.task-send-button",
  taskStopButton: "mobile.task-stop-button",
  agentMessageView: "mobile.agent-message-view",
  agentMessageReady: "mobile.agent-message-ready",
  terminalOverlay: "mobile.terminal-overlay",
  terminalInspection: "mobile.terminal-inspection",
  accountButton: "mobile.account-button",
  accountSheet: "mobile.account-sheet",
  accountCloseButton: "mobile.account-close",
  accountConnectionStatus: "mobile.account-connection-status",
  accountConnectionTitle: "mobile.account-connection-title",
  accountConnectLocalButton: "mobile.account-connect-local",
  accountForceCloudToggle: "mobile.account-force-cloud",
  accountEmailInput: "mobile.account-email",
  accountPasswordInput: "mobile.account-password",
  accountPasswordToggle: "mobile.account-toggle-password",
  accountSignInButton: "mobile.account-sign-in",
  accountSignOutButton: "mobile.account-sign-out",
  createTaskPromptInput: "mobile.create-task.prompt",
  createTaskProvisioning: "mobile.create-task.provisioning",
  createTaskProvisioningBackground: "mobile.create-task.provisioning.background",
  createTaskProvisioningRecover: "mobile.create-task.provisioning.recover",
  createTaskSubmitButton: "mobile.create-task.submit",
  createTaskError: "mobile.create-task.error",
  createTaskOptionsToggle: "mobile.create-task.options-toggle",
  createTaskMachineOption(desktopId: string): string {
    return `mobile.create-task.machine.${desktopId}`;
  },
  createTaskAgentOption(provider: string): string {
    return `mobile.create-task.agent.${provider}`;
  },
  updateInfoOtaValue: "mobile.update-info.ota",
  updateReadyBanner: "mobile.update-ready",
  updateReadyDismissButton: "mobile.update-ready.dismiss",
  updateReadyRestartButton: "mobile.update-ready.restart",
  toolbarTab(tabName: string): string {
    return `mobile.toolbar.tab.${tabName}`;
  },
  taskListItem(taskId: string): string {
    return `mobile.task-row.${taskId}`;
  }
} as const;

export const MOBILE_E2E_IDS = {
  appShell: "mobile.app-shell",
  moreScreen: "mobile.more-screen",
  tasksScreen: "mobile.tasks-screen",
  recentScreen: "mobile.recent-screen",
  searchScreen: "mobile.search-screen",
  searchInput: "mobile.search-input",
  searchKeyboardDismissTarget: "mobile.search-keyboard-dismiss-target",
  toolbarNavigation: "mobile.toolbar.navigation",
  toolbarSearch: "mobile.toolbar.search",
  taskDetailScreen: "mobile.task-detail-screen",
  taskDetailTitle: "mobile.task-detail-title",
  taskTitleButton: "mobile.task-title-button",
  taskExpandedPrompt: "mobile.task-expanded-prompt",
  taskExpandedTaskId: "mobile.task-expanded-task-id",
  taskTitleDismissLayer: "mobile.task-title-dismiss-layer",
  taskSnapshotMarker: "mobile.task-snapshot-marker",
  taskBackButton: "mobile.task-back-button",
  taskMoreButton: "mobile.task-more-button",
  taskComposerChrome: "mobile.task-composer-chrome",
  taskInput: "mobile.task-input",
  taskSendButton: "mobile.task-send-button",
  taskStopButton: "mobile.task-stop-button",
  agentMessageView: "mobile.agent-message-view",
  agentMessageReady: "mobile.agent-message-ready",
  terminalOverlay: "mobile.terminal-overlay",
  taskCreationRecoverButton: "mobile.task-creation.recover",
  terminalInspection: "mobile.terminal-inspection",
  visualCompanionButton: "mobile.visual-companion.button",
  visualCompanionUnread: "mobile.visual-companion.unread",
  visualCompanionModal: "mobile.visual-companion.modal",
  visualCompanionClose: "mobile.visual-companion.close",
  visualCompanionStatus: "mobile.visual-companion.status",
  visualCompanionWebView: "mobile.visual-companion.webview",
  taskFilePreviewPath: "mobile.task-file-preview.path",
  taskFilePreviewMode: "mobile.task-file-preview.mode",
  taskFilePreviewClose: "mobile.task-file-preview.close",
  taskFilePreviewError: "mobile.task-file-preview.error",
  taskFilePreviewErrorMessage: "mobile.task-file-preview.error-message",
  taskFilePreviewInspection: "mobile.task-file-preview.inspection",
  accountButton: "mobile.account-button",
  accountSheet: "mobile.account-sheet",
  accountCloseButton: "mobile.account-close",
  accountMachinesButton: "mobile.account-machines",
  accountEmailInput: "mobile.account-email",
  accountPasswordInput: "mobile.account-password",
  accountPasswordToggle: "mobile.account-toggle-password",
  accountSignInButton: "mobile.account-sign-in",
  accountSignOutButton: "mobile.account-sign-out",
  machinesScreen: "mobile.machines-screen",
  machinesBackButton: "mobile.machines-back",
  machinesAddButton: "mobile.machines-add",
  machinePairingSheet: "mobile.machine-pairing.sheet",
  machinePairingCamera: "mobile.machine-pairing.camera",
  machinePairingScanModeButton: "mobile.machine-pairing.mode.scan",
  machinePairingCodeInput: "mobile.machine-pairing.code",
  machinePairingSubmitButton: "mobile.machine-pairing.submit",
  machinePairingError: "mobile.machine-pairing.error",
  machinePairingCloseButton: "mobile.machine-pairing.close",
  machinePairingOpenSettingsButton: "mobile.machine-pairing.open-settings",
  developerForceCloudToggle: "mobile.developer.force-cloud",
  machineRow(desktopId: string): string {
    return `mobile.machine.${desktopId}`;
  },
  machineName(desktopId: string): string {
    return `mobile.machine.${desktopId}.name`;
  },
  machineOrigin(desktopId: string, origin: "account" | "manual"): string {
    return `mobile.machine.${desktopId}.origin.${origin}`;
  },
  machineRemoveButton(desktopId: string): string {
    return `mobile.machine.${desktopId}.remove`;
  },
  createTaskPromptInput: "mobile.create-task.prompt",
  createTaskCancelButton: "mobile.create-task.cancel",
  createTaskSubmitButton: "mobile.create-task.submit",
  createTaskError: "mobile.create-task.error",
  createTaskOptionsToggle: "mobile.create-task.options-toggle",
  createTaskMachineOption(desktopId: string): string {
    return `mobile.create-task.machine.${desktopId}`;
  },
  createTaskAgentOption(provider: string): string {
    return `mobile.create-task.agent.${provider}`;
  },
  updateReadyBanner: "mobile.update-ready",
  updateReadyDismissButton: "mobile.update-ready.dismiss",
  updateReadyRestartButton: "mobile.update-ready.restart",
  toolbarTab(tabName: string): string {
    return `mobile.toolbar.tab.${tabName}`;
  },
  toolbarUtilityAction(actionName: string): string {
    return `mobile.toolbar.utility.${actionName}`;
  },
  moreCommand(actionId: string): string {
    return `mobile.more.command.${actionId}`;
  },
  moreRepo(repoId: string): string {
    return `mobile.more.repo.${repoId}`;
  },
  moreCommandGroup(group: string): string {
    return `mobile.more.command-group.${group}`;
  },
  taskListItem(taskId: string): string {
    return `mobile.task-row.${taskId}`;
  }
} as const;

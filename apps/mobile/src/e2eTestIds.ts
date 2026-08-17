export const MOBILE_E2E_IDS = {
  appShell: "mobile.app-shell",
  appStartupLoading: "mobile.app-startup-loading",
  moreScreen: "mobile.more-screen",
  moreHeading: "mobile.more-heading",
  moreSearchInput: "mobile.more-search-input",
  moreRetryButton: "mobile.more-retry-button",
  tasksScreen: "mobile.tasks-screen",
  tasksPairMacButton: "mobile.tasks-pair-mac",
  tasksRepo(repoId: string): string {
    return `mobile.tasks.repo.${repoId}`;
  },
  recentScreen: "mobile.recent-screen",
  activityBadge: "mobile.activity-badge",
  activityDismissAction(taskId: string): string {
    return `mobile.activity-dismiss-action.${taskId}`;
  },
  activityDismissButton(taskId: string): string {
    return `mobile.activity-dismiss-button.${taskId}`;
  },
  activityDismissError(taskId: string): string {
    return `mobile.activity-dismiss-error.${taskId}`;
  },
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
  taskTopChrome: "mobile.task-top-chrome",
  taskMoreButton: "mobile.task-more-button",
  taskActionPendingSpinner: "mobile.task-action-pending",
  taskComposerChrome: "mobile.task-composer-chrome",
  taskInput: "mobile.task-input",
  taskSendButton: "mobile.task-send-button",
  taskQuickReplyRail: "mobile.quick-reply.rail",
  taskQuickReplyPicker: "mobile.quick-reply.picker",
  taskQuickReplyPickerCancel: "mobile.quick-reply.picker.cancel",
  taskStopButton: "mobile.task-stop-button",
  agentMessageView: "mobile.agent-message-view",
  agentMessageReady: "mobile.agent-message-ready",
  terminalOverlay: "mobile.terminal-overlay",
  taskCreationRecoverButton: "mobile.task-creation.recover",
  taskPinAction(taskId: string): string {
    return `mobile.task-pin-action.${taskId}`;
  },
  taskPinButton(taskId: string): string {
    return `mobile.task-pin-button.${taskId}`;
  },
  taskPinError(taskId: string): string {
    return `mobile.task-pin-error.${taskId}`;
  },
  taskBlockedPlaceholder: "mobile.task-blocked-placeholder",
  terminalInspection: "mobile.terminal-inspection",
  visualCompanionButton: "mobile.visual-companion.button",
  visualCompanionUnread: "mobile.visual-companion.unread",
  visualCompanionModal: "mobile.visual-companion.modal",
  visualCompanionClose: "mobile.visual-companion.close",
  visualCompanionStatus: "mobile.visual-companion.status",
  visualCompanionWebView: "mobile.visual-companion.webview",
  taskDiffTitle: "mobile.task-diff.title",
  taskDiffScopeOption(scope: string): string {
    return `mobile.task-diff.scope.${scope}`;
  },
  taskDiffModeOption(mode: string): string {
    return `mobile.task-diff.mode.${mode}`;
  },
  taskDiffBase: "mobile.task-diff.base",
  taskDiffClose: "mobile.task-diff.close",
  taskDiffError: "mobile.task-diff.error",
  taskDiffErrorMessage: "mobile.task-diff.error-message",
  taskDiffInspection: "mobile.task-diff.inspection",
  taskFilePreviewPath: "mobile.task-file-preview.path",
  taskFilePreviewMode: "mobile.task-file-preview.mode",
  taskFilePreviewClose: "mobile.task-file-preview.close",
  taskFilePreviewError: "mobile.task-file-preview.error",
  taskFilePreviewErrorMessage: "mobile.task-file-preview.error-message",
  taskFilePreviewInspection: "mobile.task-file-preview.inspection",
  taskMentionedFilesModal: "mobile.task-mentioned-files.modal",
  taskMentionedFilesClose: "mobile.task-mentioned-files.close",
  taskMentionedFilesError: "mobile.task-mentioned-files.error",
  taskMentionedFilesRetry: "mobile.task-mentioned-files.retry",
  taskMentionedFilesRow(path: string): string {
    return `mobile.task-mentioned-files.row.${path}`;
  },
  accountButton: "mobile.account-button",
  accountSheet: "mobile.account-sheet",
  accountCloseButton: "mobile.account-close",
  accountMachinesButton: "mobile.account-machines",
  accountQuickRepliesButton: "mobile.account-quick-replies",
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
  createTaskSheetScroll: "mobile.create-task.sheet-scroll",
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
  quickReplyEditor: "mobile.quick-replies.editor",
  quickReplyEditorAdd: "mobile.quick-replies.add",
  quickReplyEditorDone: "mobile.quick-replies.done",
  quickReplyEditorCancel: "mobile.quick-replies.cancel",
  quickReplyEditorSaveError: "mobile.quick-replies.save-error",
  quickReplyLoadNotice: "mobile.quick-replies.load-notice",
  buildInfoToggle: "mobile.build-info.toggle",
  buildInfoDetails: "mobile.build-info.details",
  buildInfoNative: "mobile.build-info.native",
  buildInfoRuntime: "mobile.build-info.runtime",
  buildInfoEnvironment: "mobile.build-info.environment",
  buildInfoChannel: "mobile.build-info.channel",
  buildInfoRunningSource: "mobile.build-info.running-source",
  buildInfoUpdateId: "mobile.build-info.update-id",
  buildInfoCopyHint: "mobile.build-info.copy-hint",
  crashDiagnostics: "mobile.crash-diagnostics",
  crashDiagnosticsCopy: "mobile.crash-diagnostics.copy",
  crashDiagnosticsClear: "mobile.crash-diagnostics.clear",
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
  },
  taskListSubtaskRow(taskId: string): string {
    return `mobile.task-row.${taskId}.subtask`;
  },
  taskQuickReply(replyId: string): string {
    return `mobile.quick-reply.${replyId}`;
  },
  quickReplyEditorInput(replyId: string): string {
    return `mobile.quick-replies.${replyId}.input`;
  },
  quickReplyEditorMoveUp(replyId: string): string {
    return `mobile.quick-replies.${replyId}.up`;
  },
  quickReplyEditorMoveDown(replyId: string): string {
    return `mobile.quick-replies.${replyId}.down`;
  },
  quickReplyEditorDelete(replyId: string): string {
    return `mobile.quick-replies.${replyId}.delete`;
  },
  quickReplyEditorError(replyId: string): string {
    return `mobile.quick-replies.${replyId}.error`;
  }
} as const;

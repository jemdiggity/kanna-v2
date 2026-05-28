export const MOBILE_E2E_IDS = {
  appShell: "mobile.app-shell",
  tasksScreen: "mobile.tasks-screen",
  taskDetailScreen: "mobile.task-detail-screen",
  taskBackButton: "mobile.task-back-button",
  taskMoreButton: "mobile.task-more-button",
  taskInput: "mobile.task-input",
  taskSendButton: "mobile.task-send-button",
  terminalOverlay: "mobile.terminal-overlay",
  accountButton: "mobile.account-button",
  accountSheet: "mobile.account-sheet",
  accountCloseButton: "mobile.account-close",
  accountConnectionStatus: "mobile.account-connection-status",
  accountConnectionTitle: "mobile.account-connection-title",
  accountConnectLocalButton: "mobile.account-connect-local",
  accountEmailInput: "mobile.account-email",
  accountPasswordInput: "mobile.account-password",
  accountSignInButton: "mobile.account-sign-in",
  accountSignOutButton: "mobile.account-sign-out",
  taskListItem(taskId: string): string {
    return `mobile.task-row.${taskId}`;
  }
} as const;

import { describe, expect, it } from "vitest";
import { MOBILE_E2E_IDS } from "./e2eTestIds";

describe("MOBILE_E2E_IDS", () => {
  it("keeps the smoke-test selectors stable", () => {
    expect(MOBILE_E2E_IDS.appShell).toBe("mobile.app-shell");
    expect(MOBILE_E2E_IDS.tasksScreen).toBe("mobile.tasks-screen");
    expect(MOBILE_E2E_IDS.recentScreen).toBe("mobile.recent-screen");
    expect(MOBILE_E2E_IDS.searchScreen).toBe("mobile.search-screen");
    expect(MOBILE_E2E_IDS.moreScreen).toBe("mobile.more-screen");
    expect(MOBILE_E2E_IDS.toolbarNavigation).toBe("mobile.toolbar.navigation");
    expect(MOBILE_E2E_IDS.toolbarSearch).toBe("mobile.toolbar.search");
    expect(MOBILE_E2E_IDS.taskDetailScreen).toBe("mobile.task-detail-screen");
    expect(MOBILE_E2E_IDS.taskDetailTitle).toBe("mobile.task-detail-title");
    expect(MOBILE_E2E_IDS.taskTitleButton).toBe("mobile.task-title-button");
    expect(MOBILE_E2E_IDS.taskExpandedPrompt).toBe(
      "mobile.task-expanded-prompt"
    );
    expect(MOBILE_E2E_IDS.taskTitleDismissLayer).toBe(
      "mobile.task-title-dismiss-layer"
    );
    expect(MOBILE_E2E_IDS.taskBackButton).toBe("mobile.task-back-button");
    expect(MOBILE_E2E_IDS.accountButton).toBe("mobile.account-button");
    expect(MOBILE_E2E_IDS.accountSheet).toBe("mobile.account-sheet");
    expect(MOBILE_E2E_IDS.accountCloseButton).toBe("mobile.account-close");
    expect(MOBILE_E2E_IDS.accountConnectionStatus).toBe(
      "mobile.account-connection-status"
    );
    expect(MOBILE_E2E_IDS.accountConnectionTitle).toBe(
      "mobile.account-connection-title"
    );
    expect(MOBILE_E2E_IDS.accountConnectLocalButton).toBe(
      "mobile.account-connect-local"
    );
    expect(MOBILE_E2E_IDS.accountEmailInput).toBe("mobile.account-email");
    expect(MOBILE_E2E_IDS.accountPasswordInput).toBe("mobile.account-password");
    expect(MOBILE_E2E_IDS.accountPasswordToggle).toBe(
      "mobile.account-toggle-password"
    );
    expect(MOBILE_E2E_IDS.accountSignInButton).toBe("mobile.account-sign-in");
    expect(MOBILE_E2E_IDS.accountSignOutButton).toBe("mobile.account-sign-out");
    expect(MOBILE_E2E_IDS.taskCreationRecoverButton).toBe(
      "mobile.task-creation.recover"
    );
    expect(MOBILE_E2E_IDS.createTaskCancelButton).toBe(
      "mobile.create-task.cancel"
    );
    expect(MOBILE_E2E_IDS.toolbarUtilityAction("create")).toBe(
      "mobile.toolbar.utility.create"
    );
    expect(MOBILE_E2E_IDS.moreCommand("compose")).toBe(
      "mobile.more.command.compose"
    );
  });
});

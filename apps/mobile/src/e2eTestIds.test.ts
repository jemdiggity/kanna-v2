import { describe, expect, it } from "vitest";
import { MOBILE_E2E_IDS } from "./e2eTestIds";

describe("MOBILE_E2E_IDS", () => {
  it("keeps the smoke-test selectors stable", () => {
    expect(MOBILE_E2E_IDS.appShell).toBe("mobile.app-shell");
    expect(MOBILE_E2E_IDS.tasksScreen).toBe("mobile.tasks-screen");
    expect(MOBILE_E2E_IDS.taskDetailScreen).toBe("mobile.task-detail-screen");
    expect(MOBILE_E2E_IDS.taskDetailTitle).toBe("mobile.task-detail-title");
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
    expect(MOBILE_E2E_IDS.createTaskProvisioning).toBe(
      "mobile.create-task.provisioning"
    );
  });
});

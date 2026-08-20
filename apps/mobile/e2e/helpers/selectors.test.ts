import { describe, expect, it } from "vitest";
import * as selectorHelpers from "./selectors";

describe("mobile E2E selector helpers", () => {
  it("exposes the native Search journey controls", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      searchInput: "~mobile.search-input",
      searchKeyboardDismissTarget: "~mobile.search-keyboard-dismiss-target",
      searchScreen: "~mobile.search-screen",
      searchToolbarButton: "~mobile.toolbar.search"
    });
  });

  it("exposes repository command controls through stable Appium selectors", () => {
    expect(selectorHelpers.selectors.moreRepoOptionsXPath).toBe(
      '//*[starts-with(@name, "mobile.more.repo.")]'
    );
    expect(selectorHelpers.selectors.moreCommandGroup("configure")).toBe(
      "~mobile.more.command-group.configure"
    );
    expect(selectorHelpers.selectors.moreCommand("factory:create-agent")).toBe(
      "~mobile.more.command.factory:create-agent"
    );
  });

  it("exposes the expandable build identity journey", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      buildInfoToggle: "~mobile.build-info.toggle",
      buildInfoDetails: "~mobile.build-info.details",
      buildInfoNative: "~mobile.build-info.native",
      buildInfoRuntime: "~mobile.build-info.runtime",
      buildInfoEnvironment: "~mobile.build-info.environment",
      buildInfoChannel: "~mobile.build-info.channel",
      buildInfoRunningSource: "~mobile.build-info.running-source",
      buildInfoUpdateId: "~mobile.build-info.update-id",
      buildInfoCopyHint: "~mobile.build-info.copy-hint"
    });
  });

  it("exposes native file-preview controls for the relay smoke", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      taskFilePreviewClose: "~mobile.task-file-preview.close",
      taskFilePreviewError: "~mobile.task-file-preview.error",
      taskFilePreviewErrorMessage: "~mobile.task-file-preview.error-message",
      taskFilePreviewInspection: "~mobile.task-file-preview.inspection",
      taskFilePreviewMode: "~mobile.task-file-preview.mode",
      taskFilePreviewPath: "~mobile.task-file-preview.path"
    });
  });

  it("exposes the mentioned-file menu and canonical row controls", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      taskMentionedFilesClose: "~mobile.task-mentioned-files.close",
      taskMentionedFilesError: "~mobile.task-mentioned-files.error",
      taskMentionedFilesModal: "~mobile.task-mentioned-files.modal",
      taskMentionedFilesRetry: "~mobile.task-mentioned-files.retry"
    });
    expect(
      selectorHelpers.taskMentionedFilesRowSelector(
        "fixtures/unique/TaskScreen.tsx"
      )
    ).toBe(
      "~mobile.task-mentioned-files.row.fixtures/unique/TaskScreen.tsx"
    );
  });

  it("exposes the prompt expansion controls through stable Appium selectors", () => {
    expect(selectorHelpers.selectors.taskTitleButton).toBe(
      "~mobile.task-title-button"
    );
    expect(selectorHelpers.selectors.taskExpandedPrompt).toBe(
      "~mobile.task-expanded-prompt"
    );
    expect(
      (selectorHelpers.selectors as Record<string, string>)
        .taskExpandedTaskId
    ).toBe("~mobile.task-expanded-task-id");
    expect(selectorHelpers.selectors.taskTitleDismissLayer).toBe(
      "~mobile.task-title-dismiss-layer"
    );
  });

  it("exposes the profile-to-Machines pairing flow", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      accountMachinesButton: "~mobile.account-machines",
      machinesScreen: "~mobile.machines-screen",
      machinesBackButton: "~mobile.machines-back",
      machinesAddButton: "~mobile.machines-add",
      machinePairingSheet: "~mobile.machine-pairing.sheet",
      machinePairingCodeInput: "~mobile.machine-pairing.code",
      machinePairingSubmit: "~mobile.machine-pairing.submit",
      machinePairingProgress: "~mobile.machine-pairing.progress",
      machinePairingError: "~mobile.machine-pairing.error",
      machinePairingClose: "~mobile.machine-pairing.close",
      machinePairingCamera: "~mobile.machine-pairing.camera",
      machinePairingScanMode: "~mobile.machine-pairing.mode.scan",
      machinePairingOpenSettings: "~mobile.machine-pairing.open-settings"
    });
    expect(selectorHelpers.machineRowsXPath("desktop-1")).toBe(
      '//*[@name="mobile.machine.desktop-1.name"]'
    );
    expect(selectorHelpers.machineOriginSelector("desktop-1", "manual")).toBe(
      "~mobile.machine.desktop-1.origin.manual"
    );
  });

  it("exposes the in-app visual companion controls", () => {
    expect(selectorHelpers.selectors).toMatchObject({
      visualCompanionButton: "~mobile.visual-companion.button",
      visualCompanionClose: "~mobile.visual-companion.close",
      visualCompanionModal: "~mobile.visual-companion.modal",
      visualCompanionStatus: "~mobile.visual-companion.status",
      visualCompanionWebView: "~mobile.visual-companion.webview"
    });
  });

  it("extracts the exact display-task id from an Appium task-row name", () => {
    const extractTaskRowId = (
      selectorHelpers as typeof selectorHelpers & {
        extractTaskRowId?: (accessibilityName: string | null) => string | null;
      }
    ).extractTaskRowId;

    expect(extractTaskRowId).toBeTypeOf("function");
    if (!extractTaskRowId) return;

    expect(
      extractTaskRowId("mobile.task-row.cloud:desktop:repo:task")
    ).toBe("cloud:desktop:repo:task");
    expect(extractTaskRowId("mobile.account-button")).toBeNull();
    expect(extractTaskRowId(null)).toBeNull();
  });
});

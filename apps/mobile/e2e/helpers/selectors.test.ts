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

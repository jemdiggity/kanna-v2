import { describe, expect, it } from "vitest";
import * as selectorHelpers from "./selectors";

describe("mobile E2E selector helpers", () => {
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

import { describe, expect, it } from "vitest";
import { buildUpdateInfoRows } from "./moreUpdateInfo";

describe("buildUpdateInfoRows", () => {
  it("formats current OTA update metadata for the More screen", () => {
    expect(
      buildUpdateInfoRows({
        enabled: true,
        updateId: "0123456789abcdef",
        runtimeVersion: "1.0.0",
        channel: "staging"
      })
    ).toEqual([
      { label: "OTA", value: "enabled" },
      { label: "Channel", value: "staging" },
      { label: "Runtime", value: "1.0.0" },
      { label: "Update", value: "01234567" }
    ]);
  });

  it("shows inert dev update metadata without pretending OTA is active", () => {
    expect(
      buildUpdateInfoRows({
        enabled: false,
        updateId: null,
        runtimeVersion: "1.0.0",
        channel: null
      })
    ).toEqual([
      { label: "OTA", value: "disabled" },
      { label: "Channel", value: "none" },
      { label: "Runtime", value: "1.0.0" },
      { label: "Update", value: "embedded" }
    ]);
  });
});

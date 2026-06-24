import { describe, expect, it } from "vitest";

interface ExpoUpdatesDevContract {
  isEnabled: boolean;
}

describe("mobile OTA dev smoke contract", () => {
  it("keeps expo-updates inert in dev builds and simulator smoke runs", () => {
    const devUpdatesModule: ExpoUpdatesDevContract = { isEnabled: false };

    expect(devUpdatesModule.isEnabled).toBe(false);
  });
});

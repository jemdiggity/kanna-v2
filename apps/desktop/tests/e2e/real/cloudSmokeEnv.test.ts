import { describe, expect, it } from "vitest";
import { missingCloudSmokeEnv } from "./cloudSmokeEnv";

describe("missingCloudSmokeEnv", () => {
  it("lists missing cloud smoke credentials", () => {
    expect(missingCloudSmokeEnv({})).toEqual([
      "KANNA_FIREBASE_API_KEY",
      "KANNA_CLOUD_TEST_EMAIL",
      "KANNA_CLOUD_TEST_PASSWORD",
      "KANNA_FIREBASE_PROJECT_ID",
      "KANNA_CLOUD_FUNCTIONS_ENDPOINT",
    ]);
  });

  it("treats blank values as missing", () => {
    expect(
      missingCloudSmokeEnv({
        KANNA_FIREBASE_API_KEY: "   ",
        KANNA_CLOUD_TEST_EMAIL: "smoke@example.invalid",
      }),
    ).toContain("KANNA_FIREBASE_API_KEY");
  });
});

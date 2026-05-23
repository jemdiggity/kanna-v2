import { describe, expect, it } from "vitest";
import appConfig from "../app.json";

describe("mobile app config", () => {
  it("uses the Firebase iOS app bundle identifier and plist", () => {
    expect(appConfig.expo.ios.bundleIdentifier).toBe("build.kanna.app");
    expect(appConfig.expo.ios.googleServicesFile).toBe("./GoogleService-Info.plist");
  });
});

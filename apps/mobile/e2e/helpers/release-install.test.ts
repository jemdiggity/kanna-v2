import { describe, expect, it } from "vitest";
import {
  buildReleaseLaunchArgs,
  formatMissingReleaseInstallMessage,
  resolveReleaseInstallTarget
} from "./release-install";

describe("release install check helpers", () => {
  it("resolves the staging native identity from KANNA_APP_ENV", () => {
    expect(resolveReleaseInstallTarget({ KANNA_APP_ENV: "staging" })).toEqual({
      appEnv: "staging",
      bundleId: "build.kanna.app.staging",
      displayName: "Kanna Staging",
      runtimeVersion: "2.2.1"
    });
  });

  it("accepts the production alias and explicit bundle id overrides", () => {
    expect(resolveReleaseInstallTarget({ KANNA_APP_ENV: "production" })).toMatchObject({
      appEnv: "prod",
      bundleId: "build.kanna.app"
    });
    expect(
      resolveReleaseInstallTarget({
        KANNA_APP_ENV: "staging",
        KANNA_IOS_BUNDLE_ID: "build.kanna.app.custom"
      })
    ).toMatchObject({ bundleId: "build.kanna.app.custom" });
  });

  it("refuses to run without an explicit environment", () => {
    expect(() => resolveReleaseInstallTarget({})).toThrow(/Set KANNA_APP_ENV/);
    expect(() => resolveReleaseInstallTarget({ KANNA_APP_ENV: "qa" })).toThrow(/Set KANNA_APP_ENV/);
  });

  it("builds a terminate-existing devicectl launch invocation", () => {
    expect(buildReleaseLaunchArgs("00008130-001015CA1091401C", "build.kanna.app.staging")).toEqual([
      "devicectl",
      "device",
      "process",
      "launch",
      "--terminate-existing",
      "--device",
      "00008130-001015CA1091401C",
      "build.kanna.app.staging"
    ]);
  });

  it("points a missing install at the kd Release install command", () => {
    expect(
      formatMissingReleaseInstallMessage(
        {
          appEnv: "staging",
          bundleId: "build.kanna.app.staging",
          displayName: "Kanna Staging",
          runtimeVersion: "2.1.4"
        },
        "Jerome's iPhone 15"
      )
    ).toBe(
      "build.kanna.app.staging (Kanna Staging) is not installed on Jerome's iPhone 15. " +
        "Install it with: ./kd mobile run --device --staging --install"
    );
  });
});

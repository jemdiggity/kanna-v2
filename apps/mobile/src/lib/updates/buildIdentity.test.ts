import { describe, expect, it } from "vitest";
import { buildIdentity } from "./buildIdentity";

describe("buildIdentity", () => {
  it("identifies the exact downloaded OTA update", () => {
    expect(
      buildIdentity({
        nativeApplicationVersion: "2.4.0",
        nativeBuildVersion: "108",
        updatesEnabled: true,
        isEmbeddedLaunch: false,
        updateId: "84667f93-5c7b-45fb-9f78-7045160cb842",
        runtimeVersion: "2.1.2",
        channel: "staging",
        appEnvironment: "staging",
        configuredRuntimeVersion: "2.1.2",
        configuredChannel: "staging"
      })
    ).toEqual({
      nativeVersion: "2.4.0",
      nativeBuild: "108",
      nativeSummary: "2.4.0 (108)",
      runtimeVersion: "2.1.2",
      environment: "staging",
      channel: "staging",
      source: {
        kind: "ota",
        label: "84667f93-5c7b-45fb-9f78-7045160cb842",
        updateId: "84667f93-5c7b-45fb-9f78-7045160cb842"
      }
    });
  });

  it("clearly identifies an embedded bundle", () => {
    const identity = buildIdentity({
      nativeApplicationVersion: "2.4.0",
      nativeBuildVersion: "108",
      updatesEnabled: true,
      isEmbeddedLaunch: true,
      updateId: "embedded-update-id",
      runtimeVersion: "2.1.2",
      channel: "production",
      appEnvironment: "prod",
      configuredRuntimeVersion: "2.1.2",
      configuredChannel: "production"
    });

    expect(identity.source).toEqual({
      kind: "embedded",
      label: "Embedded bundle"
    });
  });

  it("distinguishes a Metro development bundle and uses configured metadata", () => {
    const identity = buildIdentity({
      nativeApplicationVersion: "2.4.0",
      nativeBuildVersion: "108",
      updatesEnabled: false,
      isEmbeddedLaunch: false,
      updateId: null,
      runtimeVersion: null,
      channel: null,
      appEnvironment: "dev",
      configuredRuntimeVersion: "2.1.2",
      configuredChannel: null
    });

    expect(identity.runtimeVersion).toBe("2.1.2");
    expect(identity.channel).toBe("None");
    expect(identity.source).toEqual({
      kind: "development",
      label: "Development bundle (Metro)"
    });
  });

  it("renders stable fallbacks when build identity is unavailable", () => {
    expect(
      buildIdentity({
        nativeApplicationVersion: null,
        nativeBuildVersion: null,
        updatesEnabled: true,
        isEmbeddedLaunch: false,
        updateId: null,
        runtimeVersion: null,
        channel: null,
        appEnvironment: "prod",
        configuredRuntimeVersion: "",
        configuredChannel: null
      })
    ).toEqual({
      nativeVersion: "Unknown",
      nativeBuild: "Unknown",
      nativeSummary: "Unknown",
      runtimeVersion: "Unknown",
      environment: "prod",
      channel: "None",
      source: { kind: "unknown", label: "Unknown" }
    });
  });

  it("uses the available native value in the collapsed summary", () => {
    const base = {
      updatesEnabled: false,
      isEmbeddedLaunch: false,
      updateId: null,
      runtimeVersion: null,
      channel: null,
      appEnvironment: "dev" as const,
      configuredRuntimeVersion: "2.1.2",
      configuredChannel: null
    };

    expect(
      buildIdentity({
        ...base,
        nativeApplicationVersion: "2.4.0",
        nativeBuildVersion: null
      }).nativeSummary
    ).toBe("2.4.0");
    expect(
      buildIdentity({
        ...base,
        nativeApplicationVersion: null,
        nativeBuildVersion: "108"
      }).nativeSummary
    ).toBe("108");
  });
});

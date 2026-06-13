import { describe, expect, it } from "vitest";
import {
  createExpoConfig,
  resolveMobileAppEnvironment
} from "../app.config";

describe("mobile app config", () => {
  it("uses production identity by default", () => {
    const config = createExpoConfig({});

    expect(config.name).toBe("Kanna");
    expect(config.scheme).toBe("kanna");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app");
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.production.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "prod",
      firebase: { projectId: "kanna-build" },
      relayUrl: "wss://relay.kanna.build"
    });
  });

  it("produces the dev identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "dev" });

    expect(config.name).toBe("Kanna Dev");
    expect(config.scheme).toBe("kanna-dev");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app.dev");
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.production.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "dev",
      firebase: { projectId: "kanna-local" },
      relayUrl: "ws://127.0.0.1:9080"
    });
  });

  it("produces the staging identity from KANNA_APP_ENV", () => {
    const config = createExpoConfig({ KANNA_APP_ENV: "staging" });

    expect(config.name).toBe("Kanna Staging");
    expect(config.scheme).toBe("kanna-staging");
    expect(config.ios?.bundleIdentifier).toBe("build.kanna.app.staging");
    expect(config.ios?.googleServicesFile).toBe(
      "./firebase/GoogleService-Info.staging.plist"
    );
    expect(config.extra?.kanna).toMatchObject({
      appEnv: "staging",
      firebase: { projectId: "kanna-staging" },
      relayUrl: "wss://relay-staging.kanna.build"
    });
  });

  it("falls back to prod for unknown KANNA_APP_ENV values", () => {
    expect(resolveMobileAppEnvironment("qa").name).toBe("prod");
  });
});

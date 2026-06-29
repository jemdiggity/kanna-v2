import { describe, expect, it } from "vitest";
import { applyProductionCloudEnv } from "../src/runtime/cloud-creds";

describe("cloud env defaults", () => {
  it("fills production cloud env defaults without overriding explicit values", () => {
    const applied = applyProductionCloudEnv({ KANNA_RELAY_URL: "ws://127.0.0.1:9080" });
    expect(applied.KANNA_RELAY_URL).toBe("ws://127.0.0.1:9080");
    expect(applied.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-build");
    expect(applied.KANNA_FIREBASE_API_KEY).toMatch(/^AIza/);
    expect(applied.KANNA_FIREBASE_APP_ID).toContain(":web:");

    const defaulted = applyProductionCloudEnv({});
    expect(defaulted.KANNA_RELAY_URL).toBe("wss://relay.kanna.build");
  });

  it("selects the production cloud via KANNA_CLOUD_ENV (the app ignores emulator env under it)", () => {
    const applied = applyProductionCloudEnv({
      KANNA_FIREBASE_AUTH_PORT: "9099",
      KANNA_CLOUD_ENV: "local",
    });
    expect(applied.KANNA_CLOUD_ENV).toBe("production");
    // Emulator pointers stay in the env; the app's KANNA_CLOUD_ENV gate is
    // what makes them inert (desktopFirebaseConfig.ts).
    expect(applied.KANNA_FIREBASE_AUTH_PORT).toBe("9099");
  });
});

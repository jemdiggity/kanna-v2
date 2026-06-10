import { describe, expect, it } from "vitest";
import {
  buildCloudEmulatorTestCommand,
  buildCloudSmokeEnv,
  requireCloudSmokeEnv,
} from "../src/runtime/cloud-test";

describe("cloud test runtime", () => {
  it("builds the emulator e2e command", () => {
    expect(buildCloudEmulatorTestCommand()).toEqual([
      "pnpm",
      ["--dir", "apps/desktop", "exec", "tsx", "tests/e2e/run.ts", "real/cloud-task-sync.test.ts"],
    ]);
  });

  it("requires staging Firebase configuration without a Functions endpoint", () => {
    expect(() => requireCloudSmokeEnv({
      KANNA_FIREBASE_API_KEY: "key",
      KANNA_FIREBASE_PROJECT_ID: "project",
      KANNA_FIREBASE_APP_ID: "app",
      KANNA_CLOUD_TEST_EMAIL: "test@example.com",
      KANNA_CLOUD_TEST_PASSWORD: "password",
    }, "staging")).not.toThrow();
  });

  it("rejects incomplete cloud smoke configuration", () => {
    expect(() => requireCloudSmokeEnv({}, "staging")).toThrow("KANNA_FIREBASE_API_KEY");
  });

  it("builds cloud smoke env without mutating input", () => {
    const source = { KANNA_FIREBASE_API_KEY: "key" };
    const env = buildCloudSmokeEnv(source, "staging");
    expect(env.KANNA_CLOUD_ENV).toBe("staging");
    expect(source).toEqual({ KANNA_FIREBASE_API_KEY: "key" });
  });
});

import { describe, expect, it } from "vitest";
import { createInstanceConfig } from "./runConfig";

describe("createInstanceConfig", () => {
  it("uses kd for lifecycle commands and passes explicit launch directories", () => {
    const config = createInstanceConfig({
      daemonDir: "/tmp/e2e-daemon",
      dbName: "test-task-primary.db",
      devPortEnvValue: 1421,
      env: {},
      effectiveWebDriverPort: 4445,
      mobileServerPortEnvValue: 48122,
      sessionName: "kanna-e2e-test-session",
      transferPortEnvValue: 48121,
      webDriverPortEnvValue: 4445,
    });

    expect(config.startCommand).toEqual([
      "./kd",
      "dev",
      "up",
      "--db",
      "test-task-primary.db",
      "--delete-db",
      "--daemon-dir",
      "/tmp/e2e-daemon",
      "--transfer-root",
      "/tmp/e2e-daemon/transfer-root",
    ]);
    expect(config.stopCommand).toEqual([
      "./kd",
      "dev",
      "down",
      "--kill-daemon",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { remoteHarnessSpecFiles, remoteHarnessVitestArgs } from "./vitestArgs";

describe("remote harness Vitest arguments", () => {
  it("keeps the current full dev suite in serial runner order", () => {
    expect(remoteHarnessSpecFiles(false)).toEqual([
      "src/remote-harness.smoke.test.ts",
      "src/cloud-pairing-auth-discovery.e2e.test.ts",
      "src/terminal-flow.e2e.test.ts",
      "src/task-listing-actions.e2e.test.ts",
      "src/lan-layer.e2e.test.ts",
      "src/task-image-attachment.e2e.test.ts"
    ]);
  });

  it("keeps the staging smoke suite in serial runner order", () => {
    expect(remoteHarnessSpecFiles(true)).toEqual(["src/staging-smoke.e2e.test.ts"]);
  });

  it("runs one spec file at a time with CI hook headroom", () => {
    expect(remoteHarnessVitestArgs("src/terminal-flow.e2e.test.ts")).toEqual([
      "exec",
      "vitest",
      "run",
      "--no-file-parallelism",
      "--maxWorkers=1",
      "--maxConcurrency=1",
      "--hookTimeout=240000",
      "--testTimeout=120000",
      "src/terminal-flow.e2e.test.ts"
    ]);
  });
});

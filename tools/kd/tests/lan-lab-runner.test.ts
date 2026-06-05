import { describe, expect, it } from "vitest";
import { buildLanLabScenarioCommand } from "../src/runtime/lan-lab-runner";

describe("LAN lab assertion runner", () => {
  it("builds the controller-side scenario command", () => {
    const command = buildLanLabScenarioCommand({
      prompt: "LAN lab visible task",
      source: {
        repo: "/Users/jeremy/kanna",
        peerId: "desktop-a",
        displayName: "desktop-a",
        localWebDriverPort: 46000,
      },
      observer: {
        repo: "/Users/jeremy/kanna",
        peerId: "desktop-b",
        displayName: "desktop-b",
        localWebDriverPort: 46001,
      },
    });

    expect(command).toEqual({
      command: "pnpm",
      args: [
        "--dir",
        "apps/desktop",
        "exec",
        "tsx",
        "tests/e2e/helpers/lan-lab-scenario.ts",
        "--source-port",
        "46000",
        "--observer-port",
        "46001",
        "--source-repo",
        "/Users/jeremy/kanna",
        "--observer-repo",
        "/Users/jeremy/kanna",
        "--source-peer",
        "desktop-a",
        "--observer-peer",
        "desktop-b",
        "--observer-name",
        "desktop-b",
        "--prompt",
        "LAN lab visible task",
      ],
    });
  });
});

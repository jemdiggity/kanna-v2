import { describe, expect, it } from "vitest";
import {
  buildLanLabPlan,
  parseLanLabInventory,
} from "../src/runtime/lan-lab";

describe("LAN lab runtime", () => {
  it("parses a physical Mac inventory", () => {
    const inventory = parseLanLabInventory(JSON.stringify({
      hosts: [
        { name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna" },
        { name: "desktop-b", ssh: "desktop-b.local", repo: "/Users/jeremy/kanna", webDriverPort: 4456 },
      ],
    }));

    expect(inventory.hosts).toHaveLength(2);
    expect(inventory.hosts[0]).toMatchObject({
      name: "desktop-a",
      ssh: "desktop-a.local",
      repo: "/Users/jeremy/kanna",
      webDriverPort: 4445,
    });
    expect(inventory.hosts[1]?.webDriverPort).toBe(4456);
  });

  it("requires at least two physical hosts", () => {
    expect(() => parseLanLabInventory(JSON.stringify({
      hosts: [{ name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna" }],
    }))).toThrow("LAN lab requires at least two hosts");
  });

  it("builds isolated worker commands", () => {
    const plan = buildLanLabPlan({
      runId: "run-123",
      tunnelBasePort: 46000,
      hosts: [
        { name: "desktop-a", ssh: "desktop-a.local", repo: "/Users/jeremy/kanna", webDriverPort: 4445 },
        { name: "desktop-b", ssh: "desktop-b.local", repo: "/Users/jeremy/kanna", webDriverPort: 4445 },
      ],
    });

    expect(plan.workers[0]?.startSshArgs).toEqual([
      "desktop-a.local",
      "cd '/Users/jeremy/kanna' && KANNA_WEBDRIVER_PORT='4445' KANNA_TRANSFER_DISCOVERY='mdns' KANNA_TRANSFER_PEER_ID='desktop-a' KANNA_TRANSFER_DISPLAY_NAME='desktop-a' ./kd dev up --db 'kanna-test-lab-run-123-desktop-a.db' --delete-db --daemon-dir '.kanna-lab/run-123/desktop-a/daemon' --transfer-root '.kanna-lab/run-123/desktop-a/transfer'",
    ]);
    expect(plan.workers[0]?.peerId).toBe("desktop-a");
    expect(plan.workers[0]?.tunnelArgs).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "46000:127.0.0.1:4445",
      "desktop-a.local",
    ]);
  });
});

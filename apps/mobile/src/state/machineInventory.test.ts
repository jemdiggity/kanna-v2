import { describe, expect, it } from "vitest";
import { buildMachineInventory, summarizeMachines } from "./machineInventory";

describe("buildMachineInventory", () => {
  it("deduplicates account and manual records by desktop identity", () => {
    const endpoint = {
      baseUrl: "http://studio.local:48120",
      lastSeenAt: "2026-07-17T00:00:00Z"
    };

    expect(buildMachineInventory({
      accountDesktops: [
        {
          id: "desktop-1",
          name: "Cloud Name",
          online: true,
          mode: "remote",
          reachableViaRelay: true,
          connectionMode: "both"
        },
        {
          id: "desktop-2",
          name: "Remote Mac",
          online: false,
          mode: "remote",
          lastSeenAt: "2026-07-16T00:00:00Z"
        }
      ],
      manualDesktops: [
        {
          desktopId: "desktop-1",
          displayName: "Local Name",
          lanEndpoints: [endpoint],
          lastSeenAt: endpoint.lastSeenAt
        },
        {
          desktopId: "desktop-3",
          displayName: "Paired Mac",
          lanEndpoints: [],
          lastSeenAt: "2026-07-15T00:00:00Z"
        }
      ],
      liveLanDesktops: [
        {
          id: "desktop-1",
          name: "Nearby Name",
          online: true,
          mode: "lan",
          lastSeenAt: "2026-07-18T00:00:00Z"
        }
      ]
    })).toEqual([
      expect.objectContaining({
        desktopId: "desktop-1",
        displayName: "Nearby Name",
        origins: { account: true, manual: true },
        availability: {
          lan: true,
          cloud: true,
          lastSeenAt: "2026-07-18T00:00:00Z"
        },
        lanEndpoints: [endpoint]
      }),
      expect.objectContaining({
        desktopId: "desktop-3",
        origins: { account: false, manual: true },
        availability: expect.objectContaining({ lan: false, cloud: false })
      }),
      expect.objectContaining({
        desktopId: "desktop-2",
        origins: { account: true, manual: false }
      })
    ]);
  });

  it("prefers the live LAN agent inventory and leaves manual-only machines unknown", () => {
    const machines = buildMachineInventory({
      accountDesktops: [
        {
          id: "desktop-1",
          name: "Studio Mac",
          online: true,
          mode: "remote",
          reachableViaRelay: true,
          agentProviders: ["claude", "opencode"]
        },
        {
          id: "desktop-2",
          name: "Travel Mac",
          online: true,
          mode: "remote",
          reachableViaRelay: true,
          agentProviders: []
        }
      ],
      manualDesktops: [
        {
          desktopId: "desktop-3",
          displayName: "Paired Mac",
          lanEndpoints: [],
          lastSeenAt: "2026-07-15T00:00:00Z"
        }
      ],
      liveLanDesktops: [
        {
          id: "desktop-1",
          name: "Studio Mac",
          online: true,
          mode: "lan",
          agentProviders: ["opencode"]
        }
      ]
    });
    const byId = new Map(machines.map((machine) => [machine.desktopId, machine]));

    expect(byId.get("desktop-1")?.agentProviders).toEqual(["opencode"]);
    expect(byId.get("desktop-2")?.agentProviders).toEqual([]);
    expect(byId.get("desktop-3")?.agentProviders).toBeUndefined();
  });

  it("sorts available machines before offline machines and then by name", () => {
    const machines = buildMachineInventory({
      accountDesktops: [
        { id: "z", name: "Zulu", online: false, mode: "remote" },
        { id: "b", name: "Beta", online: true, mode: "remote" },
        { id: "a", name: "Alpha", online: true, mode: "remote" }
      ],
      manualDesktops: [],
      liveLanDesktops: []
    });

    expect(machines.map((machine) => machine.displayName)).toEqual([
      "Alpha",
      "Beta",
      "Zulu"
    ]);
    expect(summarizeMachines(machines)).toEqual({ total: 3, available: 2 });
  });
});

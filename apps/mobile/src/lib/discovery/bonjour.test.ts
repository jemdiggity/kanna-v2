import { describe, expect, it } from "vitest";
import { applyBonjourServiceEvent, type BonjourService } from "./bonjour";

describe("applyBonjourServiceEvent", () => {
  it("removes a service when native Bonjour reports it as removed", async () => {
    const services = new Map<string, BonjourService>();

    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    });
    expect(Array.from(services.values())).toHaveLength(1);

    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" },
      removed: true
    });

    expect(Array.from(services.values())).toEqual([]);
  });
});

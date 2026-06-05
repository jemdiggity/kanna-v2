import { describe, expect, it } from "vitest";
import { applyBonjourServiceEvent, type BonjourService } from "./bonjour";

// Full native Bonjour/Appium coverage requires a signed iOS app with local
// network permission and a desktop LAN server; these reducer tests cover the
// JS/native event contract that would otherwise retain stale trusted endpoints.
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

  it("removes a cached service when the native removal event has no resolved endpoint", async () => {
    const services = new Map<string, BonjourService>();

    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    });

    expect(
      applyBonjourServiceEvent(services, {
        name: "Studio Mac",
        type: "_kanna-mobile._tcp.",
        txt: { desktopId: "desktop-1" },
        removed: true
      })
    ).toBe(true);
    expect(Array.from(services.values())).toEqual([]);
  });

  it("removes a cached service when the native removal endpoint differs from the resolved add", async () => {
    const services = new Map<string, BonjourService>();

    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    });

    expect(
      applyBonjourServiceEvent(services, {
        name: "Studio Mac",
        type: "_kanna-mobile._tcp.",
        host: "stale.local",
        port: 9,
        txt: { desktopId: "desktop-1" },
        removed: true
      })
    ).toBe(true);
    expect(Array.from(services.values())).toEqual([]);
  });

  it("replaces a service endpoint when the same service name resolves to a new host and port", async () => {
    const services = new Map<string, BonjourService>();

    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio-old.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    });
    applyBonjourServiceEvent(services, {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio-new.local",
      port: 48121,
      txt: { desktopId: "desktop-1" }
    });

    expect(Array.from(services.values())).toEqual([
      {
        name: "Studio Mac",
        type: "_kanna-mobile._tcp.",
        host: "studio-new.local",
        port: 48121,
        txt: { desktopId: "desktop-1" },
        removed: false
      }
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { BonjourService } from "./bonjour";
import { resolveTrustedBonjourEndpoint } from "./trustedBonjour";

const trustedDesktops = [
  {
    desktopId: "desktop-1",
    displayName: "Studio Mac",
    lanEndpoints: [],
    lastSeenAt: "2026-06-01T00:00:00.000Z"
  }
];

describe("trusted Bonjour discovery", () => {
  it("accepts a Bonjour endpoint when status desktop id matches trust", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ desktopId: "desktop-1" })
    }));
    const service: BonjourService = {
      name: "Studio Mac",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    };

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [service],
        trustedDesktops,
        selectedDesktopId: null
      })
    ).resolves.toEqual({
      baseUrl: "http://studio.local:48120",
      desktopId: "desktop-1",
      displayName: "Studio Mac"
    });
  });

  it("ignores untrusted Bonjour services without probing them", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [
          {
            name: "Unknown Mac",
            type: "_kanna-mobile._tcp.",
            host: "unknown.local",
            port: 48120,
            txt: { desktopId: "desktop-2" }
          }
        ],
        trustedDesktops,
        selectedDesktopId: null
      })
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a trusted service when status reports a different desktop id", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ desktopId: "desktop-other" })
    }));

    await expect(
      resolveTrustedBonjourEndpoint({
        fetchImpl,
        services: [
          {
            name: "Studio Mac",
            type: "_kanna-mobile._tcp.",
            host: "studio.local",
            port: 48120,
            txt: { desktopId: "desktop-1" }
          }
        ],
        trustedDesktops,
        selectedDesktopId: "desktop-1"
      })
    ).resolves.toBeNull();
  });
});

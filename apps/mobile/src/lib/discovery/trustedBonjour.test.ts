import { describe, expect, it, vi } from "vitest";
import type { BonjourService } from "./bonjour";
import {
  resolveTrustedBonjourEndpoint,
  resolveTrustedBonjourEndpoints
} from "./trustedBonjour";

const trustedDesktopIds = ["desktop-1"];

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
        trustedDesktopIds,
        preferredDesktopId: null
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
        trustedDesktopIds,
        preferredDesktopId: null
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
        trustedDesktopIds,
        preferredDesktopId: "desktop-1"
      })
    ).resolves.toBeNull();
  });

  it("accepts a Bonjour endpoint whose desktop id is trusted by the account", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ desktopId: "desktop-cloud" })
    }));

    const endpoint = await resolveTrustedBonjourEndpoint({
      fetchImpl,
      services: [{
        name: "Cloud Mac",
        type: "_kanna-mobile._tcp.",
        host: "cloud.local",
        port: 48120,
        txt: { desktopId: "desktop-cloud" }
      }],
      trustedDesktopIds: ["desktop-cloud"],
      preferredDesktopId: null
    });

    expect(endpoint?.desktopId).toBe("desktop-cloud");
  });

  it("validates every reachable trusted desktop for inventory", async () => {
    const fetchImpl = vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        desktopId: input.includes("first.local") ? "desktop-1" : "desktop-2"
      })
    }));

    await expect(resolveTrustedBonjourEndpoints({
      fetchImpl,
      services: [
        {
          name: "First Mac",
          type: "_kanna-mobile._tcp.",
          host: "first.local",
          port: 48120,
          txt: { desktopId: "desktop-1" }
        },
        {
          name: "Second Mac",
          type: "_kanna-mobile._tcp.",
          host: "second.local",
          port: 48120,
          txt: { desktopId: "desktop-2" }
        }
      ],
      trustedDesktopIds: ["desktop-1", "desktop-2"],
      preferredDesktopId: null
    })).resolves.toEqual([
      expect.objectContaining({ desktopId: "desktop-1" }),
      expect.objectContaining({ desktopId: "desktop-2" })
    ]);
  });

  it("bounds status validation when a trusted service never responds", async () => {
    const fetchImpl = vi.fn(() => new Promise<never>(() => undefined));

    await expect(resolveTrustedBonjourEndpoint({
      fetchImpl,
      services: [{
        name: "Sleeping Mac",
        type: "_kanna-mobile._tcp.",
        host: "sleeping.local",
        port: 48120,
        txt: { desktopId: "desktop-1" }
      }],
      trustedDesktopIds,
      preferredDesktopId: null,
      probeTimeoutMs: 10
    })).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://sleeping.local:48120/v1/status",
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });
});

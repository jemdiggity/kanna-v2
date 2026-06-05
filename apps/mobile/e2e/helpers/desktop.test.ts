import { describe, expect, it, vi } from "vitest";
import {
  assertDesktopServerReachable,
  readDesktopIdentity,
  resolveDesktopServerUrlForTarget
} from "./desktop";

describe("assertDesktopServerReachable", () => {
  it("reports the target URL when the desktop server cannot be reached", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      assertDesktopServerReachable("http://127.0.0.1:48120", fetchMock)
    ).rejects.toThrow(
      "Desktop mobile server check failed for http://127.0.0.1:48120/v1/status"
    );
  });

  it("reports the target URL when the desktop server returns an error status", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503
    }));

    await expect(
      assertDesktopServerReachable("http://127.0.0.1:48120", fetchMock)
    ).rejects.toThrow(
      "Desktop mobile server check failed for http://127.0.0.1:48120/v1/status: 503"
    );
  });
});

describe("readDesktopIdentity", () => {
  it("returns desktop identity from status", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        desktopId: "desktop-1",
        desktopName: "Studio Mac"
      })
    }));

    await expect(readDesktopIdentity("http://127.0.0.1:48120", fetchMock)).resolves.toEqual({
      desktopId: "desktop-1",
      desktopName: "Studio Mac"
    });
  });

  it("rejects status without desktop identity", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: "running" })
    }));

    await expect(
      readDesktopIdentity("http://127.0.0.1:48120", fetchMock)
    ).rejects.toThrow("Desktop status did not include desktopId and desktopName.");
  });
});

describe("resolveDesktopServerUrlForTarget", () => {
  it("keeps the configured URL for simulator runs", () => {
    expect(
      resolveDesktopServerUrlForTarget(
        "http://127.0.0.1:48120",
        "simulator",
        () => "192.168.1.23"
      )
    ).toBe("http://127.0.0.1:48120");
  });

  it("keeps the configured URL when the device target already uses a non-loopback host", () => {
    expect(
      resolveDesktopServerUrlForTarget(
        "http://192.168.1.23:48120",
        "device",
        () => "192.168.1.44"
      )
    ).toBe("http://192.168.1.23:48120");
  });

  it("rewrites loopback URLs to the host LAN IP for physical-device runs", () => {
    expect(
      resolveDesktopServerUrlForTarget(
        "http://127.0.0.1:48120",
        "device",
        () => "192.168.1.23"
      )
    ).toBe("http://192.168.1.23:48120");
  });

  it("throws a clear error when the host LAN IP cannot be determined for a device run", () => {
    expect(() =>
      resolveDesktopServerUrlForTarget("http://127.0.0.1:48120", "device", () => undefined)
    ).toThrow("Could not determine a host LAN IP address");
  });
});

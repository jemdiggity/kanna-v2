import { describe, expect, it, vi } from "vitest";
import { createDesktopPairingSession } from "./desktopPairing";

describe("desktop pairing client", () => {
  it("creates pairing through the desktop loopback boundary", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "ABC123",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      pairingPayload: "{}",
      lanHost: "127.0.0.1",
      lanPort: 48120,
      expiresAtUnixMs: 1_800_000,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(createDesktopPairingSession(
      "http://127.0.0.1:48120",
      fetchImpl as typeof fetch,
    )).resolves.toMatchObject({
      code: "ABC123",
      desktopId: "desktop-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/pairing/sessions",
      { method: "POST" },
    );
  });

  it("reports the status and body when desktop pairing fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));

    await expect(createDesktopPairingSession(
      "http://127.0.0.1:48120",
      fetchImpl as typeof fetch,
    )).rejects.toThrow("403 forbidden");
  });
});

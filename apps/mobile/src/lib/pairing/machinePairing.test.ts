import { describe, expect, it, vi } from "vitest";
import { createStaticBonjourBrowser } from "../discovery/bonjour";
import type { FetchLike, FetchResponseLike } from "../transports/lanTransport";
import { createMachinePairingService } from "./machinePairing";

const validPayload = JSON.stringify({
  type: "kanna.machine-pairing",
  version: 1,
  desktopId: "desktop-2",
  code: "ABC123"
});

function response(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function services() {
  return [
    {
      name: "one",
      type: "_kanna-mobile._tcp",
      host: "10.0.0.2",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    },
    {
      name: "two",
      type: "_kanna-mobile._tcp",
      host: "10.0.0.3",
      port: 48120,
      txt: { desktopId: "desktop-2" }
    }
  ];
}

function pairingService(fetchImpl: FetchLike, claimTimeoutMs?: number) {
  return createMachinePairingService({
    bonjourBrowser: createStaticBonjourBrowser(services()),
    fetchImpl,
    getDeviceIdentity: () => ({
      deviceId: "phone-1",
      deviceName: "Kanna Mobile"
    }),
    claimTimeoutMs,
    now: () => new Date("2026-07-17T00:00:00.000Z")
  });
}

describe("machine pairing", () => {
  it("claims a QR payload only against its matching desktop", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac"
    }));

    await expect(pairingService(fetchImpl).claimPayload(validPayload)).resolves.toEqual({
      desktopId: "desktop-2",
      displayName: "Studio Mac",
      lanEndpoints: [{
        baseUrl: "http://10.0.0.3:48120",
        lastSeenAt: "2026-07-17T00:00:00.000Z"
      }],
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.0.0.3:48120/v1/pairing/sessions/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "ABC123",
          deviceId: "phone-1",
          deviceName: "Kanna Mobile"
        })
      })
    );
  });

  it("matches the uppercased compact QR identity case-insensitively", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "DeSkToP-2",
      desktopName: "Studio Mac"
    }));

    await expect(
      pairingService(fetchImpl).claimPayload("KANNA1:DESKTOP-2:ABC123")
    ).resolves.toMatchObject({ desktopId: "DeSkToP-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.0.0.3:48120/v1/pairing/sessions/claim",
      expect.anything()
    );
  });

  it("stores the issued device secret from the claim response", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac",
      deviceSecret: "issued-lan-secret"
    }));

    await expect(
      pairingService(fetchImpl).claimPayload(validPayload)
    ).resolves.toMatchObject({
      desktopId: "desktop-2",
      deviceSecret: "issued-lan-secret"
    });
  });

  it("stores the anonymous desktop identity and pairing certificate", async () => {
    const desktopPushIdentity = {
      publicKey: "desktop-ed25519-public-key",
      relayUrl: "wss://relay.example",
      environment: "development"
    };
    const pushPairingCert = {
      deviceId: "phone-1",
      issuedAt: 1_784_246_400_000,
      expiresAt: 1_847_318_400_000,
      signature: "desktop-signature"
    };
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac",
      desktopPushIdentity,
      pushPairingCert
    }));

    await expect(
      pairingService(fetchImpl).claimPayload(validPayload)
    ).resolves.toMatchObject({ desktopPushIdentity, pushPairingCert });
  });

  it("tolerates an older claim response without anonymous push fields", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac",
      deviceSecret: "issued-lan-secret"
    }));

    const record = await pairingService(fetchImpl).claimPayload(validPayload);
    expect(record.deviceSecret).toBe("issued-lan-secret");
    expect("desktopPushIdentity" in record).toBe(false);
    expect("pushPairingCert" in record).toBe(false);
  });

  it("does not persist a certificate issued for another device", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac",
      desktopPushIdentity: {
        publicKey: "desktop-ed25519-public-key",
        relayUrl: "wss://relay.example",
        environment: "development"
      },
      pushPairingCert: {
        deviceId: "another-phone",
        issuedAt: 1_784_246_400_000,
        expiresAt: 1_847_318_400_000,
        signature: "desktop-signature"
      }
    }));

    const record = await pairingService(fetchImpl).claimPayload(validPayload);
    expect("desktopPushIdentity" in record).toBe(false);
    expect("pushPairingCert" in record).toBe(false);
  });

  it("pairs against desktops that predate device secrets without storing one", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-2",
      desktopName: "Studio Mac"
    }));

    const record = await pairingService(fetchImpl).claimPayload(validPayload);
    expect("deviceSecret" in record).toBe(false);
  });

  it("claims a manual code while signed out", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes("10.0.0.2")) {
        return response(200, {
          desktopId: "desktop-1",
          desktopName: "Desk One"
        });
      }
      return response(400, { error: "invalid code" });
    });

    await expect(pairingService(fetchImpl).claimCode("abc-123")).resolves.toMatchObject({
      desktopId: "desktop-1",
      displayName: "Desk One"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [410, "expired"],
    [429, "rate-limited"]
  ])("maps HTTP %s to %s", async (status, reason) => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(status, { error: reason }));

    await expect(pairingService(fetchImpl).claimCode("ABC123")).rejects.toMatchObject({ reason });
  });

  it("rejects malformed codes before discovery", async () => {
    const fetchImpl = vi.fn<FetchLike>();

    await expect(pairingService(fetchImpl).claimCode("bad")).rejects.toMatchObject({
      reason: "invalid-code"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a successful claim whose identity does not match Bonjour", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, {
      desktopId: "desktop-imposter",
      desktopName: "Imposter"
    }));

    await expect(pairingService(fetchImpl).claimPayload(validPayload)).rejects.toMatchObject({
      reason: "identity-mismatch"
    });
  });

  it("reports multiple successful code claims instead of choosing a machine", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => response(200, {
      desktopId: url.includes("10.0.0.2") ? "desktop-1" : "desktop-2",
      desktopName: "Studio Mac"
    }));

    await expect(pairingService(fetchImpl).claimCode("ABC123")).rejects.toMatchObject({
      reason: "multiple-matches"
    });
  });

  it("does not let an unreachable candidate block a successful code claim", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes("10.0.0.2")) {
        return response(200, {
          desktopId: "desktop-1",
          desktopName: "Desk One"
        });
      }
      return new Promise<FetchResponseLike>(() => undefined);
    });

    await expect(Promise.race([
      pairingService(fetchImpl, 10).claimCode("ABC123"),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("pairing did not honor its candidate timeout")),
        100
      ))
    ])).resolves.toMatchObject({ desktopId: "desktop-1" });
  });
});

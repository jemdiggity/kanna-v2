import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

interface FakeDoc {
  path: string;
  data: Record<string, unknown> | undefined;
}

/** In-memory `users/{uid}/pushDevices` with transactional get/set/delete. */
function fakeRegistry(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, FakeDoc>();
  for (const [id, data] of Object.entries(initial)) {
    docs.set(id, { path: `users/operator-1/pushDevices/${id}`, data });
  }
  const refFor = (id: string): FakeDoc => {
    const existing = docs.get(id);
    if (existing) return existing;
    const created = { path: `users/operator-1/pushDevices/${id}`, data: undefined };
    docs.set(id, created);
    return created;
  };
  const deletionRef = { path: "accountDeletions/operator-1" };
  const transaction = {
    get: vi.fn(async (ref: FakeDoc | typeof deletionRef) => {
      if (ref === deletionRef) return { exists: false, data: () => undefined };
      const doc = ref as FakeDoc;
      return { exists: doc.data !== undefined, data: () => doc.data };
    }),
    set: vi.fn((ref: FakeDoc, data: Record<string, unknown>) => {
      ref.data = data;
    }),
    delete: vi.fn((ref: FakeDoc) => {
      ref.data = undefined;
    })
  };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "accountDeletions") return { doc: () => deletionRef };
      expect(name).toBe("users");
      return {
        doc: (userId: string) => {
          expect(userId).toBe("operator-1");
          return { collection: () => ({ doc: (id: string) => refFor(id) }) };
        }
      };
    }),
    runTransaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction))
  };
  return { db, docs, transaction };
}

const deviceDocId = createHash("sha256").update("mobile-device-1", "utf8").digest("hex");

describe("relay push device registry", () => {
  it("retires only the registration an unregister names, so a late cleanup cannot delete a newer one", async () => {
    const registry = fakeRegistry();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.doMock("./firebase.js", () => ({ getFirebaseServices: () => ({ db: registry.db }) }));
    const { registerPushDevice, unregisterPushDevice } = await import("./pushDevices.js");

    // The 2026-09-03 shape: the effect re-ran with the same FCM token, the
    // new run registered, then the old run's cleanup landed.
    await registerPushDevice("operator-1", "mobile-device-1", "fcm-same", "reg-1");
    await registerPushDevice("operator-1", "mobile-device-1", "fcm-same", "reg-2");
    await expect(
      unregisterPushDevice("operator-1", "mobile-device-1", {
        deviceToken: "fcm-same",
        registrationId: "reg-1"
      })
    ).resolves.toBe("stale");
    expect(registry.docs.get(deviceDocId)?.data).toEqual({
      deviceId: "mobile-device-1",
      token: "fcm-same",
      registrationId: "reg-2",
      updatedAt: expect.any(String)
    });

    // The live registration retires when named, leaving an attributable record.
    await expect(
      unregisterPushDevice("operator-1", "mobile-device-1", {
        deviceToken: "fcm-same",
        registrationId: "reg-2"
      })
    ).resolves.toBe("retired");
    expect(registry.docs.get(deviceDocId)?.data).toEqual({
      deviceId: "mobile-device-1",
      token: null,
      registrationId: null,
      updatedAt: expect.any(String),
      retiredAt: expect.any(String),
      retiredReason: "unregistered"
    });
    await expect(
      unregisterPushDevice("operator-1", "mobile-device-1", { registrationId: "reg-2" })
    ).resolves.toBe("alreadyRetired");
    await expect(
      unregisterPushDevice("operator-1", "never-registered", {})
    ).resolves.toBe("absent");

    // A re-registration replaces the retirement record outright.
    await registerPushDevice("operator-1", "mobile-device-1", "fcm-next", "reg-3");
    expect(registry.docs.get(deviceDocId)?.data).toEqual({
      deviceId: "mobile-device-1",
      token: "fcm-next",
      registrationId: "reg-3",
      updatedAt: expect.any(String)
    });
  });

  it("keeps the token guard for phones that predate registration ids", async () => {
    const registry = fakeRegistry();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.doMock("./firebase.js", () => ({ getFirebaseServices: () => ({ db: registry.db }) }));
    const { registerPushDevice, unregisterPushDevice } = await import("./pushDevices.js");

    await registerPushDevice("operator-1", "mobile-device-1", "fcm-new");
    await expect(
      unregisterPushDevice("operator-1", "mobile-device-1", { deviceToken: "fcm-old" })
    ).resolves.toBe("stale");
    expect(registry.docs.get(deviceDocId)?.data?.token).toBe("fcm-new");
    await expect(
      unregisterPushDevice("operator-1", "mobile-device-1", { deviceToken: "fcm-new" })
    ).resolves.toBe("retired");
    expect(registry.docs.get(deviceDocId)?.data?.token).toBeNull();

    await registerPushDevice("operator-1", "mobile-device-1", "fcm-legacy");
    await expect(unregisterPushDevice("operator-1", "mobile-device-1")).resolves.toBe("retired");
  });

  it("logs every registration change without the token", async () => {
    const registry = fakeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.doMock("./firebase.js", () => ({ getFirebaseServices: () => ({ db: registry.db }) }));
    const { registerPushDevice, unregisterPushDevice } = await import("./pushDevices.js");

    await registerPushDevice("operator-1", "mobile-device-1", "fcm-secret", "reg-1");
    await unregisterPushDevice("operator-1", "mobile-device-1", {
      deviceToken: "fcm-secret",
      registrationId: "reg-1"
    });

    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "[auth] Registered mobile push device mobile-device-1 for user operator-1 (registration reg-1)",
      "[auth] Unregister mobile push device mobile-device-1 for user operator-1: retired (registration reg-1)"
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("fcm-secret");
  });

  it("attributes a provider rejection to the delivery that met it and never to a replacement", async () => {
    const registry = fakeRegistry({
      [deviceDocId]: { deviceId: "mobile-device-1", token: "fcm-rejected", registrationId: "reg-1" }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.doMock("./firebase.js", () => ({ getFirebaseServices: () => ({ db: registry.db }) }));
    const { retirePushDeviceAfterProviderRejection, describeNoPushDevices } =
      await import("./pushDevices.js");
    const ref = registry.docs.get(deviceDocId)!;

    await expect(retirePushDeviceAfterProviderRejection(
      registry.db as never,
      {
        ref: ref as never,
        expectedToken: "fcm-replacement",
        providerCode: "messaging/registration-token-not-registered",
        desktopId: "desktop-2"
      }
    )).resolves.toBe(false);
    expect(ref.data?.token).toBe("fcm-rejected");

    await expect(retirePushDeviceAfterProviderRejection(
      registry.db as never,
      {
        ref: ref as never,
        expectedToken: "fcm-rejected",
        providerCode: "messaging/registration-token-not-registered",
        desktopId: "desktop-2",
        nowIso: "2026-09-03T08:39:00.000Z"
      }
    )).resolves.toBe(true);
    expect(ref.data).toEqual({
      deviceId: "mobile-device-1",
      token: null,
      registrationId: null,
      updatedAt: "2026-09-03T08:39:00.000Z",
      retiredAt: "2026-09-03T08:39:00.000Z",
      retiredReason: "tokenRejected",
      retiredProviderCode: "messaging/registration-token-not-registered",
      retiredByDesktopId: "desktop-2"
    });
    expect(warn).toHaveBeenCalledWith(
      `[push] Retired mobile push device registration users/operator-1/pushDevices/${deviceDocId} `
      + "after messaging/registration-token-not-registered during delivery for desktop desktop-2"
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fcm-");

    expect(describeNoPushDevices([ref.data!])).toEqual({
      code: "tokenRejected",
      message: expect.stringContaining("desktop desktop-2 at 2026-09-03T08:39:00.000Z"),
      retiredAt: "2026-09-03T08:39:00.000Z",
      providerCode: "messaging/registration-token-not-registered",
      retiredByDesktopId: "desktop-2"
    });
  });

  it("describes the most recent retirement and labels records without one as unknown", async () => {
    const { describeNoPushDevices } = await import("./pushDevices.js");
    expect(describeNoPushDevices([])).toMatchObject({ code: "neverRegistered" });
    expect(describeNoPushDevices([
      {
        token: null,
        retiredAt: "2026-09-03T08:11:31.000Z",
        retiredReason: "unregistered"
      },
      {
        token: null,
        retiredAt: "2026-08-26T23:39:00.000Z",
        retiredReason: "tokenRejected",
        retiredProviderCode: "messaging/invalid-argument"
      }
    ])).toEqual({
      code: "unregistered",
      message: expect.stringContaining("at 2026-09-03T08:11:31.000Z"),
      retiredAt: "2026-09-03T08:11:31.000Z"
    });
    expect(describeNoPushDevices([{ deviceId: "legacy", token: "" }])).toMatchObject({
      code: "unknown"
    });
  });
});

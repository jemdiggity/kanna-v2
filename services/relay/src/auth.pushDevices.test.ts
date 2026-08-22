import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("relay push device registration", () => {
  it("replaces the device document instead of merging token history", async () => {
    const deletionRef = { path: "accountDeletions/operator-1" };
    const deviceRef = {
      path: `users/operator-1/pushDevices/${createHash("sha256")
        .update("mobile-device-1", "utf8")
        .digest("hex")}`
    };
    const set = vi.fn();
    const transaction = {
      get: vi.fn(async (ref: unknown) => {
        expect(ref).toBe(deletionRef);
        return { exists: false };
      }),
      set
    };
    const pushDevices = {
      doc: vi.fn(() => deviceRef)
    };
    const userDocument = {
      collection: vi.fn(() => pushDevices)
    };
    const collections = {
      accountDeletions: { doc: vi.fn(() => deletionRef) },
      users: { doc: vi.fn(() => userDocument) }
    };
    const db = {
      collection: vi.fn((name: keyof typeof collections) => collections[name]),
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => Promise<void>) => {
        await callback(transaction);
      })
    };
    vi.doMock("./firebase.js", () => ({
      getFirebaseServices: () => ({ db })
    }));
    const { registerPushDevice } = await import("./auth.js");

    await registerPushDevice("operator-1", "mobile-device-1", "fcm-old");
    await registerPushDevice("operator-1", "mobile-device-1", "fcm-current");

    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[1]).toEqual([
      deviceRef,
      {
        deviceId: "mobile-device-1",
        token: "fcm-current",
        updatedAt: expect.any(String)
      }
    ]);
  });
});

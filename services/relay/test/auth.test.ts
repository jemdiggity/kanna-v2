import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface FakeDesktopDoc {
  userId: string;
  data: Record<string, unknown>;
}

function fakeSnapshotDoc(doc: FakeDesktopDoc): Record<string, unknown> {
  return {
    data: () => doc.data,
    ref: { parent: { parent: { id: doc.userId } } },
  };
}

async function importAuthWithFirebaseMock(options: {
  uid?: string;
  deviceUserId?: string | null;
  docs?: FakeDesktopDoc[];
  capturedLimit?: number[];
  getError?: Error;
}): Promise<{
  auth: typeof import("../src/auth.js");
  collectionGroup: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const docs = options.docs ?? [];
  const getDesktopDocs = vi.fn(async () => {
    if (options.getError) {
      throw options.getError;
    }
    return {
      empty: docs.length === 0,
      docs: docs.map(fakeSnapshotDoc),
    };
  });
  const limit = vi.fn((value: number) => {
    options.capturedLimit?.push(value);
    return { get: getDesktopDocs };
  });
  const where = vi.fn(() => ({ limit }));
  const collectionGroup = vi.fn(() => ({ where }));
  vi.doMock("../src/firebase.js", () => ({
    getFirebaseServices: () => ({
      auth: {
        verifyIdToken: vi.fn(async () => ({ uid: options.uid ?? "firebase-user" })),
      },
      db: {
        collection: vi.fn(() => ({
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({
              exists: options.deviceUserId !== null,
              data: () => ({ userId: options.deviceUserId ?? "device-user" }),
            })),
            set: vi.fn(async () => undefined),
          })),
        })),
        collectionGroup,
      },
    }),
  }));

  return {
    auth: await import("../src/auth.js"),
    collectionGroup,
    where,
  };
}

describe("relay auth", () => {
  it("verifies phone tokens through Firebase Auth", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      uid: "seeded-user",
    });

    await expect(auth.verifyPhoneToken("emulator-id-token")).resolves.toBe("seeded-user");
  });

  it("verifies device tokens through Firestore devices", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      deviceUserId: "seeded-user",
    });

    await expect(auth.verifyDeviceToken("seeded-device-token")).resolves.toBe("seeded-user");
  });

  it("returns the owning user when the desktop secret hash matches", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      docs: [
        {
          userId: "user-1",
          data: {
            desktopId: "desktop-1",
            desktopSecretHash: sha256Hex("desktop-secret"),
            revokedAt: null,
          },
        },
      ],
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "desktop-secret")).resolves.toEqual({
      userId: "user-1",
      desktopId: "desktop-1",
    });
  });

  it("queries the desktops collection group by desktopId with a bounded limit", async () => {
    const capturedLimit: number[] = [];
    const { auth, collectionGroup, where } = await importAuthWithFirebaseMock({
      capturedLimit,
    });

    await auth.verifyDesktopCredentials("desktop-1", "desktop-secret");

    expect(collectionGroup).toHaveBeenCalledWith("desktops");
    expect(where).toHaveBeenCalledWith("desktopId", "==", "desktop-1");
    expect(capturedLimit).toEqual([10]);
  });

  it("rejects a wrong desktop secret", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      docs: [
        {
          userId: "user-1",
          data: {
            desktopId: "desktop-1",
            desktopSecretHash: sha256Hex("desktop-secret"),
            revokedAt: null,
          },
        },
      ],
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "wrong-secret")).resolves.toBeNull();
  });

  it("rejects revoked desktop credentials even when the hash matches", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      docs: [
        {
          userId: "user-1",
          data: {
            desktopId: "desktop-1",
            desktopSecretHash: sha256Hex("desktop-secret"),
            revokedAt: "2026-06-01T00:00:00Z",
          },
        },
      ],
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "desktop-secret")).resolves.toBeNull();
  });

  it("rejects desktop docs without a stored secret hash", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      docs: [
        {
          userId: "user-1",
          data: {
            desktopId: "desktop-1",
            desktopSecret: "desktop-secret",
            revokedAt: null,
          },
        },
      ],
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "desktop-secret")).resolves.toBeNull();
  });

  it("authenticates against the matching doc when another user squats the same desktopId", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      docs: [
        {
          userId: "attacker",
          data: {
            desktopId: "desktop-1",
            desktopSecretHash: sha256Hex("attacker-secret"),
            revokedAt: null,
          },
        },
        {
          userId: "owner",
          data: {
            desktopId: "desktop-1",
            desktopSecretHash: sha256Hex("owner-secret"),
            revokedAt: null,
          },
        },
      ],
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "owner-secret")).resolves.toEqual({
      userId: "owner",
      desktopId: "desktop-1",
    });
  });

  it("returns null when no desktop doc matches", async () => {
    const { auth } = await importAuthWithFirebaseMock({});

    await expect(auth.verifyDesktopCredentials("desktop-unknown", "desktop-secret")).resolves.toBeNull();
  });

  it("returns null when the Firestore query fails", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      getError: new Error("9 FAILED_PRECONDITION: missing index"),
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "desktop-secret")).resolves.toBeNull();
  });
});

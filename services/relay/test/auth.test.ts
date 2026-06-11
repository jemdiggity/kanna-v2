import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsAuthBypassed, mockGetFirebaseServices } = vi.hoisted(() => ({
  mockIsAuthBypassed: vi.fn(() => false),
  mockGetFirebaseServices: vi.fn(),
}));

vi.mock("../src/firebase.js", () => ({
  isAuthBypassed: mockIsAuthBypassed,
  getFirebaseServices: mockGetFirebaseServices,
}));

import { verifyDesktopCredentials } from "../src/auth.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface FakeDesktopDoc {
  userId: string;
  data: Record<string, unknown>;
}

function fakeSnapshotDoc(doc: FakeDesktopDoc) {
  return {
    data: () => doc.data,
    ref: { parent: { parent: { id: doc.userId } } },
  };
}

function mockDesktopQuery(docs: FakeDesktopDoc[], options: { capturedLimit?: number[] } = {}) {
  const get = vi.fn(async () => ({
    empty: docs.length === 0,
    docs: docs.map(fakeSnapshotDoc),
  }));
  const limit = vi.fn((value: number) => {
    options.capturedLimit?.push(value);
    return { get };
  });
  const where = vi.fn(() => ({ limit }));
  const collectionGroup = vi.fn(() => ({ where }));
  mockGetFirebaseServices.mockReturnValue({ db: { collectionGroup }, auth: {} });
  return { collectionGroup, where, limit, get };
}

describe("verifyDesktopCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthBypassed.mockReturnValue(false);
  });

  it("returns the owning user when the secret hash matches", async () => {
    mockDesktopQuery([
      {
        userId: "user-1",
        data: {
          desktopId: "desktop-1",
          desktopSecretHash: sha256Hex("desktop-secret"),
          revokedAt: null,
        },
      },
    ]);

    const principal = await verifyDesktopCredentials("desktop-1", "desktop-secret");

    expect(principal).toEqual({ userId: "user-1", desktopId: "desktop-1" });
  });

  it("queries the desktops collection group by desktopId with a bounded limit", async () => {
    const capturedLimit: number[] = [];
    const { collectionGroup, where } = mockDesktopQuery([], { capturedLimit });

    await verifyDesktopCredentials("desktop-1", "desktop-secret");

    expect(collectionGroup).toHaveBeenCalledWith("desktops");
    expect(where).toHaveBeenCalledWith("desktopId", "==", "desktop-1");
    expect(capturedLimit).toEqual([10]);
  });

  it("rejects a wrong secret", async () => {
    mockDesktopQuery([
      {
        userId: "user-1",
        data: {
          desktopId: "desktop-1",
          desktopSecretHash: sha256Hex("desktop-secret"),
          revokedAt: null,
        },
      },
    ]);

    expect(await verifyDesktopCredentials("desktop-1", "wrong-secret")).toBeNull();
  });

  it("rejects revoked desktop credentials even when the hash matches", async () => {
    mockDesktopQuery([
      {
        userId: "user-1",
        data: {
          desktopId: "desktop-1",
          desktopSecretHash: sha256Hex("desktop-secret"),
          revokedAt: "2026-06-01T00:00:00Z",
        },
      },
    ]);

    expect(await verifyDesktopCredentials("desktop-1", "desktop-secret")).toBeNull();
  });

  it("rejects desktop docs without a stored secret hash", async () => {
    mockDesktopQuery([
      {
        userId: "user-1",
        data: {
          desktopId: "desktop-1",
          desktopSecret: "desktop-secret",
          revokedAt: null,
        },
      },
    ]);

    expect(await verifyDesktopCredentials("desktop-1", "desktop-secret")).toBeNull();
  });

  it("authenticates against the matching doc when another user squats the same desktopId", async () => {
    mockDesktopQuery([
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
    ]);

    const principal = await verifyDesktopCredentials("desktop-1", "owner-secret");

    expect(principal).toEqual({ userId: "owner", desktopId: "desktop-1" });
  });

  it("returns null when no desktop doc matches", async () => {
    mockDesktopQuery([]);

    expect(await verifyDesktopCredentials("desktop-unknown", "desktop-secret")).toBeNull();
  });

  it("returns null when the Firestore query fails", async () => {
    const get = vi.fn(async () => {
      throw new Error("9 FAILED_PRECONDITION: missing index");
    });
    mockGetFirebaseServices.mockReturnValue({
      db: { collectionGroup: () => ({ where: () => ({ limit: () => ({ get }) }) }) },
      auth: {},
    });

    expect(await verifyDesktopCredentials("desktop-1", "desktop-secret")).toBeNull();
  });

  it("derives the bypass user from the secret prefix when SKIP_AUTH is enabled", async () => {
    mockIsAuthBypassed.mockReturnValue(true);

    expect(await verifyDesktopCredentials("desktop-1", "user-a:anything")).toEqual({
      userId: "user-a",
      desktopId: "desktop-1",
    });
    expect(await verifyDesktopCredentials("desktop-1", "opaque-secret")).toEqual({
      userId: "test-user",
      desktopId: "desktop-1",
    });
  });
});

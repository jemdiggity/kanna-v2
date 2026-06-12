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
  authBypassed: boolean;
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
  const get = vi.fn(async () => {
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
    return { get };
  });
  const where = vi.fn(() => ({ limit }));
  const collectionGroup = vi.fn(() => ({ where }));
  vi.doMock("../src/firebase.js", () => ({
    isAuthBypassed: () => options.authBypassed,
    getFirebaseServices: () => ({ db: { collectionGroup }, auth: {} }),
  }));

  return {
    auth: await import("../src/auth.js"),
    collectionGroup,
    where,
  };
}

async function importFirebase(): Promise<typeof import("../src/firebase.js")> {
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  return import("../src/firebase.js");
}

describe("verifyDesktopCredentials", () => {
  it("returns the owning user when the secret hash matches", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      authBypassed: false,
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
      authBypassed: false,
      capturedLimit,
    });

    await auth.verifyDesktopCredentials("desktop-1", "desktop-secret");

    expect(collectionGroup).toHaveBeenCalledWith("desktops");
    expect(where).toHaveBeenCalledWith("desktopId", "==", "desktop-1");
    expect(capturedLimit).toEqual([10]);
  });

  it("rejects a wrong secret", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      authBypassed: false,
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
      authBypassed: false,
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
      authBypassed: false,
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
      authBypassed: false,
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
    const { auth } = await importAuthWithFirebaseMock({
      authBypassed: false,
    });

    await expect(auth.verifyDesktopCredentials("desktop-unknown", "desktop-secret")).resolves.toBeNull();
  });

  it("returns null when the Firestore query fails", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      authBypassed: false,
      getError: new Error("9 FAILED_PRECONDITION: missing index"),
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "desktop-secret")).resolves.toBeNull();
  });

  it("derives the bypass user from the secret prefix when SKIP_AUTH is enabled", async () => {
    const { auth } = await importAuthWithFirebaseMock({
      authBypassed: true,
    });

    await expect(auth.verifyDesktopCredentials("desktop-1", "user-a:anything")).resolves.toEqual({
      userId: "user-a",
      desktopId: "desktop-1",
    });
    await expect(auth.verifyDesktopCredentials("desktop-1", "opaque-secret")).resolves.toEqual({
      userId: "test-user",
      desktopId: "desktop-1",
    });
  });
});

describe("relay auth bypass", () => {
  it("does not bypass auth in production even when SKIP_AUTH is true", async () => {
    process.env.SKIP_AUTH = "true";
    process.env.NODE_ENV = "production";
    process.env.KANNA_RELAY_ALLOW_AUTH_BYPASS = "true";

    const { isAuthBypassed } = await importFirebase();

    expect(isAuthBypassed()).toBe(false);
  });
});

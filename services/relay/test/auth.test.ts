import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirebaseServices: vi.fn(),
  isAuthBypassed: vi.fn(() => false),
}));

vi.mock("../src/firebase.js", () => ({
  getFirebaseServices: mocks.getFirebaseServices,
  isAuthBypassed: mocks.isAuthBypassed,
}));

const { verifyDesktopCredentials } = await import("../src/auth.js");

type MockDoc = {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
};

function desktopCredentialDoc(data?: Record<string, unknown>): MockDoc {
  return {
    exists: data !== undefined,
    data: () => data,
  };
}

function collectionGroupDoc(
  data: Record<string, unknown>,
  userId: string | null,
) {
  return {
    data: () => data,
    ref: {
      parent: {
        parent: userId ? { id: userId } : null,
      },
    },
  };
}

function mockFirestore(input: {
  desktopCredential?: Record<string, unknown>;
  fallbackDocs?: Array<ReturnType<typeof collectionGroupDoc>>;
}) {
  const credentialGet = vi.fn(async () =>
    desktopCredentialDoc(input.desktopCredential),
  );
  const fallbackGet = vi.fn(async () => {
    const docs = input.fallbackDocs ?? [];
    return { empty: docs.length === 0, docs };
  });
  const where = vi.fn(() => ({ limit: vi.fn(() => ({ get: fallbackGet })) }));
  const collectionGroup = vi.fn(() => ({ where }));
  const doc = vi.fn(() => ({ get: credentialGet }));
  const collection = vi.fn(() => ({ doc }));
  const db = { collection, collectionGroup };

  mocks.getFirebaseServices.mockReturnValue({ auth: {}, db });

  return {
    collection,
    collectionGroup,
    doc,
    credentialGet,
    where,
    fallbackGet,
  };
}

describe("desktop credential auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthBypassed.mockReturnValue(false);
  });

  it("authenticates top-level desktopCredentials with a matching secret", async () => {
    const db = mockFirestore({
      desktopCredential: {
        desktopId: "desktop-1",
        desktopSecret: "secret-1",
        uid: "user-1",
      },
    });

    await expect(
      verifyDesktopCredentials("desktop-1", "secret-1"),
    ).resolves.toEqual({
      userId: "user-1",
      desktopId: "desktop-1",
    });

    expect(db.collection).toHaveBeenCalledWith("desktopCredentials");
    expect(db.doc).toHaveBeenCalledWith("desktop-1");
    expect(db.collectionGroup).not.toHaveBeenCalled();
  });

  it("rejects a wrong top-level desktopCredentials secret", async () => {
    mockFirestore({
      desktopCredential: {
        desktopId: "desktop-1",
        desktopSecret: "correct-secret",
        uid: "user-1",
      },
    });

    await expect(
      verifyDesktopCredentials("desktop-1", "wrong-secret"),
    ).resolves.toBeNull();
  });

  it("rejects a revoked top-level desktopCredentials document", async () => {
    mockFirestore({
      desktopCredential: {
        desktopId: "desktop-1",
        desktopSecret: "secret-1",
        uid: "user-1",
        revokedAt: "2026-06-10T00:00:00.000Z",
      },
    });

    await expect(
      verifyDesktopCredentials("desktop-1", "secret-1"),
    ).resolves.toBeNull();
  });

  it("rejects a top-level desktopCredentials document without a uid", async () => {
    mockFirestore({
      desktopCredential: {
        desktopId: "desktop-1",
        desktopSecret: "secret-1",
      },
    });

    await expect(
      verifyDesktopCredentials("desktop-1", "secret-1"),
    ).resolves.toBeNull();
  });

  it("falls back to users/*/desktops when top-level desktopCredentials is missing", async () => {
    const db = mockFirestore({
      fallbackDocs: [
        collectionGroupDoc(
          {
            desktopId: "desktop-legacy",
            desktopSecret: "legacy-secret",
          },
          "legacy-user",
        ),
      ],
    });

    await expect(
      verifyDesktopCredentials("desktop-legacy", "legacy-secret"),
    ).resolves.toEqual({
      userId: "legacy-user",
      desktopId: "desktop-legacy",
    });

    expect(db.collectionGroup).toHaveBeenCalledWith("desktops");
    expect(db.where).toHaveBeenCalledWith("desktopId", "==", "desktop-legacy");
  });
});

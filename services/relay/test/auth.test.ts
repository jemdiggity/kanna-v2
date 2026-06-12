import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

function mockDesktopDoc(
  userId: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    data: () => data,
    ref: {
      parent: {
        parent: {
          id: userId,
        },
      },
    },
  };
}

async function importAuthWithFirebaseMock(options: {
  authBypassed: boolean;
  docs?: Record<string, unknown>[];
}): Promise<typeof import("../src/auth.js")> {
  vi.resetModules();
  vi.doMock("../src/firebase.js", () => ({
    isAuthBypassed: () => options.authBypassed,
    getFirebaseServices: () => ({
      db: {
        collectionGroup: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              get: vi.fn(async () => ({
                empty: (options.docs ?? []).length === 0,
                docs: options.docs ?? [],
              })),
            })),
          })),
        })),
      },
    }),
  }));

  return import("../src/auth.js");
}

async function importFirebase(): Promise<typeof import("../src/firebase.js")> {
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  return import("../src/firebase.js");
}

describe("relay auth", () => {
  it("derives distinct bypass desktop users from the presented desktop secret", async () => {
    const { verifyDesktopCredentials } = await importAuthWithFirebaseMock({
      authBypassed: true,
    });

    await expect(
      verifyDesktopCredentials("desktop-one", "user-one:secret")
    ).resolves.toEqual({
      userId: "user-one",
      desktopId: "desktop-one",
    });
    await expect(
      verifyDesktopCredentials("desktop-two", "user-two:secret")
    ).resolves.toEqual({
      userId: "user-two",
      desktopId: "desktop-two",
    });
  });

  it("continues past a colliding desktop id until it finds a matching non-revoked secret", async () => {
    const { hashDesktopSecret, verifyDesktopCredentials } =
      await importAuthWithFirebaseMock({
        authBypassed: false,
      });
    const desktopId = "desktop-collision";
    const legitimateSecret = "legitimate-secret";
    const attackerDoc = mockDesktopDoc("attacker-user", {
      desktopId,
      desktopSecretHash: hashDesktopSecret("attacker-secret"),
    });
    const legitimateDoc = mockDesktopDoc("legitimate-user", {
      desktopId,
      desktopSecretHash: hashDesktopSecret(legitimateSecret),
    });
    const auth = await importAuthWithFirebaseMock({
      authBypassed: false,
      docs: [attackerDoc, legitimateDoc],
    });

    await expect(
      auth.verifyDesktopCredentials(desktopId, legitimateSecret)
    ).resolves.toEqual({
      userId: "legitimate-user",
      desktopId,
    });
  });

  it("does not bypass auth in production even when SKIP_AUTH is true", async () => {
    process.env.SKIP_AUTH = "true";
    process.env.NODE_ENV = "production";
    process.env.KANNA_RELAY_ALLOW_AUTH_BYPASS = "true";

    const { isAuthBypassed } = await importFirebase();

    expect(isAuthBypassed()).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const DESKTOP_ID = "desktop-1";
const DESKTOP_SECRET = "desktop-secret";
const OWNER = "owner-uid";

function activeCredential(): Record<string, unknown> {
  return {
    desktopId: DESKTOP_ID,
    desktopSecretHash: sha256Hex(DESKTOP_SECRET),
    uid: OWNER,
  };
}

function revokedCredential(): Record<string, unknown> {
  return { ...activeCredential(), revokedAt: "2026-08-20T00:00:00Z" };
}

interface CredentialStore {
  /** What Firestore currently holds; null means the document is absent. */
  credential: Record<string, unknown> | null;
  /** Set to make the read fail, standing in for a Firestore outage. */
  failure: Error | null;
}

/**
 * Import `auth.ts` against a Firestore mock that counts credential reads, so
 * a test can assert what the cache actually saved.
 */
async function importAuthWithCountedReads(store: CredentialStore): Promise<{
  auth: typeof import("../src/auth.js");
  reads: () => number;
}> {
  vi.resetModules();
  let reads = 0;
  vi.doMock("../src/firebase.js", () => ({
    getFirebaseServices: () => ({
      auth: { verifyIdToken: vi.fn(async () => ({ uid: OWNER })) },
      db: {
        collection: vi.fn(() => ({
          doc: vi.fn(() => ({
            get: vi.fn(async () => {
              reads += 1;
              if (store.failure) throw store.failure;
              return {
                exists: store.credential != null,
                data: () => store.credential,
              };
            }),
          })),
        })),
        // Reached only when the canonical document is absent.
        collectionGroup: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) })),
          })),
        })),
      },
    }),
  }));

  return { auth: await import("../src/auth.js"), reads: () => reads };
}

function desktopProof(secret = DESKTOP_SECRET) {
  return { kind: "desktop" as const, desktopId: DESKTOP_ID, desktopSecret: secret };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  vi.restoreAllMocks();
});

describe("desktop credential cache", () => {
  it("serves a burst of revalidations from a single credential read", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    for (let index = 0; index < 50; index += 1) {
      expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    }

    expect(reads()).toBe(1);
  });

  it("reads Firestore again once per TTL window", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);
    vi.useFakeTimers();

    for (let index = 0; index < 10; index += 1) {
      await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID);
    }
    expect(reads()).toBe(1);

    vi.advanceTimersByTime(auth.DEFAULT_DESKTOP_CREDENTIAL_CACHE_TTL_MS + 1);
    for (let index = 0; index < 10; index += 1) {
      await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID);
    }
    expect(reads()).toBe(2);
  });

  it("stops honouring a credential revoked mid-window within the TTL bound", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth } = await importAuthWithCountedReads(store);
    vi.useFakeTimers();

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    store.credential = revokedCredential();

    // Inside the window the already-open socket keeps its cached validation.
    vi.advanceTimersByTime(auth.DEFAULT_DESKTOP_CREDENTIAL_CACHE_TTL_MS - 1);
    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);

    // The TTL is the revocation bound, so it must actually bind.
    vi.advanceTimersByTime(2);
    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(false);
  });

  it("drops a cached validation immediately on explicit invalidation", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    store.credential = revokedCredential();
    auth.invalidateDesktopCredentialCache(DESKTOP_ID);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(false);
    expect(reads()).toBe(2);
  });

  it("purges the cache when a new connection is authoritatively rejected", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    store.credential = revokedCredential();

    // A desktop reconnecting after sign-out is rejected, and that rejection
    // flushes the entry still serving its previous socket.
    expect(await auth.verifyDesktopCredentials(DESKTOP_ID, DESKTOP_SECRET)).toBeNull();
    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(false);
  });

  it("never caches a rejection", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof("wrong"), OWNER, DESKTOP_ID)).toBe(false);
    expect(await auth.revalidateServerAuth(desktopProof("wrong"), OWNER, DESKTOP_ID)).toBe(false);

    expect(reads()).toBe(2);
  });

  it("does not serve a secret it never validated", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    expect(reads()).toBe(1);

    // Same desktopId, different secret: a miss, not a hit on the cached entry.
    expect(await auth.revalidateServerAuth(desktopProof("other"), OWNER, DESKTOP_ID)).toBe(false);
    expect(reads()).toBe(2);
  });

  it("does not serve a cached principal to a different expected user", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    expect(await auth.revalidateServerAuth(desktopProof(), "someone-else", DESKTOP_ID)).toBe(false);
  });

  it("keeps a good cached validation through a Firestore outage", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth } = await importAuthWithCountedReads(store);

    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
    store.failure = new Error("14 UNAVAILABLE: Firestore is down");

    // The outage is not evidence about the credential, so it must not flush.
    expect(await auth.verifyDesktopCredentials(DESKTOP_ID, DESKTOP_SECRET)).toBeNull();
    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);
  });

  it("never serves connection establishment from the cache", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    await auth.verifyDesktopCredentials(DESKTOP_ID, DESKTOP_SECRET);
    await auth.verifyDesktopCredentials(DESKTOP_ID, DESKTOP_SECRET);

    expect(reads()).toBe(2);
  });

  it("lets a successful handshake serve the revalidation that follows it", async () => {
    const store: CredentialStore = { credential: activeCredential(), failure: null };
    const { auth, reads } = await importAuthWithCountedReads(store);

    // This is the relay's own connection sequence: verify, then revalidate.
    expect(await auth.verifyDesktopCredentials(DESKTOP_ID, DESKTOP_SECRET)).toEqual({
      userId: OWNER,
      desktopId: DESKTOP_ID,
    });
    expect(await auth.revalidateServerAuth(desktopProof(), OWNER, DESKTOP_ID)).toBe(true);

    expect(reads()).toBe(1);
  });
});

describe("desktop credential cache TTL configuration", () => {
  it("defaults, honours an override, and ignores an unusable one", async () => {
    const { auth } = await importAuthWithCountedReads({ credential: null, failure: null });

    expect(auth.resolveDesktopCredentialCacheTtlMs({}))
      .toBe(auth.DEFAULT_DESKTOP_CREDENTIAL_CACHE_TTL_MS);
    expect(auth.resolveDesktopCredentialCacheTtlMs({
      KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS: "250",
    })).toBe(250);
    // 0 is a legal value: it disables the cache so revocation is immediate.
    expect(auth.resolveDesktopCredentialCacheTtlMs({
      KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS: "0",
    })).toBe(0);
    expect(auth.resolveDesktopCredentialCacheTtlMs({
      KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS: "soon",
    })).toBe(auth.DEFAULT_DESKTOP_CREDENTIAL_CACHE_TTL_MS);
    expect(auth.resolveDesktopCredentialCacheTtlMs({
      KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS: "-1",
    })).toBe(auth.DEFAULT_DESKTOP_CREDENTIAL_CACHE_TTL_MS);
  });
});

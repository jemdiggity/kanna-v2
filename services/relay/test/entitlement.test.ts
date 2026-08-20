import { afterEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-uid";

interface EntitlementStore {
  /** What Firestore currently holds; null means the document is absent. */
  record: Record<string, unknown> | null;
  /** Set to make the read fail, standing in for a Firestore outage. */
  failure: Error | null;
}

function activeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "active",
    source: "stripe",
    capabilities: ["cloud_relay", "cloud_task_index", "remote_task_control"],
    currentPeriodEndsAt: "2026-09-20T00:00:00.000Z",
    graceEndsAt: null,
    duplicateSources: false,
    environment: "staging",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Import `entitlement.ts` with a chosen environment and a Firestore mock that
 * counts entitlement reads, so a test can assert what the cache actually saved.
 *
 * The module resolves its flag and TTL once at import, exactly as `auth.ts`
 * does, so every configuration is a fresh module instance.
 */
async function importEntitlement(
  env: Record<string, string>,
  store: EntitlementStore,
): Promise<{ entitlement: typeof import("../src/entitlement.js"); reads: () => number }> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  let reads = 0;
  vi.doMock("../src/firebase.js", () => ({
    getFirebaseServices: () => ({
      auth: { verifyIdToken: vi.fn() },
      db: {
        collection: vi.fn(() => ({
          doc: vi.fn(() => ({
            collection: vi.fn(() => ({
              doc: vi.fn(() => ({
                get: vi.fn(async () => {
                  reads += 1;
                  if (store.failure) throw store.failure;
                  return { exists: store.record != null, data: () => store.record };
                }),
              })),
            })),
          })),
        })),
      },
    }),
  }));
  return { entitlement: await import("../src/entitlement.js"), reads: () => reads };
}

const ENFORCING = { KANNA_RELAY_ENTITLEMENT_ENFORCEMENT: "on" };

function phone(emailVerified = true) {
  return { userId: OWNER, emailVerified };
}

/** A desktop credential session carries no token, so no email claim. */
const DESKTOP_SUBJECT = { userId: OWNER, emailVerified: null };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../src/firebase.js");
  vi.restoreAllMocks();
});

describe("enforcement flag", () => {
  it("is off unless explicitly turned on", async () => {
    const { entitlement } = await importEntitlement({}, { record: null, failure: null });

    expect(entitlement.resolveEntitlementEnforcement({})).toBe(false);
    for (const value of ["on", "true", "1", "ON", " on "]) {
      expect(entitlement.resolveEntitlementEnforcement({
        KANNA_RELAY_ENTITLEMENT_ENFORCEMENT: value,
      })).toBe(true);
    }
    for (const value of ["off", "false", "0", ""]) {
      expect(entitlement.resolveEntitlementEnforcement({
        KANNA_RELAY_ENTITLEMENT_ENFORCEMENT: value,
      })).toBe(false);
    }
    // A typo must leave the relay serving everyone, not refusing everyone.
    expect(entitlement.resolveEntitlementEnforcement({
      KANNA_RELAY_ENTITLEMENT_ENFORCEMENT: "yes-please",
    })).toBe(false);
  });

  it("reads nothing and restricts nothing while off", async () => {
    const { entitlement, reads } = await importEntitlement({}, { record: null, failure: null });

    expect(entitlement.entitlementEnforcementEnabled()).toBe(false);
    const session = await entitlement.resolveSessionEntitlement(phone());
    // No entitlement block at all, so `auth_ok` keeps its pre-billing shape.
    expect(session.snapshot).toBeNull();
    expect(session.grants("cloud_relay")).toBe(true);
    expect(await entitlement.sessionHasCapability(phone(false), "cloud_task_index")).toBe(true);
    expect(reads()).toBe(0);
  });
});

describe("entitlement gate", () => {
  it("serves an entitled account and advertises its state", async () => {
    const { entitlement } = await importEntitlement(ENFORCING, {
      record: activeRecord(),
      failure: null,
    });

    const session = await entitlement.resolveSessionEntitlement(phone());
    expect(session.snapshot).toEqual({
      active: true,
      status: "active",
      currentPeriodEndsAt: "2026-09-20T00:00:00.000Z",
      graceEndsAt: null,
    });
    expect(session.grants("cloud_relay")).toBe(true);
    expect(session.grants("cloud_task_index")).toBe(true);
  });

  it("refuses an account with no entitlement document", async () => {
    const { entitlement } = await importEntitlement(ENFORCING, { record: null, failure: null });

    const session = await entitlement.resolveSessionEntitlement(DESKTOP_SUBJECT);
    expect(session.snapshot).toEqual({
      active: false,
      status: "none",
      currentPeriodEndsAt: null,
      graceEndsAt: null,
    });
    expect(session.grants("cloud_relay")).toBe(false);
    expect(await entitlement.sessionHasCapability(DESKTOP_SUBJECT, "cloud_task_index")).toBe(false);
  });

  it("refuses expired and revoked entitlements", async () => {
    for (const status of ["expired", "revoked"] as const) {
      const { entitlement } = await importEntitlement(ENFORCING, {
        record: activeRecord({ status, capabilities: [] }),
        failure: null,
      });
      const session = await entitlement.resolveSessionEntitlement(DESKTOP_SUBJECT);
      expect(session.snapshot?.active).toBe(false);
      expect(session.grants("cloud_relay")).toBe(false);
    }
  });

  it("honours a grace period only until it ends", async () => {
    // Nothing sweeps an expired grace: the source doc stays `grace` until the
    // billing source sends another event, so a dunning process that leaves a
    // subscription past_due forever would otherwise entitle it forever.
    const graceEndsAt = "2026-09-27T00:00:00.000Z";
    const { entitlement } = await importEntitlement(ENFORCING, {
      record: activeRecord({ status: "grace", graceEndsAt, capabilities: ["cloud_relay"] }),
      failure: null,
    });
    const record = {
      status: "grace" as const,
      capabilities: ["cloud_relay" as const],
      currentPeriodEndsAt: null,
      graceEndsAt,
    };

    expect(entitlement.isEntitlementHonored(record, Date.parse(graceEndsAt) - 1)).toBe(true);
    expect(entitlement.isEntitlementHonored(record, Date.parse(graceEndsAt) + 1)).toBe(false);

    // A grace record with no end named has no bound to enforce.
    expect(entitlement.isEntitlementHonored({ ...record, graceEndsAt: null })).toBe(true);
  });

  it("keeps serving an active record past its period end", async () => {
    // Renewal advances currentPeriodEndsAt moments after the period ends;
    // refusing that gap would lock out subscribers over webhook latency.
    const { entitlement } = await importEntitlement(ENFORCING, { record: null, failure: null });

    expect(entitlement.isEntitlementHonored({
      status: "active",
      capabilities: ["cloud_relay"],
      currentPeriodEndsAt: "2020-01-01T00:00:00.000Z",
      graceEndsAt: null,
    })).toBe(true);
  });

  it("grants only the capabilities the record names", async () => {
    const { entitlement } = await importEntitlement(ENFORCING, {
      record: activeRecord({ capabilities: ["cloud_relay"] }),
      failure: null,
    });

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    expect(await entitlement.sessionHasCapability(phone(), "cloud_task_index")).toBe(false);
  });

  it("refuses an unverified phone token without reading the document", async () => {
    const { entitlement, reads } = await importEntitlement(ENFORCING, {
      record: activeRecord(),
      failure: null,
    });

    const session = await entitlement.resolveSessionEntitlement(phone(false));
    // Named as its own reason, so a client says "verify your email" rather than
    // sending the account to a checkout page that would refuse it too.
    expect(session.snapshot).toEqual({
      active: false,
      status: "unknown",
      currentPeriodEndsAt: null,
      graceEndsAt: null,
      reason: "unverified_email",
    });
    expect(session.grants("cloud_relay")).toBe(false);
    expect(await entitlement.sessionHasCapability(phone(false), "cloud_relay")).toBe(false);
    expect(reads()).toBe(0);

    // A desktop credential session makes no email claim and is unaffected.
    expect(await entitlement.sessionHasCapability(DESKTOP_SUBJECT, "cloud_relay")).toBe(true);
  });

  it("fails open when Firestore is unavailable", async () => {
    const store: EntitlementStore = {
      record: null,
      failure: new Error("14 UNAVAILABLE: Firestore is down"),
    };
    const { entitlement } = await importEntitlement(ENFORCING, store);

    // An outage of the billing database must not disconnect paying subscribers.
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    const session = await entitlement.resolveSessionEntitlement(phone());
    expect(session.grants("cloud_relay")).toBe(true);
    // Honest about it: served, but the relay does not claim to know the state.
    expect(session.snapshot).toMatchObject({ active: true, status: "unknown" });
  });

  it("ignores a document whose status is unusable", async () => {
    const { entitlement } = await importEntitlement(ENFORCING, {
      record: activeRecord({ status: "definitely-paid" }),
      failure: null,
    });

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
  });
});

describe("entitlement cache", () => {
  it("serves a burst of checks from a single read", async () => {
    const { entitlement, reads } = await importEntitlement(ENFORCING, {
      record: activeRecord(),
      failure: null,
    });

    for (let index = 0; index < 50; index += 1) {
      expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    }

    expect(reads()).toBe(1);
  });

  it("caches an absent document too", async () => {
    const { entitlement, reads } = await importEntitlement(ENFORCING, {
      record: null,
      failure: null,
    });

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
    expect(reads()).toBe(1);
  });

  it("never caches a failed read", async () => {
    const store: EntitlementStore = { record: null, failure: new Error("down") };
    const { entitlement, reads } = await importEntitlement(ENFORCING, store);

    await entitlement.sessionHasCapability(phone(), "cloud_relay");
    await entitlement.sessionHasCapability(phone(), "cloud_relay");
    expect(reads()).toBe(2);

    // …and the first good answer after the outage is authoritative.
    store.failure = null;
    store.record = activeRecord();
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
  });

  it("stops honouring an entitlement revoked mid-window within the TTL bound", async () => {
    const store: EntitlementStore = { record: activeRecord(), failure: null };
    const { entitlement } = await importEntitlement(ENFORCING, store);
    vi.useFakeTimers();

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    store.record = activeRecord({ status: "revoked", capabilities: [] });

    // Inside the window the live session keeps the entitlement it was granted.
    vi.advanceTimersByTime(entitlement.DEFAULT_ENTITLEMENT_CACHE_TTL_MS - 1);
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);

    // The TTL is the revocation bound, so it must actually bind.
    vi.advanceTimersByTime(2);
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
  });

  it("picks up a new subscription within the TTL bound, without a reconnect", async () => {
    const store: EntitlementStore = { record: null, failure: null };
    const { entitlement } = await importEntitlement(ENFORCING, store);
    vi.useFakeTimers();

    expect(await entitlement.sessionHasCapability(phone(), "cloud_task_index")).toBe(false);
    store.record = activeRecord();

    vi.advanceTimersByTime(entitlement.DEFAULT_ENTITLEMENT_CACHE_TTL_MS + 1);
    expect(await entitlement.sessionHasCapability(phone(), "cloud_task_index")).toBe(true);
  });

  it("drops a cached entitlement on explicit invalidation", async () => {
    const store: EntitlementStore = { record: activeRecord(), failure: null };
    const { entitlement, reads } = await importEntitlement(ENFORCING, store);

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    store.record = activeRecord({ status: "expired", capabilities: [] });
    entitlement.invalidateEntitlementCache(OWNER);

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
    expect(reads()).toBe(2);
  });

  it("reads through when the cache is disabled", async () => {
    const store: EntitlementStore = { record: activeRecord(), failure: null };
    const { entitlement, reads } = await importEntitlement(
      { ...ENFORCING, KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: "0" },
      store,
    );

    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(true);
    store.record = activeRecord({ status: "revoked", capabilities: [] });
    expect(await entitlement.sessionHasCapability(phone(), "cloud_relay")).toBe(false);
    expect(reads()).toBe(2);
  });
});

describe("entitlement cache TTL configuration", () => {
  it("defaults, honours an override, and ignores an unusable one", async () => {
    const { entitlement } = await importEntitlement({}, { record: null, failure: null });

    expect(entitlement.resolveEntitlementCacheTtlMs({}))
      .toBe(entitlement.DEFAULT_ENTITLEMENT_CACHE_TTL_MS);
    expect(entitlement.resolveEntitlementCacheTtlMs({
      KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: "250",
    })).toBe(250);
    expect(entitlement.resolveEntitlementCacheTtlMs({
      KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: "0",
    })).toBe(0);
    expect(entitlement.resolveEntitlementCacheTtlMs({
      KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: "soon",
    })).toBe(entitlement.DEFAULT_ENTITLEMENT_CACHE_TTL_MS);
    expect(entitlement.resolveEntitlementCacheTtlMs({
      KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: "-1",
    })).toBe(entitlement.DEFAULT_ENTITLEMENT_CACHE_TTL_MS);
  });
});

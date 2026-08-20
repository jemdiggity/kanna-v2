import { describe, expect, it } from "vitest";
import { entitlementChanged, reduceEntitlement } from "../src/billing/entitlement.js";
import {
  appStoreSource,
  billingFixtureAccounts,
  compSource,
  fixtureSourceSnapshot,
  stripeSource,
  FIXTURE_ENVIRONMENT,
} from "../src/billing/fixtures.js";
import {
  CLOUD_ACCESS_CAPABILITIES,
  type BillingSourceSnapshot,
  type EntitlementRecord,
} from "../src/billing/types.js";

const NOW = "2026-08-20T12:00:00.000Z";

function reduce(
  sources: Partial<BillingSourceSnapshot>,
  previous: EntitlementRecord | null = null
): EntitlementRecord | null {
  return reduceEntitlement({
    sources: {
      stripe: sources.stripe ?? null,
      app_store: sources.app_store ?? null,
      comp: sources.comp ?? null,
    },
    previous,
    now: NOW,
    defaultEnvironment: FIXTURE_ENVIRONMENT,
  });
}

describe("recomputeEntitlement reducer", () => {
  describe("each source alone in each state", () => {
    const states = ["active", "grace", "expired", "revoked"] as const;

    it.each(states)("honors a lone stripe source in %s", (status) => {
      const entitlement = reduce({ stripe: stripeSource({ status }) });
      expect(entitlement).toMatchObject({ status, source: "stripe", duplicateSources: false });
      expect(entitlement?.capabilities).toEqual(
        status === "active" || status === "grace" ? [...CLOUD_ACCESS_CAPABILITIES] : []
      );
    });

    it.each(states)("honors a lone app_store source in %s", (status) => {
      const entitlement = reduce({ app_store: appStoreSource({ status }) });
      expect(entitlement).toMatchObject({ status, source: "app_store", duplicateSources: false });
    });

    it("writes nothing when no source and no previous record exist", () => {
      expect(reduce({})).toBeNull();
    });

    it("expires a previously honored record once every source doc is gone", () => {
      const previous = reduce({ stripe: stripeSource() });
      expect(previous).not.toBeNull();
      const entitlement = reduce({}, previous);
      expect(entitlement).toMatchObject({
        status: "expired",
        source: "stripe",
        capabilities: [],
        currentPeriodEndsAt: null,
      });
    });
  });

  describe("comp beats everything", () => {
    it("honors comp over an active stripe subscription without flagging a double-pay", () => {
      const entitlement = reduce({ comp: compSource(), stripe: stripeSource() });
      expect(entitlement).toMatchObject({
        status: "active",
        source: "comp",
        duplicateSources: false,
        currentPeriodEndsAt: null,
        graceEndsAt: null,
      });
    });

    it.each(["active", "grace", "expired", "revoked"] as const)(
      "honors comp beside an app_store source in %s",
      (status) => {
        const entitlement = reduce({
          comp: compSource(),
          app_store: appStoreSource({ status }),
        });
        expect(entitlement).toMatchObject({ status: "active", source: "comp" });
      }
    );

    it("never expires: comp carries no period end or grace machinery", () => {
      const entitlement = reduce({ comp: compSource() });
      expect(entitlement).toMatchObject({
        status: "active",
        source: "comp",
        currentPeriodEndsAt: null,
        graceEndsAt: null,
      });
    });

    it("falls back to the paid source when the comp grant is revoked", () => {
      const comped = reduce({ comp: compSource(), stripe: stripeSource() });
      const entitlement = reduce(
        { comp: compSource({ active: false, revokedAt: NOW }), stripe: stripeSource() },
        comped
      );
      expect(entitlement).toMatchObject({
        status: "active",
        source: "stripe",
        currentPeriodEndsAt: stripeSource().currentPeriodEndsAt,
      });
    });

    it("leaves an account unentitled when a revoked comp is its only source", () => {
      const entitlement = reduce({ comp: compSource({ active: false, revokedAt: NOW }) });
      expect(entitlement).toBeNull();
    });

    it("carries the underlying billing ids through a comp grant", () => {
      const entitlement = reduce({ comp: compSource(), stripe: stripeSource() });
      expect(entitlement).toMatchObject({
        stripeCustomerId: "cus_fixture",
        stripeSubscriptionId: "sub_fixture",
      });
    });
  });

  describe("two billed sources", () => {
    it("flags duplicateSources when both are active and honors the later period end", () => {
      const entitlement = reduce({
        stripe: stripeSource({ currentPeriodEndsAt: "2026-09-20T00:00:00.000Z" }),
        app_store: appStoreSource({ currentPeriodEndsAt: "2026-11-20T00:00:00.000Z" }),
      });
      expect(entitlement).toMatchObject({
        status: "active",
        source: "app_store",
        duplicateSources: true,
        currentPeriodEndsAt: "2026-11-20T00:00:00.000Z",
      });
    });

    it("flags duplicateSources for active beside grace and honors the active one", () => {
      const entitlement = reduce({
        stripe: stripeSource({ status: "grace", graceEndsAt: "2026-09-27T00:00:00.000Z" }),
        app_store: appStoreSource(),
      });
      expect(entitlement).toMatchObject({
        status: "active",
        source: "app_store",
        duplicateSources: true,
      });
    });

    it("lets a revoked source contribute nothing without suppressing the other", () => {
      const entitlement = reduce({
        stripe: stripeSource({ status: "revoked" }),
        app_store: appStoreSource(),
      });
      expect(entitlement).toMatchObject({
        status: "active",
        source: "app_store",
        duplicateSources: false,
      });
    });

    it("does not flag a duplicate when only one source is honored", () => {
      const entitlement = reduce({
        stripe: stripeSource({ status: "expired" }),
        app_store: appStoreSource(),
      });
      expect(entitlement?.duplicateSources).toBe(false);
    });

    it("reports the best status both sources hold when neither is entitled", () => {
      const entitlement = reduce({
        stripe: stripeSource({ status: "revoked" }),
        app_store: appStoreSource({ status: "expired" }),
      });
      expect(entitlement).toMatchObject({ status: "expired", source: "app_store" });
    });
  });

  describe("tie-breaks are stable", () => {
    const tied: Partial<BillingSourceSnapshot> = {
      stripe: stripeSource({ currentPeriodEndsAt: "2026-09-20T00:00:00.000Z" }),
      app_store: appStoreSource({ currentPeriodEndsAt: "2026-09-20T00:00:00.000Z" }),
    };

    it("keeps the previously honored source rather than flapping", () => {
      const previous: EntitlementRecord = {
        ...(reduce(tied) as EntitlementRecord),
        source: "app_store",
      };
      const first = reduce(tied, previous);
      expect(first?.source).toBe("app_store");
      expect(reduce(tied, first)?.source).toBe("app_store");
    });

    it("resolves an otherwise identical tie the same way on every run", () => {
      const runs = Array.from({ length: 5 }, () => reduce(tied)?.source);
      expect(new Set(runs)).toEqual(new Set(["stripe"]));
    });
  });

  describe("the seeded fixture matrix", () => {
    it.each(billingFixtureAccounts.map((account) => [account.uid, account] as const))(
      "derives the documented entitlement for %s",
      (_uid, account) => {
        const entitlement = reduce(fixtureSourceSnapshot(account));
        if (!account.expected) {
          expect(entitlement).toBeNull();
          return;
        }
        expect(entitlement).toMatchObject({
          status: account.expected.status,
          source: account.expected.source,
          duplicateSources: account.expected.duplicateSources,
          currentPeriodEndsAt: account.expected.currentPeriodEndsAt,
          graceEndsAt: account.expected.graceEndsAt,
        });
        expect((entitlement?.capabilities ?? []).length > 0).toBe(account.expected.entitled);
      }
    );
  });

  describe("entitlementChanged", () => {
    it("ignores a bare updatedAt bump so a replay leaves no trace", () => {
      const first = reduce({ stripe: stripeSource() }) as EntitlementRecord;
      const second = { ...first, updatedAt: "2027-01-01T00:00:00.000Z" };
      expect(entitlementChanged(first, second)).toBe(false);
    });

    it("reports a genuine state change", () => {
      const first = reduce({ stripe: stripeSource() }) as EntitlementRecord;
      const second = reduce({ stripe: stripeSource({ status: "expired" }) }) as EntitlementRecord;
      expect(entitlementChanged(first, second)).toBe(true);
    });
  });
});

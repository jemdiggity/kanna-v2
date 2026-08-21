/**
 * The billing backend against the real Firestore emulator.
 *
 * Skipped without `FIRESTORE_EMULATOR_HOST`; run with
 * `./kd emulators exec -- pnpm test`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckoutSession,
  type CheckoutCaller,
  type CreateCheckoutSessionDependencies,
} from "../src/billing/checkout.js";
import { recomputeEntitlement } from "../src/billing/entitlement.js";
import { BillingRequestError } from "../src/billing/errors.js";
import {
  appStoreSource,
  billingFixtureAccounts,
  compSource,
  stripeSource,
  FIXTURE_ENVIRONMENT,
} from "../src/billing/fixtures.js";
import { seedBillingFixtures } from "../src/billing/seed.js";
import type { StripeCheckoutGateway } from "../src/billing/stripeGateway.js";
import { signStripePayload } from "../src/billing/stripeSignature.js";
import { handleStripeWebhook } from "../src/billing/stripeWebhook.js";
import {
  accountCheckoutPath,
  accountDeletionPath,
  billingSourcePath,
  entitlementPath,
  stripeCustomerPath,
  stripeEventPath,
  userDocPath,
  type BilledSourceState,
  type EntitlementRecord,
} from "../src/billing/types.js";
import { deleteAccount, firestoreAccountDeletionStore } from "../src/accountDeletion.js";
import {
  clearFirestoreEmulator,
  emulatorFirestore,
  hasFirestoreEmulator,
  shutdownEmulatorFirestore,
} from "./support/emulator.js";

const describeWithEmulator = hasFirestoreEmulator ? describe : describe.skip;

const WEBHOOK_SECRET = "whsec_slice1_test_secret";
const CHECKOUT_UID = "fixture-checkout-user";
const FIXTURE_DIR = join(import.meta.dirname, "fixtures/stripe");

const webhookEnv: NodeJS.ProcessEnv = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GCLOUD_PROJECT: "kanna-local",
};

const checkoutEnv: NodeJS.ProcessEnv = {
  STRIPE_SECRET_KEY: "sk_test_slice1",
  KANNA_PORTAL_BASE_URL: "https://portal.kanna.build/",
  GCLOUD_PROJECT: "kanna-local",
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fixtureBody(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/**
 * Deliver a fixture the way Stripe does: the raw bytes plus a real signature
 * over those exact bytes.
 *
 * The signature is stamped at delivery time, as Stripe's is — the event's own
 * `created` field is when the event happened, and a signature carrying it would
 * fall outside the replay-tolerance window the moment a fixture ages.
 */
async function deliver(
  db: Firestore,
  name: string,
  options: { secret?: string; now?: string } = {}
) {
  const body = fixtureBody(name);
  const signature = signStripePayload(body, options.secret ?? WEBHOOK_SECRET);
  return handleStripeWebhook(
    { rawBody: Buffer.from(body, "utf8"), signature },
    {
      db,
      env: webhookEnv,
      logger: silentLogger,
      ...(options.now ? { now: () => options.now as string } : {}),
    }
  );
}

async function readDoc<T>(db: Firestore, path: string): Promise<T | null> {
  const snapshot = await db.doc(path).get();
  return (snapshot.data() as T | undefined) ?? null;
}

interface StubGateway extends StripeCheckoutGateway {
  calls: { customers: number; sessions: unknown[]; closedSessions: string[] };
}

function stubGateway(): StubGateway {
  const calls = { customers: 0, sessions: [] as unknown[], closedSessions: [] as string[] };
  return {
    calls,
    async createCustomer() {
      calls.customers += 1;
      return { id: "cus_TestSlice1" };
    },
    async resolvePriceId(lookupKey) {
      return `price_for_${lookupKey}`;
    },
    async createCheckoutSession(input) {
      calls.sessions.push(input);
      return { id: "cs_test_TestSlice1", url: "https://checkout.stripe.com/c/pay/cs_test" };
    },
    async closeCheckoutSession(sessionId) {
      calls.closedSessions.push(sessionId);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describeWithEmulator("billing backend against the Firestore emulator", () => {
  let db: Firestore;

  beforeAll(() => {
    db = emulatorFirestore();
  });

  beforeEach(async () => {
    // A Stripe billing relationship is only valid for an existing account.
    // Webhook application reads this root transactionally so delayed events
    // cannot recreate cloud data after account deletion.
    await db.doc(userDocPath(CHECKOUT_UID)).set({ createdAt: "2026-08-19T00:00:00.000Z" });
  });

  afterEach(async () => {
    await clearFirestoreEmulator();
  });

  afterAll(async () => {
    await shutdownEmulatorFirestore();
  });

  describe("stripeWebhook", () => {
    it("rejects a payload whose signature does not verify", async () => {
      const outcome = await deliver(db, "checkout.session.completed.json", {
        secret: "whsec_a_different_secret",
      });
      expect(outcome).toMatchObject({ httpStatus: 400, code: "invalid_signature" });
      expect(await readDoc(db, billingSourcePath(CHECKOUT_UID, "stripe"))).toBeNull();
    });

    it("rejects a payload with no signature header at all", async () => {
      const body = fixtureBody("checkout.session.completed.json");
      const outcome = await handleStripeWebhook(
        { rawBody: body, signature: undefined },
        { db, env: webhookEnv, logger: silentLogger }
      );
      expect(outcome).toMatchObject({ httpStatus: 400, code: "invalid_signature" });
    });

    it("refuses to run at all when the webhook secret is not configured", async () => {
      const body = fixtureBody("checkout.session.completed.json");
      const outcome = await handleStripeWebhook(
        { rawBody: body, signature: signStripePayload(body, WEBHOOK_SECRET) },
        { db, env: { GCLOUD_PROJECT: "kanna-local" }, logger: silentLogger }
      );
      expect(outcome).toMatchObject({ httpStatus: 500, code: "not_configured" });
      expect(outcome.message).toContain("STRIPE_WEBHOOK_SECRET");
    });

    it("acknowledges an event type it does not handle without recording it", async () => {
      const outcome = await deliver(db, "customer.updated.json");
      expect(outcome).toMatchObject({ httpStatus: 200, code: "ignored" });
      expect(await readDoc(db, stripeEventPath("evt_customer_updated"))).toBeNull();
    });

    it("acknowledges and drops an event that resolves to no account", async () => {
      const body = JSON.parse(fixtureBody("customer.subscription.created.json")) as {
        data: { object: { metadata: Record<string, string> } };
      };
      body.data.object.metadata = {};
      const raw = JSON.stringify(body);
      const outcome = await handleStripeWebhook(
        { rawBody: raw, signature: signStripePayload(raw, WEBHOOK_SECRET) },
        { db, env: webhookEnv, logger: silentLogger }
      );
      expect(outcome).toMatchObject({ httpStatus: 200, code: "unresolved_account" });
    });

    it("resolves the account through the customer reverse map when metadata is absent", async () => {
      await db
        .doc(stripeCustomerPath("cus_TestSlice1"))
        .set({ uid: CHECKOUT_UID, updatedAt: "2026-08-19T00:00:00.000Z" });

      const body = JSON.parse(fixtureBody("customer.subscription.created.json")) as {
        data: { object: { metadata: Record<string, string> } };
      };
      body.data.object.metadata = {};
      const raw = JSON.stringify(body);
      const outcome = await handleStripeWebhook(
        { rawBody: raw, signature: signStripePayload(raw, WEBHOOK_SECRET) },
        { db, env: webhookEnv, logger: silentLogger }
      );
      expect(outcome).toMatchObject({ code: "applied", uid: CHECKOUT_UID });
    });

    it("processes a duplicate event id exactly once", async () => {
      const first = await deliver(db, "customer.subscription.created.json", {
        now: "2026-08-19T00:00:05.000Z",
      });
      expect(first).toMatchObject({ code: "applied", entitlementWritten: true });

      const sourceBefore = await readDoc<BilledSourceState>(
        db,
        billingSourcePath(CHECKOUT_UID, "stripe")
      );
      const entitlementBefore = await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID));

      const replay = await deliver(db, "customer.subscription.created.json", {
        now: "2026-08-19T00:09:09.000Z",
      });
      expect(replay).toMatchObject({ code: "duplicate", entitlementWritten: false });

      expect(await readDoc(db, billingSourcePath(CHECKOUT_UID, "stripe"))).toEqual(sourceBefore);
      expect(await readDoc(db, entitlementPath(CHECKOUT_UID))).toEqual(entitlementBefore);
    });

    it("does not let a delayed cancellation webhook write after deletion starts", async () => {
      await db.doc(accountDeletionPath(CHECKOUT_UID)).set({ uid: CHECKOUT_UID, started: true });

      const result = await deliver(db, "customer.subscription.deleted.json");

      expect(result).toMatchObject({ code: "deleted_account", uid: CHECKOUT_UID });
      expect(await readDoc(db, stripeEventPath("evt_subscription_deleted"))).toBeNull();
      expect(await readDoc(db, billingSourcePath(CHECKOUT_UID, "stripe"))).toBeNull();
      expect(await readDoc(db, entitlementPath(CHECKOUT_UID))).toBeNull();
    });

    it("never lets a late older event walk back newer state", async () => {
      await deliver(db, "customer.subscription.deleted.json");
      expect(
        (await readDoc<BilledSourceState>(db, billingSourcePath(CHECKOUT_UID, "stripe")))?.status
      ).toBe("expired");

      const stale = await deliver(db, "customer.subscription.created.json");
      expect(stale.code).toBe("stale");
      expect(
        (await readDoc<BilledSourceState>(db, billingSourcePath(CHECKOUT_UID, "stripe")))?.status
      ).toBe("expired");
    });

    it("still records a stale event so it is never reprocessed", async () => {
      await deliver(db, "customer.subscription.deleted.json");
      await deliver(db, "customer.subscription.created.json");
      expect(await readDoc(db, stripeEventPath("evt_subscription_created"))).toMatchObject({
        uid: CHECKOUT_UID,
        type: "customer.subscription.created",
      });
    });

    it("carries a checkout session through to a granted entitlement", async () => {
      const checkout = await deliver(db, "checkout.session.completed.json");
      expect(checkout).toMatchObject({ code: "applied", uid: CHECKOUT_UID });

      expect(await readDoc(db, stripeCustomerPath("cus_TestSlice1"))).toMatchObject({
        uid: CHECKOUT_UID,
      });

      const subscription = await deliver(db, "customer.subscription.created.json");
      expect(subscription.code).toBe("applied");

      expect(
        await readDoc<BilledSourceState>(db, billingSourcePath(CHECKOUT_UID, "stripe"))
      ).toMatchObject({
        source: "stripe",
        status: "active",
        currentPeriodEndsAt: "2026-09-19T00:00:00.000Z",
        stripeCustomerId: "cus_TestSlice1",
        stripeSubscriptionId: "sub_TestSlice1",
      });

      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "active",
        source: "stripe",
        duplicateSources: false,
        currentPeriodEndsAt: "2026-09-19T00:00:00.000Z",
        capabilities: ["cloud_relay", "cloud_task_index", "remote_task_control"],
      });
    });

    it("writes only the stripe source doc, never the entitlement doc directly", async () => {
      await deliver(db, "checkout.session.completed.json");
      await deliver(db, "customer.subscription.created.json");

      const billing = await db.collection(`users/${CHECKOUT_UID}/billing`).get();
      expect(billing.docs.map((doc) => doc.id)).toEqual(["stripe"]);
    });

    it("walks the full dunning lifecycle into and back out of grace", async () => {
      await deliver(db, "customer.subscription.created.json");
      await deliver(db, "invoice.payment_failed.json");

      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "grace",
        source: "stripe",
        graceEndsAt: "2026-09-26T00:00:00.000Z",
      });

      await deliver(db, "customer.subscription.updated.unpaid.json");
      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "expired",
        capabilities: [],
      });
    });

    it("renews the period from a paid invoice", async () => {
      await deliver(db, "customer.subscription.created.json");
      await deliver(db, "invoice.paid.json");
      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "active",
        currentPeriodEndsAt: "2026-10-19T00:00:00.000Z",
      });
    });

    it("leaves a comped account entitled no matter what Stripe says", async () => {
      await db.doc(billingSourcePath(CHECKOUT_UID, "comp")).set(compSource());
      await deliver(db, "customer.subscription.deleted.json");

      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "active",
        source: "comp",
        duplicateSources: false,
      });
    });

    it("does not let a canceled Stripe subscription erase a live Apple one", async () => {
      await db.doc(billingSourcePath(CHECKOUT_UID, "app_store")).set(appStoreSource());
      await deliver(db, "customer.subscription.deleted.json");

      expect(await readDoc<EntitlementRecord>(db, entitlementPath(CHECKOUT_UID))).toMatchObject({
        status: "active",
        source: "app_store",
      });
    });
  });

  describe("createCheckoutSession", () => {
    const verified: CheckoutCaller = {
      uid: CHECKOUT_UID,
      email: "checkout@example.com",
      emailVerified: true,
    };

    function deps(gateway: StripeCheckoutGateway): CreateCheckoutSessionDependencies {
      return { db, env: checkoutEnv, gateway, logger: silentLogger };
    }

    async function expectRefusal(
      caller: CheckoutCaller | null,
      reason: string
    ): Promise<BillingRequestError> {
      const gateway = stubGateway();
      const error = await createCheckoutSession({ plan: "monthly" }, caller, deps(gateway)).then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(BillingRequestError);
      const billingError = error as BillingRequestError;
      expect(billingError.reason).toBe(reason);
      expect(gateway.calls.sessions).toHaveLength(0);
      return billingError;
    }

    it("refuses an anonymous caller", async () => {
      const error = await expectRefusal(null, "sign_in_required");
      expect(error.code).toBe("unauthenticated");
    });

    it("refuses an unverified email address before Stripe is ever called", async () => {
      await expectRefusal({ ...verified, emailVerified: false }, "email_verification_required");
    });

    it("refuses a tombstoned account before creating Stripe or Firestore state", async () => {
      await db.doc(accountDeletionPath(CHECKOUT_UID)).set({
        uid: CHECKOUT_UID,
        started: true,
      });
      const before = await readDoc<Record<string, unknown>>(db, userDocPath(CHECKOUT_UID));
      const gateway = stubGateway();

      await expect(
        createCheckoutSession({ plan: "monthly" }, verified, deps(gateway)),
      ).rejects.toMatchObject({
        code: "failed-precondition",
        reason: "account_deleted",
      });

      expect(gateway.calls.customers).toBe(0);
      expect(gateway.calls.sessions).toHaveLength(0);
      expect(await readDoc(db, userDocPath(CHECKOUT_UID))).toEqual(before);
      expect((await db.collection("stripeCustomers").where("uid", "==", CHECKOUT_UID).get()).empty)
        .toBe(true);
    });

    it("refuses an unknown plan", async () => {
      const gateway = stubGateway();
      await expect(
        createCheckoutSession({ plan: "lifetime" }, verified, deps(gateway))
      ).rejects.toMatchObject({ reason: "unknown_plan" });
    });

    it("never lets a comped account pay", async () => {
      await db.doc(billingSourcePath(CHECKOUT_UID, "comp")).set(compSource());
      await expectRefusal(verified, "comp_active");
    });

    it("sends an App Store subscriber to Apple with a distinct reason", async () => {
      await db.doc(billingSourcePath(CHECKOUT_UID, "app_store")).set(appStoreSource());
      const error = await expectRefusal(verified, "app_store_active");
      expect(error.message).toContain("App Store");
    });

    it("refuses a second subscription while the first is active", async () => {
      await db.doc(billingSourcePath(CHECKOUT_UID, "stripe")).set(stripeSource());
      await expectRefusal(verified, "already_subscribed");
    });

    it("refuses while a Stripe subscription is in grace", async () => {
      await db
        .doc(billingSourcePath(CHECKOUT_UID, "stripe"))
        .set(stripeSource({ status: "grace" }));
      await expectRefusal(verified, "already_subscribed");
    });

    it("allows a new checkout once the previous subscription expired", async () => {
      await db
        .doc(billingSourcePath(CHECKOUT_UID, "stripe"))
        .set(stripeSource({ status: "expired" }));
      const gateway = stubGateway();
      await expect(
        createCheckoutSession({ plan: "monthly" }, verified, deps(gateway))
      ).resolves.toMatchObject({ sessionId: "cs_test_TestSlice1" });
    });

    it("reports a clear configuration error rather than calling Stripe with no key", async () => {
      const gateway = stubGateway();
      await expect(
        createCheckoutSession({ plan: "monthly" }, verified, {
          db,
          env: { GCLOUD_PROJECT: "kanna-local" },
          gateway,
          logger: silentLogger,
        })
      ).rejects.toMatchObject({ reason: "not_configured" });
      expect(gateway.calls.customers).toBe(0);
    });

    it("creates a customer stamped with the uid and records the reverse map", async () => {
      const gateway = stubGateway();
      const result = await createCheckoutSession({ plan: "monthly" }, verified, deps(gateway));

      expect(result).toMatchObject({
        sessionId: "cs_test_TestSlice1",
        customerId: "cus_TestSlice1",
      });
      expect(gateway.calls.sessions[0]).toMatchObject({
        uid: CHECKOUT_UID,
        priceId: "price_for_cloud_monthly_usd",
        successUrl: "https://portal.kanna.build/billing/success?session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://portal.kanna.build/billing/canceled",
      });
      expect(await readDoc(db, userDocPath(CHECKOUT_UID))).toMatchObject({
        stripeCustomerId: "cus_TestSlice1",
      });
      expect(await readDoc(db, stripeCustomerPath("cus_TestSlice1"))).toMatchObject({
        uid: CHECKOUT_UID,
      });
    });

    it("rejects the unpriced annual plan", async () => {
      const gateway = stubGateway();
      await expect(createCheckoutSession({ plan: "annual" }, verified, deps(gateway)))
        .rejects.toMatchObject({ reason: "unknown_plan" });
    });

    it("resolves the selected currency by stable lookup key", async () => {
      const gateway = stubGateway();
      await createCheckoutSession({ plan: "monthly", currency: "jpy" }, verified, deps(gateway));
      expect(gateway.calls.sessions[0]).toMatchObject({ priceId: "price_for_cloud_monthly_jpy" });
    });

    it("reuses the account's existing Stripe customer", async () => {
      const gateway = stubGateway();
      await createCheckoutSession({ plan: "monthly" }, verified, deps(gateway));
      await createCheckoutSession({ plan: "monthly" }, verified, deps(gateway));
      expect(gateway.calls.customers).toBe(1);
    });

    it("writes no billing source doc merely because checkout was opened", async () => {
      const gateway = stubGateway();
      await createCheckoutSession({ plan: "monthly" }, verified, deps(gateway));
      const billing = await db.collection(`users/${CHECKOUT_UID}/billing`).get();
      expect(billing.empty).toBe(true);
      expect(await readDoc(db, entitlementPath(CHECKOUT_UID))).toBeNull();
    });
  });

  describe("seeded fixtures", () => {
    it("derives the documented entitlement for every fixture account", async () => {
      await seedBillingFixtures(db, "2026-08-20T00:00:00.000Z");

      for (const account of billingFixtureAccounts) {
        const entitlement = await readDoc<EntitlementRecord>(db, entitlementPath(account.uid));
        if (!account.expected) {
          expect(entitlement, account.uid).toBeNull();
          continue;
        }
        expect(entitlement, account.uid).toMatchObject({
          status: account.expected.status,
          source: account.expected.source,
          duplicateSources: account.expected.duplicateSources,
          currentPeriodEndsAt: account.expected.currentPeriodEndsAt,
        });
      }
    });

    it("leaves the entitlement doc untouched when a recompute changes nothing", async () => {
      await db.doc(billingSourcePath("fixture-idempotent", "stripe")).set(stripeSource());
      const first = await recomputeEntitlement({
        db,
        uid: "fixture-idempotent",
        defaultEnvironment: FIXTURE_ENVIRONMENT,
        now: "2026-08-20T00:00:00.000Z",
      });
      expect(first.written).toBe(true);

      const second = await recomputeEntitlement({
        db,
        uid: "fixture-idempotent",
        defaultEnvironment: FIXTURE_ENVIRONMENT,
        now: "2026-08-21T00:00:00.000Z",
      });
      expect(second.written).toBe(false);
      expect(
        (await readDoc<EntitlementRecord>(db, entitlementPath("fixture-idempotent")))?.updatedAt
      ).toBe("2026-08-20T00:00:00.000Z");
    });
  });

  describe("account deletion", () => {
    it("serializes deletion against an admitted checkout and closes its Stripe session", async () => {
      const uid = CHECKOUT_UID;
      const enteredStripe = deferred();
      const releaseStripe = deferred();
      const usableSessions = new Set<string>();
      const gateway: StripeCheckoutGateway = {
        async createCustomer() {
          return { id: "cus_racing_delete" };
        },
        async resolvePriceId() {
          return "price_for_cloud_monthly_usd";
        },
        async createCheckoutSession() {
          enteredStripe.resolve();
          await releaseStripe.promise;
          usableSessions.add("cs_racing_delete");
          return {
            id: "cs_racing_delete",
            url: "https://checkout.stripe.test/cs_racing_delete",
          };
        },
        async closeCheckoutSession(sessionId) {
          usableSessions.delete(sessionId);
        },
      };
      const cancelSubscription = vi.fn(async () => undefined);
      const closeCheckoutSession = vi.fn(async (sessionId: string) => {
        await gateway.closeCheckoutSession(sessionId);
      });
      const auth = {
        revokeRefreshTokens: vi.fn(async () => undefined),
        deleteUser: vi.fn(async () => undefined),
      };
      const deletionDependencies = {
        store: firestoreAccountDeletionStore(db),
        stripe: { cancelSubscription, closeCheckoutSession },
        auth,
      };

      const checkout = createCheckoutSession(
        { plan: "monthly" },
        { uid, email: "checkout@example.com", emailVerified: true },
        { db, env: checkoutEnv, gateway, logger: silentLogger },
      );
      await enteredStripe.promise;

      await expect(deleteAccount({ uid }, deletionDependencies)).rejects.toMatchObject({
        code: "failed-precondition",
        reason: "checkout_in_progress",
      });
      expect(auth.deleteUser).not.toHaveBeenCalled();

      releaseStripe.resolve();
      await expect(checkout).resolves.toMatchObject({ sessionId: "cs_racing_delete" });
      expect(usableSessions).toEqual(new Set(["cs_racing_delete"]));

      await expect(deleteAccount({ uid }, deletionDependencies)).resolves.toEqual({ deleted: true });

      expect(closeCheckoutSession).toHaveBeenCalledWith("cs_racing_delete");
      expect(usableSessions.size).toBe(0);
      expect((await db.doc(userDocPath(uid)).get()).exists).toBe(false);
      expect((await db.collection("stripeCustomers").where("uid", "==", uid).get()).empty)
        .toBe(true);
      expect((await db.doc(accountCheckoutPath(uid)).get()).exists).toBe(false);
      expect((await db.doc(accountDeletionPath(uid)).get()).exists).toBe(true);
      expect(auth.deleteUser).toHaveBeenCalledWith(uid);
    });

    it("removes every uid-owned Firestore record, including nested mirrors and relay pairings", async () => {
      const uid = "fixture-delete-user";
      await Promise.all([
        db.doc(`users/${uid}`).set({ stripeCustomerId: "cus_delete" }),
        db.doc(`users/${uid}/billing/stripe`).set(stripeSource({ stripeSubscriptionId: "sub_delete" })),
        db.doc(`users/${uid}/billing/comp`).set(compSource()),
        db.doc(`users/${uid}/entitlements/cloud_access`).set({ status: "active" }),
        db.doc(`users/${uid}/desktops/desktop-1`).set({ desktopId: "desktop-1" }),
        db.doc(`users/${uid}/desktops/desktop-1/tasks/task-1`).set({ title: "private" }),
        db.doc(`users/${uid}/pushDevices/push-1`).set({ token: "push" }),
        db.doc("stripeCustomers/cus_delete").set({ uid }),
        db.doc("stripeEvents/evt_delete").set({ uid }),
        db.doc("appAccountTokens/token-delete").set({ uid }),
        db.doc("desktopCredentials/desktop-1").set({ uid }),
        db.doc("devices/legacy-delete").set({ userId: uid }),
        db.doc("users/other-user/desktops/desktop-other").set({ desktopId: "desktop-other" }),
      ]);
      const cancelSubscription = vi.fn(async () => undefined);
      const closeCheckoutSession = vi.fn(async () => undefined);
      const auth = {
        revokeRefreshTokens: vi.fn(async () => undefined),
        deleteUser: vi.fn(async () => undefined),
      };

      await deleteAccount(
        { uid },
        {
          store: firestoreAccountDeletionStore(db),
          stripe: { cancelSubscription, closeCheckoutSession },
          auth,
        },
      );

      expect(cancelSubscription).toHaveBeenCalledWith("sub_delete");
      for (const path of [
        `users/${uid}`,
        `users/${uid}/billing/stripe`,
        `users/${uid}/billing/comp`,
        `users/${uid}/entitlements/cloud_access`,
        `users/${uid}/desktops/desktop-1`,
        `users/${uid}/desktops/desktop-1/tasks/task-1`,
        `users/${uid}/pushDevices/push-1`,
        "stripeCustomers/cus_delete",
        "stripeEvents/evt_delete",
        "appAccountTokens/token-delete",
        "desktopCredentials/desktop-1",
        "devices/legacy-delete",
      ]) {
        expect((await db.doc(path).get()).exists, path).toBe(false);
      }
      expect((await db.doc(accountDeletionPath(uid)).get()).data()).toMatchObject({
        uid,
        started: true,
      });
      expect((await db.doc("users/other-user/desktops/desktop-other").get()).exists).toBe(true);
      expect(auth.revokeRefreshTokens).toHaveBeenCalledWith(uid);
      expect(auth.deleteUser).toHaveBeenCalledWith(uid);
    });
  });
});

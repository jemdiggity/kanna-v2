/**
 * Complimentary access grants against the real Firestore emulator.
 *
 * Skipped without `FIRESTORE_EMULATOR_HOST`; run with
 * `./kd emulators exec -- pnpm test`.
 *
 * The property under test is the one an operator cannot see: writing
 * `billing/comp` grants nothing by itself, because no Firestore trigger watches
 * the source docs. Every assertion below reads the derived entitlement record,
 * never the source doc alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  GRANDFATHERED_REASON,
  grantCompAccess,
  revokeCompAccess,
} from "../src/billing/comp.js";
import { stripeSource } from "../src/billing/fixtures.js";
import {
  billingSourcePath,
  entitlementPath,
  type CompSourceState,
  type EntitlementRecord,
} from "../src/billing/types.js";
import {
  clearFirestoreEmulator,
  emulatorFirestore,
  hasFirestoreEmulator,
  shutdownEmulatorFirestore,
} from "./support/emulator.js";

const describeWithEmulator = hasFirestoreEmulator ? describe : describe.skip;

const UID = "comp-grant-user";
const OPERATOR = "operator@example.com";
const ENVIRONMENT = "staging" as const;

describeWithEmulator("comp access grants", () => {
  let db: Firestore;

  beforeAll(() => {
    db = emulatorFirestore();
  });

  afterEach(async () => {
    await clearFirestoreEmulator();
  });

  afterAll(async () => {
    await shutdownEmulatorFirestore();
  });

  async function entitlement(uid = UID): Promise<EntitlementRecord | undefined> {
    return (await db.doc(entitlementPath(uid)).get()).data() as EntitlementRecord | undefined;
  }

  async function comp(uid = UID): Promise<CompSourceState | undefined> {
    return (await db.doc(billingSourcePath(uid, "comp")).get()).data() as CompSourceState | undefined;
  }

  it("grants cloud access to an account with no billing relationship", async () => {
    const result = await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });

    expect(await comp()).toMatchObject({
      source: "comp",
      active: true,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      revokedAt: null,
    });
    // The point of the exercise: the derived record, not the source doc.
    expect(result.entitlement).toMatchObject({ status: "active", source: "comp" });
    expect(await entitlement()).toMatchObject({
      status: "active",
      source: "comp",
      // Comp never expires; only an explicit revocation ends it.
      currentPeriodEndsAt: null,
      graceEndsAt: null,
      duplicateSources: false,
      capabilities: ["cloud_relay", "cloud_task_index", "remote_task_control"],
    });
  });

  it("grants nothing when only the source doc is written", async () => {
    // The mistake the runbook exists to prevent: a hand-written comp doc with
    // no recompute leaves the account exactly as unentitled as it was.
    await db.doc(billingSourcePath(UID, "comp")).set({
      source: "comp",
      active: true,
      reason: "written by hand",
      grantedBy: OPERATOR,
      grantedAt: "2026-08-21T00:00:00.000Z",
      revokedAt: null,
      updatedAt: "2026-08-21T00:00:00.000Z",
    });

    expect(await entitlement()).toBeUndefined();

    // …and the recompute the script runs is what makes it real.
    await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });
    expect(await entitlement()).toMatchObject({ status: "active", source: "comp" });
  });

  it("is idempotent and keeps the original grant instant", async () => {
    const first = await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
      now: "2026-08-21T00:00:00.000Z",
    });
    const second = await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
      now: "2026-08-22T00:00:00.000Z",
    });

    expect(second.comp.grantedAt).toBe(first.comp.grantedAt);
    // `updatedAt` on the entitlement is a last-*changed* stamp, so an unchanged
    // grant leaves no trace on the derived record.
    expect((await entitlement())?.updatedAt).toBe("2026-08-21T00:00:00.000Z");
  });

  it("takes precedence over a paid subscription without flagging a double-pay", async () => {
    await db.doc(billingSourcePath(UID, "stripe")).set(stripeSource());
    await grantCompAccess({
      db,
      uid: UID,
      reason: "owner account",
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });

    // Comp beside a paid subscription is a gift, not a double-pay.
    expect(await entitlement()).toMatchObject({
      status: "active",
      source: "comp",
      duplicateSources: false,
      currentPeriodEndsAt: null,
    });
  });

  it("falls back to the paid source on revocation", async () => {
    await db.doc(billingSourcePath(UID, "stripe")).set(stripeSource());
    await grantCompAccess({
      db,
      uid: UID,
      reason: "owner account",
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });

    const result = await revokeCompAccess({ db, uid: UID, defaultEnvironment: ENVIRONMENT });

    expect(result.comp).toMatchObject({ active: false, reason: "owner account" });
    expect(result.comp.revokedAt).toEqual(expect.any(String));
    // Comping a paying user and later un-comping them must be safe.
    expect(await entitlement()).toMatchObject({ status: "active", source: "stripe" });
  });

  it("ends cloud access on revocation when nothing paid remains", async () => {
    await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });

    await revokeCompAccess({ db, uid: UID, defaultEnvironment: ENVIRONMENT });

    expect(await entitlement()).toMatchObject({ status: "expired", capabilities: [] });
    // The grant is deactivated rather than deleted, so the history stays legible.
    expect(await comp()).toMatchObject({ active: false, reason: GRANDFATHERED_REASON });
  });

  it("re-grants a revoked comp without inventing a new grant", async () => {
    await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
      now: "2026-08-21T00:00:00.000Z",
    });
    await revokeCompAccess({ db, uid: UID, defaultEnvironment: ENVIRONMENT });
    const regranted = await grantCompAccess({
      db,
      uid: UID,
      reason: GRANDFATHERED_REASON,
      grantedBy: OPERATOR,
      defaultEnvironment: ENVIRONMENT,
    });

    expect(regranted.comp.grantedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(regranted.comp.revokedAt).toBeNull();
    expect(await entitlement()).toMatchObject({ status: "active", source: "comp" });
  });
});

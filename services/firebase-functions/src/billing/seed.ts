/**
 * Write the billing fixtures into a Firestore instance (the emulator, in
 * practice) and derive each account's entitlement with the real reducer.
 *
 * Used by `scripts/seed-billing-fixtures.mjs` and by the emulator tests, so a
 * developer running `./kd dev up --emulators` and a test asserting the matrix
 * see exactly the same accounts.
 *
 * This lives under `src/` because it needs the compiled reducer, so it does
 * reach the deploy bundle — but `src/index.ts` exports no function that calls
 * it, and the script that does refuses to run without `FIRESTORE_EMULATOR_HOST`.
 * It cannot fabricate an entitlement in a real project.
 */
import type { Firestore } from "firebase-admin/firestore";
import { recomputeEntitlement } from "./entitlement.js";
import {
  billingFixtureAccounts,
  FIXTURE_ENVIRONMENT,
  type BillingFixtureAccount,
} from "./fixtures.js";
import { billingSourcePath, userDocPath, type BillingSourceId } from "./types.js";

export interface SeedBillingFixturesResult {
  uid: string;
  entitlementStatus: string | null;
}

export async function seedBillingFixtureAccount(
  db: Firestore,
  account: BillingFixtureAccount,
  now?: string
): Promise<SeedBillingFixturesResult> {
  await db.doc(userDocPath(account.uid)).set(
    {
      primaryEmail: account.email,
      emailVerified: account.emailVerified,
      updatedAt: now ?? new Date().toISOString(),
    },
    { merge: true }
  );

  for (const source of ["stripe", "app_store", "comp"] as BillingSourceId[]) {
    const state = account.sources[source];
    if (!state) continue;
    await db.doc(billingSourcePath(account.uid, source)).set(state);
  }

  const result = await recomputeEntitlement({
    db,
    uid: account.uid,
    defaultEnvironment: FIXTURE_ENVIRONMENT,
    ...(now ? { now } : {}),
  });
  return { uid: account.uid, entitlementStatus: result.entitlement?.status ?? null };
}

export async function seedBillingFixtures(
  db: Firestore,
  now?: string
): Promise<SeedBillingFixturesResult[]> {
  const results: SeedBillingFixturesResult[] = [];
  for (const account of billingFixtureAccounts) {
    results.push(await seedBillingFixtureAccount(db, account, now));
  }
  return results;
}

#!/usr/bin/env node
/**
 * Seed the billing fixtures into a running Firebase emulator.
 *
 *   pnpm --filter @kanna/firebase-functions seed:billing
 *
 * Requires `FIRESTORE_EMULATOR_HOST` (./kd dev up --emulators exports it) and a
 * prior `pnpm --filter @kanna/firebase-functions build`, since the fixtures and
 * the reducer that derives their entitlements are TypeScript.
 *
 * Refuses to run against anything but an emulator: these accounts are test
 * data, and writing them into staging or production would fabricate
 * entitlements.
 */
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    "FIRESTORE_EMULATOR_HOST is not set. Start the emulators first (./kd dev up --emulators) — this script never writes to a real project."
  );
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT || "kanna-local";
const { default: admin } = await import("firebase-admin");
const { seedBillingFixtures } = await import("../dist/src/billing/seed.js");

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

const results = await seedBillingFixtures(admin.firestore());
console.log(JSON.stringify({ projectId, seeded: results }, null, 2));

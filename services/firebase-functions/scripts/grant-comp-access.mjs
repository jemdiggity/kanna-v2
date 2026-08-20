#!/usr/bin/env node
/**
 * Grant or revoke complimentary (`comp`) cloud access — the owner's "leech
 * flag", and the mechanism the existing invited accounts are grandfathered
 * onto (`docs/specs/accounts-and-billing.md`, Decisions 3 and 5).
 *
 *   # Emulator (default): the accounts must already exist in Firebase Auth.
 *   pnpm --filter @kanna/firebase-functions comp:grant -- friend@example.com
 *
 *   # A real project — human operators only, per the production rule.
 *   pnpm --filter @kanna/firebase-functions comp:grant -- \
 *     --project kanna-build --confirm kanna-build \
 *     --reason grandfathered friend@example.com
 *
 * Options:
 *   --revoke              Revoke instead of granting.
 *   --reason <text>       Why (default: "grandfathered"). Stamped on the doc.
 *   --granted-by <who>    Operator identity for the audit trail (default $USER).
 *   --project <id>        Target a real Firebase project instead of the emulator.
 *   --confirm <id>        Must repeat --project; the deliberate second keystroke.
 *   --dry-run             Resolve the accounts and print the plan; write nothing.
 *
 * Targets are email addresses or raw uids, in any mix. An email is resolved
 * through Firebase Auth, so a typo fails before anything is written rather than
 * comping a uid nobody owns.
 *
 * The script writes `users/{uid}/billing/comp` and then calls
 * `recomputeEntitlement` itself. That second step is not optional bookkeeping:
 * no Firestore trigger watches the source docs, so a comp doc written without a
 * recompute grants nothing at all. See `docs/comp-access-runbook.md`.
 */
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    revoke: false,
    reason: "grandfathered",
    grantedBy: process.env.USER || process.env.LOGNAME || "operator",
    project: null,
    confirm: null,
    dryRun: false,
    targets: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) fail(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      // pnpm forwards its own `--` separator through to argv; ignore it so the
      // documented `pnpm ... comp:grant -- --revoke user@example.com` works.
      case "--": break;
      case "--revoke": options.revoke = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--reason": options.reason = value(); break;
      case "--granted-by": options.grantedBy = value(); break;
      case "--project": options.project = value(); break;
      case "--confirm": options.confirm = value(); break;
      default:
        if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
        options.targets.push(arg);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.targets.length === 0) {
  fail("Name at least one account, by email address or uid.");
}

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

// Two mutually exclusive modes, and neither can be entered by accident. The
// emulator is the default because that is where agents and tests run; a real
// project has to be named twice, because this script hands out paid access.
if (options.project) {
  if (options.confirm !== options.project) {
    fail(
      `Writing to ${options.project} needs --confirm ${options.project}. ` +
      "Granting complimentary access in a real project is a human operator action " +
      "(docs/comp-access-runbook.md)."
    );
  }
  if (emulatorHost) {
    fail(
      `FIRESTORE_EMULATOR_HOST=${emulatorHost} is set, so this process would write to the ` +
      "emulator no matter what --project says. Unset it and run again."
    );
  }
} else if (!emulatorHost) {
  fail(
    "FIRESTORE_EMULATOR_HOST is not set. Start the emulators (./kd dev up --emulators) " +
    "or name a real project with --project <id> --confirm <id>."
  );
}

const projectId = options.project || process.env.GCLOUD_PROJECT || "kanna-local";

const { default: admin } = await import("firebase-admin");
const { grantCompAccess, revokeCompAccess } = await import("../dist/src/billing/comp.js");
const { resolveBillingEnvironment } = await import("../dist/src/billing/config.js");

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

const auth = admin.auth();
const db = admin.firestore();
const defaultEnvironment = resolveBillingEnvironment({ ...process.env, GCLOUD_PROJECT: projectId });

/** Resolve every target to a uid first, so a typo aborts before any write. */
const accounts = [];
for (const target of options.targets) {
  if (target.includes("@")) {
    const user = await auth.getUserByEmail(target).catch((error) => {
      fail(`No account for ${target} in ${projectId}: ${error.message ?? error}`);
    });
    accounts.push({ uid: user.uid, email: user.email ?? target, emailVerified: user.emailVerified });
  } else {
    const user = await auth.getUser(target).catch((error) => {
      fail(`No account for uid ${target} in ${projectId}: ${error.message ?? error}`);
    });
    accounts.push({ uid: user.uid, email: user.email ?? null, emailVerified: user.emailVerified });
  }
}

const action = options.revoke ? "revoke" : "grant";
console.log(JSON.stringify({
  projectId,
  environment: defaultEnvironment,
  action,
  reason: options.revoke ? null : options.reason,
  grantedBy: options.revoke ? null : options.grantedBy,
  dryRun: options.dryRun,
  accounts,
}, null, 2));

if (options.dryRun) {
  console.log("--dry-run: nothing was written.");
  process.exit(0);
}

const results = [];
for (const account of accounts) {
  const result = options.revoke
    ? await revokeCompAccess({ db, uid: account.uid, defaultEnvironment })
    : await grantCompAccess({
        db,
        uid: account.uid,
        reason: options.reason,
        grantedBy: options.grantedBy,
        defaultEnvironment,
      });
  results.push({
    uid: result.uid,
    email: account.email,
    compActive: result.comp.active,
    entitlementStatus: result.entitlement?.status ?? null,
    entitlementSource: result.entitlement?.source ?? null,
  });
}

console.log(JSON.stringify({ projectId, action, results }, null, 2));

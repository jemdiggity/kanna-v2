# Complimentary (`comp`) cloud access — operator runbook

Complimentary access is the owner's "leech flag": cloud access with no billing
relationship, for accounts that should not pay — the owner's own accounts, the
App Review demo account, and legacy users who predate billing and are
grandfathered in. It is one of the three sources the entitlement reducer reads
(`docs/specs/accounts-and-billing.md`, Decision 3).

There is no admin UI in v1 and no callable function: a grant is an operator
action, run from this repo against the emulator or, by a human, against a real
project.

## The one thing that is easy to get wrong

**Writing `users/{uid}/billing/comp` by hand grants nothing.** No Firestore
trigger watches the billing source docs — `users/{uid}/entitlements/cloud_access`
is derived only when something calls `recomputeEntitlement(uid)`. A hand-written
comp doc leaves the account exactly as unentitled as it was, and the discrepancy
is invisible until somebody reads the entitlement doc.

So: use the script below, which writes and recomputes in that order. If you do
edit a source doc by hand — from the Firebase console, or an ad-hoc admin-SDK
snippet — you must run the recompute yourself afterwards, for that uid, in the
same project.

## Granting

```bash
# Against the emulator (./kd dev up --emulators exports both emulator hosts):
pnpm --filter @kanna/firebase-functions comp:grant -- friend@example.com

# Grandfathering several existing accounts at once:
pnpm --filter @kanna/firebase-functions comp:grant -- \
  --reason grandfathered a@example.com b@example.com
```

Targets are email addresses or raw uids in any mix. Emails resolve through
Firebase Auth first, so a typo aborts before anything is written. `--dry-run`
prints the resolved accounts and stops.

The grant writes:

```json
{ "source": "comp", "active": true, "reason": "grandfathered",
  "grantedBy": "<operator>", "grantedAt": "…", "revokedAt": null, "updatedAt": "…" }
```

and the reducer then derives `entitlements/cloud_access` with
`status: "active"`, `source: "comp"`, `currentPeriodEndsAt: null` and the full
capability set. Note the derived `source` reads `comp`, not `grandfathered`:
Decision 3 folds every manual grant into the one comp mechanism with a `reason`
field, so the grandfathering intent lives in `reason`. Decision 5's wording
("seed existing accounts as `source: grandfathered`") describes the intent, not
a fourth source writer.

Grants are idempotent. Re-granting an active comp rewrites the same state and
the reducer rewrites nothing; re-granting a revoked one clears `revokedAt` and
keeps the original `grantedAt`.

## Revoking

```bash
pnpm --filter @kanna/firebase-functions comp:grant -- --revoke friend@example.com
```

The record is deactivated and stamped with `revokedAt` rather than deleted, so
the history stays legible. The reducer then falls back to whatever paid source
the account still holds — comping a paying subscriber and later un-comping them
is safe. An account with no paid source loses cloud access at the relay within
its entitlement-cache TTL (60 s by default), not instantly.

## Running against staging or production

Real projects are human-only, the same rule as production deploys. The script
refuses unless the project is named twice, and refuses outright if either
`FIRESTORE_EMULATOR_HOST` or `FIREBASE_AUTH_EMULATOR_HOST` is set, naming the
one it found. Both redirect, and the auth one is the dangerous half: with only
`FIRESTORE_EMULATOR_HOST` unset, the email is resolved against the emulator's
user directory while the grant is written to the real project — so the account
you meant to comp gets nothing and a stray grant lands on a uid nobody owns.
`./kd dev up --emulators` exports both, so unset both:

```bash
unset FIRESTORE_EMULATOR_HOST FIREBASE_AUTH_EMULATOR_HOST
gcloud auth application-default login   # or export GOOGLE_APPLICATION_CREDENTIALS
pnpm --filter @kanna/firebase-functions comp:grant -- \
  --project kanna-build --confirm kanna-build --reason "owner account" me@example.com
```

Use `kanna-staging` for staging and `kanna-build` for production. The credential
needs Firestore write and Firebase Auth read on the target project.

Confirm afterwards by reading the derived record — the source doc alone is not
evidence that anything was granted:

```bash
# users/{uid}/entitlements/cloud_access should read status: active, source: comp
```

## What this does not do

- It does not create accounts. The account must already exist in Firebase Auth.
- It does not cancel anything. A comped account with a live Stripe or App Store
  subscription keeps being billed by that source — comp is a gift laid over the
  top, and `createCheckoutSession` / `beginAppStorePurchase` refuse while it is
  active so no *new* charge can start. If somebody is comped and paying, cancel
  their subscription through its own channel.
- It does not list grants. `kd cloud comp grant|revoke|list` is the eventual
  operator surface named in Decision 3; until it exists, read
  `users/{uid}/billing/comp` directly.

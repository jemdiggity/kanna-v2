/**
 * Complimentary access — the owner's "leech flag"
 * (`docs/specs/accounts-and-billing.md`, Decision 3).
 *
 * A `comp` grant is cloud access with no billing relationship: while active it
 * never bills, never duns and never expires, and only an explicit revocation
 * ends it. On revocation the reducer falls back to whatever paid source the
 * account still holds, so comping a paying user and later un-comping them is
 * safe.
 *
 * Two properties this module carries, both of them easy to get wrong by hand:
 *
 * - **Nothing recomputes the entitlement for you.** There is no Firestore
 *   trigger on `users/{uid}/billing/comp`; the entitlement record is derived
 *   only when something calls `recomputeEntitlement`. An admin-SDK write on its
 *   own therefore grants nothing at all — the source doc changes and the
 *   entitlement the relay reads does not. Every function here writes and
 *   recomputes in that order.
 * - **Grandfathering rides on this same mechanism.** Decision 5 describes
 *   seeding existing legacy accounts as `source: grandfathered`, but
 *   Decision 3 folds every manual grant into the one `comp` source with a
 *   `reason` field rather than three source spellings. So a grandfathered
 *   account is a comp grant whose `reason` says so, and the derived entitlement
 *   reads `source: "comp"`.
 *
 * v1 has no admin UI and no callable: grants are an operator action, run
 * through `scripts/grant-comp-access.mjs`. See `docs/comp-access-runbook.md`.
 * This module lives under `src/` because the script needs the compiled reducer,
 * so it does reach the deploy bundle — but `src/index.ts` exports no function
 * that calls it, so no deployed endpoint can grant anybody access.
 */
import type { Firestore } from "firebase-admin/firestore";
import { recomputeEntitlement } from "./entitlement.js";
import {
  billingSourcePath,
  type BillingEnvironment,
  type CompSourceState,
  type EntitlementRecord,
} from "./types.js";

/** The reason stamped on a grant that exists because the account predates billing. */
export const GRANDFATHERED_REASON = "grandfathered";

export interface CompGrantRequest {
  db: Firestore;
  uid: string;
  /** Why this account is comped; free text, stamped on the source doc. */
  reason: string;
  /** Who granted it — an operator identity, for the audit trail. */
  grantedBy: string;
  defaultEnvironment: BillingEnvironment;
  now?: string;
}

export interface CompMutationResult {
  uid: string;
  comp: CompSourceState;
  entitlement: EntitlementRecord | null;
}

/**
 * Grant complimentary access and derive the entitlement from it.
 *
 * Idempotent: re-granting an active comp rewrites the same state and leaves the
 * entitlement record untouched (the reducer rewrites nothing that has not
 * changed). Re-granting a previously revoked comp clears `revokedAt` and keeps
 * the original `grantedAt`, so the audit trail reads as one grant that was
 * interrupted rather than a fresh one.
 */
export async function grantCompAccess(
  request: CompGrantRequest
): Promise<CompMutationResult> {
  const { db, uid, reason, grantedBy, defaultEnvironment } = request;
  const now = request.now ?? new Date().toISOString();
  const ref = db.doc(billingSourcePath(uid, "comp"));
  const existing = (await ref.get()).data() as CompSourceState | undefined;

  const comp: CompSourceState = {
    source: "comp",
    active: true,
    reason,
    grantedBy,
    grantedAt: existing?.grantedAt ?? now,
    revokedAt: null,
    updatedAt: now,
  };
  await ref.set(comp);

  const { entitlement } = await recomputeEntitlement({
    db,
    uid,
    now,
    defaultEnvironment,
  });
  return { uid, comp, entitlement };
}

export interface CompRevokeRequest {
  db: Firestore;
  uid: string;
  defaultEnvironment: BillingEnvironment;
  now?: string;
}

/**
 * Revoke complimentary access and derive the entitlement again.
 *
 * The grant record is kept — deactivated, with `revokedAt` stamped — rather
 * than deleted, so a revocation is legible after the fact. An account with a
 * live paid subscription falls back to it; an account with none loses cloud
 * access at the relay within its entitlement-cache TTL.
 *
 * Revoking an account that was never comped writes an inactive record and
 * recomputes anyway: the write is harmless and the recompute is the point, in
 * case the doc was hand-edited into an inconsistent state.
 */
export async function revokeCompAccess(
  request: CompRevokeRequest
): Promise<CompMutationResult> {
  const { db, uid, defaultEnvironment } = request;
  const now = request.now ?? new Date().toISOString();
  const ref = db.doc(billingSourcePath(uid, "comp"));
  const existing = (await ref.get()).data() as CompSourceState | undefined;

  const comp: CompSourceState = {
    source: "comp",
    active: false,
    reason: existing?.reason ?? null,
    grantedBy: existing?.grantedBy ?? null,
    grantedAt: existing?.grantedAt ?? null,
    revokedAt: now,
    updatedAt: now,
  };
  await ref.set(comp);

  const { entitlement } = await recomputeEntitlement({
    db,
    uid,
    now,
    defaultEnvironment,
  });
  return { uid, comp, entitlement };
}

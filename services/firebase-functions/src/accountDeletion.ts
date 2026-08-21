import type { Auth } from "firebase-admin/auth";
import type {
  DocumentReference,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import { BillingRequestError } from "./billing/errors.js";
import { requireEnv, STRIPE_SECRET_KEY_ENV } from "./billing/config.js";
import { stripeSubscriptionGateway, type StripeSubscriptionGateway } from "./billing/stripeGateway.js";
import {
  accountDeletionPath,
  billingSourcePath,
  userDocPath,
  type BilledSourceState,
} from "./billing/types.js";

export interface DeleteAccountCaller {
  uid: string;
}

export interface AccountDeletionStore {
  activeStripeSubscriptionId(uid: string): Promise<string | null>;
  markAccountDeletionStarted(uid: string): Promise<void>;
  deleteUserTree(uid: string): Promise<void>;
  deleteBillingIndexes(uid: string): Promise<void>;
  revokeDesktopPairings(uid: string): Promise<void>;
  deleteLegacyDevicePairings(uid: string): Promise<void>;
}

export interface AccountDeletionAuth {
  revokeRefreshTokens(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface DeleteAccountDependencies {
  store: AccountDeletionStore;
  auth: AccountDeletionAuth;
  stripe: StripeSubscriptionGateway;
}

export interface DeleteAccountResult {
  deleted: true;
}

/**
 * Permanently delete one account. Each completed step can safely be repeated;
 * the Auth user remains until every cloud record has been removed, making any
 * partial failure retryable by the still-authenticated caller.
 */
export async function deleteAccount(
  caller: DeleteAccountCaller | null,
  dependencies: DeleteAccountDependencies,
): Promise<DeleteAccountResult> {
  if (!caller) {
    throw new BillingRequestError(
      "unauthenticated",
      "sign_in_required",
      "Sign in before deleting your account.",
    );
  }

  const subscriptionId = await dependencies.store.activeStripeSubscriptionId(caller.uid);
  if (subscriptionId) {
    await dependencies.stripe.cancelSubscription(subscriptionId);
  }

  await dependencies.store.markAccountDeletionStarted(caller.uid);
  await dependencies.store.revokeDesktopPairings(caller.uid);
  await dependencies.store.deleteLegacyDevicePairings(caller.uid);
  await dependencies.store.deleteUserTree(caller.uid);
  await dependencies.store.deleteBillingIndexes(caller.uid);
  await revokeRefreshTokensIdempotently(dependencies.auth, caller.uid);
  await deleteAuthUserIdempotently(dependencies.auth, caller.uid);
  return { deleted: true };
}

export function firestoreAccountDeletionStore(db: Firestore): AccountDeletionStore {
  return {
    async activeStripeSubscriptionId(uid) {
      const snapshot = await db.doc(billingSourcePath(uid, "stripe")).get();
      const source = snapshot.data() as Partial<BilledSourceState> | undefined;
      return source
        && (source.status === "active" || source.status === "grace")
        && typeof source.stripeSubscriptionId === "string"
        && source.stripeSubscriptionId.trim()
        ? source.stripeSubscriptionId
        : null;
    },
    async markAccountDeletionStarted(uid) {
      await db.doc(accountDeletionPath(uid)).set({
        uid,
        started: true,
      });
    },
    async deleteUserTree(uid) {
      await db.recursiveDelete(db.doc(userDocPath(uid)));
    },
    async deleteBillingIndexes(uid) {
      await deleteQueries(db, [
        db.collection("stripeCustomers").where("uid", "==", uid),
        db.collection("stripeEvents").where("uid", "==", uid),
        db.collection("appAccountTokens").where("uid", "==", uid),
      ]);
    },
    async revokeDesktopPairings(uid) {
      await deleteQuery(db, db.collection("desktopCredentials").where("uid", "==", uid));
    },
    async deleteLegacyDevicePairings(uid) {
      await deleteQuery(db, db.collection("devices").where("userId", "==", uid));
    },
  };
}

export function accountDeletionDependencies(
  db: Firestore,
  auth: Auth,
  env: NodeJS.ProcessEnv,
): DeleteAccountDependencies {
  return {
    store: firestoreAccountDeletionStore(db),
    auth,
    stripe: stripeSubscriptionGateway(requireEnv(env, STRIPE_SECRET_KEY_ENV)),
  };
}

async function deleteQueries(db: Firestore, queries: readonly Query[]): Promise<void> {
  for (const query of queries) {
    await deleteQuery(db, query);
  }
}

async function deleteQuery(db: Firestore, query: Query): Promise<void> {
  const snapshot = await query.get();
  if (snapshot.empty) return;
  const writer = db.bulkWriter();
  for (const document of snapshot.docs) {
    writer.delete(document.ref as DocumentReference);
  }
  await writer.close();
}

async function deleteAuthUserIdempotently(auth: AccountDeletionAuth, uid: string): Promise<void> {
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (isAuthUserNotFound(error)) return;
    throw error;
  }
}

async function revokeRefreshTokensIdempotently(
  auth: AccountDeletionAuth,
  uid: string,
): Promise<void> {
  try {
    await auth.revokeRefreshTokens(uid);
  } catch (error) {
    if (isAuthUserNotFound(error)) return;
    throw error;
  }
}

function isAuthUserNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "auth/user-not-found";
}

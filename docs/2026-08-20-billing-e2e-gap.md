# Billing (Stripe) E2E gap — 2026-08-20

Required by `docs/specs/accounts-and-billing.md` Decision 8, which asks for a
dated note wherever Stripe-hosted pages block CI automation. Written by the
Slice-1 backend task (`344057c3`), which landed
`services/firebase-functions`' `createCheckoutSession` and `stripeWebhook`, the
source-state + `recomputeEntitlement` reducer, the `firestore.rules` stanzas,
and the emulator fixtures.

## What cannot be tested end to end, and why

**No Stripe credentials exist yet.** The Stripe account for Tampopo LLC — test
mode included — is a Slice-0 human item. Until it exists there is no test-mode
secret key, no price ids, no webhook signing secret and no `stripe listen`
endpoint, so nothing in CI or on a dev machine can talk to Stripe at all.

**Stripe Checkout is a hosted page.** Even with test keys, the paying half of
the funnel happens on `checkout.stripe.com`: entering a test card, submitting,
and being redirected back. That page is Stripe's, it changes without notice,
and driving it with a browser automation harness produces a test that fails for
reasons that have nothing to do with Kanna. The repo's E2E tier deliberately
does not include third-party hosted UIs.

**Webhook delivery is Stripe's.** The real end-to-end path is
Stripe → public HTTPS endpoint → Cloud Function. Reproducing it needs a
deployed function on a project with a registered endpoint and a live Stripe
account, which is the same Slice-0 blocker plus a staging deploy.

## What runs now instead

All of it in `services/firebase-functions/test/`, against the Firebase emulator
and checked-in Stripe fixture payloads (`test/fixtures/stripe/`):

- **Signature verification** — a payload signed with the wrong secret and one
  with no `stripe-signature` header are both rejected with 400, and no source
  doc is written. Signatures are produced by Stripe's own
  `generateTestHeaderString`, so the bytes are the real format.
- **Idempotency** — a duplicate event id is answered `duplicate` and leaves the
  source doc and the entitlement doc byte-identical, which is the "duplicate
  event → one state change" bar.
- **Out-of-order delivery** — an older event arriving after a newer one is
  answered `stale` and does not walk the state back, while still being recorded
  so it is never reprocessed.
- **The state mapping** — every Stripe subscription status, `invoice.paid`,
  `invoice.payment_failed` with and without a next retry attempt, checkout
  sessions paid and unpaid, and one event type the handler must ignore.
- **The flow** — checkout session completed → subscription created →
  `billing/stripe` active → `entitlements/cloud_access` granted with the full
  capability set, asserted against the emulator.
- **`createCheckoutSession` guards** — anonymous, unverified email, comp
  active, App Store active, already subscribed. The Stripe API sits behind a
  gateway interface so the guards, the customer reuse and the metadata stamping
  are exercised without credentials.
- **The reducer** — the full matrix from Decision 8, both as a pure function
  and through Firestore transactions.
- **Firestore rules** — entitlement and every billing source doc (including
  `billing/comp`) owner-readable and client-write-rejected;
  `appAccountTokens`, `stripeEvents` and `stripeCustomers` neither readable nor
  writable by clients.

## What would close the gap

1. Slice-0 lands the Stripe account and test-mode keys.
2. The five Secret Manager entries created in `kanna-staging`
   (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`,
   `KANNA_PORTAL_BASE_URL` on `createCheckoutSession`; `STRIPE_WEBHOOK_SECRET`
   on `stripeWebhook`), then `./kd cloud deploy --staging --functions`, then a
   Stripe test-mode webhook endpoint pointed at the deployed `stripeWebhook`.

   The bindings themselves are declared in the code (`src/index.ts`, lists in
   `src/billing/config.ts`), so this step is creating the secrets, not wiring
   them. Until they exist the deploy fails naming the missing one — deliberately,
   since the alternative is publishing a backend whose environment is empty.
   That the declared bindings actually reach the deployment manifest is pinned
   by `test/function-secrets.test.ts`; that Secret Manager then populates the
   running function's environment is deploy-time Firebase behaviour no emulator
   reproduces, and is part of this gap rather than something tests can close.
3. A staging E2E that creates an account, drives `createCheckoutSession`,
   completes payment with a test card, and asserts the entitlement doc and the
   relay's response — the flow Decision 8 names. The Checkout page itself stays
   the un-automatable step; `stripe trigger` against the deployed endpoint is
   the closest CI-able substitute and covers everything after the redirect.

The Apple side has its own boundary and its own required note
(`docs/YYYY-MM-DD-iap-e2e-gap.md`), owed by the Slice-2 task that lands the
Apple track.

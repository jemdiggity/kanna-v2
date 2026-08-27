# Accounts and Billing (Stripe + Apple IAP) — Architecture Spec

Status: architect consultation verdict (task `da6b6800`, 2026-08-20), amended
2026-08-20 by task `72f6675f` on the owner's decision (verbatim): "Let's
include iap from the start." Apple In-App Purchase is now a **launch channel**
alongside web Stripe — Model 1 of
`docs/2026-07-08-mobile-subscription-iap-strategy.md` — not the review-forced
fallback the original verdict kept in reserve. That strategy doc's two-tier
model and entitlement schema remain adopted here. The same amendment folds in
a second owner addition (verbatim): "Also I'll need a leech flag for users who
don't need to pay" — the complimentary `comp` entitlement source in
Decision 3.

Amended again 2026-08-21 by task `1d70926f` to make the web portal the sole
account-creation and payment surface at that time. The owner superseded the
account-creation part on 2026-08-24 with: “We have payments set up, so let's
just open it ALL.” Account creation is now open in the web portal and mobile;
both use Firebase email/password registration and require email verification.
Payment remains in the portal. Desktop opens that portal for registration and
subscription management and never transfers an auth token to the browser.
Mobile may link directly to the portal's subscription page; that external link
must be reconsidered before production App Store review if storefront policy
requires it. In-app account deletion remains available for lifecycle
compliance.

Amended again 2026-08-21 by task `ed6c7f7b` on two further owner rulings,
recorded verbatim:

> "Cloud access is paid; connecting to machines the user manually adds with the
> QR method is free — the user can remotely control them when they're on the
> same LAN."

> "¥500 JPY, $5 USD, $5 CAD, $5 AUD, €5, £5 per month" — "possibly revised
> pending our new opex estimation."

The first originally settled the enforcement boundary as everything crossing
the relay. The owner's 2026-08-24 anonymous-push amendment narrows that ruling:
**push notifications are free for account and pair-scoped anonymous identities**;
phone→desktop `invoke`, tunnels, snapshots, and remote terminal access remain
entitlement-gated (Decision 5). LAN stays free, permanently, including remote
control of a machine the user paired by QR on the same network. The second sets
the launch price (Decision 4, "Pricing").

Apple App Store analysis in this spec reflects knowledge current to
January 2026. Every item under "Human verification required" must be checked
against Apple's live guidelines before the paid launch.

## Verified current state (2026-08-20)

Confirmed by source inspection; corrections to the consultation prompt noted.

- Identity is Firebase Auth email/password everywhere. Mobile supports sign-in
  and account creation with verification email in `apps/mobile/src/lib/firebase/sdk.ts`
  and `AccountSheet.tsx`. The desktop also signs in as a
  real Firebase user (`apps/desktop/src/services/desktopAuthSdk.ts`,
  `desktopAutoSignIn.ts`) and bootstraps a per-machine
  `desktopCredentials/{desktopId}` secret-hash record
  (`desktopCloudAssociation.ts`). The portal provides registration,
  verification, subscription, and account management; mobile also provides
  registration and verification. Account deletion is available in both
  account surfaces.
- The relay (`services/relay`, Node/TS on a single **e2-micro** GCE VM behind
  Caddy; prod `relay.kanna.build` in GCP project `kanna-build`, staging
  `relay-staging.kanna.build` in `kanna-staging`) authenticates phones by
  Firebase ID token and desktops by `desktopCredentials` hash compare, then
  serves **every authenticated account unconditionally**: tunnels, cloud task
  snapshot publication to Firestore, push notifications. No entitlement, plan,
  quota, bandwidth, or per-user connection limit exists. Only mechanical
  backpressure caps (`router.ts`) and payload size caps.
- `services/firebase-functions` deploys **zero functions by design** —
  `src/index.ts` is `export {};` with a guard comment that the retired
  `createPairingCode` bootstrap must never be resurrected by
  `firebase deploy --only functions`. The package holds shared cloud types and
  emulator rules tests. Any billing backend placed here must revive function
  deployment deliberately, through `kd`, without re-shipping that function.
- Firestore (`firestore.rules`): `users/{uid}` self-readable; task index and
  desktop docs owner-read-only, admin-SDK-written by the relay; deny-by-default
  catch-all. Three Firebase projects: `kanna-local` (emulator), `kanna-staging`,
  `kanna-build` — a clean seam for Stripe test vs live mode.
- No billing, entitlement, IAP/StoreKit, telemetry, or crash-reporting SDK code
  exists anywhere (mobile crash diagnostics are local-only and redacted).
- The mobile app is Expo SDK 57 / React Native 0.86, `runtimeVersion: "2.1.4"`
  in all three environments of `apps/mobile/src/mobileEnvironments.json`,
  native identity applied by config plugins in `apps/mobile/plugins/`. Adding
  any StoreKit dependency is a native change: per the repo contract it bumps
  `runtimeVersion` in **every** environment and ships binary-only, never OTA.
- Legal/web: privacy policy and support pages are live at
  `kanna.build/privacy` / `/support`, served from the **separate**
  `tampopogk/kanna-web` repo; markdown source lives here in `docs/legal/`.
  Operator is Tampopo LLC, governing law Japan, contact
  `support@tampopomyoko.com`. **No Terms of Service exist.** Account deletion
  today is a manual 30-day email process (`docs/legal/support.md`).
- There is no in-repo signup allowlist in Firebase Functions or the relay.
  Ordinary access is governed by verified Firebase identity plus the derived
  cloud entitlement; complimentary/grandfathered accounts use the same `comp`
  source as before.
- ⚠️ Normalization of the amendment prompt's `source: "apple"`: the adopted
  entitlement schema already names this enum value `app_store`. This spec
  keeps `app_store`; introducing a second spelling for the same source would
  be a bug factory. Everywhere the owner said "apple", read `app_store`.

## Decision 1 — Account lifecycle

**Keep Firebase Auth as the identity backbone.** It is already wired into
mobile, desktop, relay verification, and Firestore rules; replacing it buys
nothing. Additions:

- **Registration is open in the web account portal and mobile.** Both follow
  register → verify email; verified users without entitlement continue to the
  portal subscription page. The portal remains the only payment funnel, and
  desktop links to it in the system browser. Email/password is the only launch
  identity method; no social providers.
- **Mobile keeps in-app account deletion** backed by the `deleteAccount`
  pipeline below. Open mobile signup makes this lifecycle and compliance path
  directly necessary in the signed-in app.
- **Account-first purchase, always.** Portal payment requires a signed-in,
  email-verified Firebase account. Anonymous purchase-then-bind-later remains
  rejected because it creates orphaned purchases and account-claim ambiguity.
- **Email verification** is required before a portal purchase can activate an
  entitlement, and the relay treats `email_verified: false` phone tokens as
  unentitled.
- **Password reset**: Firebase `sendPasswordResetEmail`, surfaced on the
  portal sign-in page and as a "Forgot password?" link in the mobile
  `AccountSheet`.
- **Account deletion** is a first-class backend pipeline regardless of where
  the button lives (APPI/GDPR, the existing 30-day manual promise, and now
  [App Store Review Guideline 5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage)
  all demand it). The implemented contract is detailed below. Apple IAP is not
  part of the currently shipping deletion operation; when that billing source
  ships, its inability to be canceled by Kanna and the required
  manage-subscriptions warning must be added before release.

### Permanent account deletion contract (implemented 2026-08-21)

`deleteAccount` is an authenticated callable shared by the native mobile app
and the account portal. Both surfaces require a hard `DELETE` confirmation
that names the subscription, cloud data, and cloud desktop pairings being
lost. This is native-initiated on iOS, as required by Guideline 5.1.1(v), not a
link that leaves account deletion available only on the web.

The callable performs these phases strictly in order:

1. Atomically coordinate checkout and deletion through
   `accountCheckouts/{uid}`. Checkout transactionally admits one Stripe-creation
   operation only while no deletion tombstone exists, and does not write
   `users/{uid}` or `stripeCustomers` until a second transaction records the
   resulting session and releases that admission. Deletion refuses retryably
   while an admitted operation is still creating Stripe state. Once it has
   finished, deletion atomically creates the durable
   `accountDeletions/{uid}` tombstone and reads every recorded session. No new
   checkout can pass admission after that transaction commits.
2. Before deleting any local billing/customer index, collect every Stripe
   customer attributable to the uid from the code-enumerated legacy and current
   records: `users/{uid}.stripeCustomerId`,
   `users/{uid}/billing/stripe.stripeCustomerId`, and every
   `stripeCustomers` document whose `uid` matches. Cancel every locally
   recorded subscription immediately, close every session recorded in
   `accountCheckouts/{uid}`, then exhaustively page through every collected
   Stripe customer's Checkout sessions and subscriptions. Open Checkout
   sessions are expired, completed sessions' subscriptions are canceled, and
   every other live subscription for every mapping is canceled. This covers
   Checkout URLs created by the original implementation before the session
   ledger existed, including multiple historical customer mappings.
   Cancellation is cancel-at-once with no refund or proration logic. Missing,
   expired, and already-canceled Stripe resources make reruns no-ops.
3. Relay publication transactions and Stripe webhook transactions read the
   tombstone before any uid-owned write. Firestore Rules require its absence
   for the desktop client's direct `users/{uid}` profile and
   `desktopCredentials/{desktopId}` create/update operations. Revoke cloud/relay
   pairings by deleting `desktopCredentials` rows whose `uid` matches, then
   delete legacy `devices` rows whose `userId` matches.
4. Recursively delete `users/{uid}`. This removes the user profile, all billing
   source documents (including `billing/comp`), the derived entitlement,
   `pushDevices`, published `desktops`, and every published `tasks` mirror
   below those desktops.
5. Delete the code-enumerated uid indexes: `stripeCustomers` (`uid`),
   `stripeEvents` (`uid`), and `appAccountTokens` (`uid`), plus the completed
   `accountCheckouts/{uid}` coordination record.
6. Revoke Firebase refresh tokens, then delete the Firebase Auth user last.

Every deletion is safe when the document is already absent, and a Stripe
“resource missing” response is treated as already canceled. If a phase fails,
Auth still exists and the caller can run the operation again. Auth goes last
specifically so no mid-pipeline failure strands an account that can no longer
authenticate to retry. The tombstone is written idempotently and remains
present across retries. Stripe webhook application, every relay desktop/task
publication transaction, and the Firestore Rules governing direct desktop
profile and credential writes read it as their durable write fence. Checkout
uses the tombstone and its `accountCheckouts/{uid}` admission record as one
transactional coordination boundary rather than relying on a one-time read.
The relay's `/register` and `/push/register` handlers likewise read the
tombstone and write `devices/{token}` or `users/{uid}/pushDevices/{id}` in one
transaction. A registration that commits first is included in the subsequent
deletion sweep; a transaction that would commit after the tombstone is written
conflicts, retries against the tombstone, and is rejected even if Firebase
still accepts its already-issued ID token.
Cancellation events, cached or in-flight publishers, direct desktop writes,
and cached-token checkout calls following deletion are rejected without
recreating Stripe, dedupe, billing, entitlement, profile, credential, desktop,
or task state. A direct client write committed before the tombstone remains
eligible for the deletion sweep; one committing after it is denied.

The Firestore-emulator suite exercises the adversarial checkout race by pausing
the mocked Stripe gateway after transactional admission, attempting deletion,
then releasing Stripe. The first deletion is retryable; the rerun fences the
uid, closes the recorded session, removes the user tree and billing reverse
map, and deletes Auth last.

It also seeds a pre-ledger open Checkout session with no
`accountCheckouts/{uid}` record plus completed/live subscriptions across
multiple customer mappings. The mocked Stripe boundary proves deletion makes
the old URL unusable, cancels all subscriptions, and repeats safely after an
injected mid-pipeline failure without making live Stripe calls.

There is no soft-disable, grace period, undo window, or refund path. No user
content or credential survives: no account, complimentary grant, entitlement,
task or desktop mirror, push token, billing source/index, app-account-token
mapping, or relay credential. The sole Kanna-side remnant is the minimal
`accountDeletions/{uid}` safety tombstone; it is not account content and exists
only to prevent old tokens, cached relay credentials, and delayed writers from
resurrecting deleted data. Stripe may retain its canceled subscription/customer
and financial records under Stripe's own retention obligations; Kanna does not
use those records to restore an account. A person may register the same email
again, but receives a new Firebase uid and a blank account, so the old uid's
tombstone does not apply. Complimentary access and prior paid entitlement are
not inherited.

The desktop loses relay access when its canonical credential is next checked
and its Firebase session becomes visibly signed out when credential refresh
reports the deleted identity. Local databases, worktrees, LAN discovery, and
QR/LAN pairings are installation-local and remain usable; deletion is of the
cloud account, not the local install.

Data export is a separate follow-up. The deliberate no-undo choice keeps this
operation honest and immediate; export support does not weaken or delay
deletion.

## Decision 2 — The Apple question (superseded; portal link-out adopted for dogfood)

The 2026-08-24 surface ruling above supersedes this earlier launch plan:
payment occurs only in the web portal, mobile registration is open in-app, and
verified unsubscribed users may open the portal subscription page. Production
App Store review may require that link to change. The historical design below
is retained as context, not current implementation authority.

**Earlier owner decision (2026-08-20): the iOS app sells `cloud_access` as an
auto-renewable In-App Purchase from the start.** This is Model 1 of the
strategy doc — the same entitlement sold through StoreKit on iOS and Stripe
on the web, normalized into one backend entitlement record. The original
verdict's honor-only posture (Model 2/3, app sells nothing) and its
"IAP only if App Review forces it" fallback framing are dead for iOS.

What this buys and costs, so the record is honest:

- The chronic 3.1.3(b) exposure disappears: web-purchased subscribers may
  sign in and be served precisely because the same item **is** available as
  IAP in the app. App Review risk shifts from "is this companion framing
  accepted" to ordinary subscription-compliance mechanics (3.1.2), which are
  checkable and enumerated in Decision 4.
- The cost is Apple commission on app-channel revenue (15% under the Small
  Business Program), the App Store Connect business setup, a mandatory new
  binary + subscription review, and the reconciliation surface of two billing
  sources (Decision 4). All accepted by the owner's decision.
- **LAN remains free and account-free, permanently.** The free-companion
  floor is unchanged and still what makes the free tier honest.
- **What the app says about web billing — conservative default**: the app
  shows **only** the IAP price and terms, and never mentions web pricing,
  the portal, or that a web purchase path exists. For an already-subscribed
  Stripe-sourced account, the app states the subscription is active and
  managed outside the App Store, without price or link (exact copy in
  Decision 4; whether naming "kanna.build" there is acceptable is a verify
  item). As of the January 2026 cutoff, the US storefront external-link
  rules (post-Epic contempt ruling, appeal pending) and Japan's smartphone
  competition act would likely permit more explicit web-pricing references
  on those storefronts — **do not build on either**: storefront-specific,
  in legal flux, and unnecessary now that IAP exists. One global binary,
  one global policy.

**Human verification required before paid launch** (knowledge-cutoff items):
(1) current text of 3.1.1 / 3.1.2 / 3.1.3; (2) whether 5.1.1(v) deletion
requirements have widened; (3) status of the US external-link rules and the
Epic appeal, and Japan storefront obligations — informational only, since
this spec does not rely on them; (4) **Paid Applications Agreement signed in
App Store Connect** (required even for sandbox IAP testing); (5) **banking
and tax setup complete in App Store Connect**; (6) **subscription group +
auto-renewable products created with price points chosen** (Apple's price
grid may not exactly match the Stripe price — pick the nearest tier, owner
signs off); (7) **Small Business Program enrollment** (15% assumes it);
(8) the React Native StoreKit library landscape (Decision 4 names `expo-iap`
from cutoff knowledge — re-verify maintenance status at implementation time);
(9) whether the in-app "managed outside the App Store" copy for
Stripe-sourced subscribers is acceptable, or must stay fully neutral. Also
update the App Review notes and listing copy at flag day; open signup and the
external subscription link must be described accurately.

## Decision 3 — Stripe integration shape

- **Stripe Billing + hosted Checkout (mode=subscription) + hosted Customer
  Portal.** Not Payment Links (no reliable account linkage), not embedded
  elements (more surface, no benefit at this scale). Checkout carries
  `client_reference_id = uid` and the Customer carries `firebase_uid`
  metadata; the Customer Portal handles cancel/payment-method/invoices so
  Kanna builds no billing UI beyond a "Manage billing" button.
- **The billing backend lives in `services/firebase-functions`**, revived as
  real 2nd-gen Cloud Functions on the existing three Firebase projects:
  - `createCheckoutSession` (callable, auth + verified email required;
    **refuses with a distinct error when an `app_store`-sourced subscription
    is active** — the portal renders "you're subscribed via the App Store —
    manage it in Apple's subscription settings" with the deep link instead
    of a checkout button; double-pay prevention, Decision 4),
  - `createPortalSession` (callable),
  - `stripeWebhook` (HTTPS, signature-verified; handles
    `checkout.session.completed`,
    `customer.subscription.created/updated/deleted`,
    `invoice.payment_failed`, `invoice.paid`),
  - `deleteAccount` (callable; Decision 1),
  - plus the Apple-side functions in Decision 4.
  Rationale vs the relay VM: the relay is a single availability-critical
  e2-micro tunnel with a heavyweight deploy path; billing needs an
  independent lifecycle, TLS/webhook hosting for free, admin Firestore
  writes, and per-environment secrets — all native to Functions. The
  `createPairingCode` guard must be preserved: function deployment goes
  through `./kd cloud deploy` (extended to own `--functions`), never bare
  `firebase deploy`, and the retired function stays unexported.
- **One entitlement, three writers, one reducer** (amended structure): with
  multiple billing sources, no handler upserts `entitlements/cloud_access`
  directly — source-blind writers racing on one doc is how a canceled Stripe
  sub erases a live Apple one. Instead each source has its own **source-state
  doc** — `users/{uid}/billing/stripe` and `users/{uid}/billing/app_store`
  written by their webhooks, plus `users/{uid}/billing/comp` below — all
  admin-written, owner-readable, same rules stanza pattern as entitlements —
  and every write invokes a shared `recomputeEntitlement(uid)` that reads all
  source docs in a transaction and derives the single
  `users/{uid}/entitlements/cloud_access` record. Reconciliation rules live
  only in the reducer (Decision 4).
- **Complimentary access — the `comp` source** (owner addition, 2026-08-20:
  "I'll need a leech flag for users who don't need to pay"). An
  admin-granted grant of `cloud_access` with no billing relationship:
  `users/{uid}/billing/comp` holds `{active, reason, grantedBy, grantedAt,
  revokedAt}`. Semantics: while active it **never bills, never duns, never
  expires** — only explicit revocation ends it; on revocation the reducer
  falls back to whatever paid source the account holds, so comping a paying
  user and later un-comping them is safe. `createCheckoutSession` and
  `beginAppStorePurchase` refuse while comp is active (never let a comped
  user pay). Grant/revoke is a **manual admin-SDK Firestore write for v1**
  (single operator, a handful of grants); the eventual admin surface is a
  `kd cloud comp grant|revoke|list <email>` command — `kd` is already the
  canonical operator surface, and a portal admin page would drag in a
  role/claims system nothing else needs. Client writes are impossible under
  the deny-by-default rules; the rules tests must pin that (Decision 8).
  **The App Review demo account and the owner's own accounts run on comp**,
  which also keeps them out of revenue reconciliation. This subsumes the
  adopted enum's `manual` and `review` values — one comp mechanism with a
  `reason` field, not three source spellings; `free_beta`, `grandfathered`,
  and `promo` remain distinct because they carry different lifecycle policy.
- **Entitlement record**: the strategy doc's schema at
  `users/{uid}/entitlements/cloud_access` — `status`
  (`active|grace|expired|revoked`), `source`
  (`stripe|app_store|comp|free_beta|grandfathered|promo`),
  `capabilities` (`cloud_relay`, `cloud_task_index`, `remote_task_control`),
  `currentPeriodEndsAt` (null for non-expiring sources such as `comp`),
  `graceEndsAt`, `stripeCustomerId`,
  `stripeSubscriptionId`, `appStoreOriginalTransactionId`,
  `duplicateSources` (bool, Decision 4), `environment`, `updatedAt`.
  Owner-read-only in `firestore.rules`; only the admin SDK writes it. No
  Firebase custom claims for entitlement — the relay already does a
  Firestore read per auth and revalidates per publish, so the entitlement
  read piggybacks on that path; claims would add up-to-1h staleness for no
  savings.
- **Webhook correctness**: dedupe on `stripeEvents/{event.id}`; source-state
  writes are idempotent upserts keyed by subscription id; out-of-order events
  resolved by Stripe's `created` timestamp. Grace/dunning: map Stripe
  `past_due` → source status `grace` with `graceEndsAt` = end of Stripe Smart
  Retries; `canceled`/`unpaid` → `expired`. Cancellation at period end keeps
  `active` until `currentPeriodEndsAt` passes.
- **Test vs live**: `kanna-staging` ↔ Stripe **test mode** (own webhook
  endpoint + test keys), `kanna-build` ↔ live mode. Keys in GCP Secret
  Manager per project; never in the repo. Agents develop against the
  emulator (`services/firebase/emulator-seed` grows entitlement fixtures) and
  Stripe test mode via the Stripe CLI (`stripe listen`/`trigger`); live keys
  and live-mode operations are human-only, same rule as production deploys.

### Japan anti-fraud compliance

The 2025 revision of METI's Credit Card Security Guidelines is the practical
security standard under the amended Installment Sales Act (割賦販売法). For EC
merchants it calls for EMV 3-D Secure and appropriate anti-fraud controls. See
METI's [2025 revision announcement][meti-card-security-2025] and its
[Installment Sales Act overview][meti-installment-sales-act].

The owner confirmed on 2026-08-21 that the two measures declared during Stripe
Japan onboarding were exactly:

1. **EMV 3-D Secure (本人認証).** Every Kanna card Checkout Session sends
   `payment_method_options.card.request_three_d_secure = "any"`. Unlike the
   default `"automatic"`, which lets Stripe decide when to request 3DS from
   regulatory and risk signals, `"any"` explicitly asks Stripe to attempt 3DS
   whenever the card supports it. Stripe-hosted Checkout handles the
   frictionless or challenge flow; the issuer makes the final flow decision.
   This is stronger declaration evidence than `"automatic"`, at the UX cost
   of more authentication attempts and potentially more challenge friction,
   including for customers outside Japan. See Stripe's
   [3DS authentication-flow documentation][stripe-3ds].
2. **IP-based fraud detection (不正検知 / 属性・行動分析).** Standard Stripe
   Radar screens every card payment attempt without a separate Kanna fraud
   integration. Its network risk model incorporates the originating IP and
   related reputation/context signals: IP reputation, proxy/VPN/anonymizer
   risk, and geolocation mismatch. Its public rule attributes specifically
   expose the client IP and geolocation, known proxy/Tor status, and
   card-country/IP-country mismatch for fraud decisions. This maps the
   onboarding description "suspicious IP addresses" to Radar's IP-informed
   scoring and default high-risk action, rather than to a Kanna-maintained IP
   denylist. See
   Stripe's [Radar overview][stripe-radar], [supported IP attributes][stripe-radar-attributes],
   and [default fraud-prevention rules][stripe-radar-rules].

Kanna also employs **CVV/CVC verification (券面認証)** beyond the declared two.
When a buyer enters card details, hosted Checkout collects the required
security code and Stripe sends it to the issuer for verification; Kanna never
handles or stores it. Wallets and later off-session subscription renewals do
not re-collect a CVC, so this statement applies to Checkout card-detail entry,
not every subsequent charge. See Stripe's [CVC collection requirements][stripe-cvc]
and [card verification checks][stripe-card-checks]. Physical-goods delivery
address confirmation is inapplicable because Kanna Cloud is a digital service.

Operator runbook (live Stripe account):

1. Open **Radar → Rules** and confirm Radar is active and the default
   IP-informed risk protections are enabled, including the highest-risk block
   rule and any default review rule shown for the account. Confirm recent live
   Checkout card payments receive Radar risk evaluations with client-IP
   context. If a review rule is unavailable on the standard tier, record that
   fact; do not purchase Radar for Fraud Teams for this requirement.
2. The explicit API-level `request_three_d_secure = "any"` is the 3DS control
   and overrides dynamic 3DS Radar rules for these Checkout Sessions. A custom
   Radar "request 3DS" rule is therefore unnecessary. If the API policy is
   ever relaxed to `"automatic"`, add and verify the appropriate Dashboard
   backstop before changing this declaration.

[meti-card-security-2025]: https://www.meti.go.jp/press/2024/03/20250305002/20250305002.html
[meti-installment-sales-act]: https://www.meti.go.jp/policy/economy/consumer/credit/kappuhanbaihoatobaraibunyanogaiyofaq.html
[stripe-3ds]: https://docs.stripe.com/payments/3d-secure/authentication-flow?api-integration=checkout-session-api
[stripe-radar]: https://docs.stripe.com/radar
[stripe-radar-attributes]: https://docs.stripe.com/radar/rules/supported-attributes
[stripe-radar-rules]: https://docs.stripe.com/radar/rules
[stripe-cvc]: https://support.stripe.com/questions/cvc-collection-requirements
[stripe-card-checks]: https://docs.stripe.com/disputes/prevention/verification

## Decision 4 — Apple IAP integration shape (new)

### Products and client library

- **One subscription group ("Kanna Cloud") holding the same catalog as the
  web**: a monthly and an annual auto-renewable subscription for
  `cloud_access` (product ids `build.kanna.cloud.monthly` /
  `build.kanna.cloud.annual`). Same group so plan changes are Apple-managed
  up/crossgrades. No consumables, no non-renewing products, no intro/promo
  offers at launch (fast-follow once trial mechanics are decided — keep
  parity with the Stripe trial decision, one trial policy across channels).
- **Client: StoreKit 2 via `expo-iap`** (the maintained successor to
  `react-native-iap` from the same author, StoreKit-2-backed, Expo config
  plugin, works with `expo prebuild`). `expo-in-app-purchases` is archived —
  do not use it. Re-verify the library landscape at implementation time
  (Decision 2 item 8); if the ecosystem has shifted, a thin native
  StoreKit-2 module in `apps/mobile/plugins/` style is the fallback, not a
  reason to change this architecture. Either way it is a **native
  dependency: `runtimeVersion` bumps in every environment and the IAP build
  ships binary-only** (see Decision 7 for the timeline consequence).
- The app never hardcodes price strings: price and period render from
  StoreKit product metadata (localized, storefront-correct), which is also
  what keeps the binary honest if price points change.

### Purchase binding — `appAccountToken`

- `appAccountToken` must be a UUID and Firebase uids are not UUIDs, so a
  callable `beginAppStorePurchase` (auth + verified email required, Decision
  1) mints a stable random UUID per account on first use, storing it both on
  `users/{uid}` and as a reverse-lookup doc `appAccountTokens/{token} → uid`
  (admin-only; not client-writable). The app passes it to every StoreKit
  purchase; every signed transaction and server notification then carries
  the uid binding. The mint refusal path (unverified email, already-active
  entitlement) is what keeps the purchase UI honest before StoreKit is ever
  invoked.

### Activation and authority

- **App Store Server Notifications v2 is the authoritative entitlement
  writer** for the Apple source: a new HTTPS function
  `appStoreNotifications` in `services/firebase-functions`, beside
  `stripeWebhook`. It verifies the `signedPayload` JWS by validating the
  embedded `x5c` certificate chain against the **pinned Apple Root CA
  certificates** (bundled, not fetched), checks the payload's `environment`
  claim, dedupes on `appleNotifications/{notificationUUID}`, upserts
  `users/{uid}/billing/app_store` keyed by `originalTransactionId` (uid
  resolved via `appAccountToken`; a token that resolves to a tombstone —
  deleted account — is logged and dropped), and calls
  `recomputeEntitlement(uid)`.
- **Fast path**: waiting for a notification after purchase is bad UX, so the
  app also posts its signed transaction JWS to a callable
  `registerAppStoreTransaction`, which verifies the JWS exactly the same way
  and performs the same source-state upsert. Both paths converge on
  idempotent writes keyed by `originalTransactionId`, so ordering between
  them is irrelevant. ASSN remains the authority for everything the app
  cannot observe: renewals, billing retry, expiration, refunds, revocation.
- Notification mapping (source-state, mirroring the Stripe table):
  `SUBSCRIBED` / `DID_RENEW` / `DID_CHANGE_RENEWAL_STATUS` → `active` with
  `currentPeriodEndsAt` = `expiresDate` (auto-renew intent is display-only);
  `DID_FAIL_TO_RENEW` with `GRACE_PERIOD` subtype → `grace` with
  `graceEndsAt` = `gracePeriodExpiresDate`; `DID_FAIL_TO_RENEW` without
  grace → `expired` at `expiresDate`; `EXPIRED` → `expired`; `REFUND` /
  `REVOKE` → `revoked` immediately. **Enable Billing Grace Period in App
  Store Connect** so Apple-side dunning mirrors the Stripe Smart Retries
  design instead of hard-expiring.
- The **App Store Server API** (subscription statuses, transaction history)
  is the reconciliation/backfill tool — used by an admin runbook script and
  by `registerAppStoreTransaction` conflict checks when needed, never as the
  steady-state polling source.

### Restore purchases and relink policy

- Restore reads `Transaction.currentEntitlements` and posts the JWS(s) to
  `registerAppStoreTransaction` — same verification, same upsert. Required
  by Apple; also the recovery path for reinstalls and new devices.
- **An `originalTransactionId` binds to exactly one uid.** If a restore (or
  notification) arrives whose transaction is already bound to a different
  uid, the backend refuses the relink and the app shows support-contact
  copy. Self-serve relink is deliberately not offered at launch: silent
  relink is an entitlement-sharing and account-takeover lever, and support
  volume for legitimate cases (user made a second account) will be tiny.

### Reconciliation across sources

- **Prevention first, then resolution.** Prevented double-pay: the portal's
  `createCheckoutSession` refuses when the Apple source is active (Decision
  3); the app's `beginAppStorePurchase` refuses — and the purchase UI is
  replaced by a status row — when **any** source is active. What survives
  prevention (races, restore of an old sub onto a Stripe-active account) is
  resolved by the reducer, never hidden.
- **Reducer rule — one honored source at a time**: an active `comp` grant
  takes absolute precedence — `status: active`, `source: comp`,
  `currentPeriodEndsAt: null`, no grace machinery, and no
  `duplicateSources` flag against paid sources (comp beside a paid sub is a
  gift, not a double-pay). Among the billed sources, per-source states rank
  `active` > `grace` > everything else. The entitlement takes the best
  status any source holds; `source` names the source holding it, tie-broken
  by later `currentPeriodEndsAt`, then by keeping the previously honored
  source (stable, no flapping). `currentPeriodEndsAt`/`graceEndsAt` come
  from the honored source. A `revoked` source contributes nothing (refunded
  ≠ entitled) but never suppresses the *other* source. When two billed
  sources are simultaneously `active`/`grace`, the reducer sets
  `duplicateSources: true`.
- **Double-pay display**: on `duplicateSources`, the portal and the app both
  show a warning banner — "you have two active subscriptions" — with
  per-source guidance: cancel Stripe via the Customer Portal, cancel Apple
  via Apple's subscription settings. Kanna never auto-cancels either (an
  Apple sub it cannot touch at all; a Stripe sub it must not cancel without
  consent). Refund requests for the redundant period are a support-runbook
  matter (Apple refunds are Apple's alone; Stripe refunds via dashboard).
- **Cancellation flows per source**: Apple subscriptions are managed only
  through Apple — the app opens the native manage-subscriptions sheet
  (StoreKit `showManageSubscriptions`), the portal deep-links
  `https://apps.apple.com/account/subscriptions`; neither ever renders its
  own "cancel Apple subscription" affordance. Stripe subscriptions are
  managed only through the Customer Portal; the app shows Stripe-sourced
  subscriptions as "active — managed outside the App Store" (copy
  neutrality per Decision 2; verify item 9) and offers no management
  affordance for them.

### Environments

- App Store Connect carries the production **and** sandbox server-notification
  URLs, and **both point at the `kanna-build` project's
  `appStoreNotifications` function**. Sandbox is not staging: TestFlight and
  sandbox purchases happen inside the production-configured app
  (`build.kanna.app`, Firebase `kanna-build`), so their `appAccountToken`s
  resolve only in production Firestore — routing the sandbox URL at
  `kanna-staging` would orphan every one of them. The function trusts the
  verified JWS `environment` claim, stamps it into the source state and the
  entitlement (`environment: sandbox`), and the relay honors
  sandbox-stamped entitlements (TestFlight testers keep working) while
  revenue reconciliation excludes them.
- The staging bundle id (`build.kanna.app.staging`) is not an App Store
  Connect app and gets no ASC products; dev/staging IAP work runs on
  **StoreKit configuration files** (Decision 8) and the emulator.

### 3.1.2 compliance surface — the screens

The purchase-silent design is replaced by exactly these iOS surfaces, all in
the `AccountSheet` area:

1. **Registration screen** — email/password create + verification-pending
   state (resend link), per Decision 1.
2. **Subscribe screen (paywall)** — what `cloud_access` is (relay access,
   cloud task index, push — framed as connecting to *your* desktop), the
   monthly and annual plans with **StoreKit-localized price and period**,
   auto-renewal disclosure copy, Subscribe button, **Restore Purchases**
   button, and functional links to **Terms of Service and Privacy Policy**.
   No web pricing, no portal link (Decision 2). Reached only by a signed-in,
   verified, unentitled account.
3. **Subscription status screen** — active/grace/expired state; for
   Apple-sourced subs a "Manage subscription" row opening the native
   manage-subscriptions sheet; for Stripe-sourced subs the neutral
   managed-elsewhere row; for `comp` a plain "Complimentary access" state
   with **no** manage-billing affordance and no paywall route (the portal
   renders the same); the `duplicateSources` warning banner.
4. **Account deletion screen** — Decision 1, including the active-Apple-sub
   warning and deep link.
5. **App Store metadata** — privacy policy URL and Terms of Use (EULA) link
   in the listing, subscription display metadata in ASC, and rewritten App
   Review notes (demo account — running on the `comp` source, Decision 3 —
   how to exercise purchase/restore in sandbox, an already-entitled account)
   replacing the "no purchases" notes.

The unentitled-but-not-buying states elsewhere in the app keep the neutral
"Cloud access is not active for this account" copy, now with a route to the
subscribe screen — a paywall existing in-app makes that pointer legal and
correct where it was steering before. LAN surfaces never gate or upsell.

### Pricing

**The launch price (owner ruling, 2026-08-21, verbatim): "¥500 JPY, $5 USD,
$5 CAD, $5 AUD, €5, £5 per month" — "possibly revised pending our new opex
estimation."** One plan, "Kanna Cloud", billed monthly:

| Currency | Monthly | Stripe `unit_amount` |
|---|---|---|
| JPY | ¥500 | `500` (zero-decimal currency) |
| USD | $5 | `500` |
| CAD | $5 | `500` |
| AUD | $5 | `500` |
| EUR | €5 | `500` |
| GBP | £5 | `500` |

The revision caveat is part of the ruling, not an editorial hedge: the number
may move once the opex estimate lands. The portal infers one currency from the
browser locale's region and renders the corresponding static amount with
`Intl.NumberFormat`; unknown regions fall back to USD.
`VITE_KANNA_CLOUD_PRICE` remains overridable per deploy: its standard
`$5/month` value enables locale pricing, while a non-default value explicitly
replaces the localized headline. The portal notes that Checkout makes the
actual local-currency decision. The iOS app renders StoreKit's own localized
price and never hardcodes one. A re-price is therefore a replacement Stripe
multi-currency Price, an App Store Connect change, and an update to the portal's
static price map.

**The ruling prices the monthly plan only.** The earlier default of "~2 months
free annual" is not part of it and no annual amount is decided here, while
`createCheckoutSession` accepts the monthly plan only; an annual plan remains
out until the owner prices one.

### Pricing parity

**Default (owner decision, revisit post-launch): same nominal price on both
channels; the owner absorbs Apple's 15% Small Business Program commission on
app-channel revenue.** Rationale: price-splitting by channel invites
storefront-rule complexity (and looks petty at a $5 price point), and the
margin question is a spreadsheet problem, not an architecture problem. Apple
price points are a grid — pick the tier nearest the Stripe price and accept
small regional divergence. Small Business Program enrollment is a Slice-0
human item; without it the take is 30% and the owner should re-confirm the
default.

## Decision 5 — Entitlement enforcement

- **The relay is the enforcement point.** It already terminates every unit of
  paid remote value — tunnels, snapshot publication, remote task control —
  and already re-reads Firestore for credential revalidation. After identity
  verification (`services/relay/src/auth.ts`), resolve uid → read
  `users/{uid}/entitlements/cloud_access` (in-memory TTL cache ~60s, same
  pattern as credential revalidation). Unentitled sessions still get
  `auth_ok` but with no advertised `tunnelServices`; publication and remote
  control requests are refused with a distinct close/error code (e.g. 4402
  "entitlement required") so clients render the neutral inactive state
  instead of a generic connection error. Enforcement applies to both phone
  ID-token sessions and desktop `desktopCredentials` sessions (both resolve
  to a uid).
- **Enforcement is source-agnostic and unchanged by this amendment** — the
  relay reads `status`/`capabilities` and never branches on `source`. That
  the schema was designed source-agnostic is exactly why adding the Apple
  channel — and the `comp` source, which lands in the same doc shape with
  `status: active` — touches the writers and the reducer, never the
  enforcement point.
- **Firestore rules stay as they are initially.** The task index is the
  user's own data; when publication stops, it merely goes stale. Gating owner
  reads on an entitlement `get()` doubles read costs for marginal benefit —
  optional hardening later, not launch scope.
- **Desktop and mobile are display surfaces, not enforcement points**: they
  read entitlement state (from the relay auth response and/or the owner-read
  entitlement doc) and render active/grace/inactive. Mobile's inactive state
  now routes to the subscribe screen (Decision 4) instead of being a dead
  end.
- **The enforced set is every paid remote-control/data path that crosses the
  relay. Push notification delivery is the explicit carve-out** (owner
  amendment, 2026-08-24): notifications are free for account and anonymous
  pair-scoped identities. The relay still authenticates the sender and enforces
  the anonymous principal's notification-only boundary; this amendment removes
  only the `cloud_relay` entitlement check from notification publication.
  Enumerated, so a reader knows what flag day turns off for an unentitled
  account and what remains available:
  - `tunnel_request` and the tunnel socket itself — `cloud_relay`;
  - `task_snapshot_publish` — `cloud_task_index`;
  - `mobile_notification_publish` — free after authenticated account or
    pair-scoped anonymous identity proof; no cloud entitlement required;
  - **`invoke` — `remote_task_control`**: phone→desktop remote task control,
    and desktop→desktop routing (`desktopRouting`), which crosses the same
    relay and is therefore paid on the same terms. An unentitled session is
    advertised neither `tunnelServices` nor `desktopRouting`, and each refused
    request answers 4402 rather than closing the session.
- **Expired subscription**: relay tunnel refused, publication refused (index
  frozen), `invoke` refused; push notifications continue. Nothing is deleted —
  paid remote data and control return on renewal.
- **What stays free — stated explicitly**: LAN is free, permanently. The
  desktop app is fully functional with no account; LAN QR pairing and the
  mobile LAN companion need no account and no subscription — **including
  remote task control of a QR-paired machine over the LAN**, which reaches no
  relay code and is gated by nothing (owner ruling, 2026-08-21). The funnel is:
  free local product and notifications → paid remote access (`cloud_access` =
  tunnels + cloud task index + remote task control). This spec endorses that
  shape.
- **Grandfathering / flag day** (owner default): seed existing
  manually-provisioned accounts as `source: grandfathered, status: active`
  (the legacy cohort is small); enforcement turns on for everyone else on
  a flag day after the portal + billing path is live. The cutoff is enforced
  in the backend seeding, never inferred by clients.

## Decision 6 — Adoption gap-check (ranked)

Launch-blocking for the **web channel** (a stranger cannot responsibly pay
without these):

1. **Terms of Service** — none exist. Plus privacy-policy revision (Stripe as
   processor, entitlement/billing data, portal cookies) and — Japan-specific
   and easy to miss — a **Specified Commercial Transactions Act
   (特定商取引法) disclosure page**, legally required for paid online services
   sold by a Japanese operator. Human/legal work in `docs/legal/` +
   `tampopogk/kanna-web`. The ToS/privacy links are now *also* an Apple
   3.1.2 requirement, so this blocks both channels.
2. **Web account portal + pricing page** (registration, verification,
   checkout, manage billing, delete account) — the entire self-serve web
   funnel, now including the "subscribed via the App Store" state.
3. **Billing backend + entitlement record + relay enforcement** (Decisions
   3–5) — without enforcement, "subscribed" is meaningless and the relay is
   an open free tunnel the moment signup is self-serve.
4. **Email verification + password reset** (Decision 1).
5. **Deletion pipeline** (Decision 1) — replaces the manual 30-day email
   promise for self-serve accounts; the email route stays as fallback.
6. **Relay viability as a paid service**: uptime monitoring/alerting and a
   capacity plan. One unmonitored e2-micro is acceptable for a small dogfood
   cohort, not for paying customers; an unnoticed outage is churn plus refunds. An
   instance upsize plus an uptime check is enough for launch; HA/multi-region
   is not.
7. **Website funnel**: landing page that explains the product, pricing page,
   and a quickstart doc (download → pair → sign up → go remote). Lives in
   `kanna-web`; the desktop app is discovered and downloaded from there.
8. **Baseline abuse controls on the relay**: entitlement gating is itself the
   main gate; add per-user concurrent-connection caps and per-IP pre-auth
   rate limiting, and note the unauthenticated `/ota/*` endpoints as a
   bandwidth-abuse surface to cap. Full metering/quotas are fast-follow.

Additionally launch-blocking for the **app channel** (the IAP binary cannot
ship without these; the web channel can go live first if App Review lags —
Decision 7):

9. **App Store Connect business setup** (human): Paid Applications
   Agreement, banking/tax, subscription group + products + price points,
   Small Business Program enrollment, grace period enabled, ASSN URLs set.
10. **Apple backend track**: `appStoreNotifications`, `beginAppStorePurchase`,
    `registerAppStoreTransaction`, the source-state docs and
    `recomputeEntitlement` reducer, tombstone handling (Decisions 3–4).
11. **iOS surfaces**: in-app registration, the 3.1.2 screen set, in-app
    deletion (Decisions 1, 4) — one binary, `runtimeVersion` bumped
    everywhere, binary-only ship.
12. **App Review readiness**: comp-sourced demo account (Decision 3),
    sandbox test pass, rewritten review notes and listing copy (Decision 4).

Fast-follow (weeks after, in rough order):

13. **Crash reporting + opt-in telemetry** (Sentry or equivalent on desktop +
    mobile): strangers file unreproducible bugs; do it early. Updates the App
    Store privacy label (Diagnostics → collected) and privacy policy. Opt-in
    is the right default for a developer tool that tunnels source code.
14. **Trial mechanics** — owner decision; sensible default: 14-day free trial
    with card required (Stripe `trial_period_days`), because card-up-front
    kills throwaway-account relay abuse. If a trial ships, mirror it on the
    Apple side as an introductory offer **at the same time** — one trial
    policy across channels — noting Apple-side free trials cannot require a
    card, so the abuse calculus differs; resolve then, not now.
15. **Teams/multi-seat**: defer — single-user first is right. The per-uid
    entitlement schema extends later (org doc + seat entitlements) without
    migration of the single-user shape.
16. Per-user bandwidth metering/quotas, relay horizontal scaling, additional
    Firestore-rule hardening; self-serve Apple-transaction relink if support
    volume warrants it.

Owner decisions needed (defaults supplied, none block spec-writing): price —
**decided 2026-08-21**: one plan, "Kanna Cloud", ¥500/$5/€5/£5 monthly, no
annual plan priced yet, same nominal price on both channels with the owner
absorbing Apple's commission (Decision 4, "Pricing"); trial shape (default: 14-day, card required, cross-channel policy
resolved when trials ship); grandfathering (default: permanent for existing
legacy accounts).

## Decision 7 — Sequencing

- **Slice 0 (human, unblocks everything)**: ~~Stripe accounts for Tampopo LLC
  (test + live)~~ **done 2026-08-21 — sandbox/test account
  `acct_1Swy1rI0Oqa4EKBj`; live account `acct_1Swxz4RSDDrR2YPq`**;
  ToS/legal/特商法 pages, verify Firebase console signup
  settings, the Apple verification list from Decision 2 — including Paid
  Applications Agreement, banking/tax, subscription products + price points,
  Small Business Program enrollment, and grace-period enablement in App Store
  Connect. The price decision itself landed 2026-08-21 (Decision 4,
  "Pricing"). For the first provisioning run, use the sandbox account's test
  secret key; that same sandbox key belongs in the staging function config.
  Run the idempotent command below with that key (use `--dry-run` to print the
  plan without contacting Stripe):
  `STRIPE_SECRET_KEY=... pnpm --filter @kanna/firebase-functions stripe:provision`.
  Provision the live account later with its live secret key only as an
  explicitly named human production step.
  It creates what remains:
  - One **Product**, "Kanna Cloud", in **each** of test mode and live mode.
  - Under it, one **recurring multi-currency monthly Price** per mode with the
    stable lookup key `cloud_monthly`: USD 500 is the default amount, with JPY
    500, CAD 500, AUD 500, EUR 500, and GBP 500 as manual currency options
    (JPY is zero-decimal, so `500` is ¥500; the rest are $5.00 / €5.00 /
    £5.00). Checkout chooses a supported local currency from the buyer's
    location; neither the portal nor the callable accepts a currency choice.
    The script deactivates legacy `cloud_monthly_<currency>` Prices only after
    the multi-currency replacement exists and retains them for historical
    subscriptions. Live-mode creation is human-only, like production deploys.
  - **Still requiring dashboard/key access:** create restricted API keys for
    test and live mode; supply each portal build environment's publishable key
    as `KANNA_WEB_PORTAL_STRIPE_PUBLISHABLE_KEY`; after the deployed
    `stripeWebhook` function URL is registered as a Stripe endpoint, record its
    webhook signing secret. Store only `STRIPE_SECRET_KEY` and
    `STRIPE_WEBHOOK_SECRET` with `firebase functions:secrets:set` in each
    project. `KANNA_PORTAL_BASE_URL` is public Firebase Functions parameterized
    configuration committed in `services/firebase-functions/.env` (production
    and local default) and `.env.kanna-staging`; operators no longer set it as a
    function secret.
  - **One-time obsolete-secret cleanup, after a functions deploy using the
    parameter:** the already-set Secret Manager value is unused and may be
    deleted. Run the applicable commands if the value exists in those projects:

    ```sh
    pnpm exec firebase functions:secrets:destroy KANNA_PORTAL_BASE_URL --project kanna-staging
    pnpm exec firebase functions:secrets:destroy KANNA_PORTAL_BASE_URL --project kanna-build
    ```

    This is an explicit operator runbook step; automation and agents must not
    perform the destructive cleanup.
  - **The annual plan is still unpriced** (the ruling covers monthly only), so
    checkout deliberately exposes only monthly billing. Owner call, Slice 0.
  - Apple's grid has no exact ¥500/$5 equivalents in every storefront: pick
    the nearest tier per the parity default in Decision 4 and accept small
    regional divergence.
- **Slice 1 — one stranger can sign up and pay on the web** (rough edges
  fine):
  - `services/firebase-functions`: revive function deploys via `kd cloud
    deploy --functions`; implement `createCheckoutSession`, `stripeWebhook`;
    **land the source-state + `recomputeEntitlement` reducer shape from day
    one** (the Stripe writer targets `billing/stripe`, never the entitlement
    doc directly — retrofitting the reducer after Apple ships is the
    expensive order); `firestore.rules` stanzas for entitlements, billing
    source docs, and `appAccountTokens`; emulator seed fixtures.
  - Account portal (registration/verification/sign-in → Checkout → success
    page). Product surface with backend contracts; recommended home is this
    repo (e.g. `apps/web-portal/`, deployed by `kd cloud deploy` to Firebase
    Hosting on the same projects) so agents can build it against the
    functions; `kanna-web` keeps marketing/legal pages. Owner may choose to
    fold it into `kanna-web` instead — the contract (callable functions +
    Firebase Auth) is identical.
  - Relay: entitlement check + 4402 semantics behind a config flag;
    grandfather seeding script; flag stays off until slice 3.
- **Slice 2 — lifecycle completeness + the Apple track** (backend/portal and
  mobile sub-tracks can run in parallel):
  - Web lifecycle: `createPortalSession` + "Manage billing"; `deleteAccount`
    pipeline + portal deletion UI; password reset surfaces; grace/dunning
    state rendering; the portal's App-Store-sourced and `duplicateSources`
    states.
  - Apple backend: `appStoreNotifications` (JWS verification, dedupe,
    mapping table), `beginAppStorePurchase`, `registerAppStoreTransaction`,
    restore conflict rule, tombstones; emulator + fixture coverage
    (Decision 8).
  - iOS binary: `expo-iap` dependency (**`runtimeVersion` bump in every
    environment of `mobileEnvironments.json`**), in-app registration +
    deletion, the 3.1.2 screen set, StoreKit-configuration-file testing,
    then a TestFlight sandbox pass against `kanna-build` (sandbox-stamped
    entitlements, Decision 4).
- **Slice 3 — flag day**: turn relay enforcement on; **submit the IAP binary
  (1.1.0) with its subscription products for App Review**, with rewritten
  review notes, listing copy, and privacy label; desktop entitlement state
  surface; privacy-policy final. **The web channel may flag-day before the
  IAP binary is approved**: the shipped 1.0.0 binary predates billing,
  contains no purchase UI and no CTA, and honoring web subscriptions in it
  is the transitional Model-2 posture — acceptable for a short window, and
  the IAP binary replaces it as soon as Apple approves. Do not hold the web
  launch hostage to App Review; do not ship any OTA update that references
  billing to the 1.0.0 binary.
- **Slice 4 — operate it**: relay monitoring/alerting + instance upsize;
  connection caps + pre-auth rate limit; `/ota/*` caps; billing runbook in
  `docs/` (refunds — Stripe and Apple's separate worlds, disputes,
  double-pay support flow, App Store Server API reconciliation script,
  support flows).
- **Slice 5 — grow it**: crash reporting/telemetry (opt-in), onboarding
  polish, trial/intro-offer tuning (cross-channel, Decision 6 item 14), then
  the deferred items (teams, metering, relink self-serve).

**App Store timeline note**: the IAP build is necessarily a new binary (new
native dependency → `runtimeVersion` bump → binary-only) and its first
subscription product review rides with a binary review. It is independent of
the 1.0.0 currently in App Review — do not touch that submission.
**Recommendation: target the first post-1.0 update (1.1.0) as the IAP
binary, timed to Slice 3** — not earlier, because a paywall in the store
while cloud is still free-for-everyone is incoherent and reviewers will
exercise the purchase against a backend that isn't enforcing anything; and
not later, because every week the web channel runs alone is a week iOS-first
users can't pay. If an unrelated 1.0.x fix must ship first, it must not
carry StoreKit.

## Decision 8 — Required test coverage (repo taxonomy)

- **Emulator rules tests** (`services/firebase-functions/test/`): entitlement
  doc and billing source docs — `billing/comp` explicitly included —
  owner-read/no-client-write;
  `appAccountTokens/{token}` not client-readable or writable; deletion
  pipeline leaves no `users/{uid}` residue and leaves the token tombstone.
- **Unit/integration — Stripe**: webhook handler against Stripe CLI fixture
  events — idempotency (duplicate event id), out-of-order events, every
  subscription-state transition mapping to source state.
- **Unit/integration — Apple**: `signedPayload` JWS verification against
  fixture payloads — valid chain accepted, broken/expired/untrusted chain
  rejected, wrong-environment claim stamped correctly; dedupe on
  `notificationUUID`; the full notification-type mapping matrix of Decision
  4 (SUBSCRIBED, DID_RENEW, DID_FAIL_TO_RENEW ± GRACE_PERIOD, EXPIRED,
  REFUND, REVOKE, DID_CHANGE_RENEWAL_STATUS); token-tombstone drop path;
  restore/relink refusal when `originalTransactionId` is bound to another
  uid.
- **Unit/integration — reducer**: `recomputeEntitlement` matrix — each
  source alone in each state; both billed sources active (honored-source
  rule + `duplicateSources`); active + grace; active + revoked (revocation
  never suppresses the other source); comp beside each billed-source state
  (comp wins, no `duplicateSources`, null `currentPeriodEndsAt`); comp
  revoked with a paid source present (falls back to the paid source);
  checkout/purchase refusal while comp is active; tie-breaks stable across
  repeated runs.
- **Unit/integration — relay**: entitlement gate (entitled / grace /
  expired / absent / unverified-email / sandbox-stamped) for both phone and
  desktop auth paths, including the 4402 refusal semantics and TTL-cache
  revalidation on revocation, and covering every path in the enforced set of
  Decision 5 — tunnels, publication, and `invoke` (phone→desktop and
  desktop→desktop) — plus the enforcement-on notification carve-out proving
  an unentitled account still publishes push.
- **Mobile/local**: a checked-in **StoreKit configuration file** in
  `apps/mobile` drives simulator purchase, restore, renewal, and refund
  flows without App Store Connect; sandbox Apple IDs cover
  device/TestFlight passes, with sandbox ASSN arriving at the `kanna-build`
  function per Decision 4.
- **E2E** (per the repo's E2E expectation): a staging-stack flow — create
  account → Stripe test-mode checkout → webhook fires → entitlement doc →
  relay session gains tunnel service; and the reverse (subscription canceled
  → relay refuses with 4402 → mobile shows neutral state).
- **What cannot be E2E-tested**, and the record it requires: a real App
  Store purchase, real production ASSN delivery, and App Review's own
  behavior are not automatable — the closest executable proofs are the
  StoreKit-configuration simulator flows, the sandbox/TestFlight pass, and
  the fixture-driven ASSN verification tests above. Per the repo convention,
  the implementation task that lands the Apple track must also land a dated
  `docs/YYYY-MM-DD-iap-e2e-gap.md` note naming exactly that boundary and the
  narrower tests that run now (the Stripe-side equivalent gap note,
  `docs/YYYY-MM-DD-billing-e2e-gap.md`, is likewise required where
  Stripe-hosted pages block CI automation).

## Scope / exclusions

This consultation designs; it changed no product code. Out of scope, decided
deliberately: teams/multi-seat, metered/usage-based pricing, relay HA,
Firestore-rule entitlement gating, any non-Stripe web processor, **Google
Play billing** (no Android channel is in scope anywhere in this spec),
introductory/promotional offers and Family Sharing (deferred with trial
mechanics), storefront-specific external-purchase-link builds, and
self-serve Apple-transaction relink. Not repo-resolvable: Firebase console
signup setting, Stripe/legal onboarding, the App Store Connect business
setup, Apple current-guideline verification, and `tampopogk/kanna-web`
content — all named above as human work.

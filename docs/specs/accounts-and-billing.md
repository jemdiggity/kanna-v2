# Accounts and Billing (Stripe) — Architecture Spec

Status: architect consultation verdict (task `da6b6800`, 2026-08-20). This is
the approach-level spec the owner asked for ("proper account creation and
subscription handling … assume Stripe"). It builds on, and does not replace,
`docs/2026-07-08-mobile-subscription-iap-strategy.md` — that document's
two-tier model and entitlement schema are adopted here.

Apple App Store analysis in this spec reflects knowledge current to
January 2026. Every item under "Human verification required" must be checked
against Apple's live guidelines before the paid launch.

## Verified current state (2026-08-20)

Confirmed by source inspection; corrections to the consultation prompt noted.

- Identity is Firebase Auth email/password everywhere. Mobile sign-in only
  (`apps/mobile/src/lib/firebase/sdk.ts`, `AccountSheet.tsx` — invite-only copy
  linking to `https://kanna.build/support`). The desktop also signs in as a
  real Firebase user (`apps/desktop/src/services/desktopAuthSdk.ts`,
  `desktopAutoSignIn.ts`) and bootstraps a per-machine
  `desktopCredentials/{desktopId}` secret-hash record
  (`desktopCloudAssociation.ts`). No registration, deletion, password-reset, or
  email-verification flow exists anywhere in the product.
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
- Legal/web: privacy policy and support pages are live at
  `kanna.build/privacy` / `/support`, served from the **separate**
  `tampopogk/kanna-web` repo; markdown source lives here in `docs/legal/`.
  Operator is Tampopo LLC, governing law Japan, contact
  `support@tampopomyoko.com`. **No Terms of Service exist.** Account deletion
  today is a manual 30-day email process (`docs/legal/support.md`).
- ⚠️ Correction to "accounts are provisioned manually": that is a **UI**
  restriction, not a backend one. The Firebase email/password provider has no
  in-repo allowlist; unless self-signup is disabled in the Firebase console,
  the Identity Toolkit REST API may already allow anyone to create an account —
  and today any account gets full relay service. Verify the console setting
  now; once entitlement enforcement (below) ships, open signup becomes safe.

## Decision 1 — Account lifecycle

**Keep Firebase Auth as the identity backbone.** It is already wired into
mobile, desktop, relay verification, and Firestore rules; replacing it buys
nothing. Additions:

- **Registration lives on the web first**: a small account portal (see
  component layout below) at `kanna.build` handles register → verify email →
  subscribe → manage billing → delete account. Web-first keeps the iOS app
  free of account-creation (so Apple's 5.1.1(v) in-app-deletion requirement is
  not triggered in phase 1) and puts registration on the same page as Stripe
  Checkout, which Apple cannot police. Email/password only at launch; no
  social providers (adding Google would drag in mandatory Sign in with Apple
  on iOS — defer both).
- **Email verification**: required before an entitlement can activate.
  Firebase `sendEmailVerification`; the billing backend refuses to create a
  Checkout session for an unverified account, and the relay treats
  `email_verified: false` phone tokens as unentitled.
- **Password reset**: Firebase `sendPasswordResetEmail`, surfaced on the
  portal sign-in page and as a "Forgot password?" link in the mobile
  `AccountSheet` (a reset link is not account creation and triggers no Apple
  obligations).
- **Account deletion** becomes a first-class backend pipeline regardless of
  where the button lives (APPI/GDPR and the existing 30-day manual promise
  both demand it): a callable function `deleteAccount` that, in order —
  cancels any Stripe subscription immediately (`cancel_now`, no proration
  surprises), recursively deletes `users/{uid}` (task index, desktops,
  pushDevices, entitlements, transfers), deletes/tombstones
  `desktopCredentials` docs whose `uid` matches, deletes legacy
  `devices/{token}` rows, revokes refresh tokens, then deletes the Firebase
  Auth user. The Stripe Customer object and invoices are retained (financial
  record-keeping obligation) — say so in the privacy policy. Paired desktops:
  LAN pairing is untouched (accountless by design); the desktop's cloud
  session dies with token revocation and it falls back to local-only.
  The portal exposes deletion in phase 1; mobile gets an in-app deletion
  screen **at the same time as** (or before) mobile in-app registration.
- **Mobile registration** is a fast-follow, not phase 1. When added, ship
  in-app deletion in the same release, and re-audit the App Store listing.
  Until then the mobile invite-only copy (`AccountSheet.tsx`,
  `CLOUD_ACCESS_REQUEST_URL`) must change to neutral wording — once accounts
  are self-serve, a link that lands users one click from a Stripe paywall is
  steering; keep the in-app link pointing at support/docs, not the
  pricing/signup page (see Decision 2).

## Decision 2 — The Apple question

Answered from the January 2026 knowledge cutoff plus the sources already
reviewed in `docs/2026-07-08-mobile-subscription-iap-strategy.md`; a human
must re-verify the flagged items against Apple's current text.

- **When Apple requires IAP** (3.1.1): when the *app itself* unlocks paid
  digital features or shows a purchase path. Guideline 3.1.3(b)
  ("multiplatform services") permits an app to *honor* subscriptions bought
  on other platforms; its "provided those items are also available as IAP"
  clause is applied with reviewer discretion, and 3.1.3(f) permits free
  companion apps to a paid web/desktop tool with **no purchase UI and no
  calls to action**. Slack/GitHub-style companion apps live in this space.
- **US anti-steering**: after the Epic v. Apple contempt ruling
  (April 30, 2025), Apple's US-storefront guidelines were changed to allow
  external purchase links without commission; Apple's appeal was pending as
  of the cutoff. Japan's smartphone competition act (in force from
  December 2025) imposes similar obligations for the Japan storefront —
  relevant since Tampopo LLC is Japan-based. **Do not build the launch
  posture on either carveout**: they are storefront-specific, in legal flux,
  and Kanna does not need them.
- **Recommended structure** (Model 2/3 of the strategy doc, unchanged):
  **web-first Stripe checkout; the iOS app honors existing entitlements and
  sells nothing.** The iOS app must NOT: show pricing, plan pickers, upgrade
  buttons, purchase links, "subscribe at kanna.build" copy, or locked-feature
  UI that advertises a paid upgrade. Expired/absent entitlement shows the
  neutral copy already specified: "Cloud access is not active for this
  account." LAN remains a first-class free path, which is what makes the
  free-companion framing honest. If App Review still objects under
  3.1.1/3.1.3(b), the prepared fallback is exactly one `cloud_access`
  auto-renewable IAP normalized into the same entitlement record (the
  entitlement schema below is deliberately source-agnostic so this bolts on
  without reshaping anything).
- **Human verification required before paid launch**: (1) current text of
  3.1.1 / 3.1.3(b) / 3.1.3(f); (2) status of the US external-link rules and
  the Epic appeal; (3) Japan storefront obligations; (4) whether 5.1.1(v)
  deletion has widened beyond "supports account creation"; (5) whether the
  App Review posture on web-created accounts signing in has shifted. Also
  update the App Review notes and listing copy ("invite-only") at flag day.

## Decision 3 — Stripe integration shape

- **Stripe Billing + hosted Checkout (mode=subscription) + hosted Customer
  Portal.** Not Payment Links (no reliable account linkage), not embedded
  elements (more surface, no benefit at this scale). Checkout carries
  `client_reference_id = uid` and the Customer carries `firebase_uid`
  metadata; the Customer Portal handles cancel/payment-method/invoices so
  Kanna builds no billing UI beyond a "Manage billing" button.
- **The billing backend lives in `services/firebase-functions`**, revived as
  real 2nd-gen Cloud Functions on the existing three Firebase projects:
  - `createCheckoutSession` (callable, auth + verified email required),
  - `createPortalSession` (callable),
  - `stripeWebhook` (HTTPS, signature-verified; handles
    `checkout.session.completed`,
    `customer.subscription.created/updated/deleted`,
    `invoice.payment_failed`, `invoice.paid`),
  - `deleteAccount` (callable; Decision 1).
  Rationale vs the relay VM: the relay is a single availability-critical
  e2-micro tunnel with a heavyweight deploy path; billing needs an
  independent lifecycle, TLS/webhook hosting for free, admin Firestore
  writes, and per-environment secrets — all native to Functions. The
  `createPairingCode` guard must be preserved: function deployment goes
  through `./kd cloud deploy` (extended to own `--functions`), never bare
  `firebase deploy`, and the retired function stays unexported.
- **Entitlement record**: adopt the strategy doc's schema at
  `users/{uid}/entitlements/cloud_access` — `status`
  (`active|grace|expired|revoked`), `source`
  (`stripe|app_store|free_beta|grandfathered|promo|manual|review`),
  `capabilities` (`cloud_relay`, `cloud_task_index`, `remote_task_control`),
  `currentPeriodEndsAt`, `graceEndsAt`, `stripeCustomerId`,
  `stripeSubscriptionId`, `environment`, `updatedAt`. Owner-read-only in
  `firestore.rules` (same stanza pattern as the task index); only the admin
  SDK writes it. No Firebase custom claims for entitlement — the relay
  already does a Firestore read per auth and revalidates per publish, so the
  entitlement read piggybacks on that path; claims would add up-to-1h
  staleness for no savings.
- **Webhook correctness**: dedupe on `stripeEvents/{event.id}`; entitlement
  writes are idempotent upserts keyed by subscription id; out-of-order events
  resolved by Stripe's `created` timestamp. Grace/dunning: map Stripe
  `past_due` → `status: grace` with `graceEndsAt` = end of Stripe Smart
  Retries; `canceled`/`unpaid` → `expired`. Cancellation at period end keeps
  `active` until `currentPeriodEndsAt` passes.
- **Test vs live**: `kanna-staging` ↔ Stripe **test mode** (own webhook
  endpoint + test keys), `kanna-build` ↔ live mode. Keys in GCP Secret
  Manager per project; never in the repo. Agents develop against the
  emulator (`services/firebase/emulator-seed` grows entitlement fixtures) and
  Stripe test mode via the Stripe CLI (`stripe listen`/`trigger`); live keys
  and live-mode operations are human-only, same rule as production deploys.

## Decision 4 — Entitlement enforcement

- **The relay is the enforcement point.** It already terminates every unit of
  remote value — tunnels, snapshot publication, push — and already re-reads
  Firestore for credential revalidation. After identity verification
  (`services/relay/src/auth.ts`), resolve uid → read
  `users/{uid}/entitlements/cloud_access` (in-memory TTL cache ~60s, same
  pattern as credential revalidation). Unentitled sessions still get
  `auth_ok` but with no advertised `tunnelServices`, publication and
  notification requests refused with a distinct close/error code (e.g. 4402
  "entitlement required") so clients render the neutral inactive state
  instead of a generic connection error. Enforcement applies to both phone
  ID-token sessions and desktop `desktopCredentials` sessions (both resolve
  to a uid).
- **Firestore rules stay as they are initially.** The task index is the
  user's own data; when publication stops, it merely goes stale. Gating owner
  reads on an entitlement `get()` doubles read costs for marginal benefit —
  optional hardening later, not launch scope.
- **Desktop and mobile are display surfaces, not enforcement points**: they
  read entitlement state (from the relay auth response and/or the owner-read
  entitlement doc) and render active/grace/inactive, with mobile keeping the
  strategy doc's neutral no-CTA copy.
- **Expired subscription**: relay tunnel refused, publication refused (index
  frozen), push stops. Nothing is deleted — data returns on renewal.
- **What stays free — stated explicitly**: LAN is free, permanently. The
  desktop app is fully functional with no account; LAN QR pairing and the
  mobile LAN companion need no account and no subscription. The funnel is:
  free local product → paid remote access (`cloud_access` = relay + cloud
  task index + push). This spec endorses that shape.
- **Grandfathering / flag day** (owner default): seed existing
  manually-provisioned accounts as `source: grandfathered, status: active`
  (they are few and were invited); enforcement turns on for everyone else on
  a flag day after the portal + billing path is live. The cutoff is enforced
  in the backend seeding, never inferred by clients.

## Decision 5 — Adoption gap-check (ranked)

Launch-blocking (a stranger cannot responsibly pay without these):

1. **Terms of Service** — none exist. Plus privacy-policy revision (Stripe as
   processor, entitlement/billing data, portal cookies) and — Japan-specific
   and easy to miss — a **Specified Commercial Transactions Act
   (特定商取引法) disclosure page**, legally required for paid online services
   sold by a Japanese operator. Human/legal work in `docs/legal/` +
   `tampopogk/kanna-web`.
2. **Web account portal + pricing page** (registration, verification,
   checkout, manage billing, delete account) — the entire self-serve funnel.
3. **Billing backend + entitlement record + relay enforcement** (Decisions
   3–4) — without enforcement, "subscribed" is meaningless and the relay is
   an open free tunnel the moment signup is self-serve.
4. **Email verification + password reset** (Decision 1).
5. **Deletion pipeline** (Decision 1) — replaces the manual 30-day email
   promise for self-serve accounts; the email route stays as fallback.
6. **Relay viability as a paid service**: uptime monitoring/alerting and a
   capacity plan. One unmonitored e2-micro is acceptable for invited friends,
   not for paying customers; an unnoticed outage is churn plus refunds. An
   instance upsize plus an uptime check is enough for launch; HA/multi-region
   is not.
7. **Website funnel**: landing page that explains the product, pricing page,
   and a quickstart doc (download → pair → sign up → go remote). Lives in
   `kanna-web`; the desktop app is discovered and downloaded from there.
8. **Baseline abuse controls on the relay**: entitlement gating is itself the
   main gate; add per-user concurrent-connection caps and per-IP pre-auth
   rate limiting, and note the unauthenticated `/ota/*` endpoints as a
   bandwidth-abuse surface to cap. Full metering/quotas are fast-follow.

Fast-follow (weeks after, in rough order):

9. **Crash reporting + opt-in telemetry** (Sentry or equivalent on desktop +
   mobile): strangers file unreproducible bugs; do it early. Updates the App
   Store privacy label (Diagnostics → collected) and privacy policy. Opt-in
   is the right default for a developer tool that tunnels source code.
10. **Trial mechanics** — owner decision; sensible default: 14-day free trial
    with card required (Stripe `trial_period_days`), because card-up-front
    kills throwaway-account relay abuse. Alternative (better funnel, more
    abuse surface): no-card trial via a `promo`-source entitlement.
11. **Mobile in-app registration + in-app deletion** (shipped together), then
    the IAP fallback only if App Review forces it or mobile-led growth
    matters.
12. **Teams/multi-seat**: defer — single-user first is right. The per-uid
    entitlement schema extends later (org doc + seat entitlements) without
    migration of the single-user shape.
13. Per-user bandwidth metering/quotas, relay horizontal scaling, additional
    Firestore-rule hardening.

Owner decisions needed (defaults supplied, none block spec-writing): price
(default: one plan, "Kanna Cloud", ~$10/month, ~2 months free annual);
trial shape (default: 14-day, card required); grandfathering (default:
permanent for existing invited accounts); whether the iOS app ever sells
(default: no, honor-only).

## Decision 6 — Sequencing

- **Slice 0 (human, unblocks everything)**: Stripe account for Tampopo LLC
  (test + live), ToS/legal/特商法 pages, price decision, verify Firebase
  console signup settings, Apple-guideline verification list from Decision 2.
- **Slice 1 — one stranger can sign up and pay** (rough edges fine):
  - `services/firebase-functions`: revive function deploys via `kd cloud
    deploy --functions`; implement `createCheckoutSession`, `stripeWebhook`,
    entitlement writes; `firestore.rules` entitlement stanza; emulator seed
    fixtures.
  - Account portal (registration/verification/sign-in → Checkout → success
    page). Product surface with backend contracts; recommended home is this
    repo (e.g. `apps/web-portal/`, deployed by `kd cloud deploy` to Firebase
    Hosting on the same projects) so agents can build it against the
    functions; `kanna-web` keeps marketing/legal pages. Owner may choose to
    fold it into `kanna-web` instead — the contract (callable functions +
    Firebase Auth) is identical.
  - Relay: entitlement check + 4402 semantics behind a config flag;
    grandfather seeding script; flag stays off until slice 3.
- **Slice 2 — lifecycle completeness**: `createPortalSession` + "Manage
  billing"; `deleteAccount` pipeline + portal deletion UI; password reset
  surfaces (portal + mobile sheet); grace/dunning state rendering.
- **Slice 3 — flag day**: turn relay enforcement on; mobile neutral
  inactive/expired states and removal of invite-only copy; desktop
  entitlement state surface; App Store listing/review-notes/support-doc
  updates; privacy-policy final.
- **Slice 4 — operate it**: relay monitoring/alerting + instance upsize;
  connection caps + pre-auth rate limit; `/ota/*` caps; billing runbook in
  `docs/` (refunds, disputes, support flows).
- **Slice 5 — grow it**: crash reporting/telemetry (opt-in), onboarding
  polish, trial tuning, then the deferred items (mobile registration+deletion,
  IAP fallback, teams).

## Required test coverage (repo taxonomy)

- **Emulator rules tests** (`services/firebase-functions/test/`): entitlement
  doc owner-read/no-client-write; deletion pipeline leaves no `users/{uid}`
  residue.
- **Unit/integration**: webhook handler against Stripe CLI fixture events —
  idempotency (duplicate event id), out-of-order events, every
  subscription-state transition mapping to `status`; relay entitlement gate
  (entitled / grace / expired / absent / unverified-email) for both phone and
  desktop auth paths, including the 4402 refusal semantics and TTL-cache
  revalidation on revocation.
- **E2E** (per the repo's E2E expectation): a staging-stack flow — create
  account → Stripe test-mode checkout → webhook fires → entitlement doc →
  relay session gains tunnel service; and the reverse (subscription canceled →
  relay refuses with 4402 → mobile shows neutral state). Where live-stack
  automation is not yet possible (Stripe-hosted pages in CI), land the dated
  `docs/YYYY-MM-DD-billing-e2e-gap.md` note naming the narrower tests that
  run now, per convention.

## Scope / exclusions

This consultation designs; it changed no product code. Out of scope, decided
deliberately: teams/multi-seat, IAP implementation (fallback-ready only),
metered/usage-based pricing, relay HA, Firestore-rule entitlement gating, and
any non-Stripe processor. Not repo-resolvable: Firebase console signup
setting, Stripe/legal onboarding, Apple current-guideline verification, and
`tampopogk/kanna-web` content — all named above as human work.

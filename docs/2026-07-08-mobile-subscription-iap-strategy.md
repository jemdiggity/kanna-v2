# Mobile Subscription and IAP Strategy

## Scope

This is a product and technical recommendation, not legal advice. Apple App
Review decisions can turn on presentation details, reviewer interpretation,
territory, and the exact feature set in the submitted binary. Before shipping a
paid cloud launch, Kanna should confirm the selected model with counsel or by
asking App Review through App Store Connect review notes / appeal channels.

Kanna's current production mobile identity is:

- iOS bundle id: `build.kanna.app`
- Display name: `Kanna`
- Relay: `wss://relay.kanna.build`
- Firebase project: `kanna-build`

Cloud access currently has no user-facing billing because the billing feature is
not built yet, so users can use it for free today. That is a temporary launch
state, not the intended long-term free tier: Kanna pays real infrastructure cost
for relay/cloud access and expects to charge a small monthly subscription for
new users once billing ships. LAN access stays free and can provide the same
mobile task workflows while the phone is on the same network as the user's
machine.

## Apple Sources Reviewed

- [App Review Guidelines, 3.1 Payments](https://developer.apple.com/app-store/review/guidelines/#business)
  - 3.1.1 says app-unlocked digital features, functionality, subscriptions, or
    premium content must use in-app purchase, and apps cannot use their own
    unlock mechanisms for that in-app functionality.
  - 3.1.2 allows auto-renewable subscriptions and lists SaaS and cloud support
    as examples of appropriate ongoing subscription value.
  - 3.1.3 says listed exceptions may use other purchase methods, but in-app UI
    generally cannot encourage non-IAP purchase methods except where allowed for
    United States storefront apps or specific entitlements.
  - 3.1.3(b) allows multiplatform apps to let users access subscriptions or
    features acquired elsewhere, provided those items are also available as IAP
    in the app.
  - 3.1.3(f) says free stand-alone companion apps for a paid web-based tool do
    not need IAP if there is no in-app purchasing and no calls to action for
    outside purchase.
- [Apple Developer News, May 1, 2025 guideline update](https://developer.apple.com/news/?id=9txfddzf)
  notes that United States storefront guidance changed for buttons, external
  links, and calls to action in 3.1.1 and 3.1.3. Kanna should not rely on the
  United States-only carveout as its default global App Store posture.
- [App Store Connect Help: App Store Server Notifications](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/)
  says Apple can send key IAP lifecycle events, including subscription status
  changes and refunds, to production and sandbox server endpoints.
- [StoreKit In-App Purchase documentation](https://developer.apple.com/documentation/storekit/in-app-purchase),
  [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi),
  [StoreKit purchase restoration](https://developer.apple.com/documentation/storekit/restoring-purchased-products),
  and
  [`Transaction.currentEntitlements`](https://developer.apple.com/documentation/storekit/transaction/currententitlements)
  are the relevant Apple technical surfaces if Kanna adds IAP.

## Recommendation

Use a two-tier access model:

- Free tier: LAN companion access. Users can control and view tasks from mobile
  when the phone is on the same LAN as their desktop. This stays free.
- Paid tier: cloud/relay access. Once billing ships, new users need an active
  `cloud_access` subscription for off-LAN relay, cloud task index access, and
  remote task control.

For the current launch, keep cloud temporarily free because billing does not
exist yet. The iOS app should stay free, contain no purchase UI, no pricing, no
plan picker, no "upgrade on web/desktop" call to action, and no external
purchase links. Existing Kanna accounts can sign in and use cloud/relay
functionality during this free pre-billing period. The mobile app should also
make the durable free LAN path first-class, because that is the long-term free
alternative to paid cloud access.

When billing ships, the lowest-risk App Store model is to offer the same
`cloud_access` entitlement as an App Store auto-renewable subscription and also
allow web/desktop purchases. This lets Kanna charge for cloud cost recovery
without making the iOS app a web-purchase-only unlock surface.

The practical rule should be:

- Start with no IAP while cloud access is temporarily free to users because
  billing is not built, and iOS has no purchase CTAs.
- Treat LAN as the permanent free mobile path and cloud/relay as the future paid
  entitlement for new users.
- Before turning cloud access into a paid entitlement, decide whether iOS will
  continue to expose cloud features for subscribed accounts. If yes, add IAP at
  the same time as the paywall or before it ships. If no, keep paid-gated cloud
  functionality out of the iOS app.
- Add exactly one IAP auto-renewable subscription for `cloud_access` before
  adding any native iOS paywall, in-app upgrade prompt, plan comparison,
  pricing, or marketing that makes cloud access look like a paid iOS feature.
- If App Review rejects the no-IAP companion build under 3.1.1 or 3.1.3(b),
  either remove the paid-gated cloud functionality from iOS or implement the
  single IAP entitlement. Do not add workaround copy that points users to
  desktop/web purchase.

Business/legal confirmation is not urgent while cloud is temporarily free to
users. It becomes important before launch of paid cloud access, especially if
Kanna wants the iOS app to keep using paid cloud functionality without offering
IAP.

## Model Comparison

### Model 1: Same Cloud Entitlement Sold Through IAP and Web/Desktop

Users can buy `cloud_access` in iOS via StoreKit or outside iOS through
web/desktop billing. The backend normalizes both purchase sources into the same
account entitlement.

Mobile can safely expose:

- Sign-in and account creation.
- Cloud relay / remote task access for active subscribers.
- Native paywall, subscription management entry points, restore purchases, and
  trial / promotional offer surfaces.
- Mobile task creation or command features if those are part of the subscribed
  cloud service.
- Access for subscribers who purchased on web/desktop, as long as the equivalent
  subscription is also available through IAP in the app.

Review risk:

- Lowest if cloud task access is a paid digital service consumed in iOS.
- Requires App Store subscription compliance: clear subscription terms before
  purchase, restore purchases, cancellation/management through Apple surfaces,
  subscription group hygiene, sandbox review readiness, and server validation.
- Adds operational cost and Apple commission exposure. If $5/month is important
  economically, web/desktop and IAP pricing strategy needs business approval.

When Apple likely expects IAP:

- The iOS app has a paywall or upgrade button.
- The iOS app shows subscription pricing or plan comparisons.
- Mobile-only users can reasonably discover that cloud access is paid.
- The paid entitlement unlocks material iOS functionality, not merely a desktop
  companion relationship.

### Model 2: Existing Web/Desktop Subscribers Sign In on iOS, No Purchase UI

Users cannot buy in iOS. They can sign in, and if their Firebase account has an
active externally purchased cloud entitlement, iOS enables cloud transport. The
app contains no web/desktop purchase CTA.

Mobile can safely expose:

- Free LAN companion functionality for all users.
- Sign-in, sign-out, account deletion, and session/device management.
- Cloud relay/task access for accounts that already have `cloud_access`, if the
  app avoids purchase prompts and does not explain where to buy.
- A neutral expired-state message such as "Cloud access is not active for this
  account" with no price, website, button, or upgrade instructions.

Review risk:

- Medium. This is cleaner than sending users out to buy, but 3.1.3(b)'s text for
  multiplatform services says externally acquired subscriptions or features are
  allowed when the same items are also available as IAP in the app.
- Risk increases if the App Store listing, screenshots, onboarding, or in-app
  empty states make cloud access the app's main value.
- Risk decreases if mobile has meaningful free companion behavior and App Review
  notes explain that no purchase is possible in the app.

When Apple likely expects IAP:

- Reviewers see paid cloud access as a digital service consumed in iOS.
- Cloud access is the only practical way to use the app.
- The app has disabled/locked UI that clearly implies a paid upgrade exists.

### Model 3: Free Stand-Alone Companion to Paid Desktop/Cloud Tool

iOS is submitted as a free companion app. It does not sell anything, link to
purchase, mention prices, or include upgrade calls to action. Paid cloud access
is treated as part of the desktop/web service relationship, not as a mobile
subscription surface.

Mobile can safely expose:

- Local/LAN pairing with a user-owned desktop.
- Viewing and controlling tasks on a paired desktop where the mobile app is a
  companion remote.
- Account sign-in required for device identity, relay authentication, and
  security.
- Cloud relay access only as an authenticated companion transport, ideally
  framed around connecting to the user's desktop rather than unlocking iOS-only
  content.

Review risk:

- Low IAP implementation scope but not zero App Review risk. 3.1.3(f) is the
  relevant path, but Kanna's category is not an exact match for Apple's examples.
- The app must be genuinely free in-app: no purchase UI, no external purchase
  CTA, no "subscribe at Kanna" language, and no App Store metadata that routes
  users around IAP.
- If cloud-backed task access looks like a paid SaaS feature experienced inside
  iOS, Review may apply 3.1.1 / 3.1.3(b) instead.

When Apple likely expects IAP:

- The iOS app is marketed as "Kanna Cloud" or as a direct paid cloud task client.
- The app gates most screens behind a paid account.
- Kanna adds mobile-native cloud features whose value is consumed primarily in
  the app rather than on the desktop service.

## Entitlement Model

Use one backend entitlement regardless of purchase source:

```text
accounts/{accountId}/entitlements/cloud_access
```

`accountId` should be the Firebase Auth `uid`. The entitlement document should
not be source-specific; source-specific purchase records live in subcollections
or separate billing tables.

Suggested entitlement fields:

- `status`: `active`, `grace`, `expired`, `revoked`
- `source`: `stripe`, `app_store`, `free_beta`, `grandfathered`, `promo`,
  `manual`, `review`
- `capabilities`: stable strings such as `cloud_relay`, `cloud_task_index`,
  `remote_task_control`
- `currentPeriodEndsAt`
- `graceEndsAt`
- `canceledAt`
- `revokedAt`
- `sourceSubscriptionId`
- `appStoreOriginalTransactionId` when source is `app_store`
- `stripeSubscriptionId` when source is `stripe`
- `environment`: `production`, `sandbox`, `staging`
- `updatedAt`

Access checks should happen server-side:

- LAN access should not require `cloud_access`. It is the permanent free local
  companion path and should remain authorized by local pairing/trust.
- Relay authentication should verify the Firebase token/device credential and
  then check `cloud_access` before allowing production cloud transport if cloud
  transport is paid.
- Firestore security rules or backend writers should avoid exposing paid cloud
  task data to accounts without an active entitlement.
- The mobile client may cache entitlement state for presentation, but it must not
  be authoritative.

Expired behavior:

- Existing local/LAN companion features continue.
- Paid cloud relay, remote task streams, and remote task commands are disabled
  after `currentPeriodEndsAt` plus any accepted grace policy.
- Messaging stays neutral in no-IAP builds: "Cloud access is not active for this
  account." Do not include purchase instructions.

Pre-billing behavior:

- Until billing launches, cloud can be represented as `source = free_beta` with
  `status = active`, or the backend can skip entitlement enforcement for cloud
  while the mobile and desktop clients are prepared for the future entitlement
  response shape.
- Before billing launches, decide whether existing users receive a
  `grandfathered`, trial, or promotional entitlement, or whether enforcement
  applies only to new accounts after a cutoff date.
- The cutoff policy must be enforced on the backend, not inferred by the mobile
  app.

If IAP exists:

- Add one auto-renewable subscription product for `cloud_access`, preferably in
  a single subscription group.
- The iOS app completes purchases with StoreKit and sends the signed transaction
  or app account token mapping to the backend.
- The backend validates through App Store Server API / signed transaction
  verification, stores `appStoreOriginalTransactionId`, and updates the unified
  entitlement.
- Configure App Store Server Notifications for production and sandbox so
  renewals, expirations, refunds, billing retry, and revocations update the
  entitlement without relying on the app launch path.
- Provide Restore Purchases. Restore should read StoreKit current entitlements,
  send active transactions to the backend, and relink the entitlement to the
  signed-in Kanna account after conflict checks.
- Prevent accidental duplicate payment: if an account already has active
  `cloud_access` from web/desktop, do not push the user into an App Store
  purchase. Show entitlement active and provide Apple management only for
  App-Store-sourced subscriptions.

If IAP does not exist:

- Do not link StoreKit.
- Do not include a product catalog, paywall, pricing copy, upgrade CTA, or
  external purchase link.
- Keep the entitlement API source-agnostic so App Store IAP can be added later
  without changing mobile feature authorization semantics.

## App Review Demo Behavior

For a no-IAP companion submission:

- Provide App Review with a demo account that can sign in.
- Seed either an active companion desktop or deterministic demo cloud tasks so
  Review can exercise the app without purchasing anything.
- In review notes, state that the app is free, has no in-app purchases, has no
  purchase links or calls to action, and is a companion for an existing desktop
  developer tool. Do not tell reviewers to buy on the website.
- Ensure all account deletion and privacy flows work for the demo account.

For an IAP submission:

- Configure sandbox products before submission.
- Include the StoreKit purchase path, restore purchases, and clear subscription
  terms in the binary.
- Provide Review notes for testing purchase, restore, expiration, and an already
  entitled account.
- Ensure the backend accepts sandbox App Store Server Notifications separately
  from production.

## Later Repo Implementation Tasks

No executable billing system should be built as part of this strategy document.
Later implementation should be split into small tasks:

1. Define a shared entitlement schema and capability constants for
   `cloud_access`.
2. Define the permanent free LAN path separately from paid cloud/relay access.
3. Add backend entitlement reads to relay authentication and any cloud task index
   access path.
4. Add Firebase/Firestore rules or backend API guards for paid cloud task data.
5. Add neutral mobile entitlement states: active, inactive, expired, and
   temporarily unavailable.
6. Add pre-billing and cutoff handling for `free_beta`, `grandfathered`, or
   promotional cloud access.
7. Audit mobile copy and App Store metadata for purchase CTAs before any no-IAP
   submission.
8. If IAP is selected, add StoreKit product loading, purchase, transaction
   listener, restore purchases, and sandbox tests behind a feature flag.
9. If IAP is selected, add backend App Store transaction validation and App Store
   Server Notification ingestion.
10. Add App Review demo seeding for production/staging review accounts.
11. Add regression tests ensuring no-IAP builds contain no purchase buttons,
   external purchase links, or pricing strings.

## Unresolved Decisions

- Business/legal: confirm whether Kanna can credibly submit under 3.1.3(f) as a
  free stand-alone companion before cloud access becomes paid.
- Product: decide the cutoff policy for existing users when new-user cloud
  subscriptions launch: no grandfathering, limited trial, promotional credits,
  or permanent grandfathering.
- Pricing: if IAP is required, decide whether App Store pricing matches
  web/desktop or differs to account for Apple commission and regional price
  tiers.
- Packaging: decide whether Kanna ships one global no-IAP binary or uses
  storefront-specific external purchase link behavior for the United States.
  The recommended default is one global policy: either a no-IAP companion build
  or an IAP-enabled build, not storefront-specific purchase copy.
- Review readiness: decide how to maintain a stable demo account and reachable
  demo desktop/cloud task data for App Review.

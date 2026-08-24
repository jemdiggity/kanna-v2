# Anonymous Push Notifications — Architecture Recommendation

Status: **Proposed** (architect consultation, task `38025180`, 2026-08-24;
delivery semantics amended by owner directive, task `20a9518c`, 2026-08-24).
Owner question: can mobile push notifications work for LAN-paired devices with
no account, while remote terminal access stays behind paid cloud sign-in — and
can the fix for "LAN delivery suppresses push exactly when push is needed" land
in the same architecture?

Verdict: **APPROVE** — yes to both, with the design below. Notifications become
a pair-scoped, account-free relay capability anchored in the existing LAN
pairing ceremony. Delivery is push-only in every mobile app state; LAN is not a
notification transport.

---

## 1. Verified current behavior

- **Delivery suppression bug** (`crates/kanna-server/src/http_api/mobile_notifications.rs:43-60`):
  `deliver_lan_mobile_notification` counts a successful `try_send` into any
  device's LAN frame channel as "delivered" and skips the relay queue entirely.
  A socket write is not proof of display: iOS suspends the backgrounded app, the
  frame is never processed, and `lanNotifications.ts`'s background
  `scheduleNotificationAsync` path never runs. Additionally, *one* delivered
  device suppresses push for *all* paired devices (`state.rs:556-584` counts per
  device but the caller only checks `> 0`).
- **Push transport is FCM, not raw APNs**: the phone registers an FCM
  registration token (`@react-native-firebase/messaging`) at relay
  `POST /push/register`, authenticated by a **Firebase Auth ID token** and
  stored under `users/{uid}/pushDevices` (`services/relay/src/index.ts:294`,
  `auth.ts:403`). The desktop publishes `mobile_notification_publish` over a
  relay WebSocket authenticated by `desktopId` + `desktopSecret` against the
  uid-bound Firestore `desktopCredentials` doc written at desktop sign-in.
  **Both halves require an account today; FCM itself requires none.** Nothing
  in this design needs raw APNs.
- **Pairing trust anchor** (`crates/kanna-server/src/pairing.rs`): compact QR
  `KANNA1:{DESKTOP-ID}:{CODE}` (5-minute TTL, 5 failed claims max), phone claims
  over LAN, receives a one-time 32-byte device secret whose hash the desktop
  persists; the phone authenticates every LAN request with it. This ceremony
  already proves physical co-presence and mutual consent.
- **Entitlement boundary** (`services/relay/src/entitlement.ts`): `cloud_relay`
  gates tunnels *and* push; `remote_task_control` gates invoke routing.
  Enforcement is flag-gated off until Slice 3. The 2026-08-21 owner ruling made
  every relay-crossing path paid; the owner's 2026-08-24 question revises that
  for notifications specifically. `docs/specs/accounts-and-billing.md`
  (Decision 5) must be amended accordingly — that amendment is in scope for the
  implementing work and carries the owner's decision, not the architect's.

## 2. Chosen design

### 2.1 Delivery semantics: push-only

The owner's 2026-08-24 directive supersedes the architect's always-push plus
LAN-foreground-banner recommendation: remove LAN notification delivery and use
the relay push path unconditionally. A live socket is neither proof of display
nor a useful notification transport on iOS, and retaining it would require
deduplication solely to support a fast path the product does not need.

Mechanics:

- `kanna-server` always queues the validated notification on the relay. It has
  no LAN fan-out, `mobile_notifications` KSP capability, notification server
  frame, or `lanDeliveredCount` response field.
- Mobile has no LAN notification listener, local-notification fallback, in-app
  notification banner, haptic, notification id, or dedupe cache. Expo's
  foreground presentation handler shows the same system notification used in
  background and terminated states.
- Task-target data remains in the push payload, so tapping a notification opens
  the task whether the app launches from the tap or was already running.
- The mobile change is JS-only (no new native dependencies, so no
  `runtimeVersion` bump).

This signed-in delivery fix is independent of the anonymous credential work
and ships first. Follow-up tasks add anonymous registration and publishing
without reintroducing LAN delivery.

### 2.2 Pair-scoped anonymous credentials

**Identity.** The desktop generates a long-lived Ed25519 keypair on first use
(stored beside the pairing store, never leaving the machine). Its public key is
the desktop's **self-certifying anonymous push identity**: the relay
authenticates it by signature, needing no registry, no Firestore doc, and no
account. Impersonation requires the private key.

**Proof-of-pairing (yes, the relay requires it).** The relay never trusts a
bare desktop claim about a phone's token, and never lets an unpaired client
register against a desktop's identity. At LAN pairing claim time the response
gains two additive fields:

- `desktopPushIdentity`: the Ed25519 public key (plus relay URL/environment so
  a signed-out phone knows where to register);
- `pushPairingCert`: `{deviceId, issuedAt, expiresAt, signature}` — signed by
  the desktop's anon key. Lifetime ~24 months; transparently re-issued whenever
  the phone talks to the desktop over LAN (the LAN channel is already
  authenticated by the pairing device secret).

**Registration is phone-authoritative.** The phone — the only party that knows
its own FCM token — registers directly with the relay:
`POST /push/pairings {desktopPubKey, deviceId, fcmToken, cert}`. The relay
verifies the cert signature and expiry and upserts a binding keyed by
`(sha256(pubKey), sha256(deviceId))` in a new Firestore collection
(`anonymousPushPairings`), storing the token and `updatedAt`. This is the
co-sign the design question asks about: the desktop signed consent to push to
that device; the phone's own registration proves token ownership and consent to
receive. A full phone-side keypair adds protocol weight without adding a
property (FCM token possession already binds the endpoint) — deliberately
omitted.

**Lifecycle.**

- *Rotation*: FCM `onTokenRefresh` → phone re-POSTs the same cert with the new
  token; the keyed binding is overwritten. The phone also refreshes the binding
  opportunistically (app open, token refresh) to keep `updatedAt` fresh.
- *Revocation on unpair*: phone-initiated — `DELETE /push/pairings` with the
  cert; desktop-initiated (trusted-device removed in desktop UI) — a signed
  revocation message over the desktop's relay session, queued until the next
  connection if offline. Rotating the desktop keypair revokes everything at
  once (new pubkey = new namespace).
- *Expiry/GC*: the relay garbage-collects bindings with no refresh and no
  successful delivery for ~180 days. Cert expiry only bites a phone that has
  not touched the desktop's LAN in ~24 months.
- *Sending*: a signed-out desktop authenticates a relay session with a new
  challenge–response auth variant (`auth {anonPubKey}` → `auth_challenge
  {nonce}` → `auth_proof {signature}` → `auth_ok`), which kills replay of a
  captured auth blob and reuses the existing capability-advertisement and
  publish/ack machinery in `relay_client.rs`. Signed-out desktops connect
  lazily per notification burst and idle-disconnect (~60s) rather than holding
  a permanent socket per free user.

### 2.3 Abuse resistance without accounts

- **Registration**: cert required (unpaired clients cannot bind a token to a
  desktop identity — this is also what prevents an attacker from receiving a
  victim desktop's notifications); per-IP HTTP rate limits on `/push/pairings`
  (the relay already has per-IP upgrade admission machinery in
  `webSocketLimits.ts` to pattern-match); caps: ~10 devices per desktop key,
  ~20 desktop keys per token.
- **Publish**: existing payload caps stay (title 200 / body 2000 chars, 16 KB
  frame); add per-desktop-key rate limits (order of 30/min burst, 500/day) and
  per-token limits across all senders (order of 60/min, 1000/day) — in-memory
  on the relay VM is sufficient at current scale; a publish with no bindings is
  refused before any FCM call, so the relay cannot be used as a blind FCM
  proxy.
- **Malicious desktop binary**: it owns the machine, so it owns the anon key
  and can spam *its own paired phones* until unpaired — bounded by rate limits,
  display-only payloads (title/body/taskId; no remote-control value), and
  one-tap unpair + iOS notification settings on the phone. It cannot harvest
  *other* users' pairings: impersonating another desktop needs its private key,
  and registering a token against any desktop needs that desktop's signed cert.

### 2.4 Product boundary and in-place upgrade

- **Enforcement stays message-type-granular at the relay**, where it already
  lives. An anonymous session's principal kind grants exactly
  `mobile_notification_publish`; tunnels, `invoke` routing, task snapshot
  publication, and desktop routing are refused for anonymous principals by
  principal-kind check before any entitlement logic runs. `remote_task_control`
  and tunnel gating for account sessions are untouched — the paid boundary is
  clean because the anonymous principal never reaches those handlers.
- **Push exits `cloud_relay`**: when Slice-3 enforcement turns on,
  `mobile_notification_publish` must no longer require the entitlement (free
  for account and anonymous principals alike). This amends the 2026-08-21
  ruling per the owner's 2026-08-24 decision; `accounts-and-billing.md`
  Decision 5 is updated in the same change.
- **Upgrade in place**: a desktop that is signed in presents *both* identities
  on one session (its `desktopCredentials` plus its anon pubkey proven against
  the same challenge nonce). The relay delivers to the **union** of
  `users/{uid}/pushDevices` and the anon bindings for that proven key,
  deduplicated by FCM token. This closes every mixed state without data
  migration: desktop signed in + phone anonymous (bindings cover it), phone
  signed in + binding still present (token dedupe prevents doubles), desktop
  signs out (falls back to anon-only session, bindings persist). The union is
  keyed strictly on *same-session-proven* identities — never on a desktopId
  claimed inside a cert, which an attacker could mint.

### 2.5 Migration (existing signed-in devices)

The account path — `/push/register`, `users/{uid}/pushDevices`,
`desktopCredentials` session auth, FCM delivery — is not modified, only
unioned-with. Existing paired signed-in devices keep working with zero
re-registration through every phase. Phase 1 changes their behavior only by
fixing the suppression bug (they gain background notifications). Devices paired
before pairing secrets existed already cannot authenticate LAN requests and
must re-pair to obtain a cert — unchanged posture.

## 3. API / protocol changes by component

| Surface | Change |
|---|---|
| `kanna-server` | Anon Ed25519 keypair storage; pairing claim response += `desktopPushIdentity`, `pushPairingCert` (additive JSON); notification delivery is relay-only and its LAN KSP capability/frame are removed; lazy anon relay session; signed unpair revocation; LAN cert re-issue endpoint. |
| relay | `POST/DELETE /push/pairings` (cert-verified, rate-limited); `auth_challenge`/`auth_proof` messages; `anonymousDesktop` principal limited to `mobile_notification_publish`; dual-identity account auth; union + token-dedupe delivery; `anonymousPushPairings` collection + GC; per-key/per-token rate limits; push carved out of `cloud_relay`. |
| mobile | LAN notification handler and in-app banner removed; foreground push uses system presentation; new anonymous registration module (cert + FCM token, `onTokenRefresh`, unregister on unpair); notification permission prompt at pairing time. JS-only → OTA-deliverable. |

## 4. Phased implementation plan (4 tasks)

**Task 1 — Push-only delivery fix (ships alone, fixes today's bug).** Remove
LAN notification fan-out and KSP capability/frame, always queue relay push,
remove the mobile LAN listener/banner, and enable foreground system
presentation. *E2E*: kanna-server integration coverage proves an authenticated
notify request queues relay push even while a paired LAN stream is active;
mobile tests cover foreground presentation and task opening from initial and
running-app notification taps. Verify visible iOS notifications foregrounded
and backgrounded.

**Task 2 — Desktop anonymous identity + pairing certificate.** Keypair
generation/storage, claim-response extension, LAN cert re-issue, mobile
persistence of identity + cert (`sessionPersistence`). No relay involvement
yet; a paired phone simply holds an unused cert. *E2E*: pairing-claim
round-trip test asserting cert verifies against the returned pubkey and that
old clients tolerate the additive fields.

**Task 3 — Relay anonymous path.** `/push/pairings` endpoints, cert
verification, binding store + caps + GC, challenge–response anon auth,
`anonymousDesktop` principal restricted to notification publish, rate limits;
kanna-server lazy anon session; mobile registration module wired to pairing
and `onTokenRefresh`. *E2E*: relay integration suite — register/rotate/revoke
binding lifecycle; anon publish delivered; anon session refused for
invoke/tunnel/snapshot; unpaired registration refused; rate-limit refusal.
kanna-server fake-relay test for the signed-out publish path. Where a true
device-push E2E is impossible in CI, land the dated coverage-gap note per repo
convention.

**Task 4 — Product boundary + upgrade-in-place + spec amendments.**
Dual-identity session auth, union + token dedupe, push carved out of
`cloud_relay` (with Slice-3 flag interaction tested), sign-in/sign-out
transitions, `accounts-and-billing.md` Decision 5 amendment. *E2E*: relay
tests for each mixed state (desktop-signed-in/phone-anon, both-signed-in with
residual binding → exactly one push per token, desktop sign-out fallback);
entitlement-enforcement-on test proving unentitled accounts still publish
notifications but not tunnels/invoke.

## 5. Alternatives considered

- **Desktop-registers-token (relay trusts desktop's claim)**: rejected — lets
  a malicious desktop bind arbitrary tokens without phone consent; the phone
  must be the registrant, and the cert is the proof-of-pairing.
- **Phone-side keypair co-signature**: rejected as redundant — token possession
  plus cert presentation already establishes both parties' consent.
- **Raw APNs (drop FCM)**: rejected — FCM requires no user account, the relay
  already holds the credentials, and switching transports is pure scope growth.
- **LAN displayed-ack with push fallback**: rejected — adds server pending
  state, timers, an ack frame, and dedupe for a transport the product does not
  need.
- **Always-push plus LAN foreground banner**: superseded by the owner's
  push-only directive — it needs notification ids and device-side dedupe while
  providing no meaningful product benefit over foreground system presentation.
- **Per-notification signed publish over stateless HTTP** instead of
  challenge–response WS auth: viable, but the WS session reuses the existing
  queue/ack/capability machinery in `relay_client.rs`; kept the session model.
- **Retain current suppression with better "displayed" detection**: rejected —
  the server fundamentally cannot know an iOS app displayed anything; any
  socket-side signal reproduces the bug.

## 6. Invariants and failure modes

- A notification produced while the app is backgrounded must reach APNs —
  never suppressed by a socket write (the bug class this design removes).
- At most one relay push is published per logical notification request; there
  is no second LAN display path to deduplicate.
- Only a phone holding a desktop-signed cert can bind a token to that desktop;
  only the holder of the desktop's private key can publish to its bindings.
- Anonymous principals can never reach tunnel/invoke/snapshot paths.
- Relay/Firestore outage: push fails with the existing honest failure ack (no
  LAN fallback and no fail-open for bindings — no binding, no push).
- Desktop key loss (pairing store reset) orphans bindings → GC reclaims;
  recovery is re-pairing over LAN.

## 7. Scope / exclusions

Free anonymous surface is notification delivery only. Remote terminal access,
task snapshots, invoke routing, and tunnels remain account + entitlement
gated. No change to LAN request auth, the pairing QR format (additive claim
*response* fields only), raw PTY transcripts, or the desktop sidebar/mobile
activity semantics. Production relay deploys and the entitlement flag day
remain human-gated per repo convention.

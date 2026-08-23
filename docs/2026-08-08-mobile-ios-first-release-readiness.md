# Kanna Mobile — iOS First Release Readiness

Last verified: 2026-08-10, after the seven preparation PRs landed on `main`.
Includes source checks, live checks of `kanna.build` and `relay.kanna.build`,
and a rescue-pass check against Apple's current App Store Connect requirements.

**Status: every repo-side and web-side blocker is closed.** What remains is
Apple Developer portal work, one Firebase console step, screenshots and review
contact details, and standing up the review environment — none of which can be
completed from this repository. Jump to [Suggested order](#suggested-order) for
the sequence.

This supersedes the source-inventory sections of
[`2026-07-07-kanna-mobile-app-store-submission.md`](2026-07-07-kanna-mobile-app-store-submission.md)
and [`mobile-app-store-review-audit.md`](mobile-app-store-review-audit.md),
both of which predate push notifications, camera pairing, and crash
diagnostics. The July screenshot rules and human-confirmation prompts remain
useful; its metadata draft is replaced by
[`2026-08-09-mobile-app-store-listing.md`](2026-08-09-mobile-app-store-listing.md),
and its dependency inventory and privacy-label table are stale.

Scope: what is left to do before a first submission to the iOS App Store. It
does not cover Android.

## What is already done

Verified in the repo, not assumed:

| Area | State | Evidence |
|---|---|---|
| Production identity | `Kanna` / `build.kanna.app` / team `EA4J68749Z` | `apps/mobile/src/mobileEnvironments.json`, `apps/mobile/app.config.ts` |
| Archive + upload workflow | `./kd mobile archive --production --build-number <n> [--upload]` — prebuild → `xcodebuild archive` → `app-store-connect` export → Transporter | `tools/kd/src/runtime/mobile-archive.ts` |
| Release QA gate | `./kd mobile qa --production [--ota]` | `docs/testing/mobile-production-qa-gate.md` |
| Production backend | `https://relay.kanna.build/health` → 200 (checked 2026-08-10) | live |
| OTA | Self-hosted, code-signed, `production` channel, runtime `2.1.4` | `docs/specs/mobile-ota-updates.md` |
| Permission strings | Local network, camera, and Bonjour `_kanna-mobile._tcp` all set by config plugins | `plugins/withKannaBonjour.js`, `app.config.ts` |
| App icon | 1024×1024 source; Expo 57 prebuild removes transparency and emits an opaque 1024×1024 default iOS icon | `apps/mobile/assets/icon.png`, `@expo/prebuild-config` `withIosIcons` |
| Device family | iPhone only (`ios.supportsTablet` unset → `TARGETED_DEVICE_FAMILY = 1`) | `@expo/config-plugins` `DeviceFamily` |
| Crash diagnostics | Local-only, AsyncStorage `kanna.mobile.crash-diagnostics.v1`; never transmitted | `src/lib/diagnostics/mobileCrashDiagnostics.ts` |
| Account-free LAN use | No auth gate on the UI; signed-out LAN client built when a desktop is paired by QR | `src/App.tsx`, `src/appModel.ts:855`, `src/components/MachinePairingSheet.tsx` |
| Marketing version | `apps/mobile/VERSION` = `1.0.0`, independent of the desktop `VERSION` | `apps/mobile/app.config.ts` (#1045) |
| Legal pages | `kanna.build/support` and `/privacy` live, 200, HTTPS enforced | `docs/legal/` (#1048), `tampopogk/kanna-web` |
| Privacy label answers | Submission-ready, re-derived from source | `docs/2026-08-08-mobile-app-privacy-label.md` (#1043) |
| App Review notes | Paste-ready, credentials left as placeholders | `docs/2026-08-08-mobile-app-review-notes.md` (#1042) |
| App Store listing copy | Paste-ready name, subtitle, promotional text, description, and keywords | `docs/2026-08-09-mobile-app-store-listing.md` |
| First-launch onboarding | Fresh install names the macOS app and QR pairing | `src/screens/TasksScreen.tsx` (#1044) |

The build and ship machinery is not the gap, and as of 2026-08-09 neither is
anything else in this repository.

## Resolved blockers

All three blockers this document originally raised are closed. Kept here in
summary because the reasoning still explains *why* the current state is
acceptable to App Review.

### B1. Sign-in surface explained — shipped in #1041

The app is **not** account-gated: `App.tsx` has no auth gate, and
`appModel.ts` takes an explicit signed-out branch that builds a
`createTrustedLanFallbackClient` once a desktop is paired by QR. LAN use needs
no account; only the relay/WAN path needs one. The `AccountSheet` now supports
public Firebase email/password signup, email verification, and a handoff to the
portal subscription page. In-app account deletion is present for Guideline
5.1.1(v) lifecycle compliance. Revisit the external subscription link during
production App Store review.

### B2. Privacy policy and support pages — live

`https://kanna.build/support` and `https://kanna.build/privacy` are published
and return 200 (both canonicalise to a trailing slash; enter the trailing-slash
form in App Store Connect so Apple's fetcher gets a direct 200). HTTPS is
enforced on the domain.

The pages are served from `tampopogk/kanna-web` — a **different repository**
from this one; this repo's Pages workflow only publishes `schemas.kanna.build`.
The markdown they were generated from lives here at `docs/legal/`, with
repository provenance links stripped from the published HTML.

Operator is **Tampopo LLC**, governing law **Japan**, with an APPI rights
section. All contact routes to `support@tampopomyoko.com`.

### B3. Privacy label answers — re-derived

`docs/2026-08-08-mobile-app-privacy-label.md` is the submission-ready answer
sheet, re-derived from source rather than carried forward from the stale July
table. It covers push (FCM device tokens registered with the relay), camera
(QR pairing only), and crash diagnostics (local-only, therefore *not*
collected), and it distinguishes the LAN and WAN paths.

Three questions in it remain business/legal calls: whether relay-logged IP
counts as coarse location, whether terminal output should be classed as
Sensitive Info, and whether any analytics is enabled operationally.

## What shipped on 2026-08-09

Seven PRs, all reviewed, all with `./kd test all` passing, all merged to `main`:

| PR | Change |
|---|---|
| [#1041](https://github.com/tampopogk/kanna/pull/1041) | Original cloud access notice in `AccountSheet` (superseded by open signup) |
| [#1042](https://github.com/tampopogk/kanna/pull/1042) | `docs/2026-08-08-mobile-app-review-notes.md` |
| [#1043](https://github.com/tampopogk/kanna/pull/1043) | `docs/2026-08-08-mobile-app-privacy-label.md` |
| [#1044](https://github.com/tampopogk/kanna/pull/1044) | Fresh-install onboarding pointing at macOS + QR pairing |
| [#1045](https://github.com/tampopogk/kanna/pull/1045) | `apps/mobile/VERSION` as an independent marketing version |
| [#1047](https://github.com/tampopogk/kanna/pull/1047) | Accessibility roles/labels on interactive controls |
| [#1048](https://github.com/tampopogk/kanna/pull/1048) | `docs/legal/` privacy policy and support content |

Mobile suite on `main` after all seven: **1,397 passing, 1 skipped**, typecheck
clean.

Worth knowing about #1044: a fresh signed-out install previously showed only a
generic "No tasks yet." card. That is what an App Reviewer would have seen on
first launch. It now names the macOS app and the pairing QR.

## The Apple review environment

The iMac plan is the right design, and it exists because of an asymmetry worth
stating explicitly.

Real users mostly take the **LAN path**: install the macOS desktop app, scan the
pairing QR, no account. Apple's reviewers cannot take that path — they are not
going to install the desktop app, and they are not on the iMac's network. So
they take the **WAN path** instead: install from TestFlight/App Store → sign in
as `kanna.apple@tampopomyoko.com` → the paired iMac's tasks arrive over
`wss://relay.kanna.build`. Reviewers never touch the iMac; it is infrastructure
that must stay up.

The consequence is that **reviewers exercise the path most users won't, and
cannot exercise the path most users will.** Two things follow, both handled in
the review notes rather than in code:

- The app requests **Local Network** permission that a remote reviewer will
  never see used, because there is no desktop on their network. Explain the LAN
  pairing feature and why the permission exists, so it does not read as an
  unjustified permission request.
- The App Store description must state that Kanna Mobile requires the Kanna
  desktop app for macOS, and that the account sign-in is only for remote access.

That makes these the real requirements:

- **R1 — Provision the account in production.** `kanna.apple@tampopomyoko.com`
  must exist in Firebase project `kanna-build` (production), not
  `kanna-staging`. Confirm which project it was created in. An Apple
  Developer/App Store Connect user with the same email is a separate identity
  and does not give the reviewer access inside Kanna.
- **R2 — Pair the iMac to that account and keep it online.** Signed in as the
  Apple account, Kanna desktop running, awake (disable sleep), on stable
  network, for the entire review window. Review is not a single afternoon:
  expect several days and at least one resubmission. If the desktop is offline
  when a reviewer opens the app, they see an empty or disconnected app and
  reject for App Completeness.
- **R3 — Seed safe demo data.** A demo repo with several tasks in different
  stages, with terminal output already present, so the app is not empty on first
  launch. No customer data, no secrets, no private source.
- **R4 — Decide what a reviewer is allowed to do, and make that safe.** This is
  the part that is easy to miss: the mobile app can *create tasks* and *send
  input to running agents*. A reviewer following your own review notes will
  spawn real agent CLIs on that iMac, running real commands against a real
  repo, spending real API credits. Before submitting, decide whether the demo
  repo and agent configuration are safe for an unknown third party to drive, and
  either constrain it (throwaway repo, restricted agent, no network-touching
  tooling) or write review notes that steer them to read-only actions.
- **R5 — Local Network prompt.** iOS will prompt for Local Network permission.
  The review notes already tell reviewers to allow it; keep that, and note that
  LAN discovery will not find anything because the reviewer is not on the iMac's
  network. The relay path must therefore work standalone.

## Remaining checklist

Grouped by who does it.

### Apple Developer portal / App Store Connect (human)

- **A1** — App ID `build.kanna.app` registered with the **Push Notifications**
  capability enabled. The config sets `aps-environment: production`, but the
  App ID and the distribution provisioning profile must actually carry the
  entitlement or the archive export fails or push silently dies.
- **A2** — App Store Connect app record created for `build.kanna.app`
  (name, primary language, SKU). Reserve the name `Kanna` early — it may be
  taken.
- **A3** — App Store Connect API key issued (`APP_STORE_CONNECT_API_KEY_ID`,
  `APP_STORE_CONNECT_API_ISSUER_ID`, and `AuthKey_<id>.p8` in
  `~/.appstoreconnect/private_keys/`). `./kd mobile archive --upload` requires
  all three, plus Xcode 26+. The build Mac must also have an Apple Account for
  team `EA4J68749Z` in Xcode so automatic signing can create the Apple
  Distribution certificate and provisioning profile.
- **A4** — Apple Developer Program membership active and the latest Apple
  Developer Program License Agreement accepted. A free app is covered by that
  agreement; Apple's Paid Apps Agreement, tax forms, and ordinary payout
  banking are only needed if Kanna becomes paid or adds in-app purchases. Do
  not block this free release on the paid agreement.
- **A5** — Export compliance. Nothing in the repo sets
  `ITSAppUsesNonExemptEncryption`, so App Store Connect will ask on every
  upload. Kanna uses TLS/WSS and RSA signature verification for OTA — both
  normally exempt — but this is a legal declaration for the business owner to
  make, not a value to hardcode on their behalf. Once decided, adding it to the
  Info.plist removes the per-build prompt.
- **A6** — Complete the current age-rating questionnaire, Content Rights
  declaration, category (suggested: Developer Tools / Productivity),
  territories, pricing (free), and copyright holder. Let the questionnaire
  calculate the rating; do not manually assume 4+.
- **A7** — Declare Tampopo LLC's EU Digital Services Act trader status. If the
  app will be available in the EU, Apple must verify the public trader phone,
  email, and organization address; Apple's DSA workflow also requires
  payment-account details for traders even when the app itself is free.
- **A8** — Enter `https://kanna.build/privacy/` and publish the App Privacy
  answers from `docs/2026-08-08-mobile-app-privacy-label.md` after resolving
  its three human-confirmation decisions.
- **A9** — Choose the version release setting. Manual release is recommended
  for 1.0 so approval cannot make the app public before the iMac and support
  coverage are ready.

### Firebase / backend (human)

- **D1** — Confirm R1: demo account in `kanna-build`.
- **D2** — **APNs Auth Key uploaded to Firebase** for `kanna-build`, iOS app
  `build.kanna.app`. FCM cannot deliver to a production iOS build without it.
  Push works in no environment until this is done, and it is easy to overlook
  because nothing in the repo can check it.
- **D3** — Confirm Firestore rules are deployed to `kanna-build`
  (`./kd cloud deploy --production`).

### Repo / build (agent-runnable)

- **C1** — ~~Decide the marketing version.~~ **Done (#1045).** The mobile app now
  has its own `apps/mobile/VERSION`, seeded `1.0.0`. Precedence is
  `KANNA_APP_VERSION` → `apps/mobile/VERSION` → repo `VERSION` in every mobile
  environment. Desktop releases and staging RCs do not select or bump the
  mobile marketing version. Note nothing in `kd` bumps `apps/mobile/VERSION` —
  it is a hand edit.
- **C2** — Run the gate: `./kd mobile qa --production --ota`. The OTA half needs
  Google Cloud credentials for `kanna-build`. Run this against the actual
  archive candidate, not just `main`.
- **C3** — Watch the first upload for `ITMS-91053` (missing required-reason API
  declarations). There is no app-level `PrivacyInfo.xcprivacy`; the dependencies
  that need one ship their own (React Native, AsyncStorage, `expo-constants`,
  `expo-file-system`, `expo-application`), so this will probably pass — but if
  Apple flags first-party usage, add `ios.privacyManifests` to `app.config.ts`
  rather than hand-editing the generated project.
- **C4** — Inspect the generated archive, not just the RGBA source icon. Expo 57
  removes transparency from the default iOS icon during prebuild; confirm the
  generated `App-Icon-1024x1024@1x.png` is opaque and visually acceptable
  before uploading.

### Store listing assets (human)

- **S1** — One to ten iPhone screenshots, with at least one accepted 6.9-inch
  portrait size (1260×2736, 1290×2796, or 1320×2868) or the corresponding
  landscape size. Screenshots cannot contain alpha or transparency. Kanna is
  iPhone-only, so no iPad set is needed unless `supportsTablet` changes. Use
  the production display name `Kanna` and demo data — the screenshot rules in
  the July package still apply.
  Note the onboarding empty state changed in #1044, so capture screenshots from
  a build that includes it.
- **S2** — ~~Description, subtitle, keywords, and promotional text.~~
  **Drafted** in `docs/2026-08-09-mobile-app-store-listing.md`, with the
  companion-app and account-free LAN framing. App Store Connect does not show a
  What's New field for the first version; save that copy for TestFlight's
  What to Test field or a later update.
- **S3** — ~~App Review notes.~~ **Drafted (#1042)** at
  `docs/2026-08-08-mobile-app-review-notes.md` — paste-ready, with the relay
  review flow, the Local Network justification, the local-terminal-WebView
  statement, and the reviewer-safety boundary. Two things are still yours: fill
  the credential placeholders at submission time (they are deliberately not in
  the repo), and make the R4 call on what a reviewer may drive.
- **S4** — App review contact name, phone, and email.

### Optional before first submission

- Accessibility — a scoped props pass shipped in #1047 (roles, selected/expanded
  /disabled state, contextual labels on agent permission actions). Deliberately
  **not** covered: `TerminalWebView` exposes no accessible label and xterm's
  screen-reader mode is off, so raw terminal HTML can still trap VoiceOver.
  Fixing that needs restructuring and is its own task. A full VoiceOver pass on
  a device is still unrun.
- App Accessibility Nutrition Labels are currently voluntary. Do not claim
  VoiceOver or another feature until every common task meets Apple's criterion;
  leaving support unindicated is more accurate than publishing a partial claim.

## TestFlight (the beta phase)

Apple's pre-release channel has two tiers, and they differ enough that the
distinction drives the schedule.

**Internal testing** — up to 100 App Store Connect team members. No Beta App
Review; builds reach testers after processing. It needs the app record,
correct signing/provisioning, a successful upload, and an export-compliance
answer, but not completed product-page screenshots or copy. This is the
fastest way to get a production-identity build onto real iPhones and validate
the R1–R5 review environment.

**External testing** — up to 10,000 testers by email or public link, gated on
**Beta App Review**: a real but lighter review than full App Store review.
Needs a beta app description, feedback email, review contact, and — because
the remote review flow requires sign-in — the demo account from R1. Apple
reviews the first build added for external testing; later builds may not need a
full review.

Because B1 turned out to be minor, external beta is no longer load-bearing as a
risk probe — but it is still the cheapest way to have Apple look at the
companion-app framing (LAN pairing, Local Network permission, desktop
dependency) before a full review cycle is at stake.

Mechanics worth knowing:

- TestFlight builds expire 90 days after upload.
- Build numbers must increase monotonically across all uploads, including
  discarded ones. Start at `--build-number 1`.
- `docs/testing/mobile-production-qa-gate.md` already defines the gate and the
  human physical-device check for both "before external TestFlight" and "before
  App Store submission".

## Suggested order

Steps 1–2 of the original plan (publish the legal pages, explain the sign-in
surface) are done. The remaining path, in dependency order:

1. **Apple portal, in this order: A1 → A2 → A3 → A4.** A1 (App ID with Push
   Notifications) gates the archive, because the distribution profile must
   carry the entitlement. Confirm the program membership and current license
   agreement under A4; a free build does not require the Paid Apps Agreement.
2. **D2 in Firebase** — upload the APNs auth key to `kanna-build`. Independent of
   everything above, and the single item nothing in this repo can verify for you.
   Push is dead in production until it is done.
3. **First archive**: `./kd mobile archive --production --build-number 1 --upload`.
   Stamps `1.0.0` from `apps/mobile/VERSION`. Watch for `ITMS-91053` (C3).
4. **Internal TestFlight immediately.** Needs nothing from the listing work, so
   it can start the moment step 3 lands. This is the fastest way to get a
   production-identity build onto a real iPhone.
5. **R1–R5: stand up the iMac review environment** and leave it running.
   Validate it through the internal TestFlight build — sign in as
   `kanna.apple@tampopomyoko.com` over the relay and confirm the paired iMac's
   tasks appear. That is exactly what a reviewer will do.
6. **C2 gate** on the archive candidate, plus the human physical-device check in
   `docs/testing/mobile-production-qa-gate.md`.
7. **External TestFlight** (Beta App Review) on that exact build — a cheap check
   of the companion-app framing before a full review cycle is at stake.
8. Finish **S1, S3, S4 and A5–A9**. S2 is already drafted. Enter the
   privacy-label answers from
   `docs/2026-08-08-mobile-app-privacy-label.md` and the review notes from
   `docs/2026-08-08-mobile-app-review-notes.md`. Submit the build that passed
   TestFlight, then release it manually after approval when the iMac and support
   coverage are ready.

The critical path runs through step 1. Everything else can proceed in parallel
once the App Store Connect record exists.

## Current external references

Verified 2026-08-10:

- [Apple upload requirements](https://developer.apple.com/news/upcoming-requirements/)
  — Xcode 26 and an iOS 26 SDK have been mandatory since 2026-04-28.
- [Required App Store fields](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties/)
  and [version fields](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
  — includes Content Rights, DSA status, screenshots, support URL, copyright,
  review contact, and demo credentials when login is needed.
- [Free versus paid agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/)
  — free apps use the Apple Developer Program License Agreement; the Paid Apps
  Agreement is for paid apps and in-app purchases.
- [EU DSA trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
  — trader status must be declared and public contact details are verified for
  EU distribution.
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
  — accepted 6.9-inch sizes and the no-alpha rule.
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
  — 100 internal testers, 10,000 external testers, 90-day builds, and first
  external-build review.
- [App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
  and [App Review](https://developer.apple.com/app-store/review/) requirements.
- [Accessibility Nutrition Labels](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels/)
  — voluntary at present, with support claims evaluated across common tasks.

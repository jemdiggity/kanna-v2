# Mobile App Store Review Audit

Last reviewed: 2026-07-07

## Implemented in this pass

- Replaced the signed-out mobile auth copy that referred to "local alpha credentials" with production-safe account/local-network wording.
- Made the Expo Bonjour plugin always write explicit Local Network permission copy and keep `_kanna-mobile._tcp` in `NSBonjourServices`.
- Added focused regression tests for the signed-out copy and generated Bonjour Info.plist metadata.

## Current Review-Critical Findings

- Sign-in and sign-out exist in `ConnectionScreen` and `AccountSheet` through Firebase email/password auth.
- The mobile app does not expose in-app account creation. If App Store Connect, marketing, or onboarding says users can create Kanna accounts, Apple requires an easy-to-find in-app way to initiate account deletion.
- No account deletion or data deletion API path is present in the mobile app. Do not fake destructive deletion client-side; it needs a backend-supported account/data deletion flow.
- No public privacy policy, support URL, or account deletion URL is present in this repo. These must be real production URLs before App Store submission.
- Production mobile defaults to Firebase project `kanna-build`, relay `wss://relay.kanna.build`, and OTA channel `production`. A reviewer demo account must be provisioned in production Firebase and must either have cloud task snapshots or clear review notes explaining that the desktop app must be running and paired.

## Required Product/Legal Decisions Before Submission

- Decide whether mobile will support account creation. If yes, implement account deletion initiation in the app and a backend deletion workflow for Firebase Auth plus associated Firestore/relay data.
- Provide final privacy policy, support, and account deletion URLs for App Store Connect and any in-app support/account surface.
- Provision and document a production App Review demo account, including whether the account has preloaded data or requires a paired desktop session.

Apple reference: https://developer.apple.com/support/offering-account-deletion-in-your-app/

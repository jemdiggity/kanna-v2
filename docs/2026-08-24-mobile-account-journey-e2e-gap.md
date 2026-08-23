# Mobile account journey E2E gap (2026-08-24)

The native Appium profile smoke now proves that the real signed-out Account sheet renders both sign-in and **Create account** controls. It cannot yet drive one account through creation, emulator email verification, entitlement mutation, the external subscription handoff, and the foreground return that must change the rendered sheet from **Subscription required** to **Cloud access active** in a single native run.

The blocker is harness ownership: the profile smoke starts the app but has no API for retrieving Auth-emulator out-of-band codes or mutating a signed-in user's Firestore entitlement while preserving that app session. It also has no deterministic browser/URL interception boundary for asserting the portal handoff after React Native calls `Linking.openURL`. Existing relay fixtures pre-seed already-verified users, so using one would skip the credential transition under review.

This becomes testable when the mobile E2E harness exposes account-lifecycle controls (create/read verification code/set entitlement) and captures external URLs, or hosts the subscription portal in an Appium-controlled browser context. At that point the smoke should create through the rendered control, apply the code, tap **I verified my email**, assert the inactive subscription state, capture the subscribe URL, activate entitlement while Kanna is backgrounded, return Kanna to the foreground, and assert the same open sheet renders the active state without sign-out or restart.

Narrower coverage meanwhile:

- `accountJourney.emulator.integration.test.ts` uses real Firebase Auth and Firestore emulators to create an account, issue/apply its verification code, prove the refreshed ID token has `email_verified: true`, and read inactive then active entitlement states through the app controller's `refreshAccount()` path.
- `App.component.test.tsx` proves opening the Account sheet and returning an open inactive account to the foreground invoke the guarded account refresh, coalesce overlapping triggers, and publish the refreshed active entitlement to the rendered sheet.
- `profile-connection.e2e.ts` requires the actual native **Create account** control in the signed-out profile smoke.
- `AccountSheet.test.tsx` renders the verified-unsubscribed state and proves the subscription control hands the configured portal URL to React Native Linking.
- Firebase SDK/auth and app-model tests prove forced token renewal happens before verified state publication and that the same-UID relay client is replaced.

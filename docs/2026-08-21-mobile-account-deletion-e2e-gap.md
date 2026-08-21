# Mobile account deletion E2E gap (2026-08-21)

The mobile Appium harness cannot currently drive the account-deletion path through a real Firebase callable. Its cloud fixtures start Auth, Firestore, and relay state for a pre-seeded session, but do not start the Functions emulator with an authenticated mobile Firebase app or provide an Appium-owned disposable account. Running the destructive flow against staging would make the test depend on live account and Stripe state, which is not acceptable.

Closing this gap requires a mobile E2E fixture that creates and signs in a disposable Auth-emulator user, points the installed Expo build at that Auth and Functions emulator pair, and exposes the account sheet confirmation controls to Appium. The fixture must use a subscription-free account or an injected Stripe emulator gateway so it never makes a live Stripe call.

Narrower coverage meanwhile is split across `apps/mobile/src/components/AccountSheet.test.tsx` (the loss warning and typed `DELETE` confirmation), `apps/mobile/src/App.component.test.tsx` (callable adapter success followed by local sign-out), the portal Firebase-emulator system test (the shared authenticated callable transport and handler), and the Functions account-deletion unit/emulator suites (ordered deletion, rerun, and Firestore removal).

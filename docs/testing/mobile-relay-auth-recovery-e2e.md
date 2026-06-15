# Mobile Relay Auth Recovery E2E Coverage

The auth recovery E2E lives in `apps/desktop/tests/e2e/real/mobile-relay-auth-recovery.test.ts`.
It uses the desktop E2E runner because that harness already starts Firebase
Auth/Firestore emulators and the local relay with the committed `e2e-token`
device registration.

The test drives the mobile relay transport directly through a real relay
WebSocket:

- the first stream attempt returns an invalid cached Firebase ID token;
- the relay rejects it with close code `4005`;
- the stream client performs exactly one forced `getIdToken(true)` refresh;
- the retry opens a relay tunnel, completes the tunneled KSP auth, attaches the
  terminal stream, and receives output; and
- a second scenario keeps returning invalid tokens and verifies a single
  auth-expired callback with no further retry loop.

True Appium coverage is not practical yet for this exact behavior. The current
mobile Appium harness can sign in and open a cloud-backed task, but it cannot
inject a relay-side `4005` close for a specific cached token, swap the next
Firebase token result, or observe the exact forced-refresh call count inside the
native app. Making this a full device E2E would require a relay test double that
the Appium runner can configure per stream, plus an in-app test probe for
Firebase token refresh calls or equivalent telemetry.

The narrower focused tests remain in:

- `packages/stream-client/src/stream-client.test.ts`
- `apps/mobile/src/lib/transports/relayClient.test.ts`
- `apps/mobile/src/lib/firebase/auth.test.ts`
- mobile controller/app state tests that verify auth-expired propagation into
  the re-login UI state.

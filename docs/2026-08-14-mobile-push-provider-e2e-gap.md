# Mobile push provider E2E gap

The notification path now has automated cross-boundary coverage through the
last boundary Kanna controls:

- relay unit tests drive Firestore device lookup, the FCM multicast result,
  safe failure classification, aggregation, and invalid-token cleanup;
- relay integration tests cover authenticated registration and the WebSocket
  publication acknowledgement shape;
- `kanna-server` drives its real authenticated HTTP endpoint through a relay
  WebSocket stand-in and proves provider diagnostics reach the API response;
- mobile tests cover environment-specific registration, token refresh,
  unregistration, and task-open payload parsing.

The remaining FCM to APNs to installed-iPhone hop cannot be automated by the
current emulator harness. Firebase emulators do not deliver through APNs, and
the iOS simulator harness does not provision a signed staging app, real APNs
credentials, or a reliable system-notification assertion. Automating it needs
a managed physical-device lane for `build.kanna.app.staging` that can assert a
background notification and tap result without exposing the FCM token.

## Live staging diagnosis on 2026-08-14

The authoritative staging instance was `http://127.0.0.1:48121`, desktop
`desktop-21b320e8-a5ad-4fae-9d87-1db14090f0a9`, server
`0.2.0-staging.1`. A token-safe provider diagnostic found two sequential
configuration failures:

1. Firebase first returned `messaging/mismatched-credential` with
   `cloudmessaging.messages.create` denied for `kanna-staging`. Granting
   `roles/firebasecloudmessaging.admin` to the staging relay VM service account
   fixed that permission failure; the provisioning plan now includes the role.
2. With FCM permission fixed, Firebase returned
   `messaging/third-party-auth-error` with the exact safe provider message
   `Invalid APNs credential.` Read-only device inspection confirmed that the
   registered v0.2.0 staging app was signed by Apple team `EA4J68749Z` for
   `build.kanna.app.staging` with a validated development profile and
   `aps-environment: development`. Configuring the staging Firebase app's
   development APNs credential for that sandbox environment fixed the provider
   rejection. A final labeled test returned one accepted device and no
   failures. Receipt on the physical phone remains an operator assertion.

Until that exists, staging validation is an operator-authorized test only:
confirm `kanna_info` reports the staging server and desktop, use a title that
explicitly says test, assert the API reports an accepted device with no failure
reasons, then confirm receipt on the staging app. Never use the production
relay or credentials for this scenario.

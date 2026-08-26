# Anonymous push true-device delivery E2E gap (2026-08-24)

The phase-3 integration coverage can prove the complete anonymous trust and
relay boundary in CI, but it cannot prove the final FCM → APNs → physical iOS
device hop. Firebase provides Auth and Firestore emulators but no Cloud
Messaging/APNs device-delivery emulator, and a real registration token is tied
to an installed, correctly signed native app and environment-specific APNs
credentials.

The relay integration suite therefore runs the real HTTP server, WebSocket
challenge/response authentication, Ed25519 certificate verification,
Firestore binding lifecycle, principal restrictions, payload parsing, and
rate limits. In a test-only relay mode, the final provider call is captured in
Firestore so the suite proves the selected paired token and exact notification
reach the delivery boundary. Mobile unit coverage proves registration, token
rotation, and revocation requests use the persisted pairing material. A
kanna-server fake-relay integration test proves signed-out publication uses the
anonymous challenge flow lazily.

Closing this gap requires an environment-matched physical iOS device (or a
future provider-supported push emulator) with the staging app installed and
notification permission granted. The check must pair while signed out,
background or suspend the app, trigger a desktop notification, and verify one
system notification arrives; it must then unpair and verify later notifications
do not arrive. This is a staging-only manual check and must not use production.

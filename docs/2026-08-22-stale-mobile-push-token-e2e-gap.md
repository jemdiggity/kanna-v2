# Stale mobile push token E2E gap

The 2026-08-22 staging failure was reproduced against the real Firebase Admin
boundary: the sole stored token passed an exact-payload dry run, while a live
send returned `messaging/invalid-argument` with `APNs device token is disabled.`
That proves a permanently rejected registration rather than an invalid Kanna
notification payload.

CI cannot reproduce the final FCM → APNs → installed-app lifecycle. It has no
signed staging app on an APNs-capable physical device and cannot automate
delete/reinstall, observe the system notification, or attest that Firebase
issued a replacement token. A real-device test becomes practical when the
device harness can install the signed staging build, sign into a seeded
account, read the matching Firestore `pushDevices` metadata, and assert the iOS
system notification.

Narrower automated coverage now proves that:

- each mobile launch and FCM rotation registers the current token;
- registering the same mobile device replaces its document, while delayed
  cleanup for the old token cannot remove the replacement;
- per-device `messaging/invalid-argument` and unregistered-token failures evict
  the rejected Firestore document and return an actionable `invalidToken`
  reason through `kanna-server`.

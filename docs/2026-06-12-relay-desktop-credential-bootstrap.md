# Relay desktop credential bootstrap (2026-06-12)

## What broke

Desktop auth against the deployed relay (`wss://relay.kanna.build`) failed with
close code `4005` for the `desktop_id`/`desktop_secret` path. Relay container
logs on `kanna-relay-vm` showed the root cause:

```
[auth] Failed to verify desktop credentials: Error: 9 FAILED_PRECONDITION:
The query requires a COLLECTION_GROUP_ASC index for collection desktops and
field desktopId.
```

Production Firestore had no collection-group index for `desktops.desktopId`
(the emulator does not enforce indexes, so local E2E passed). Independently,
the desktop app never provisioned a relay credential at all: it wrote a random
`device_token` into `server.toml` without registering it anywhere, so the
legacy path looped on `[auth] Device token not found`. The old first-time
bootstrap (`createPairingCode` Cloud Function) is retired and must not be
redeployed.

## The credential flow now

1. `apps/desktop/src-tauri/src/commands/mobile.rs` persists a per-instance
   `desktop_secret` next to `desktop_id` in `desktop-identity.json` (legacy
   id-only files are migrated in place) and writes both into the generated
   `server.toml`.
2. The `desktop_cloud_credential` Tauri command exposes `desktopId` plus the
   SHA-256 hash of the secret to the frontend. The plain secret never enters
   the webview or Firestore.
3. When a signed-in user's desktop reconciles cloud task snapshots,
   `desktopCloudPublisher` upserts `desktopSecretHash` onto this desktop's
   `users/{uid}/desktops` document (allowed by existing Firestore rules).
4. `kanna-server` authenticates to the relay with
   `{type: "auth", desktop_id, desktop_secret}` (it already preferred this
   over `device_token` when the secret is present).
5. The relay (`services/relay/src/auth.ts`) queries
   `collectionGroup("desktops").where("desktopId" == …)` (bounded, not
   `limit(1)`), skips revoked docs, and compares `sha256(presented secret)`
   against `desktopSecretHash` with a timing-safe comparison. Squatting a
   desktopId in another user's subcollection cannot capture or deny the real
   desktop's session.

The legacy `device_token` + `POST /register` path still works for phones and
old configs, but the desktop app no longer depends on it.

## Deploy artifacts

- `firestore.indexes.json` (new) carries the `COLLECTION_GROUP` field override
  for `desktops.desktopId`; `firebase.json` references it and
  `kd cloud deploy` now ships `firestore:rules,firestore:indexes` (functions
  deploys stay retired).
- Relay image deploys via `./kd cloud deploy --production --relay`
  (Cloud Build → gcr.io/kanna-build/kanna-relay → compose stack on
  `kanna-relay-vm`).
- Relay logs live on the VM (`docker compose logs` in `~/kanna-relay`), not in
  Cloud Logging.

## Verification

- `services/relay`: `pnpm test` (unit tests mock Firestore; integration tests
  spawn the relay with `SKIP_AUTH`).
- `apps/desktop/src-tauri`: `cargo test --lib` covers credential persistence,
  migration, config generation/staleness, and the hash command.
- Real cloud smoke: `apps/desktop/tests/e2e/real/cloud-relay-desktop-auth.test.ts`
  (env-gated: `KANNA_FIREBASE_API_KEY`, `KANNA_FIREBASE_PROJECT_ID`,
  `KANNA_CLOUD_TEST_EMAIL`, `KANNA_CLOUD_TEST_PASSWORD`; optional
  `KANNA_RELAY_SMOKE_URL`). Creates a disposable `users/{uid}/desktops` doc,
  expects `auth_ok` from the deployed relay and a `4005` close for a wrong
  secret, then deletes the doc.

## Production cleanup candidates

Legacy `devices/*` registrations remain in the `kanna-build` Firestore from
earlier manual smokes; Firestore rules deny client deletes, so removing them
requires owner/admin REST. Leave them until desktops on this build have
switched to desktop credentials, then delete:

- `devices/422dba3dbb601e4217a9e78bbd10a40e` (2026-06-02)
- `devices/8715390b9cf7b5dec0d78f8d54002a43` (2026-06-06)
- `devices/9f0183ee124a9c0562b7f1963b6e62e7` (2026-06-11)

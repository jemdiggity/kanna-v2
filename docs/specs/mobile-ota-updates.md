# Self-Hosted OTA Updates for Kanna Mobile

Kanna mobile uses self-hosted Expo Updates for staging and production JS/asset
updates. Development builds remain Metro/dev-client only. OTA updates are served
by the relay and stored in the per-environment Firebase/GCS bucket.

## Client Scope

- `expo-updates` is configured only when `KANNA_APP_ENV` is `staging` or `prod`.
- The manifest URL is derived from the environment relay URL by converting
  `wss://` to `https://` and appending `/ota/manifest`.
- The app checks after initial model initialization and on foreground, throttled
  to once every five minutes.
- Downloaded updates do not reload active sessions immediately. The app shows
  an in-app prompt and also reloads on the next foreground after backgrounding.

## Shared Contract

- Protocol: Expo Updates protocol version `1`, platform `ios`.
- Manifest endpoint: `GET /ota/manifest`.
- Asset endpoint: `GET /ota/assets?key=<hash>&runtimeVersion=<rv>&platform=ios`.
- Origins: `https://relay-staging.kanna.build` for staging and `https://relay.kanna.build` for production.
- Dev: disabled.
- Channels: `staging` and `production`, passed by `expo-channel-name`.
- Runtime version: `1.0.0` currently, sourced from `apps/mobile/src/mobileEnvironments.json` as `runtimeVersion`.
- Code signing: RSA SHA-256, Expo alg `rsa-v1_5-sha256`.
- Code signing key id: `kanna-mobile-ota-v1`.
- Public cert: `apps/mobile/certs/ota-codesign.pem`.
- Public cert SHA-256 fingerprint: `5E:D1:D8:56:C6:C6:92:6A:3E:D7:C5:AE:E9:1F:40:09:53:58:EF:29:3C:66:FB:69:D9:5A:B3:3C:53:62:CB:D4`.
- Private key secret: Google Secret Manager secret `kanna-mobile-ota-private-key-pem` in each environment project.

## GCS Layout

Objects live in the environment bucket under `ota/`:

```text
ota/ios/<runtimeVersion>/updates/<updateId>/metadata.json
ota/ios/<runtimeVersion>/updates/<updateId>/expoConfig.json
ota/ios/<runtimeVersion>/updates/<updateId>/bundles/<sha256-base64url>.hbc
ota/ios/<runtimeVersion>/updates/<updateId>/assets/<sha256-base64url>
ota/ios/<runtimeVersion>/channels/<channel>.json
```

The channel pointer is the commit point:

```json
{ "currentUpdateId": "<updateId>", "createdAt": "...", "runtimeVersion": "1.0.0" }
```

`updateId` is deterministic: SHA-256 of `metadata.json`, converted to the Expo
UUID shape using the first 32 hex characters.

## Relay

The relay handles:

- `GET /ota/manifest`: validates Expo headers, reads the channel pointer, builds a multipart manifest, and signs the manifest or `noUpdateAvailable` directive with `expo-signature`.
- `GET /ota/assets`: serves content-addressed bundle/asset objects with immutable cache headers.

Deploy wiring fetches `kanna-mobile-ota-private-key-pem` from Secret Manager
onto the VM and mounts it read-only into the relay container at
`/run/secrets/kanna_ota_private_key.pem`.

## Operations

Provision the private key secret after key generation or rotation:

```bash
./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
./kd mobile ota provision-secret --production --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
```

Deploy relay support through the normal cloud deploy flow:

```bash
./kd cloud deploy --staging --relay
./kd cloud deploy --production --relay
```

Publish a JS/asset update:

```bash
./kd mobile ota publish --staging
./kd mobile ota publish --production
```

Check the current pointer:

```bash
./kd mobile ota status --staging
./kd mobile ota status --production
```

Rollback by repointing the channel to a prior update id:

```bash
./kd mobile ota publish --staging --rollback-to <updateId>
./kd mobile ota publish --production --rollback-to <updateId>
```

Dry run a publish or rollback with `--dry-run`.

## E2E Gap

Human post-merge verification should publish to staging, run the staging app on
device, confirm the update is fetched and applied, change a visible JS string,
republish, and confirm the new update applies on foreground/restart.

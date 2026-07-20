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
- Runtime version: sourced from the selected environment in `apps/mobile/src/mobileEnvironments.json` as `runtimeVersion`.
- Code signing: RSA SHA-256, Expo alg `rsa-v1_5-sha256`.
- Code signing key id: `kanna-mobile-ota-v1`.
- Public cert: `apps/mobile/certs/ota-codesign.pem`.
- Public cert profile: `apps/mobile/certs/ota-codesign.cnf`.
- Public cert key usage: critical `digitalSignature`.
- Public cert extended key usage: critical Code Signing (`1.3.6.1.5.5.7.3.3`).
- Public cert SHA-256 fingerprint: `18:5A:94:97:1B:8C:07:A4:CA:8E:22:51:85:FA:64:31:EE:6C:9B:B8:E5:AD:06:17:93:CD:AD:90:CF:D9:6B:22`.
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
{ "currentUpdateId": "<updateId>", "createdAt": "...", "runtimeVersion": "2.1.1" }
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

Provision the environment bucket, required API, and relay bucket-read IAM before the first deploy. This command is idempotent and requires an explicit environment:

```bash
./kd mobile ota provision --staging
./kd mobile ota provision --production
```

Provision the private key secret after key generation or rotation. This command idempotently enables Secret Manager, creates the secret when absent, adds a version, and grants the relay service account access:

```bash
./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
./kd mobile ota provision-secret --production --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
```

Before its first cloud command, `provision-secret` parses the committed
certificate and rejects an invalid private key or a key whose derived public
key does not match the certificate. It never prints PEM contents or derived
key bytes.

Reissue the public certificate only from the existing private key and committed
profile. Generate into a temporary directory, inspect the public certificate,
then replace only `apps/mobile/certs/ota-codesign.pem`:

```bash
OTA_CERT_DIR=$(mktemp -d /tmp/kanna-ota-cert.XXXXXX)
openssl req -new -x509 -sha256 -days 3650 \
  -key "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem" \
  -config apps/mobile/certs/ota-codesign.cnf \
  -out "$OTA_CERT_DIR/ota-codesign.pem"
openssl x509 -in "$OTA_CERT_DIR/ota-codesign.pem" -noout -purpose
```

The public output must report `Code signing : Yes`. Replacing the certificate
changes embedded native update configuration, so increment every environment's
`runtimeVersion` before installing or publishing a build containing it. Never
print, copy into the repository, or commit the private key.

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

`publish` validates the committed certificate and its validity window before
Expo export or cloud upload.

Check the current pointer:

```bash
./kd mobile ota status --staging
./kd mobile ota status --production
```

Run the read-only cloud and relay preflight before asking a human to verify an
OTA on a physical device:

```bash
./kd mobile ota doctor --staging
./kd mobile ota doctor --production
```

`preflight` is an alias for `doctor`. The command does not publish, roll back,
write GCS objects, modify Secret Manager, or install/launch a device app. It
requires Google Cloud credentials for the target project and verifies:

- environment resolution, OTA bucket, channel, and `runtimeVersion`
- committed certificate validity and Code Signing extended key usage
- current GCS channel pointer and referenced update metadata/config readability
- relay `/health` and `/ota/manifest` behavior for the current channel
- Secret Manager private-key secret existence
- relay VM service account resolution
- relay service account IAM for Secret Manager and OTA GCS reads

The canonical staging setup and verification sequence is:

```bash
./kd mobile ota provision --staging
./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
./kd cloud deploy --staging --relay
./kd mobile ota doctor --staging
./kd mobile ota status --staging
```

The last two commands are read-only. Publishing is a separate operation and is
not implied by provisioning or deployment.

Rollback by repointing the channel to a prior update id:

```bash
./kd mobile ota publish --staging --rollback-to <updateId>
./kd mobile ota publish --production --rollback-to <updateId>
```

Dry run a publish or rollback with `--dry-run`.

## Release Verification

Automated preflight with real staging or production cloud resources is not a CI
claim because it needs Google Cloud credentials for the target project. Run it
explicitly before human device verification:

```bash
gcloud auth application-default login
./kd mobile ota doctor --staging
```

For production, use credentials authorized for `kanna-build` and run:

```bash
./kd mobile ota doctor --production
```

Human-only post-merge verification remains: publish to staging, run the staging
app on a physical iPhone, confirm the update is fetched and applied, change a
visible JS string, republish, and confirm the replacement update applies on
foreground or restart. Agent automation must not install, launch, or run
physical-device Appium for this check.

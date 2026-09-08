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

## Native Versioning and Archive Provenance

### Motivation: reconstructing the App Store 1.0 binary

The first App Store binary predates the durable archive ledger below. App
Store Connect identifies it as uploaded August 17, 2026 at 21:04, with original
file `727ee03c-3740-44ef-bc17-0d1ff8a925eb.ipa`. Repository forensics make its
runtime knowable only circumstantially: the last `origin/main` tip before the
upload was `64824093a` (August 17 at 19:39 +09:00), that commit used production
runtime `2.1.4`, and `2.1.4` remained current until August 19. The binary
therefore embeds runtime `2.1.4` regardless of which contemporaneous ref
produced it. The owner later confirmed App Store Connect identifies the
released binary as build 3, but no historical ledger binds that build to an
exact source ref.

Current production OTA configuration uses runtime `2.2.2`, first introduced by
`6f303e3dd` on August 23. Those updates cannot reach the 1.0 store binary, so a
new native binary is mandatory. This reconstruction—and the inability to name
the exact source/build—is why archive provenance must be written and pushed at
archive time rather than deferred until publication.

### Policy

The mobile App Store version series is independent of the desktop release
series. A mobile `1.0`, `1.1`, or `1.0.1` release may accompany any desktop
`0.3.x` release; neither number is derived from the other. The checked-in
mobile marketing version uses Apple's three-component form in
`apps/mobile/VERSION` (for example `1.0.0`, which the App Store may display as
`1.0`).

The three version values answer different questions:

- **Marketing version (`CFBundleShortVersionString`)** identifies a customer-
  facing App Store release. Bump it when submitting a new binary after the
  current version has been released, or when product release semantics call
  for a new patch/minor version. A JS-only OTA does not bump it.
- **Build number (`CFBundleVersion`)** identifies one App Store binary. Use a
  numeric value higher than every prior production archive/upload, including
  across marketing versions. Any rebuilt binary from changed source takes a
  new build number; an OTA does not.
- **Expo `runtimeVersion`** is a native compatibility key, not a customer-
  facing version. Increment it in every entry of
  `apps/mobile/src/mobileEnvironments.json` whenever native code, native
  configuration, the Expo SDK, a native dependency, the native-identity
  plugin, or the embedded OTA signing certificate changes. JS/assets-only
  changes keep it unchanged. An OTA is reachable only by installed binaries
  with the same runtime.

Every successful `kd mobile archive --production` records provenance before
any optional upload by creating and pushing the immutable annotated tag
`mobile-archive-v<marketing-version>-<build-number>` at the archived commit.
Its JSON message records the requested ref, full and short commit, marketing
version, build number, runtime version, bundle id, and archive timestamp. This
git tag is the durable archive-time ledger; `.build/` output is disposable.
Inspect it with `git show mobile-archive-v<version>-<build>`. Reusing the same
version/build at another commit is refused: both the annotated tag's peeled
Git target and the commit in its JSON message must equal the requested archive
commit. `kd mobile publish` later adds its separate
`mobile-v<version>-<build>` tag with upload, verification, and App Store
Connect identifiers.

## GCS Layout

Objects live in the environment bucket under `ota/`:

```text
ota/ios/<runtimeVersion>/updates/<updateId>/metadata.json
ota/ios/<runtimeVersion>/updates/<updateId>/expoConfig.json
ota/ios/<runtimeVersion>/updates/<updateId>/kanna-source.json
ota/ios/<runtimeVersion>/updates/<updateId>/bundles/<sha256-base64url>.hbc
ota/ios/<runtimeVersion>/updates/<updateId>/assets/<sha256-base64url>
ota/ios/<runtimeVersion>/channels/<channel>.json
```

The channel pointer is the commit point:

```json
{
  "currentUpdateId": "<updateId>",
  "createdAt": "...",
  "runtimeVersion": "2.1.1",
  "sourceRef": "release/0.2",
  "sourceCommit": "<40-hex sha>"
}
```

`updateId` is deterministic: SHA-256 of `metadata.json`, converted to the Expo
UUID shape using the first 32 hex characters.

`kanna-source.json` records the git source the update was exported from:

```json
{ "updateId": "<updateId>", "ref": "release/0.2", "commit": "<40-hex sha>", "shortCommit": "<12-hex sha>" }
```

The pointer's `sourceRef`/`sourceCommit` answer "what is this channel serving
right now"; `kanna-source.json` stays with the update, so an update a later
rollback re-points to is still traceable after the pointer has been rewritten.
Neither is part of `metadata.json` — `updateId` is that file's hash and Expo
clients parse it — and the relay reads only `metadata.json`, `expoConfig.json`,
and the content-addressed artifacts, so both records are inert to the client.
A rollback pointer carries no source fields: it publishes no new source, and
the update it names carries its own.

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
./kd cloud deploy --production --relay --ref release/0.2
```

Publish a JS/asset update:

```bash
./kd mobile ota publish --staging
./kd mobile ota publish --production --ref release/0.2
```

`publish` exports whatever the working tree contains, so the source is a guard
rather than a parameter — the same treatment `kd cloud deploy` and `kd mobile
archive` apply:

- `--ref <branch|tag|sha>` is **required** with `--production`. An OTA publish
  pushes JS straight to installed apps, so the source commit must be named
  rather than inferred from whatever happens to be checked out.
- A dirty worktree is refused; so is a `--ref` that is not the checked-out
  commit (`git checkout` it first).
- Without `--ref`, staging resolves `HEAD` and reports it, so the output still
  records what shipped.
- `--rollback-to` re-points the channel at an already-published update and
  exports nothing, so it needs no `--ref`. It still refuses a dirty worktree.

The resolved commit appears in the command output (`Source: <ref> (<short
sha>)`), in the result data as `source`, and in the two GCS records described
under [GCS Layout](#gcs-layout). `kd mobile ota status` prints the raw pointer,
so it shows the source of the update the channel currently serves.

`--ref` narrows what a publish can ship; it does not change the approval
policy. Production publishes and rollbacks still require an explicit human
request (see [release.md](../dev/release.md#mobile-ota)).

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
- every runtime channel pointer, with older pointer publication dates marked stale relative to the newest channel pointer
- paired-device build observations from the running desktop, including compatibility and confirmed application when available

Publish success means the artifacts and pointer were published. It does not mean
an installation received them. Publish (including rollback) now warns when no
recently observed paired device runs the target runtime, names the reported
runtimes, and reports unknown inventory explicitly. It remains allowed.
`status` includes these observations alongside the pointer and recent updates;
its exit status still describes pointer readability. `doctor` returns a nonzero
result for WARN as well as FAIL, so unknown device data cannot produce an
all-PASS preflight. A matching runtime alone does not confirm application:
confirmation requires a recent report naming the channel's current update id.

The inventory source is `http://127.0.0.1:48120/v1/mobile/builds`, the running
local desktop, regardless of the publishing worktree's development ports.
Set `KANNA_OTA_DEVICE_SERVER_URL=http://127.0.0.1:<port>` to inspect a different
local desktop instance. Output names the source and desktop id. This is a
census of that desktop's paired devices, not every installation or every
machine in the account. Environment and channel must both match. Reports over
24 hours old (or with invalid/future timestamps) are shown as stale and never
prove current reachability. Historical mismatches remain visible.

The mobile app reports build identity when establishing a trusted LAN route,
alongside the existing once-per-route pairing-material refresh. It does not
require notification permission. Offline/remote-only devices retain their last
LAN observation; older clients have no observation. Publishing this JS to a new
runtime cannot teach an already-stranded older binary to report: until it runs
a reporting-capable build, it remains UNKNOWN. Reinstall the compatible native
build to receive that runtime's publications. No OTA compatibility rule,
runtime value, or signing/provisioning behavior changes.

An in-app “this build can no longer receive updates” banner is deferred. Neither
a publisher's checkout runtime nor a newer historical bucket entry establishes
that an older runtime is retired: publishing ahead of a native rollout is
legitimate, runtime identifiers are opaque, and older pointers may still be
maintained. A reliable banner needs an explicit channel support/retirement
signal, plus bootstrap of its reader onto older installations. This change
warns the operator about the specific publication a known device cannot receive
without inventing that policy.

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

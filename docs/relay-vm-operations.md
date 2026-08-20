# Relay VM Operations

This runbook provisions and deploys the Kanna relay VM for staging or production. Do not run these steps until the target environment and DNS change are approved.

The relay deploy is build-and-pull:

0. `kd` resolves `--ref <branch|tag|sha>` to a commit. Cloud Build uploads the
   *working tree*, not the ref, so kd refuses a dirty worktree and refuses a ref
   that is not the checked-out commit. `--ref` is required for
   `--production`; without it kd resolves and reports the current `HEAD`.
1. `kd` submits the monorepo Docker build to Cloud Build with `services/relay/cloudbuild.yaml`,
   passing the resolved short commit as the `_COMMIT` substitution.
2. Cloud Build pushes the image to Artifact Registry.
3. The VM logs in to Artifact Registry with its attached service account metadata token.
4. `kd` uploads only `services/relay/deploy/docker-compose.yml` and `Caddyfile`.
5. The VM writes `/opt/kanna-relay/.env`, runs `docker compose pull`, then `docker compose up -d`.

Do not build the relay image on the VM and do not upload the source tree to `/opt/kanna-relay`.

## What is this relay running?

`GET /health` is unauthenticated and reports the source commit baked into the
running image:

```bash
curl -s https://relay.kanna.build/health
```

```json
{"status":"ok","commit":"5022d3f9f0aa","connections":0,"tunnelFlow":{"pauseCount":0,"resumeCount":0,"capRejectCount":0,"maxBufferedBytes":0}}
```

`commit` is the short sha `kd` resolved from `--ref` at deploy time, carried into
the image as the `KANNA_RELAY_COMMIT` build arg. It reads `unknown` for an image
built outside `kd cloud deploy` (a manual `gcloud builds submit` without
`_COMMIT`, or a local `docker build`). Nothing else about the build is exposed —
no branch, no build id.

## How much traffic is this account using?

The relay keeps a **byte odometer**: cumulative sent/received counters per
WebSocket connection, attributed to the authenticated Firebase uid and desktop
id and split by message class. It exists to measure real per-user traffic ahead
of subscription pricing (`docs/specs/accounts-and-billing.md`); it enforces
nothing.

Classes:

| class | what it counts |
|---|---|
| `tunnel` | spliced `ksp` tunnel frames — the Kanna Server Protocol, including raw terminal bytes |
| `taskTransfer` | spliced `task-transfer` tunnel frames |
| `terminalEvent` | terminal stream events routed to `observe_session` observers (how the mobile app watches a terminal) |
| `control` | everything else: auth, invokes, responses, task snapshot publication, mobile notifications, acks |

`received` is what the relay read from that connection; `sent` is what it wrote
to it.

### Logs

One JSON line per connection close, plus an hourly rollup per still-open
connection so a long-lived tunnel is visible before it closes:

```bash
sudo docker compose -f /opt/kanna-relay/docker-compose.yml logs relay \
  | grep '\[bytes\]'
```

```json
{"event":"connection_close","connectionId":41,"uid":"Bax9…","desktopId":"a1b2…","role":"server","tunnelService":"ksp","durationMs":734512,"received":{"tunnel":19283746,"taskTransfer":0,"terminalEvent":0,"control":1024},"sent":{…},"receivedTotal":19284770,"sentTotal":8192,"totalBytes":19292962}
```

`event` is `connection_close` or `connection_rollup`; a rollup carries the same
totals-so-far for a connection that is still open. `KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS`
overrides the hourly cadence (used by the test suite; the deploy does not set
it).

### `GET /stats`

Process aggregates since the relay started, for ops inspection:

```bash
curl -s -H "Authorization: Bearer $FIREBASE_ID_TOKEN" https://relay.kanna.build/stats
```

Unlike `/health`, this route requires a Firebase ID token — usage data is not
public. The body carries **aggregates only**: no uid, no desktop id, no
per-connection row, so an authenticated caller learns nothing about another
account. Per-user attribution exists only in the logs above.

Counters are in-memory per process: **a relay restart or redeploy resets every
counter and loses the open connections' totals so far.** Read a window from the
logs, not from `/stats`, when a redeploy may have happened inside it.

Note that these counters measure **application** bytes — the payload the relay
handed to or received from the WebSocket layer — on both sides. WebSocket
compression (below) sits underneath that measurement point, so `/stats` and the
`[bytes]` lines report pre-compression volume and will not move when
compression is working. That is deliberate: per-user metering should not change
because a client did or did not negotiate an extension.

## WebSocket compression

The relay negotiates `permessage-deflate` on every WebSocket. It is opt-in per
client: anything that sends no `Sec-WebSocket-Extensions` header — the desktop
app's `tokio-tungstenite` client, today — connects uncompressed and is
unaffected. Nothing needs to be configured, and there is no way to turn it off
short of a code change.

The zlib configuration is bounded for the 1 GB e2-micro and documented at
`services/relay/src/webSocketCompression.ts`: roughly **160 KiB per connection
that actually compresses in both directions**, allocated lazily on that
connection's first compressed frame. If the relay starts showing memory
pressure that tracks connection count, that file is where the window and
`memLevel` bounds live; if it shows *CPU* pressure, lower the deflate `level`
there first.

One consequence worth knowing when reading the tunnel flow counters in
`/health`: the tunnel watermarks measure `bufferedAmount`, which counts the
bytes actually held — so once a frame is compressed onto the socket, it counts
compressed. The memory bound is therefore still exact, but highly compressible
traffic now moves far more application data before it reaches a pause mark.

### `KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS`

The relay caches a successful `desktopCredentials` validation for 60 s and
serves per-message revalidation from that cache, instead of reading Firestore
on every published message. The TTL is the window in which a credential revoked
elsewhere is still honoured **on an already-open socket**; opening a new
connection always re-reads Firestore, so a revoked desktop cannot reconnect.

Set this variable to shorten that window, or to `0` to disable the cache
entirely and restore a Firestore read per revalidation. The deploy does not set
it; the integration suite does.

## Staging

1. Build the provisioning plan:

   ```bash
   ./kd cloud relay-provision --staging
   ```

2. Run the first command from the plan to reserve the static IP in `kanna-staging`.

3. Add a GoDaddy DNS A record:

   ```text
   relay-staging.kanna.build -> <reserved IP>
   ```

4. Wait for DNS to resolve. Caddy cannot obtain a Let's Encrypt certificate until `relay-staging.kanna.build` resolves to the VM IP.

5. Run the remaining provision commands from the plan to create the VM and firewall rule.

6. Grant the VM service account the least environment-scoped permissions from
   the generated plan. In addition to Firestore, image, and OTA access, push
   delivery requires `roles/firebasecloudmessaging.admin`; without it Firebase
   rejects every device with `cloudmessaging.messages.create` denied.

   FCM also requires an APNs authentication key for the matching iOS app. In
   Firebase Console, open the environment project, then Project settings →
   Cloud Messaging and upload the human-owned `.p8` key with its Apple key and
   team IDs. A `messaging/third-party-auth-error` / `Invalid APNs credential.`
   response means this credential is missing, revoked, or invalid. Never copy a
   production-only credential into staging; use a key authorized for the
   environment's registered bundle ID.

   The VM uses Application Default Credentials for Firebase and an access token from the metadata server for Docker login. The attached VM service account must have `roles/artifactregistry.reader` on the environment project or repository. Apply that IAM grant through the approved GCP change process; `kd` does not execute IAM changes.

   The remote Docker login performed by deploy is equivalent to:

   ```bash
   TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' \
     'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
     | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
   printf '%s' "$TOKEN" \
     | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev
   ```

7. Deploy the relay from an explicit source ref:

   ```bash
   git fetch origin && git checkout main && git pull --ff-only
   ./kd cloud deploy --staging --relay --ref main
   ```

   For staging this builds and pushes:

   ```text
   us-central1-docker.pkg.dev/kanna-staging/kanna-relay/relay:latest
   ```

   The deploy command writes `/opt/kanna-relay/.env` with:

   ```text
   FIREBASE_PROJECT_ID=kanna-staging
   KANNA_RELAY_DOMAIN=relay-staging.kanna.build
   KANNA_RELAY_IMAGE=us-central1-docker.pkg.dev/kanna-staging/kanna-relay/relay:latest
   ```

8. Wire staging apps to:

   ```text
   KANNA_CLOUD_ENV=staging
   EXPO_PUBLIC_KANNA_RELAY_URL=wss://relay-staging.kanna.build
   ```

## Production

Production is the existing VM-backed relay:

```text
relay.kanna.build -> 34.133.233.111
project: kanna-build
```

Use the production plan only when intentionally changing production infrastructure:

```bash
./kd cloud relay-provision --production
git fetch origin && git checkout release/0.2 && git pull --ff-only
./kd cloud deploy --production --relay --ref release/0.2
```

`--ref` is required for `--production`. It is the answer to "which source went
out": pick the release branch or tag production is meant to run, check it out,
and pass it. After the deploy, confirm what is running with
`curl -s https://relay.kanna.build/health` — its `commit` is the short sha of
that ref.

Production deploy builds and pushes:

```text
us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest
```

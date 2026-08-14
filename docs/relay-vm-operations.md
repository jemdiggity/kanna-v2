# Relay VM Operations

This runbook provisions and deploys the Kanna relay VM for staging or production. Do not run these steps until the target environment and DNS change are approved.

The relay deploy is build-and-pull:

1. `kd` submits the monorepo Docker build to Cloud Build with `services/relay/cloudbuild.yaml`.
2. Cloud Build pushes the image to Artifact Registry.
3. The VM logs in to Artifact Registry with its attached service account metadata token.
4. `kd` uploads only `services/relay/deploy/docker-compose.yml` and `Caddyfile`.
5. The VM writes `/opt/kanna-relay/.env`, runs `docker compose pull`, then `docker compose up -d`.

Do not build the relay image on the VM and do not upload the source tree to `/opt/kanna-relay`.

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

7. Deploy the relay:

   ```bash
   ./kd cloud deploy --staging --relay
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
./kd cloud deploy --production --relay
```

Production deploy builds and pushes:

```text
us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest
```

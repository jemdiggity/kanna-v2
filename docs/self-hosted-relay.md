# Self-hosting the Kanna relay

Kanna's mobile and desktop clients can use `services/relay` at an operator-owned endpoint. A self-hosted relay keeps the same Firebase authentication as Kanna's hosted relays, but it does not require a Kanna Cloud entitlement when entitlement enforcement is left off.

## Authentication and subscription boundary

The relay authenticates a phone with its Firebase ID token and a desktop with the `desktopCredentials/{desktopId}` secret-hash record. Both identities must resolve to the same Firebase uid before the relay routes traffic. A custom endpoint does not disable or replace either check.

The separate `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT` setting gates subscriptions. It defaults to `off`; keep it off for self-hosted service so authenticated accounts work whether or not they subscribe to Kanna Cloud. Kanna's hosted deployments control their own value for this setting, and choosing a custom URL on a phone cannot change hosted-relay policy.

The relay's Firebase Admin configuration must target the same Firebase project as the Kanna mobile and desktop builds being connected. Set `FIREBASE_PROJECT_ID` and provide Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS_JSON` with access to that project's Firestore data. A stock production or staging app cannot authenticate against a relay backed by an unrelated Firebase project; a self-hosted deployment needs authorized Admin credentials for the app's project. Firebase identity is a prerequisite, not a Kanna Cloud subscription check.

## Run the relay

For local development, install the repository dependencies and start the service with the required Firebase environment:

```sh
pnpm install --frozen-lockfile
FIREBASE_PROJECT_ID=your-firebase-project \
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
KANNA_RELAY_ENTITLEMENT_ENFORCEMENT=off \
PORT=8080 \
pnpm --dir services/relay dev
```

For a durable deployment, build `services/relay/Dockerfile` and place it behind a WebSocket-capable TLS reverse proxy. `services/relay/deploy/Caddyfile` and `docker-compose.yml` show the production topology. A source-only relay does not need OTA signing configuration; the provided compose topology also serves OTA updates and therefore declares those variables.

Verify the public endpoint before changing clients:

```sh
curl https://relay.example.com/health
```

The response should report `"status":"ok"`.

## Point both clients at it

1. Stop `kanna-server`, edit its active `server.toml`, set `relay_url = "wss://relay.example.com"`, and restart the desktop app/server. Use the active instance's config path; development worktrees, staging, and production each have a separate file.
2. On mobile, open Account, find **Relay connection**, enter the same `wss://` URL, and tap **Use custom relay**. The app closes existing relay sockets and reconnects through the custom endpoint immediately.
3. Confirm the Account sheet says **Using custom relay**. **Reset to default** returns to the relay baked into the mobile environment and reconnects without an app restart.

The mobile override is stored on that device. It affects relay control sockets, task streams, reconnects, and signed-in push registration; it does not change LAN discovery or the Firebase project configured in the app build.

## TLS requirement

Use `wss://` with a publicly valid certificate whose hostname matches the relay URL. iOS App Transport Security effectively requires this for a user-configured internet endpoint; a self-signed certificate or bare `ws://` endpoint is rejected by the settings validation and should only be used by the repository's controlled development harness.
